import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jpeg from "jpeg-js";
import {
  FRAME_MAGIC,
  bgrxToRgba,
  browserToKeysym,
  domButtonToX,
  packFrameHeader,
  resizeRgba,
} from "../../src/view_x11";
import {
  discoverSessionType,
  discoverWaylandEnv,
  pickNewestExisting,
  resolveViewWorkerCmd,
  x11AuthorityKind,
} from "../../src/view";

describe("view_x11 helpers", () => {
  test("browserToKeysym maps common codes", () => {
    expect(browserToKeysym("Enter", "Enter")).toBe("Return");
    expect(browserToKeysym("a", "KeyA")).toBe("a");
    expect(browserToKeysym("1", "Digit1")).toBe("1");
    expect(browserToKeysym("F5", "F5")).toBe("F5");
    expect(browserToKeysym("", "Unknown")).toBeNull();
  });

  test("domButtonToX", () => {
    expect(domButtonToX(0)).toBe(1);
    expect(domButtonToX(1)).toBe(2);
    expect(domButtonToX(2)).toBe(3);
  });

  test("bgrxToRgba + jpeg-js roundtrip keeps colors", () => {
    // 2x1 BGRX: blue pixel, red pixel
    const raw = Uint8Array.from([255, 0, 0, 0, 0, 0, 255, 0]);
    const rgba = bgrxToRgba(raw, 2, 1, 8, 32);
    expect([...rgba]).toEqual([0, 0, 255, 255, 255, 0, 0, 255]);
    const small = resizeRgba(rgba, 2, 1, 1, 1);
    expect(small.length).toBe(4);
    const encoded = jpeg.encode({ data: rgba, width: 2, height: 1 }, 90);
    const decoded = jpeg.decode(encoded.data, { useTArray: true });
    expect(decoded.width).toBe(2);
    expect(decoded.height).toBe(1);
    // blue-ish first pixel, red-ish second (lossy jpeg)
    expect(decoded.data[2]!).toBeGreaterThan(decoded.data[0]!);
    expect(decoded.data[4]!).toBeGreaterThan(decoded.data[6]!);
    const hdr = packFrameHeader(1280, 720, 1920, 1080, 55);
    expect(hdr.length).toBe(20);
    expect(hdr.readUInt32LE(0)).toBe(FRAME_MAGIC);
    expect(hdr.readUInt16LE(8)).toBe(1280);
    expect(hdr.readUInt8(17)).toBe(55);
  });

  test("pickNewestExisting prefers the live cookie over a stale home file", () => {
    const dir = mkdtempSync(join(tmpdir(), "hb-xauth-"));
    try {
      const stale = join(dir, ".Xauthority");
      const live = join(dir, ".mutter-Xwaylandauth.ABC");
      writeFileSync(stale, "old");
      writeFileSync(live, "new");
      const old = new Date("2020-01-01T00:00:00Z");
      const fresh = new Date("2026-11-05T00:00:00Z");
      utimesSync(stale, old, old);
      utimesSync(live, fresh, fresh);
      expect(pickNewestExisting([stale, live, join(dir, "missing")])).toBe(live);
      expect(x11AuthorityKind(live)).toBe("mutter");
      expect(x11AuthorityKind(stale)).toBe("home");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("resolveViewWorkerCmd uses bun run entry", () => {
    const cmd = resolveViewWorkerCmd();
    expect(cmd.length).toBeGreaterThanOrEqual(2);
    expect(cmd.at(-1)).toBe("--view-worker");
  });

  test("discoverSessionType respects XDG_SESSION_TYPE", () => {
    const prev = process.env.XDG_SESSION_TYPE;
    try {
      process.env.XDG_SESSION_TYPE = "wayland";
      expect(discoverSessionType()).toBe("wayland");
      process.env.XDG_SESSION_TYPE = "x11";
      expect(discoverSessionType()).toBe("x11");
    } finally {
      if (prev == null) delete process.env.XDG_SESSION_TYPE;
      else process.env.XDG_SESSION_TYPE = prev;
    }
  });

  test("discoverWaylandEnv defaults runtime dir", () => {
    const prev = process.env.XDG_RUNTIME_DIR;
    try {
      delete process.env.XDG_RUNTIME_DIR;
      delete process.env.WAYLAND_DISPLAY;
      delete process.env.HOMEBASE_WAYLAND_DISPLAY;
      const env = discoverWaylandEnv(1000);
      expect(env.runtimeDir).toBe("/run/user/1000");
    } finally {
      if (prev == null) delete process.env.XDG_RUNTIME_DIR;
      else process.env.XDG_RUNTIME_DIR = prev;
    }
  });
});
