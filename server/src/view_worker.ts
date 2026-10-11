/**
 * Seat-user View worker: JSON length-prefixed IPC on stdin/stdout.
 * Capture/input via bun:ffi (libX11 + libXtst).
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
): {
  packet: Buffer;
  sw: number;
  sh: number;
  changed: boolean;
  digest: Buffer;
  monitors: MonitorInfo[];
  cursorX: number;
  cursorY: number;
} {
  const shot = xin.grabRgba(monitor);
  let { width, height, rgba } = shot;
  const sw = shot.screenW;
  const sh = shot.screenH;
  const cursor = xin.queryPointer();

  // Ultra may ask for native pixels, but jpeg-js encode of huge desktops blocks the
  // worker past the IPC timeout → black screen. Cap width and total megapixels.
  const ABS_MAX_WIDTH = 3840;
  const ABS_MAX_PIXELS = 3840 * 2160;
  let cap = Math.max(
    320,
    Math.min(ABS_MAX_WIDTH, maxWidth > 0 ? maxWidth : DEFAULT_MAX_WIDTH),
  );
  if (width > cap) {
    const nh = Math.max(1, Math.floor(height * (cap / width)));
    rgba = resizeRgba(rgba, width, height, cap, nh);
    width = cap;
    height = nh;
  }
  if (width * height > ABS_MAX_PIXELS) {
    const scale = Math.sqrt(ABS_MAX_PIXELS / (width * height));
    const nw = Math.max(320, Math.floor(width * scale));
    const nh = Math.max(1, Math.floor(height * scale));
    rgba = resizeRgba(rgba, width, height, nw, nh);
    width = nw;
    height = nh;
  }
  // Keep encode snappy on large frames (quality still looks sharp).
  const qEnc = width * height > 1920 * 1080 ? Math.min(quality, 82) : quality;

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
      cursorX: cursor.x,
      cursorY: cursor.y,
    };
  }

  // jpeg-js encode requires tightly packed RGBA (width*height*4).
  const encoded = jpeg.encode({ data: rgba, width, height }, qEnc);
  const header = packFrameHeader(width, height, sw, sh, qEnc);
  return {
    packet: Buffer.concat([header, encoded.data]),
    sw,
    sh,
    changed: true,
    digest,
    monitors,
    cursorX: cursor.x,
    cursorY: cursor.y,
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
        cursorX: result.cursorX,
        cursorY: result.cursorY,
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
        xin.syncDeskBounds();
        // Prefer integer pixels from the client (mapped to the capture/monitor size).
        const hasPx = msg.px != null && msg.py != null && Number.isFinite(Number(msg.px));
        let x: number;
        let y: number;
        if (hasPx) {
          const px = Math.max(0, Math.min(mw - 1, Math.round(Number(msg.px))));
          const py = Math.max(0, Math.min(mh - 1, Math.round(Number(msg.py))));
          x = rect.left + px;
          y = rect.top + py;
        } else {
          const nx = Math.min(1, Math.max(0, Number(msg.x || 0)));
          const ny = Math.min(1, Math.max(0, Number(msg.y || 0)));
          x = Math.round(rect.left + nx * Math.max(0, mw - 1));
          y = Math.round(rect.top + ny * Math.max(0, mh - 1));
        }
        // Always park at the View overlay coords before click/down/wheel so
        // a fighting laptop mouse can't leave X11 elsewhere.
        if (["move", "down", "up", "wheel", "click"].includes(action)) {
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
          try {
            // Relative/touch deltas accumulate from the real cursor — park it in the
            // selected display so D1↔All switches don't keep clicking the old desktop.
            xin.open();
            xin.centerPointer(mon);
          } catch {
            /* ignore */
          }
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
