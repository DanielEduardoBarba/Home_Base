/**
 * App PIN — salted SHA-256 in runtime storage. Lock state is server-side so a
 * page refresh cannot bypass the gate while the PIN remains enabled.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { RUNTIME_DIR, ensureRuntimeDirs } from "./config";
import { HttpError } from "./auth";

const APP_PIN_PATH = join(RUNTIME_DIR, "app_pin.json");
const DEFAULT_IDLE_MS = 5 * 60 * 1000;

export type AppPinFile = {
  enabled: boolean;
  salt: string;
  hash: string;
  idleMs: number;
  locked: boolean;
};

function chmodPrivate(path: string): void {
  try {
    chmodSync(path, 0o600);
  } catch {
    /* ignore */
  }
}

function emptyPin(): AppPinFile {
  return {
    enabled: false,
    salt: "",
    hash: "",
    idleMs: DEFAULT_IDLE_MS,
    locked: false,
  };
}

function loadPin(): AppPinFile {
  if (!existsSync(APP_PIN_PATH)) return emptyPin();
  try {
    const raw = JSON.parse(readFileSync(APP_PIN_PATH, "utf8")) as Partial<AppPinFile>;
    const idle = Number(raw.idleMs);
    return {
      enabled: !!raw.enabled && !!raw.salt && !!raw.hash,
      salt: String(raw.salt || ""),
      hash: String(raw.hash || ""),
      idleMs:
        Number.isFinite(idle) && idle >= 60_000
          ? Math.min(idle, 60 * 60_000)
          : DEFAULT_IDLE_MS,
      locked: !!raw.locked && !!raw.enabled && !!raw.salt && !!raw.hash,
    };
  } catch {
    return emptyPin();
  }
}

function savePin(data: AppPinFile): void {
  ensureRuntimeDirs();
  writeFileSync(APP_PIN_PATH, JSON.stringify(data, null, 2));
  chmodPrivate(APP_PIN_PATH);
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function hashPin(saltHex: string, pin: string): string {
  return sha256Hex(`${saltHex}:${pin}`);
}

function safeEqualHex(a: string, b: string): boolean {
  try {
    const ba = Buffer.from(a, "hex");
    const bb = Buffer.from(b, "hex");
    if (ba.length !== bb.length || ba.length === 0) return false;
    return timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

export function appPinStatus(): {
  enabled: boolean;
  locked: boolean;
  idleMs: number;
} {
  const data = loadPin();
  return {
    enabled: data.enabled,
    locked: data.enabled && data.locked,
    idleMs: data.idleMs,
  };
}

export function isAppPinEnabled(): boolean {
  return loadPin().enabled;
}

export function isAppPinLocked(): boolean {
  const data = loadPin();
  return data.enabled && data.locked;
}

export function setAppPinIdleMs(ms: number): { idleMs: number } {
  const data = loadPin();
  data.idleMs = Math.max(60_000, Math.min(Math.floor(ms) || DEFAULT_IDLE_MS, 60 * 60_000));
  savePin(data);
  return { idleMs: data.idleMs };
}

export function lockAppPin(): { locked: boolean } {
  const data = loadPin();
  if (!data.enabled) {
    throw new HttpError(400, { code: "pin_disabled", message: "App PIN is not enabled" });
  }
  data.locked = true;
  savePin(data);
  return { locked: true };
}

export function verifyAppPin(pin: string): boolean {
  if (!/^\d{4}$/.test(pin)) return false;
  const data = loadPin();
  if (!data.enabled || !data.salt || !data.hash) return false;
  return safeEqualHex(hashPin(data.salt, pin), data.hash);
}

export function unlockAppPin(pin: string): { locked: boolean } {
  if (!verifyAppPin(pin)) {
    throw new HttpError(401, { code: "bad_pin", message: "Incorrect PIN" });
  }
  const data = loadPin();
  data.locked = false;
  savePin(data);
  return { locked: false };
}

export function setAppPin(pin: string, currentPin?: string): { enabled: boolean } {
  if (!/^\d{4}$/.test(pin)) {
    throw new HttpError(400, { code: "bad_pin", message: "PIN must be 4 digits" });
  }
  const data = loadPin();
  if (data.enabled) {
    if (!currentPin || !verifyAppPin(currentPin)) {
      throw new HttpError(401, { code: "bad_pin", message: "Current PIN is incorrect" });
    }
  }
  const salt = randomBytes(16).toString("hex");
  savePin({
    enabled: true,
    salt,
    hash: hashPin(salt, pin),
    idleMs: data.idleMs || DEFAULT_IDLE_MS,
    locked: false,
  });
  return { enabled: true };
}

export function clearAppPin(currentPin: string): { enabled: boolean } {
  if (!verifyAppPin(currentPin)) {
    throw new HttpError(401, { code: "bad_pin", message: "Current PIN is incorrect" });
  }
  savePin(emptyPin());
  return { enabled: false };
}

/** One-time migrate from browser-local salt/hash (no plaintext PIN). */
export function importAppPin(opts: {
  salt: string;
  hash: string;
  idleMs?: number;
}): { enabled: boolean; imported: boolean } {
  const data = loadPin();
  if (data.enabled) return { enabled: true, imported: false };
  const salt = String(opts.salt || "").trim();
  const hash = String(opts.hash || "").trim();
  if (!/^[0-9a-f]{32}$/i.test(salt) || !/^[0-9a-f]{64}$/i.test(hash)) {
    throw new HttpError(400, { code: "bad_pin", message: "Invalid PIN material" });
  }
  const idle = Number(opts.idleMs);
  savePin({
    enabled: true,
    salt: salt.toLowerCase(),
    hash: hash.toLowerCase(),
    idleMs:
      Number.isFinite(idle) && idle >= 60_000
        ? Math.min(idle, 60 * 60_000)
        : DEFAULT_IDLE_MS,
    locked: true,
  });
  return { enabled: true, imported: true };
}
