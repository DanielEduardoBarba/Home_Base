/**
 * JWT-gated remote desktop. Capture/input run in the seat-user Python
 * view-worker (mss + XTest) over a JSON length-prefixed IPC so Bun can drive
 * it without pickle. Bun-native capture remains R-002 follow-up.
 */
import { spawn, type Subprocess } from "bun";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { BUNDLE_ROOT } from "./config";
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
  private queueChain: Promise<unknown> = Promise.resolve();

  get alive(): boolean {
    return Boolean(this.proc && !this.proc.killed && this.stdin && this.stdout);
  }

  start(): void {
    if (this.alive) return;
    this.stop();
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

    const venvPy = join(BUNDLE_ROOT, ".venv", "bin", "python");
    const entry = join(BUNDLE_ROOT, "homebase_entry.py");
    const inner = existsSync(venvPy) && existsSync(entry)
      ? [venvPy, entry, "--view-worker"]
      : ["python3", "-c", "import sys; from pathlib import Path; sys.path.insert(0, str(Path('.').resolve() / 'server-py')); from server_py.view import run_view_worker; raise SystemExit(run_view_worker())"];

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
        if (!runuser) throw new Error("setpriv/runuser required for View as root");
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
      HOMEBASE_VIEW_JSON: "1",
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

    appendTrace("info", `view worker started uid=${uid} display=${display}`, "view");
  }

  stop(): void {
    const proc = this.proc;
    this.proc = null;
    this.stdin = null;
    this.stdout = null;
    try {
      this.reader?.cancel();
    } catch {
      /* ignore */
    }
    this.reader = null;
    if (!proc) return;
    try {
      void this.call({ cmd: "stop" }, 1);
    } catch {
      /* ignore */
    }
    try {
      proc.kill();
    } catch {
      /* ignore */
    }
  }

  private async readExact(n: number): Promise<Uint8Array> {
    while (this.buf.length < n) {
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

  async call(
    msg: Record<string, unknown>,
    timeoutSec = 5,
  ): Promise<Record<string, unknown>> {
    const run = async (): Promise<Record<string, unknown>> => {
      if (!this.alive) this.start();
      if (!this.stdin || !this.reader) {
        this.lastError = "X11 worker not running";
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
      const hdrBuf = await Promise.race([
        this.readExact(4),
        sleepReject(Math.max(0, deadline - Date.now()), "X11 worker timeout"),
      ]);
      const n = new DataView(
        hdrBuf.buffer,
        hdrBuf.byteOffset,
        hdrBuf.byteLength,
      ).getUint32(0, false);
      if (n <= 0 || n > 64 * 1024 * 1024) throw new Error(`bad worker size ${n}`);
      const data = await Promise.race([
        this.readExact(n),
        sleepReject(Math.max(0, deadline - Date.now()), "X11 worker timeout"),
      ]);
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
    };

    this.queueChain = this.queueChain.then(run, run);
    return this.queueChain as Promise<Record<string, unknown>>;
  }
}

function sleepReject(ms: number, msg: string): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(msg)), ms);
  });
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
  private framesWindow = 0;
  private windowT0 = Date.now();
  private nextId = 1;

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
      worker: "python-json-bridge",
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
      worker: "python-json-bridge",
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
    const id = (ws as { __viewId?: number }).__viewId;
    const client = id != null ? this.clients.get(id) : undefined;
    if (!client) return;
    if (msg.type === "config") {
      if (msg.monitor != null) client.monitor = Number(msg.monitor);
      if (msg.maxWidth != null) client.maxWidth = Number(msg.maxWidth);
      if (msg.quality != null) client.quality = Number(msg.quality);
      if (msg.fps != null) client.fps = Number(msg.fps);
      ws.send(
        JSON.stringify({
          type: "config",
          monitor: client.monitor,
          maxWidth: client.maxWidth,
          quality: client.quality,
          fps: client.fps,
          screenW: this.bridge.screenW,
          screenH: this.bridge.screenH,
        }),
      );
      return;
    }
    if (msg.type === "pointer") {
      await this.bridge.call({
        cmd: "pointer",
        mode: msg.mode,
        action: msg.action,
        x: msg.x,
        y: msg.y,
        dx: msg.dx,
        dy: msg.dy,
        button: msg.button,
        deltaY: msg.deltaY,
        monitor: client.monitor,
      });
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
        const resp = await this.bridge.call({
          cmd: "grab",
          maxWidth: first.maxWidth,
          quality: first.quality,
          monitor: first.monitor,
        });
        if (resp.ok && resp.changed && resp.packet) {
          const packet = Buffer.from(resp.packet as Buffer | Uint8Array | string);
          this.seq = (this.seq + 1) >>> 0;
          // patch seq at offset 4 (little-endian u32 after magic)
          if (packet.length >= 8) {
            packet.writeUInt32LE(this.seq, 4);
          }
          this.bridge.screenW = Number(resp.sw || this.bridge.screenW);
          this.bridge.screenH = Number(resp.sh || this.bridge.screenH);
          if (resp.monitors) this.bridge.monitors = resp.monitors as unknown[];
          this.bytesWindow += packet.length;
          this.framesWindow += 1;
          for (const c of this.clients.values()) {
            try {
              c.ws.send(packet);
            } catch {
              /* ignore */
            }
          }
        } else if (!resp.ok) {
          const err = String(resp.error || this.bridge.lastError);
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
      const fps = Math.max(4, Math.min(20, first?.fps || 12));
      this.loop = setTimeout(() => void tick(), Math.floor(1000 / fps));
    };
    void tick();
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

void MSG_HDR;
