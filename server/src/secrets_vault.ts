/**
 * AES-256-GCM secrets at rest under .runtime/ (mode 0600).
 * Used for Cursor API key and optional Cloudflare tokens.
 */
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { RUNTIME_DIR, ensureRuntimeDirs } from "./config";

const KEY_PATH = join(RUNTIME_DIR, "secrets_vault.key");
const CURSOR_KEY_PATH = join(RUNTIME_DIR, "cursor_api_key.enc");
/** Non-secret display placeholder only (first/last 4). Never store the full key here. */
const CURSOR_HINT_PATH = join(RUNTIME_DIR, "cursor_api_key.hint");

/** Min length before first/last 4 are safe (shorter secrets would be fully revealed). */
const HINT_MIN_LEN = 12;
const HINT_BULLETS = "••••";
const HINT_OPAQUE = "••••••••";

/**
 * Client-safe placeholder: first 4 + bullets + last 4.
 * Never returns the full secret. Short secrets get opaque bullets only.
 */
export function secretDisplayHint(plain: string): string {
  const s = plain.trim();
  if (!s) return HINT_OPAQUE;
  if (s.length < HINT_MIN_LEN) return HINT_OPAQUE;
  return `${s.slice(0, 4)}${HINT_BULLETS}${s.slice(-4)}`;
}

/** Reject anything that could be a full secret written to the hint file by mistake. */
export function isValidSecretHint(hint: string): boolean {
  const h = hint.trim();
  if (h === HINT_OPAQUE) return true;
  if (h.length > 4 + HINT_BULLETS.length + 4) return false;
  const mid = h.indexOf(HINT_BULLETS);
  if (mid < 1 || mid > 4) return false;
  const suffix = h.slice(mid + HINT_BULLETS.length);
  return suffix.length >= 1 && suffix.length <= 4;
}

function writeHintFile(path: string, plain: string): string {
  const hint = secretDisplayHint(plain);
  writePrivate(path, hint);
  return hint;
}

function readHintFile(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    const hint = readFileSync(path, "utf8").trim();
    return isValidSecretHint(hint) ? hint : null;
  } catch {
    return null;
  }
}

function clearHintFile(path: string): void {
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {
    /* ignore */
  }
}

function vaultKey(): Buffer {
  ensureRuntimeDirs();
  mkdirSync(RUNTIME_DIR, { recursive: true });
  if (existsSync(KEY_PATH)) {
    const raw = readFileSync(KEY_PATH);
    if (raw.length >= 32) return raw.subarray(0, 32);
  }
  const key = randomBytes(32);
  writeFileSync(KEY_PATH, key, { mode: 0o600 });
  try {
    chmodSync(KEY_PATH, 0o600);
  } catch {
    /* ignore */
  }
  return key;
}

export function encryptSecret(plain: string): string {
  const key = vaultKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({
    v: 1,
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ct: ct.toString("base64"),
  });
}

export function decryptSecret(blob: string): string | null {
  try {
    const o = JSON.parse(blob) as {
      v?: number;
      iv?: string;
      tag?: string;
      ct?: string;
    };
    if (o.v !== 1 || !o.iv || !o.tag || !o.ct) return null;
    const key = vaultKey();
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(o.iv, "base64"),
    );
    decipher.setAuthTag(Buffer.from(o.tag, "base64"));
    const pt = Buffer.concat([
      decipher.update(Buffer.from(o.ct, "base64")),
      decipher.final(),
    ]);
    return pt.toString("utf8");
  } catch {
    return null;
  }
}

function writePrivate(path: string, body: string): void {
  ensureRuntimeDirs();
  writeFileSync(path, body, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    /* ignore */
  }
}

export function cursorApiKeyConfigured(): boolean {
  if ((process.env.CURSOR_API_KEY || "").trim()) return true;
  return existsSync(CURSOR_KEY_PATH);
}

export function loadCursorApiKey(): string {
  const fromEnv = (process.env.CURSOR_API_KEY || "").trim();
  if (fromEnv) return fromEnv;
  if (!existsSync(CURSOR_KEY_PATH)) return "";
  try {
    const blob = readFileSync(CURSOR_KEY_PATH, "utf8");
    return (decryptSecret(blob) || "").trim();
  } catch {
    return "";
  }
}

/** Decrypt vault into process.env if env is empty. Call once at boot. */
export function hydrateCursorApiKeyFromVault(): void {
  if ((process.env.CURSOR_API_KEY || "").trim()) return;
  const key = loadCursorApiKey();
  if (key) process.env.CURSOR_API_KEY = key;
}

export type CursorCredentialsMeta = {
  configured: boolean;
  /** Client-safe first/last-4 placeholder; never the full key. */
  hint: string | null;
};

/**
 * Metadata for Settings UI. Decrypts only when migrating a pre-hint vault entry;
 * never returns the plaintext key.
 */
export function getCursorCredentialsMeta(): CursorCredentialsMeta {
  const configured = cursorApiKeyConfigured();
  if (!configured) return { configured: false, hint: null };

  const stored = readHintFile(CURSOR_HINT_PATH);
  if (stored) return { configured: true, hint: stored };

  // One-time migration: derive hint server-side, persist, discard plaintext.
  const plain = loadCursorApiKey();
  if (!plain) return { configured: true, hint: null };
  const hint = writeHintFile(CURSOR_HINT_PATH, plain);
  return { configured: true, hint };
}

export function setCursorApiKey(apiKey: string): CursorCredentialsMeta {
  const trimmed = apiKey.trim();
  if (!trimmed) throw new Error("apiKey required");
  writePrivate(CURSOR_KEY_PATH, encryptSecret(trimmed));
  const hint = writeHintFile(CURSOR_HINT_PATH, trimmed);
  process.env.CURSOR_API_KEY = trimmed;
  return { configured: true, hint };
}

export function clearCursorApiKey(): CursorCredentialsMeta {
  try {
    if (existsSync(CURSOR_KEY_PATH)) unlinkSync(CURSOR_KEY_PATH);
  } catch {
    /* ignore */
  }
  clearHintFile(CURSOR_HINT_PATH);
  delete process.env.CURSOR_API_KEY;
  return { configured: false, hint: null };
}

export function encryptToFile(path: string, plain: string): void {
  writePrivate(path, encryptSecret(plain));
}

export function decryptFromFile(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    return decryptSecret(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}
