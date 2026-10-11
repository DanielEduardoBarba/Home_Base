/**
 * JWT-gated remote desktop. Capture/input run in a seat-user Bun view-worker
 * (libX11 XGetImage + XTest via bun:ffi) over JSON length-prefixed IPC.
 */
import { spawn, type Subprocess } from "bun";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { detectSeatUser } from "./shell_env";
import { appendTrace } from "./trace";

export const FRAME_MAGIC = 0x48425646;

const MSG_HDR = new DataView(new ArrayBuffer(4));

export function discoverX11Env(): { display: string; xauthority: string } {
  let display = (
    process.env.HOMEBASE_DISPLAY ||
    process.env.DISPLAY ||
    ""
  ).trim();
  let xauth = (
    process.env.HOMEBASE_XAUTHORITY ||
    process.env.XAUTHORITY ||
    ""
  ).trim();
  if (!display) display = ":0";
  if (!xauth || !existsSync(xauth)) {
    const seat = detectSeatUser();
    const cand = join(seat.home, ".Xauthority");
    xauth = existsSync(cand) ? cand : "/home/daniel/.Xauthority";
  }
  return { display, xauthority: xauth };
}

function displayOwnerIds(display: string): { uid: number; gid: number } {
  const override = (process.env.HOMEBASE_VIEW_UID || "").trim();
  if (override && /^\d+$/.test(override)) {
    const uid = Number(override);
    return { uid, gid: uid };
  }
  const name = display.replace(/^:/, "").split(".")[0] || "0";
  const sock = `/tmp/.X11-unix/X${name}`;
  if (existsSync(sock)) {
    const st = spawnSyncStat(sock);
    if (st) return st;
  }
  const seat = detectSeatUser();
  return { uid: seat.uid, gid: seat.gid };
}

function spawnSyncStat(path: string): { uid: number; gid: number } | null {
  const r = Bun.spawnSync(["stat", "-c", "%u:%g", path], { stdout: "pipe" });
  if (r.exitCode !== 0) return null;
  const [u, g] = r.stdout.toString().trim().split(":").map(Number);
  if (u == null || u < 0) return null;
  return { uid: u, gid: g || u };
}

type ClientState = {
  ws: { send: (data: string | Buffer | Uint8Array) => void };
  monitor: number;
  maxWidth: number;
  quality: number;
  fps: number;
};

/** Matches SPA View quality chips — server may force a lower rung for stability. */
const QUALITY_LADDER = [
  { preset: "ultra", maxWidth: 3840, quality: 85, fps: 12 },
  { preset: "high", maxWidth: 1680, quality: 72, fps: 18 },
  { preset: "medium", maxWidth: 1280, quality: 55, fps: 12 },
  { preset: "low", maxWidth: 960, quality: 36, fps: 8 },
] as const;

function tierFromSettings(maxWidth: number, quality: number): number {
  if (maxWidth >= 2800 || quality >= 80) return 0;
  if (maxWidth >= 1500 || quality >= 65) return 1;
  if (maxWidth >= 1100 || quality >= 45) return 2;
  return 3;
}

class X11Bridge {
  private proc: Subprocess | null = null;
  private stdin: FileSink | null = null;
  private stdout: ReadableStream<Uint8Array> | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private buf = new Uint8Array(0);
  private queue = -1;
  lastError = "";
  screenW = 0;
  screenH = 0;
  monitors: unknown[] = [];
  uid = 0;
  private queueChain: Promise<Record<string, unknown>> = Promise.resolve({
    ok: true,
  });
  private starting = false;

  get alive(): boolean {
    return Boolean(
      this.proc &&
        !this.proc.killed &&
        this.proc.exitCode === null &&
        this.stdin &&
        this.reader,
    );
  }

  /** Drop IPC handles without throwing — safe after worker death. */
  private markDead(reason?: string): void {
    if (reason) this.lastError = reason;
    const proc = this.proc;
    this.proc = null;
    this.stdin = null;
    this.stdout = null;
    this.reader = null;
    this.buf = new Uint8Array(0);
    this.starting = false;
    if (proc && proc.exitCode === null && !proc.killed) {
      try {
        proc.kill();
      } catch {
        /* ignore */
      }
    }
  }

  start(): void {
    if (this.alive || this.starting) return;
    this.markDead();
    this.starting = true;
    const { display, xauthority } = discoverX11Env();
    const { uid, gid } = displayOwnerIds(display);
    this.uid = uid;
    const seat = detectSeatUser();
    const scratch = `/tmp/homebase-view-${uid}`;
    try {
      Bun.spawnSync(["mkdir", "-p", scratch]);
      if (process.getuid?.() === 0) {
        Bun.spawnSync(["chown", `${uid}:${gid}`, scratch]);
        Bun.spawnSync(["chmod", "700", scratch]);
      }
    } catch {
      /* ignore */
    }

    try {
      const inner = resolveViewWorkerCmd();

      let cmd = inner;
      if (process.getuid?.() === 0 && uid !== 0) {
        const setpriv = Bun.which("setpriv");
        if (setpriv) {
          cmd = [
            setpriv,
            `--reuid=${uid}`,
            `--regid=${gid}`,
            "--init-groups",
            "--",
            ...inner,
          ];
        } else {
          const runuser = Bun.which("runuser");
          if (!runuser) {
            throw new Error("setpriv/runuser required for View as root");
          }
          cmd = [runuser, "-u", seat.name, "--", ...inner];
        }
      }

      const env: Record<string, string> = {
        ...(process.env as Record<string, string>),
        DISPLAY: display,
        XAUTHORITY: xauthority,
        HOME: seat.home,
        USER: seat.name,
        LOGNAME: seat.name,
        HOMEBASE_VIEW_WORKER: "1",
        HOMEBASE_HOME: scratch,
        HOMEBASE_RUNTIME: join(scratch, ".runtime"),
        TMPDIR: scratch,
      };
      delete env.HOMEBASE_SELF_TEST;

      const proc = spawn(cmd, {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env,
      });
      this.proc = proc;
      this.stdin = proc.stdin as unknown as FileSink;
      this.stdout = proc.stdout as ReadableStream<Uint8Array>;
      this.reader = this.stdout.getReader() as ReadableStreamDefaultReader<Uint8Array>;
      this.buf = new Uint8Array(0);

      void proc.exited.then((code) => {
        if (this.proc === proc) {
          this.markDead(`view-worker exited (${code ?? "?"})`);
          appendTrace("warn", this.lastError, "view");
        }
      });

      void (async () => {
        const err = proc.stderr;
        if (err && typeof err !== "number") {
          const r = (err as ReadableStream<Uint8Array>).getReader();
          const dec = new TextDecoder();
          for (;;) {
            const { done, value } = await r.read();
            if (done) break;
            const line = dec.decode(value).trim();
            if (line) appendTrace("info", `view-worker: ${line}`, "view");
          }
        }
      })();

      appendTrace(
        "info",
        `view worker started uid=${uid} display=${display} cmd=${cmd.join(" ")}`,
        "view",
      );
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      this.markDead(err);
      appendTrace("error", `view worker start failed: ${err}`, "view");
    } finally {
      this.starting = false;
    }
  }

  stop(): void {
    // Never await IPC here — a dead worker used to reject and crash the API.
    this.markDead();
  }

  private async readExact(n: number, deadlineMs: number): Promise<Uint8Array> {
    while (this.buf.length < n) {
      if (Date.now() > deadlineMs) throw new Error("X11 worker timeout");
      if (!this.reader) throw new Error("worker closed");
      const { done, value } = await this.reader.read();
      if (done || !value) throw new Error("worker closed");
      const next = new Uint8Array(this.buf.length + value.length);
      next.set(this.buf);
      next.set(value, this.buf.length);
      this.buf = next;
    }
    const out = this.buf.slice(0, n);
    this.buf = this.buf.slice(n);
    return out;
  }

  /**
   * Send one worker command. Never rejects — worker death returns `{ ok: false }`
   * so View cannot take down the Bun API process (systemd would restart).
   */
  async call(
    msg: Record<string, unknown>,
    timeoutSec = 5,
  ): Promise<Record<string, unknown>> {
    const run = async (): Promise<Record<string, unknown>> => {
      try {
        if (!this.alive) this.start();
        if (!this.stdin || !this.reader) {
          this.lastError = this.lastError || "X11 worker not running";
          return { ok: false, error: this.lastError };
        }
        const body = Buffer.from(JSON.stringify(msg), "utf8");
        const hdr = Buffer.alloc(4);
        hdr.writeUInt32BE(body.length, 0);
        this.stdin.write(hdr);
        this.stdin.write(body);
        try {
          (this.stdin as { flush?: () => void }).flush?.();
        } catch {
          /* ignore */
        }

        const deadline = Date.now() + timeoutSec * 1000;
        const hdrBuf = await this.readExact(4, deadline);
        const n = new DataView(
          hdrBuf.buffer,
          hdrBuf.byteOffset,
          hdrBuf.byteLength,
        ).getUint32(0, false);
        if (n <= 0 || n > 64 * 1024 * 1024) {
          throw new Error(`bad worker size ${n}`);
        }
        const data = await this.readExact(n, deadline);
        const obj = JSON.parse(Buffer.from(data).toString("utf8")) as Record<
          string,
          unknown
        >;
        if (obj.packetEncoding === "base64" && typeof obj.packet === "string") {
          obj.packet = Buffer.from(obj.packet, "base64");
          delete obj.packetEncoding;
        }
        if (!obj.ok) this.lastError = String(obj.error || "X11 error");
        return obj;
      } catch (e) {
        const err = e instanceof Error ? e.message : String(e);
        this.markDead(err);
        return { ok: false, error: err };
      }
    };

    // Keep the chain settled forever so a failed call cannot become an
    // unhandledRejection (Bun exits the process on those in this build).
    const next = this.queueChain.then(run, run);
    this.queueChain = next.then(
      (v) => v,
      (e) => {
        const err = e instanceof Error ? e.message : String(e);
        this.markDead(err);
        return { ok: false, error: err };
      },
    );
    return this.queueChain;
  }
}

type FileSink = {
  write: (data: Buffer | Uint8Array | string) => number;
  flush?: () => void;
  end?: () => void;
};

class ViewHub {
  private clients = new Map<number, ClientState>();
  private bridge = new X11Bridge();
  private loop: ReturnType<typeof setTimeout> | null = null;
  private seq = 0;
  private stats = { fps: 0, kbps: 0, clients: 0 };
  private bytesWindow = 0;
  private lastCursorX = Number.NaN;
  private lastCursorY = Number.NaN;
  private framesWindow = 0;
  private windowT0 = Date.now();
  private nextId = 1;
  private slowGrabs = 0;
  private failGrabs = 0;
  /** Highest tier currently allowed (0=ultra … 3=low). Raised only by user config. */
  private maxAllowedTier = 0;
  /** While Home Base is driving the pointer, suppress native-cursor echo that fights it. */
  private remoteControlUntil = 0;
  /** Last Home Base abs target (monitor-local px/py + monitor). Re-parked while owning. */
  private lastRemotePx = Number.NaN;
  private lastRemotePy = Number.NaN;
  private lastRemoteMonitor = 0;

  status(): Record<string, unknown> {
    const { display, xauthority } = discoverX11Env();
    const { uid, gid } = displayOwnerIds(display);
    let ok = false;
    let err = "";
    let sw = 0;
    let sh = 0;
    const streaming = this.clients.size > 0;
    try {
      // sync-ish via Bun - use deasync pattern with spawnSync ping too heavy;
      // status uses cached bridge fields + best-effort
      this.bridge.start();
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
    }
    return {
      ok,
      display,
      xauthority: Boolean(xauthority && existsSync(xauthority)),
      screenW: this.bridge.screenW || sw,
      screenH: this.bridge.screenH || sh,
      monitors: this.bridge.monitors,
      viewUid: uid,
      viewGid: gid,
      error: err || (streaming ? null : "Connect to start capture"),
      ...this.stats,
      clients: this.clients.size,
      worker: "bun-x11-ffi",
    };
  }

  async statusAsync(): Promise<Record<string, unknown>> {
    const { display, xauthority } = discoverX11Env();
    const { uid, gid } = displayOwnerIds(display);
    let ok = false;
    let err = "";
    let sw = 0;
    let sh = 0;
    const streaming = this.clients.size > 0;
    try {
      this.bridge.start();
      const resp = await this.bridge.call({ cmd: "ping" }, 4);
      ok = Boolean(resp.ok);
      sw = Number(resp.screenW || 0);
      sh = Number(resp.screenH || 0);
      err = ok ? "" : String(resp.error || this.bridge.lastError);
      if (sw) {
        this.bridge.screenW = sw;
        this.bridge.screenH = sh;
      }
      this.bridge.monitors = (resp.monitors as unknown[]) || [];
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
    }
    if (!streaming && this.clients.size === 0) {
      this.bridge.stop();
    }
    return {
      ok,
      display,
      xauthority: Boolean(xauthority && existsSync(xauthority)),
      screenW: sw,
      screenH: sh,
      monitors: this.bridge.monitors,
      viewUid: uid,
      viewGid: gid,
      error: err || null,
      ...this.stats,
      clients: this.clients.size,
      worker: "bun-x11-ffi",
    };
  }

  async connect(ws: ClientState["ws"]): Promise<ClientState> {
    const id = this.nextId++;
    const client: ClientState = {
      ws,
      monitor: 0,
      maxWidth: 1280,
      quality: 55,
      fps: 12,
    };
    this.clients.set(id, client);
    (ws as { __viewId?: number }).__viewId = id;
    this.ensureLoop();
    let cursorX = -1;
    let cursorY = -1;
    try {
      this.bridge.start();
      const resp = await this.bridge.call({ cmd: "ping" });
      if (resp.ok) {
        this.bridge.screenW = Number(resp.screenW || 0);
        this.bridge.screenH = Number(resp.screenH || 0);
        this.bridge.monitors = (resp.monitors as unknown[]) || [];
        cursorX = Number(resp.cursorX ?? -1);
        cursorY = Number(resp.cursorY ?? -1);
      } else {
        ws.send(
          JSON.stringify({
            type: "error",
            error: resp.error || "Cannot open display",
          }),
        );
      }
    } catch (e) {
      ws.send(
        JSON.stringify({
          type: "error",
          error: e instanceof Error ? e.message : String(e),
        }),
      );
    }
    ws.send(
      JSON.stringify({
        type: "hello",
        screenW: this.bridge.screenW,
        screenH: this.bridge.screenH,
        monitors: this.bridge.monitors,
        monitor: client.monitor,
        cursorX,
        cursorY,
        maxWidth: client.maxWidth,
        quality: client.quality,
        fps: client.fps,
        display: discoverX11Env().display,
        viewUid: this.bridge.uid,
      }),
    );
    viewClientConnected();
    return client;
  }

  async disconnect(ws: ClientState["ws"]): Promise<void> {
    const id = (ws as { __viewId?: number }).__viewId;
    if (id != null) this.clients.delete(id);
    try {
      await this.bridge.call(
        { cmd: "pointer", mode: "rel", action: "up", button: 0 },
        1,
      );
    } catch {
      /* ignore */
    }
    if (this.clients.size === 0) {
      if (this.loop) {
        clearTimeout(this.loop);
        this.loop = null;
      }
      this.bridge.stop();
    }
    viewClientDisconnected();
  }

  async handleMessage(
    ws: ClientState["ws"],
    msg: Record<string, unknown>,
  ): Promise<void> {
    try {
      const id = (ws as { __viewId?: number }).__viewId;
      const client = id != null ? this.clients.get(id) : undefined;
      if (!client) return;
      if (msg.type === "config") {
        if (msg.monitor != null) client.monitor = Number(msg.monitor);
        if (msg.maxWidth != null) {
          const w = Number(msg.maxWidth);
          if (Number.isFinite(w)) {
            client.maxWidth = Math.max(320, Math.min(3840, Math.floor(w)));
          }
        }
        if (msg.quality != null) {
          const q = Number(msg.quality);
          if (Number.isFinite(q)) {
            client.quality = Math.max(20, Math.min(95, Math.floor(q)));
          }
        }
        if (msg.fps != null) {
          const f = Number(msg.fps);
          if (Number.isFinite(f)) {
            client.fps = Math.max(4, Math.min(24, Math.floor(f)));
          }
        }
        // User explicitly picked a tier — allow retry (safety may force down again).
        this.maxAllowedTier = tierFromSettings(client.maxWidth, client.quality);
        this.slowGrabs = 0;
        this.failGrabs = 0;
        // Prefer geometry for the selected monitor — stale bridge.screenW/H from the
        // previous capture makes touch/rel mapping think All-displays is still active.
        const mons = this.bridge.monitors as
          | { index?: number; width?: number; height?: number }[]
          | undefined;
        const monMeta = Array.isArray(mons)
          ? mons.find((m) => Number(m.index) === client.monitor)
          : undefined;
        const screenW = Number(monMeta?.width) || this.bridge.screenW;
        const screenH = Number(monMeta?.height) || this.bridge.screenH;
        if (screenW > 0) this.bridge.screenW = screenW;
        if (screenH > 0) this.bridge.screenH = screenH;
        ws.send(
          JSON.stringify({
            type: "config",
            monitor: client.monitor,
            maxWidth: client.maxWidth,
            quality: client.quality,
            fps: client.fps,
            screenW,
            screenH,
            monitors: this.bridge.monitors,
          }),
        );
        return;
      }
      if (msg.type === "pointer") {
        // Home Base owns the pointer while the viewer is actively moving it.
        this.remoteControlUntil = Date.now() + 900;
        if (msg.mode !== "rel" && msg.px != null && msg.py != null) {
          this.lastRemotePx = Math.round(Number(msg.px));
          this.lastRemotePy = Math.round(Number(msg.py));
          this.lastRemoteMonitor = client.monitor;
        }
        const resp = await this.bridge.call({
          cmd: "pointer",
          mode: msg.mode,
          action: msg.action,
          x: msg.x,
          y: msg.y,
          px: msg.px,
          py: msg.py,
          dx: msg.dx,
          dy: msg.dy,
          button: msg.button,
          deltaY: msg.deltaY,
          monitor: client.monitor,
        });
        // Echo as remote-owned so clients don't treat it as a native laptop move.
        this.broadcastCursor(resp, false, "remote");
        return;
      }
      if (msg.type === "key") {
        await this.bridge.call({
          cmd: "key",
          action: msg.action,
          key: msg.key,
          code: msg.code,
        });
      }
    } catch (e) {
      appendTrace(
        "warn",
        `view handleMessage: ${e instanceof Error ? e.message : String(e)}`,
        "view",
      );
    }
  }

  private ensureLoop(): void {
    if (this.loop) return;
    const tick = async () => {
      if (this.clients.size === 0) {
        this.loop = null;
        return;
      }
      try {
        // Use first client's settings (same as typical single-viewer use)
        const first = this.clients.values().next().value as ClientState | undefined;
        if (!first) {
          this.loop = null;
          return;
        }
        const grabT0 = Date.now();
        const resp = await this.bridge.call(
          {
            cmd: "grab",
            maxWidth: first.maxWidth,
            quality: first.quality,
            monitor: first.monitor,
          },
          // Ultra / large desktops need headroom; 5s caused silent black screens.
          12,
        );
        const grabMs = Date.now() - grabT0;
        if (resp.ok) {
          this.failGrabs = 0;
          if (grabMs > 2200) {
            this.slowGrabs += 1;
            if (this.slowGrabs >= 2) {
              this.forceLowerQuality(
                `Capture was too slow (${Math.round(grabMs)}ms) — lowered quality for stability.`,
              );
              this.slowGrabs = 0;
            }
          } else if (grabMs < 900) {
            this.slowGrabs = 0;
          }
          if (resp.monitors) this.bridge.monitors = resp.monitors as unknown[];
          if (resp.sw) this.bridge.screenW = Number(resp.sw);
          if (resp.sh) this.bridge.screenH = Number(resp.sh);
          // While Home Base owns the pointer, keep re-parking X11 on the overlay
          // target so a fighting laptop mouse cannot drift between events.
          if (Date.now() < this.remoteControlUntil) {
            if (Number.isFinite(this.lastRemotePx) && Number.isFinite(this.lastRemotePy)) {
              const mon =
                (this.bridge.monitors as Array<{
                  index?: number;
                  left?: number;
                  top?: number;
                }>).find((m) => Number(m.index) === Number(this.lastRemoteMonitor)) ||
                (this.bridge.monitors as Array<{
                  index?: number;
                  left?: number;
                  top?: number;
                }>).find((m) => Number(m.index) === 0);
              const left = Number(mon?.left) || 0;
              const top = Number(mon?.top) || 0;
              const wantX = left + this.lastRemotePx;
              const wantY = top + this.lastRemotePy;
              const curX = Number(resp.cursorX);
              const curY = Number(resp.cursorY);
              if (
                !Number.isFinite(curX) ||
                !Number.isFinite(curY) ||
                Math.abs(curX - wantX) >= 1 ||
                Math.abs(curY - wantY) >= 1
              ) {
                void this.bridge.call({
                  cmd: "pointer",
                  mode: "abs",
                  action: "move",
                  px: this.lastRemotePx,
                  py: this.lastRemotePy,
                  monitor: this.lastRemoteMonitor,
                });
              }
            }
          } else {
            // Native laptop mouse sync — only when Home Base is idle.
            this.broadcastCursor(resp, true, "native");
          }
        }
        if (resp.ok && resp.changed && resp.packet) {
          const raw = resp.packet;
          const packet = Buffer.isBuffer(raw)
            ? Buffer.from(raw)
            : typeof raw === "string"
              ? Buffer.from(raw, "base64")
              : Buffer.from(raw as Uint8Array);
          if (packet.length < 20) {
            appendTrace("warn", `view grab: short packet ${packet.length}`, "view");
          } else {
            this.seq = (this.seq + 1) >>> 0;
            // patch seq at offset 4 (little-endian u32 after magic)
            packet.writeUInt32LE(this.seq, 4);
            this.bytesWindow += packet.length;
            this.framesWindow += 1;
            for (const c of this.clients.values()) {
              try {
                c.ws.send(packet);
              } catch {
                /* ignore */
              }
            }
          }
        } else if (!resp.ok) {
          const err = String(resp.error || this.bridge.lastError);
          appendTrace("warn", `view grab failed: ${err}`, "view");
          this.failGrabs += 1;
          const timedOut = /timeout/i.test(err);
          if (this.failGrabs >= (timedOut ? 1 : 2)) {
            this.forceLowerQuality(
              timedOut
                ? "Capture timed out — lowered quality so View can keep streaming."
                : `Capture failed (${err.slice(0, 80)}) — lowered quality for stability.`,
            );
            this.failGrabs = 0;
          }
          for (const c of this.clients.values()) {
            try {
              c.ws.send(JSON.stringify({ type: "error", error: err }));
            } catch {
              /* ignore */
            }
          }
        }
      } catch (e) {
        appendTrace(
          "warn",
          `view grab: ${e instanceof Error ? e.message : String(e)}`,
          "view",
        );
      }
      const now = Date.now();
      if (now - this.windowT0 >= 1000) {
        this.stats = {
          fps: this.framesWindow,
          kbps: Math.round((this.bytesWindow * 8) / 1000),
          clients: this.clients.size,
        };
        this.framesWindow = 0;
        this.bytesWindow = 0;
        this.windowT0 = now;
      }
      const first = this.clients.values().next().value as ClientState | undefined;
      const fps = Math.max(4, Math.min(24, first?.fps || 12));
      this.loop = setTimeout(() => void tick(), Math.floor(1000 / fps));
    };
    void tick();
  }

  /**
   * Push real root-pointer coords.
   * source=native → laptop mouse (only when remote is idle)
   * source=remote → echo after Home Base input (optional; clients may ignore)
   */
  private broadcastCursor(
    resp: Record<string, unknown>,
    onlyIfMoved = false,
    source: "native" | "remote" = "native",
  ): void {
    const cx = Number(resp.cursorX);
    const cy = Number(resp.cursorY);
    if (!Number.isFinite(cx) || !Number.isFinite(cy) || cx < 0 || cy < 0) return;
    if (
      onlyIfMoved &&
      Math.abs(cx - this.lastCursorX) < 0.5 &&
      Math.abs(cy - this.lastCursorY) < 0.5
    ) {
      return;
    }
    this.lastCursorX = cx;
    this.lastCursorY = cy;
    const payload = JSON.stringify({
      type: "cursor",
      cursorX: cx,
      cursorY: cy,
      source,
    });
    for (const c of this.clients.values()) {
      try {
        c.ws.send(payload);
      } catch {
        /* ignore */
      }
    }
  }

  private forceLowerQuality(reason: string): void {
    const first = this.clients.values().next().value as ClientState | undefined;
    if (!first) return;
    const cur = tierFromSettings(first.maxWidth, first.quality);
    if (cur >= 3) return;
    this.applyForcedTier(cur + 1, reason);
  }

  private applyForcedTier(tier: number, reason: string): void {
    const t = QUALITY_LADDER[Math.min(3, Math.max(0, tier))]!;
    const prev = this.clients.values().next().value as ClientState | undefined;
    const from =
      prev != null
        ? QUALITY_LADDER[tierFromSettings(prev.maxWidth, prev.quality)]!.preset
        : "?";
    if (from === t.preset) return;
    this.maxAllowedTier = tier;
    for (const c of this.clients.values()) {
      c.maxWidth = t.maxWidth;
      c.quality = t.quality;
      c.fps = t.fps;
    }
    appendTrace(
      "warn",
      `view quality forced ${from} → ${t.preset}: ${reason}`,
      "view",
    );
    const payload = JSON.stringify({
      type: "quality-forced",
      from,
      preset: t.preset,
      maxWidth: t.maxWidth,
      quality: t.quality,
      fps: t.fps,
      reason,
    });
    for (const c of this.clients.values()) {
      try {
        c.ws.send(payload);
      } catch {
        /* ignore */
      }
    }
  }
}

export const viewHub = new ViewHub();

let clients = 0;
export function viewClientConnected(): void {
  clients++;
}
export function viewClientDisconnected(): void {
  clients = Math.max(0, clients - 1);
}

export function viewStatus(): Record<string, unknown> {
  return viewHub.status();
}

export async function viewStatusAsync(): Promise<Record<string, unknown>> {
  return viewHub.statusAsync();
}

/** Spawn argv for the seat-user capture worker (Bun entry or compiled binary). */
export function resolveViewWorkerCmd(): string[] {
  const exec = process.execPath;
  const base = basename(exec).toLowerCase();
  const isBun = base === "bun" || base.startsWith("bun-");
  if (isBun) {
    const entry = join(import.meta.dir, "entry.ts");
    return [exec, "run", entry, "--view-worker"];
  }
  return [exec, "--view-worker"];
}

void MSG_HDR;
