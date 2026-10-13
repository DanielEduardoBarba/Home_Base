/**
 * Vision — AI desktop control over the same X11 view-worker as View.
 * Linux / X11 (or XWayland) only. Mutating input requires an explicit Arm
 * from a JWT session; Ask mode may screenshot/status only.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { RUNTIME_DIR, ensureRuntimeDirs } from "./config";
import { appendTrace } from "./trace";
import { resolveKeyName } from "./view_x11";
import { viewHub, viewStatusAsync } from "./view";

const VISION_DIR = join(RUNTIME_DIR, "vision");
const DEFAULT_ARM_SEC = 15 * 60;
const MAX_ARM_SEC = 60 * 60;
const MAX_SHOTS = 8;
const HEADER_LEN = 20;

type ArmState = {
  armed: boolean;
  until: number;
  armedAt: number;
};

let arm: ArmState = { armed: false, until: 0, armedAt: 0 };
let armTimer: ReturnType<typeof setTimeout> | null = null;

function ensureVisionDir(): string {
  ensureRuntimeDirs();
  try {
    mkdirSync(VISION_DIR, { recursive: true, mode: 0o700 });
  } catch {
    /* ignore */
  }
  return VISION_DIR;
}

function platformOk(): { ok: boolean; error?: string } {
  if (process.platform !== "linux") {
    return {
      ok: false,
      error:
        "Vision desktop control requires Linux X11/XWayland (not available on this host).",
    };
  }
  return { ok: true };
}

function clearArmTimer(): void {
  if (armTimer) {
    clearTimeout(armTimer);
    armTimer = null;
  }
}

function scheduleArmExpiry(): void {
  clearArmTimer();
  if (!arm.armed || arm.until <= Date.now()) return;
  armTimer = setTimeout(() => {
    armTimer = null;
    void disarmVision("ttl");
  }, arm.until - Date.now() + 50);
}

export function visionArmStatus(): {
  armed: boolean;
  until: number | null;
  remainingSec: number;
  platform: string;
  linux: boolean;
} {
  const now = Date.now();
  if (arm.armed && arm.until <= now) {
    arm = { armed: false, until: 0, armedAt: 0 };
    viewHub.setAgentHold(0);
  }
  const remainingSec =
    arm.armed && arm.until > now ? Math.ceil((arm.until - now) / 1000) : 0;
  return {
    armed: arm.armed && remainingSec > 0,
    until: arm.armed ? arm.until : null,
    remainingSec,
    platform: process.platform,
    linux: process.platform === "linux",
  };
}

export function assertVisionArmed(): void {
  const st = visionArmStatus();
  if (!st.armed) {
    throw new Error(
      "Vision desktop control is disarmed. Arm it in the Vision UI (or POST /api/vision/arm) before pointer/keyboard tools.",
    );
  }
}

export function armVision(ttlSec?: number): Record<string, unknown> {
  const plat = platformOk();
  if (!plat.ok) return { ok: false, error: plat.error, ...visionArmStatus() };
  const sec = Math.max(
    60,
    Math.min(MAX_ARM_SEC, Math.floor(Number(ttlSec) || DEFAULT_ARM_SEC)),
  );
  const now = Date.now();
  arm = { armed: true, until: now + sec * 1000, armedAt: now };
  viewHub.setAgentHold(sec * 1000);
  scheduleArmExpiry();
  appendTrace("info", `vision armed for ${sec}s`, "vision");
  return { ok: true, ...visionArmStatus() };
}

export function disarmVision(reason = "user"): Record<string, unknown> {
  const was = arm.armed;
  arm = { armed: false, until: 0, armedAt: 0 };
  clearArmTimer();
  viewHub.setAgentHold(0);
  if (was) appendTrace("info", `vision disarmed (${reason})`, "vision");
  return { ok: true, ...visionArmStatus() };
}

function pruneShots(dir: string): void {
  try {
    const files = readdirSync(dir)
      .filter((f) => f.startsWith("shot-") && f.endsWith(".jpg"))
      .sort();
    while (files.length > MAX_SHOTS) {
      const old = files.shift();
      if (old) {
        try {
          unlinkSync(join(dir, old));
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    /* ignore */
  }
}

export async function visionStatus(): Promise<Record<string, unknown>> {
  const plat = platformOk();
  const armSt = visionArmStatus();
  if (!plat.ok) {
    return { ok: false, error: plat.error, ...armSt };
  }
  const view = await viewStatusAsync();
  return {
    ...view,
    ...armSt,
    visionDir: VISION_DIR,
    guidance:
      "Prefer Home Base Shell/Files tools for terminals and file edits — do not drive the GNOME Terminal or a GUI editor via the mouse. Use homebase_vision_* for GUI apps and desktop navigation only.",
  };
}

export async function visionScreenshot(opts: {
  monitor?: number;
  maxWidth?: number;
  quality?: number;
} = {}): Promise<Record<string, unknown>> {
  const plat = platformOk();
  if (!plat.ok) return { ok: false, error: plat.error };
  const monitor = Math.max(0, Math.floor(Number(opts.monitor ?? 0)));
  const maxWidth = Math.max(
    320,
    Math.min(1920, Math.floor(Number(opts.maxWidth ?? 1280))),
  );
  const quality = Math.max(
    30,
    Math.min(85, Math.floor(Number(opts.quality ?? 62))),
  );
  const resp = await viewHub.agentCall(
    { cmd: "grab", maxWidth, quality, monitor },
    12,
  );
  if (!resp.ok) {
    return {
      ok: false,
      error: String(resp.error || "screenshot failed"),
      ...visionArmStatus(),
    };
  }
  const raw = resp.packet;
  const packet = Buffer.isBuffer(raw)
    ? Buffer.from(raw)
    : typeof raw === "string"
      ? Buffer.from(raw, "base64")
      : raw
        ? Buffer.from(raw as Uint8Array)
        : Buffer.alloc(0);
  if (packet.length <= HEADER_LEN) {
    return { ok: false, error: "empty frame", ...visionArmStatus() };
  }
  const jpeg = packet.subarray(HEADER_LEN);
  const fw = packet.readUInt16LE(8);
  const fh = packet.readUInt16LE(10);
  const sw = packet.readUInt16LE(12);
  const sh = packet.readUInt16LE(14);
  const dir = ensureVisionDir();
  const stamp = Date.now();
  const path = join(dir, `shot-${stamp}.jpg`);
  const latest = join(dir, "latest.jpg");
  writeFileSync(path, jpeg, { mode: 0o600 });
  try {
    writeFileSync(latest, jpeg, { mode: 0o600 });
  } catch {
    /* ignore */
  }
  pruneShots(dir);
  appendTrace("info", `vision screenshot ${fw}x${fh} → ${path}`, "vision");
  // Refresh agent hold while armed so a look-act loop stays warm.
  if (visionArmStatus().armed) {
    const rem = visionArmStatus().remainingSec;
    if (rem > 0) viewHub.setAgentHold(rem * 1000);
  }
  return {
    ok: true,
    path,
    latest,
    width: fw,
    height: fh,
    screenW: sw,
    screenH: sh,
    monitor,
    bytes: jpeg.length,
    hint: "Read the image at path (or latest) to see the desktop before clicking.",
    ...visionArmStatus(),
  };
}

function parsePoint(args: Record<string, unknown>): {
  x?: number;
  y?: number;
  px?: number;
  py?: number;
  monitor: number;
} {
  const monitor = Math.max(0, Math.floor(Number(args.monitor ?? 0)));
  const out: {
    x?: number;
    y?: number;
    px?: number;
    py?: number;
    monitor: number;
  } = { monitor };
  if (args.px != null && args.py != null) {
    out.px = Math.round(Number(args.px));
    out.py = Math.round(Number(args.py));
  } else if (args.x != null && args.y != null) {
    out.x = Math.min(1, Math.max(0, Number(args.x)));
    out.y = Math.min(1, Math.max(0, Number(args.y)));
  }
  return out;
}

export async function visionPointer(
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  assertVisionArmed();
  const plat = platformOk();
  if (!plat.ok) return { ok: false, error: plat.error };
  const action = String(args.action || "click");
  if (!["move", "down", "up", "click", "wheel"].includes(action)) {
    return { ok: false, error: "action must be move|down|up|click|wheel" };
  }
  const pt = parsePoint(args);
  if (pt.px == null && pt.x == null) {
    return { ok: false, error: "provide x,y (0..1) or px,py (monitor pixels)" };
  }
  const button = Math.max(0, Math.min(2, Math.floor(Number(args.button ?? 0))));
  const resp = await viewHub.agentCall({
    cmd: "pointer",
    mode: "abs",
    action,
    x: pt.x,
    y: pt.y,
    px: pt.px,
    py: pt.py,
    button,
    deltaY: args.deltaY != null ? Number(args.deltaY) : undefined,
    monitor: pt.monitor,
  });
  appendTrace(
    "info",
    `vision pointer ${action} mon=${pt.monitor} ${pt.px != null ? `px=${pt.px},${pt.py}` : `n=${pt.x},${pt.y}`}`,
    "vision",
  );
  return {
    ok: Boolean(resp.ok),
    error: resp.ok ? undefined : String(resp.error || "pointer failed"),
    cursorX: resp.cursorX,
    cursorY: resp.cursorY,
    action,
    ...visionArmStatus(),
  };
}

export async function visionKey(
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  assertVisionArmed();
  const plat = platformOk();
  if (!plat.ok) return { ok: false, error: plat.error };
  const name = String(args.key || args.name || "");
  const resolved = resolveKeyName(name);
  if (!resolved) return { ok: false, error: "key required" };
  const action = String(args.action || "press");
  if (!["down", "up", "press"].includes(action)) {
    return { ok: false, error: "action must be down|up|press" };
  }
  const resp = await viewHub.agentCall({
    cmd: "key",
    action,
    key: resolved.key,
    code: resolved.code,
  });
  appendTrace("info", `vision key ${action} ${resolved.code}`, "vision");
  return {
    ok: Boolean(resp.ok),
    error: resp.ok ? undefined : String(resp.error || "key failed"),
    key: resolved,
    ...visionArmStatus(),
  };
}

export async function visionType(
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  assertVisionArmed();
  const plat = platformOk();
  if (!plat.ok) return { ok: false, error: plat.error };
  const text = String(args.text ?? "");
  if (!text) return { ok: false, error: "text required" };
  if (text.length > 4000) {
    return { ok: false, error: "text too long (max 4000)" };
  }
  const resp = await viewHub.agentCall({ cmd: "type", text }, 30);
  appendTrace("info", `vision type len=${text.length}`, "vision");
  return {
    ok: Boolean(resp.ok),
    error: resp.ok ? undefined : String(resp.error || "type failed"),
    typed: resp.typed,
    skipped: resp.skipped,
    ...visionArmStatus(),
  };
}

export async function visionHotkey(
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  assertVisionArmed();
  const plat = platformOk();
  if (!plat.ok) return { ok: false, error: plat.error };
  const keys = Array.isArray(args.keys)
    ? args.keys.map((k) => String(k))
    : String(args.keys || "")
        .split(/[+\s]+/)
        .map((k) => k.trim())
        .filter(Boolean);
  if (!keys.length) return { ok: false, error: "keys required (e.g. [\"super\",\"a\"])" };
  const resp = await viewHub.agentCall({ cmd: "hotkey", keys });
  appendTrace("info", `vision hotkey ${keys.join("+")}`, "vision");
  return {
    ok: Boolean(resp.ok),
    error: resp.ok ? undefined : String(resp.error || "hotkey failed"),
    keys,
    ...visionArmStatus(),
  };
}

/** True when a screenshot file exists (for health). */
export function visionLatestPath(): string | null {
  const p = join(VISION_DIR, "latest.jpg");
  return existsSync(p) ? p : null;
}
