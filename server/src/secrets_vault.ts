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

export function setCursorApiKey(apiKey: string): { configured: boolean } {
  const trimmed = apiKey.trim();
  if (!trimmed) throw new Error("apiKey required");
  writePrivate(CURSOR_KEY_PATH, encryptSecret(trimmed));
  process.env.CURSOR_API_KEY = trimmed;
  return { configured: true };
}

export function clearCursorApiKey(): { configured: boolean } {
  try {
    if (existsSync(CURSOR_KEY_PATH)) unlinkSync(CURSOR_KEY_PATH);
  } catch {
    /* ignore */
  }
  delete process.env.CURSOR_API_KEY;
  return { configured: false };
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
