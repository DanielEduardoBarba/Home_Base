/**
 * Bun FFI bindings for X11 capture (XGetImage) + XTest input.
 * Runs inside the seat-user view worker (not the root API process).
 */
import { dlopen, ptr, read, toArrayBuffer, type Pointer } from "bun:ffi";

const ZPixmap = 2;
const AllPlanes = 0xffffffffn;

type LibX11 = {
  XOpenDisplay: (name: Pointer | null) => Pointer | null;
  XCloseDisplay: (dpy: Pointer) => number;
  XDefaultScreen: (dpy: Pointer) => number;
  XDisplayWidth: (dpy: Pointer, screen: number) => number;
  XDisplayHeight: (dpy: Pointer, screen: number) => number;
  XDefaultRootWindow: (dpy: Pointer) => bigint;
  XGetImage: (
    dpy: Pointer,
    drawable: bigint,
    x: number,
    y: number,
    w: number,
    h: number,
    planeMask: bigint,
    format: number,
  ) => Pointer | null;
  XDestroyImage: (img: Pointer) => number;
  XFlush: (dpy: Pointer) => number;
  XStringToKeysym: (name: Pointer) => bigint;
  XKeysymToKeycode: (dpy: Pointer, keysym: bigint) => number;
  XQueryPointer: (
    dpy: Pointer,
    w: bigint,
    rootRet: Pointer,
    childRet: Pointer,
    rootX: Pointer,
    rootY: Pointer,
    winX: Pointer,
    winY: Pointer,
    mask: Pointer,
  ) => number;
  XFree: (ptr: Pointer) => number;
};

type LibXtst = {
  XTestFakeMotionEvent: (
    dpy: Pointer,
    screen: number,
    x: number,
    y: number,
    delay: bigint,
  ) => number;
  XTestFakeRelativeMotionEvent: (
    dpy: Pointer,
    dx: number,
    dy: number,
    delay: bigint,
  ) => number;
  XTestFakeButtonEvent: (
    dpy: Pointer,
    button: number,
    isPress: number,
    delay: bigint,
  ) => number;
  XTestFakeKeyEvent: (
    dpy: Pointer,
    keycode: number,
    isPress: number,
    delay: bigint,
  ) => number;
};

type LibXinerama = {
  XineramaIsActive: (dpy: Pointer) => number;
  XineramaQueryScreens: (dpy: Pointer, number: Pointer) => Pointer | null;
};

export type MonitorInfo = {
  index: number;
  label: string;
  left: number;
  top: number;
  width: number;
  height: number;
};

export type GrabPixels = {
  width: number;
  height: number;
  /** RGBA (4 bytes/pixel) for jpeg-js encode */
  rgba: Buffer;
  screenW: number;
  screenH: number;
};

let x11: LibX11 | null = null;
let xtst: LibXtst | null = null;
let xinerama: LibXinerama | null = null;

function loadLibs(): void {
  if (x11) return;
  const x = dlopen("libX11.so.6", {
    XOpenDisplay: { args: ["ptr"], returns: "ptr" },
    XCloseDisplay: { args: ["ptr"], returns: "i32" },
    XDefaultScreen: { args: ["ptr"], returns: "i32" },
    XDisplayWidth: { args: ["ptr", "i32"], returns: "i32" },
    XDisplayHeight: { args: ["ptr", "i32"], returns: "i32" },
    XDefaultRootWindow: { args: ["ptr"], returns: "u64" },
    XGetImage: {
      args: ["ptr", "u64", "i32", "i32", "u32", "u32", "u64", "i32"],
      returns: "ptr",
    },
    XDestroyImage: { args: ["ptr"], returns: "i32" },
    XFlush: { args: ["ptr"], returns: "i32" },
    XStringToKeysym: { args: ["ptr"], returns: "u64" },
    XKeysymToKeycode: { args: ["ptr", "u64"], returns: "i32" },
    XQueryPointer: {
      args: ["ptr", "u64", "ptr", "ptr", "ptr", "ptr", "ptr", "ptr", "ptr"],
      returns: "i32",
    },
    XFree: { args: ["ptr"], returns: "i32" },
  }).symbols as unknown as LibX11;
  const t = dlopen("libXtst.so.6", {
    XTestFakeMotionEvent: {
      args: ["ptr", "i32", "i32", "i32", "u64"],
      returns: "i32",
    },
    XTestFakeRelativeMotionEvent: {
      args: ["ptr", "i32", "i32", "u64"],
      returns: "i32",
    },
    XTestFakeButtonEvent: {
      args: ["ptr", "u32", "i32", "u64"],
      returns: "i32",
    },
    XTestFakeKeyEvent: { args: ["ptr", "u32", "i32", "u64"], returns: "i32" },
  }).symbols as unknown as LibXtst;
  x11 = x;
  xtst = t;
  try {
    xinerama = dlopen("libXinerama.so.1", {
      XineramaIsActive: { args: ["ptr"], returns: "i32" },
      XineramaQueryScreens: { args: ["ptr", "ptr"], returns: "ptr" },
    }).symbols as unknown as LibXinerama;
  } catch {
    xinerama = null;
  }
}

/** XImage field offsets (x86_64 Linux libX11). */
const XI = {
  width: 0,
  height: 4,
  data: 16,
  depth: 40,
  bytes_per_line: 44,
  bits_per_pixel: 48,
} as const;

const KEY_CODE_MAP: Record<string, string> = {
  Enter: "Return",
  Escape: "Escape",
  Backspace: "BackSpace",
  Tab: "Tab",
  Space: "space",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  ArrowUp: "Up",
  ArrowDown: "Down",
  Home: "Home",
  End: "End",
  PageUp: "Page_Up",
  PageDown: "Page_Down",
  Delete: "Delete",
  Insert: "Insert",
  ShiftLeft: "Shift_L",
  ShiftRight: "Shift_R",
  ControlLeft: "Control_L",
  ControlRight: "Control_R",
  AltLeft: "Alt_L",
  AltRight: "Alt_R",
  MetaLeft: "Super_L",
  MetaRight: "Super_R",
  CapsLock: "Caps_Lock",
  Minus: "minus",
  Equal: "equal",
  BracketLeft: "bracketleft",
  BracketRight: "bracketright",
  Backslash: "backslash",
  Semicolon: "semicolon",
  Quote: "apostrophe",
  Backquote: "grave",
  Comma: "comma",
  Period: "period",
  Slash: "slash",
};

export function browserToKeysym(key: string, code: string): string | null {
  if (code in KEY_CODE_MAP) return KEY_CODE_MAP[code]!;
  if (code.startsWith("Key") && code.length === 4) return code.slice(-1).toLowerCase();
  if (code.startsWith("Digit") && code.length === 6) return code.slice(-1);
  if (code.startsWith("Numpad") && /\d$/.test(code)) return `KP_${code.slice(-1)}`;
  if (code.startsWith("F") && /^\d+$/.test(code.slice(1))) return code;
  if (key.length === 1) {
    const ch = key;
    if (/[a-zA-Z]/.test(ch)) return ch.toLowerCase();
    const table: Record<string, string> = {
      " ": "space",
      "-": "minus",
      "=": "equal",
      "[": "bracketleft",
      "]": "bracketright",
      "\\": "backslash",
      ";": "semicolon",
      "'": "apostrophe",
      "`": "grave",
      ",": "comma",
      ".": "period",
      "/": "slash",
    };
    return table[ch] ?? null;
  }
  return null;
}

export function domButtonToX(button: number): number {
  if (button === 1) return 2;
  if (button === 2) return 3;
  return 1;
}

export class X11Session {
  private dpy: Pointer | null = null;
  private screen = 0;
  private root = 0n;
  width = 0;
  height = 0;
  deskLeft = 0;
  deskTop = 0;
  lastError = "";
  private keysymCache = new Map<string, bigint>();

  open(): boolean {
    if (this.dpy) return true;
    try {
      loadLibs();
      const X = x11!;
      const dpy = X.XOpenDisplay(null);
      if (!dpy) {
        this.lastError = `Cannot open X display ${process.env.DISPLAY || "?"}`;
        return false;
      }
      this.dpy = dpy;
      this.screen = X.XDefaultScreen(dpy);
      this.root = X.XDefaultRootWindow(dpy);
      this.width = X.XDisplayWidth(dpy, this.screen);
      this.height = X.XDisplayHeight(dpy, this.screen);
      this.lastError = "";
      return true;
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  close(): void {
    if (this.dpy && x11) {
      try {
        x11.XCloseDisplay(this.dpy);
      } catch {
        /* ignore */
      }
    }
    this.dpy = null;
  }

  refreshSize(): { w: number; h: number } {
    if (!this.dpy && !this.open()) return { w: 0, h: 0 };
    const X = x11!;
    this.width = X.XDisplayWidth(this.dpy!, this.screen);
    this.height = X.XDisplayHeight(this.dpy!, this.screen);
    return { w: this.width, h: this.height };
  }

  monitors(): MonitorInfo[] {
    if (!this.dpy && !this.open()) return [];
    const X = x11!;
    const out: MonitorInfo[] = [];
    let physical: MonitorInfo[] = [];

    if (xinerama && xinerama.XineramaIsActive(this.dpy!)) {
      const nBuf = new Int32Array(1);
      const screens = xinerama.XineramaQueryScreens(this.dpy!, ptr(nBuf));
      const n = nBuf[0] || 0;
      if (screens && n > 0) {
        // XineramaScreenInfo: int + 4 shorts, size 12
        const SIZE = 12;
        for (let i = 0; i < n; i++) {
          const off = i * SIZE;
          const left = read.i16(screens, off + 4);
          const top = read.i16(screens, off + 6);
          const width = read.i16(screens, off + 8);
          const height = read.i16(screens, off + 10);
          if (width > 0 && height > 0) {
            physical.push({
              index: i + 1,
              label: `Display ${i + 1}`,
              left,
              top,
              width,
              height,
            });
          }
        }
        X.XFree(screens);
      }
    }

    if (physical.length === 0) {
      const { w, h } = this.refreshSize();
      if (w > 0 && h > 0) {
        physical = [
          { index: 1, label: "Display 1", left: 0, top: 0, width: w, height: h },
        ];
      }
    }

    if (physical.length === 0) return [];

    let minL = Infinity;
    let minT = Infinity;
    let maxR = -Infinity;
    let maxB = -Infinity;
    for (const m of physical) {
      minL = Math.min(minL, m.left);
      minT = Math.min(minT, m.top);
      maxR = Math.max(maxR, m.left + m.width);
      maxB = Math.max(maxB, m.top + m.height);
    }
    const virt: MonitorInfo = {
      index: 0,
      label: "All displays",
      left: minL,
      top: minT,
      width: maxR - minL,
      height: maxB - minT,
    };
    this.deskLeft = virt.left;
    this.deskTop = virt.top;
    this.width = virt.width;
    this.height = virt.height;
    out.push(virt, ...physical);
    return out;
  }

  monitorRect(index: number): MonitorInfo {
    const mons = this.monitors();
    if (!mons.length) {
      return { index: 0, label: "All displays", left: 0, top: 0, width: 0, height: 0 };
    }
    const m = mons[index] ?? mons[0]!;
    return m;
  }

  grabRgba(monitor: number): GrabPixels {
    if (!this.dpy && !this.open()) {
      throw new Error(this.lastError || "display closed");
    }
    const X = x11!;
    const rect = this.monitorRect(monitor);
    const sw = rect.width;
    const sh = rect.height;
    if (sw <= 0 || sh <= 0) throw new Error("no monitors");

    const img = X.XGetImage(
      this.dpy!,
      this.root,
      rect.left,
      rect.top,
      sw,
      sh,
      AllPlanes,
      ZPixmap,
    );
    if (!img) throw new Error("XGetImage failed");

    try {
      const width = read.i32(img, XI.width);
      const height = read.i32(img, XI.height);
      const dataPtr = read.ptr(img, XI.data);
      const bpl = read.i32(img, XI.bytes_per_line);
      const bpp = read.i32(img, XI.bits_per_pixel);
      if (!dataPtr || width <= 0 || height <= 0) {
        throw new Error("bad XImage");
      }
      const nbytes = bpl * height;
      // Copy before XDestroyImage frees the backing store.
      const raw = Buffer.from(toArrayBuffer(dataPtr, 0, nbytes));
      const rgba = bgrxToRgba(raw, width, height, bpl, bpp);
      return { width, height, rgba, screenW: sw, screenH: sh };
    } finally {
      X.XDestroyImage(img);
    }
  }

  motion(x: number, y: number): void {
    if (!this.dpy && !this.open()) return;
    const left = this.deskLeft;
    const top = this.deskTop;
    const width = this.width;
    const height = this.height;
    let cx = Math.trunc(x);
    let cy = Math.trunc(y);
    if (width > 0 && height > 0) {
      cx = Math.max(left, Math.min(left + width - 1, cx));
      cy = Math.max(top, Math.min(top + height - 1, cy));
    }
    xtst!.XTestFakeMotionEvent(this.dpy!, this.screen, cx, cy, 0n);
    x11!.XFlush(this.dpy!);
  }

  relativeMotion(dx: number, dy: number): void {
    if (!this.dpy && !this.open()) return;
    dx = Math.trunc(dx);
    dy = Math.trunc(dy);
    if (!dx && !dy) return;
    xtst!.XTestFakeRelativeMotionEvent(this.dpy!, dx, dy, 0n);
    x11!.XFlush(this.dpy!);
  }

  queryPointer(): { x: number; y: number } {
    if (!this.dpy && !this.open()) return { x: -1, y: -1 };
    const rootRet = new BigUint64Array(1);
    const childRet = new BigUint64Array(1);
    const rootX = new Int32Array(1);
    const rootY = new Int32Array(1);
    const winX = new Int32Array(1);
    const winY = new Int32Array(1);
    const mask = new Uint32Array(1);
    const ok = x11!.XQueryPointer(
      this.dpy!,
      this.root,
      ptr(rootRet),
      ptr(childRet),
      ptr(rootX),
      ptr(rootY),
      ptr(winX),
      ptr(winY),
      ptr(mask),
    );
    if (!ok) return { x: -1, y: -1 };
    return { x: rootX[0]!, y: rootY[0]! };
  }

  button(button: number, pressed: boolean): void {
    if (!this.dpy && !this.open()) return;
    xtst!.XTestFakeButtonEvent(this.dpy!, button, pressed ? 1 : 0, 0n);
    x11!.XFlush(this.dpy!);
  }

  wheel(deltaY: number): void {
    const steps = Math.max(1, Math.min(8, Math.trunc(Math.abs(deltaY) / 40) || 1));
    const button = deltaY < 0 ? 4 : 5;
    for (let i = 0; i < steps; i++) {
      this.button(button, true);
      this.button(button, false);
    }
  }

  key(key: string, code: string, pressed: boolean): void {
    if (!this.dpy && !this.open()) return;
    const name = browserToKeysym(key, code);
    if (!name) return;
    let sym = this.keysymCache.get(name);
    if (sym == null) {
      const nameBuf = Buffer.from(`${name}\0`, "utf8");
      sym = x11!.XStringToKeysym(ptr(nameBuf));
      this.keysymCache.set(name, sym);
    }
    if (!sym) return;
    const keycode = x11!.XKeysymToKeycode(this.dpy!, sym);
    if (!keycode) return;
    xtst!.XTestFakeKeyEvent(this.dpy!, keycode, pressed ? 1 : 0, 0n);
    x11!.XFlush(this.dpy!);
  }
}

/** Convert X11 ZPixmap BGRX/BGRA rows into tightly packed RGBA for jpeg-js. */
export function bgrxToRgba(
  src: Uint8Array,
  width: number,
  height: number,
  bytesPerLine: number,
  bitsPerPixel: number,
): Buffer {
  const out = Buffer.alloc(width * height * 4);
  const bpp = Math.max(3, Math.floor(bitsPerPixel / 8) || 4);
  let o = 0;
  for (let y = 0; y < height; y++) {
    const row = y * bytesPerLine;
    for (let x = 0; x < width; x++) {
      const i = row + x * bpp;
      out[o++] = src[i + 2]!; // R
      out[o++] = src[i + 1]!; // G
      out[o++] = src[i]!; // B
      out[o++] = 255; // A
    }
  }
  return out;
}

/** Nearest-neighbor resize for tightly packed RGBA. */
export function resizeRgba(
  src: Buffer,
  sw: number,
  sh: number,
  dw: number,
  dh: number,
): Buffer {
  if (sw === dw && sh === dh) return src;
  const out = Buffer.alloc(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(sh - 1, Math.floor((y * sh) / dh));
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(sw - 1, Math.floor((x * sw) / dw));
      const si = (sy * sw + sx) * 4;
      const di = (y * dw + x) * 4;
      out[di] = src[si]!;
      out[di + 1] = src[si + 1]!;
      out[di + 2] = src[si + 2]!;
      out[di + 3] = src[si + 3]!;
    }
  }
  return out;
}

/** @deprecated alias — kept for any residual imports */
export const bgrxToRgb = bgrxToRgba;
export const resizeRgb = resizeRgba;

export const FRAME_MAGIC = 0x48425646;

export function packFrameHeader(
  fw: number,
  fh: number,
  sw: number,
  sh: number,
  quality: number,
): Buffer {
  const b = Buffer.alloc(20);
  b.writeUInt32LE(FRAME_MAGIC, 0);
  b.writeUInt32LE(0, 4);
  b.writeUInt16LE(fw & 0xffff, 8);
  b.writeUInt16LE(fh & 0xffff, 10);
  b.writeUInt16LE(sw & 0xffff, 12);
  b.writeUInt16LE(sh & 0xffff, 14);
  b.writeUInt8(1, 16);
  b.writeUInt8(quality & 0xff, 17);
  b.writeUInt16LE(0, 18);
  return b;
}
