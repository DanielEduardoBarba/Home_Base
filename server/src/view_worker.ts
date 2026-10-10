/**
 * Seat-user View worker: JSON length-prefixed IPC on stdin/stdout.
 * Capture/input via bun:ffi (libX11 + libXtst) — no Python.
 */
import { createHash } from "node:crypto";
import jpeg from "jpeg-js";
import {
  X11Session,
  domButtonToX,
  packFrameHeader,
  resizeRgba,
  type MonitorInfo,
} from "./view_x11";

const DEFAULT_MAX_WIDTH = 1280;
const DEFAULT_QUALITY = 55;

function send(obj: Record<string, unknown>): void {
  const payload: Record<string, unknown> = { ...obj };
  const pkt = payload.packet;
  if (pkt instanceof Uint8Array || Buffer.isBuffer(pkt)) {
    payload.packet = Buffer.from(pkt).toString("base64");
    payload.packetEncoding = "base64";
  }
  const data = Buffer.from(JSON.stringify(payload), "utf8");
  const hdr = Buffer.alloc(4);
  hdr.writeUInt32BE(data.length, 0);
  const out = Bun.stdout;
  out.write(hdr);
  out.write(data);
}

async function readExact(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  n: number,
  buf: { cur: Uint8Array },
): Promise<Uint8Array> {
  while (buf.cur.length < n) {
    const { done, value } = await reader.read();
    if (done || !value) throw new Error("EOF");
    const next = new Uint8Array(buf.cur.length + value.length);
    next.set(buf.cur);
    next.set(value, buf.cur.length);
    buf.cur = next;
  }
  const out = buf.cur.slice(0, n);
  buf.cur = buf.cur.slice(n);
  return out;
}

async function recv(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  buf: { cur: Uint8Array },
): Promise<Record<string, unknown>> {
  const hdr = await readExact(reader, 4, buf);
  const n = new DataView(hdr.buffer, hdr.byteOffset, hdr.byteLength).getUint32(0, false);
  if (n <= 0 || n > 64 * 1024 * 1024) throw new Error(`bad size ${n}`);
  const data = await readExact(reader, n, buf);
  return JSON.parse(Buffer.from(data).toString("utf8")) as Record<string, unknown>;
}

function grabJpeg(
  xin: X11Session,
  lastHash: Buffer,
  maxWidth: number,
  quality: number,
  monitor: number,
): { packet: Buffer; sw: number; sh: number; changed: boolean; digest: Buffer; monitors: MonitorInfo[] } {
  const shot = xin.grabRgba(monitor);
  let { width, height, rgba } = shot;
  const sw = shot.screenW;
  const sh = shot.screenH;

  // Cap encode size early — full 4K virtual desktop + jpeg-js RGBA is heavy.
  const cap = Math.max(320, Math.min(1920, maxWidth || DEFAULT_MAX_WIDTH));
  if (width > cap) {
    const nh = Math.max(1, Math.floor(height * (cap / width)));
    rgba = resizeRgba(rgba, width, height, cap, nh);
    width = cap;
    height = nh;
  }

  const tw = 48;
  const th = Math.max(1, Math.floor((48 * height) / width));
  const sample = resizeRgba(rgba, width, height, tw, th);
  const digest = createHash("md5").update(sample).digest();
  const monitors = xin.monitors();
  if (digest.equals(lastHash)) {
    return {
      packet: Buffer.alloc(0),
      sw,
      sh,
      changed: false,
      digest: lastHash,
      monitors,
    };
  }

  // jpeg-js encode requires tightly packed RGBA (width*height*4).
  const encoded = jpeg.encode({ data: rgba, width, height }, quality);
  const header = packFrameHeader(width, height, sw, sh, quality);
  return {
    packet: Buffer.concat([header, encoded.data]),
    sw,
    sh,
    changed: true,
    digest,
    monitors,
  };
}

function dispatch(
  msg: Record<string, unknown>,
  xin: X11Session,
  lastHash: { cur: Buffer },
): Record<string, unknown> {
  const cmd = msg.cmd;
  if (cmd === "stop") return { ok: true, stop: true };
  if (cmd === "ping") {
    const ok = xin.open();
    const size = ok ? xin.refreshSize() : { w: 0, h: 0 };
    let monitors: MonitorInfo[] = [];
    try {
      monitors = xin.monitors();
    } catch {
      /* ignore */
    }
    let w = size.w;
    let h = size.h;
    if ((!ok || !w) && monitors[0]) {
      w = monitors[0].width;
      h = monitors[0].height;
    }
    const cursor = ok ? xin.queryPointer() : { x: -1, y: -1 };
    return {
      ok: ok || Boolean(monitors[0]?.width),
      screenW: w,
      screenH: h,
      monitors,
      cursorX: cursor.x,
      cursorY: cursor.y,
      uid: typeof process.getuid === "function" ? process.getuid() : -1,
      error: ok ? "" : xin.lastError,
    };
  }
  if (cmd === "grab") {
    try {
      const result = grabJpeg(
        xin,
        lastHash.cur,
        Number(msg.maxWidth || DEFAULT_MAX_WIDTH),
        Number(msg.quality || DEFAULT_QUALITY),
        Number(msg.monitor || 0),
      );
      lastHash.cur = result.digest;
      return {
        ok: true,
        packet: result.packet,
        sw: result.sw,
        sh: result.sh,
        changed: result.changed,
        monitors: result.monitors,
      };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
  if (cmd === "pointer") {
    try {
      xin.open();
      const mode = String(msg.mode || "abs");
      const action = String(msg.action || "");
      if (mode === "rel" || action === "relmove") {
        const dx = Math.round(Number(msg.dx || 0));
        const dy = Math.round(Number(msg.dy || 0));
        if (
          action === "move" ||
          action === "relmove" ||
          (["down", "up", "wheel"].includes(action) && (dx || dy))
        ) {
          if (dx || dy) xin.relativeMotion(dx, dy);
        }
      } else {
        const rect = xin.monitorRect(Number(msg.monitor || 0));
        let mw = rect.width;
        let mh = rect.height;
        if (mw <= 0 || mh <= 0) {
          const s = xin.refreshSize();
          mw = s.w;
          mh = s.h;
        }
        try {
          const desk = xin.monitorRect(0);
          xin.deskLeft = desk.left;
          xin.deskTop = desk.top;
          if (desk.width) xin.width = desk.width;
          if (desk.height) xin.height = desk.height;
        } catch {
          /* ignore */
        }
        const nx = Number(msg.x || 0);
        const ny = Number(msg.y || 0);
        const x = Math.trunc(rect.left + nx * mw);
        const y = Math.trunc(rect.top + ny * mh);
        if (["move", "down", "up", "wheel"].includes(action)) {
          xin.motion(x, y);
        }
      }
      if (action === "down") xin.button(domButtonToX(Number(msg.button || 0)), true);
      else if (action === "up") xin.button(domButtonToX(Number(msg.button || 0)), false);
      else if (action === "click") {
        const btn = domButtonToX(Number(msg.button || 0));
        xin.button(btn, true);
        xin.button(btn, false);
      } else if (action === "wheel") {
        const dy = Number(msg.deltaY || 0);
        if (dy) xin.wheel(dy);
      }
      const cursor = xin.queryPointer();
      return { ok: true, cursorX: cursor.x, cursorY: cursor.y };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
  if (cmd === "key") {
    try {
      xin.open();
      const action = String(msg.action || "");
      const key = String(msg.key || "");
      const code = String(msg.code || "");
      if (action === "down") xin.key(key, code, true);
      else if (action === "up") xin.key(key, code, false);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
  return { ok: false, error: `unknown cmd ${cmd}` };
}

export async function runViewWorker(): Promise<number> {
  const xin = new X11Session();
  const lastHash = { cur: Buffer.alloc(0) };
  let lastMonitor = 0;

  console.error(
    `view-worker ready uid=${typeof process.getuid === "function" ? process.getuid() : "?"} display=${process.env.DISPLAY} xauth=${process.env.XAUTHORITY} runtime=bun`,
  );

  const stdin = Bun.stdin.stream();
  const reader = stdin.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const buf = { cur: new Uint8Array(0) };

  try {
    for (;;) {
      let msg: Record<string, unknown>;
      try {
        msg = await recv(reader, buf);
      } catch {
        break;
      }
      if (msg.cmd === "grab") {
        const mon = Number(msg.monitor || 0);
        if (mon !== lastMonitor) {
          lastHash.cur = Buffer.alloc(0);
          lastMonitor = mon;
        }
      }
      const resp = dispatch(msg, xin, lastHash);
      const stop = Boolean(resp.stop);
      delete resp.stop;
      send(resp);
      if (stop) break;
    }
    return 0;
  } catch (e) {
    try {
      send({ ok: false, error: `worker crash: ${e instanceof Error ? e.message : String(e)}` });
    } catch {
      console.error(`view-worker crash: ${e}`);
    }
    return 1;
  } finally {
    xin.close();
  }
}

if (import.meta.main) {
  process.exit(await runViewWorker());
}
