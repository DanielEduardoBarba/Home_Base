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

const PASS_PATH = join(RUNTIME_DIR, "sudo_askpass.pass");
const META_PATH = join(RUNTIME_DIR, "sudo_askpass.meta");
const ASKPASS_PATH = join(RUNTIME_DIR, "sudo-askpass");
const DEFAULT_TTL = 600;

type Meta = { expiresAt: number };

function loadMeta(): Meta | null {
  if (!existsSync(META_PATH)) return null;
  try {
    return JSON.parse(readFileSync(META_PATH, "utf8")) as Meta;
  } catch {
    return null;
  }
}

function purgeIfExpired(): void {
  const meta = loadMeta();
  if (!meta) return;
  if (Date.now() / 1000 >= meta.expiresAt) clearSudo();
}

export function sudoStatus(): Record<string, unknown> {
  purgeIfExpired();
  const meta = loadMeta();
  const cached = Boolean(meta && existsSync(PASS_PATH));
  const expiresAt = meta?.expiresAt || 0;
  const ttlSec = cached
    ? Math.max(0, Math.floor(expiresAt - Date.now() / 1000))
    : 0;
  return {
    cached,
    expiresAt: cached ? expiresAt : null,
    ttlSec,
    askpassWaiting: false,
  };
}

export function setSudo(
  password: string,
  ttlSec = DEFAULT_TTL,
): Record<string, unknown> {
  ensureRuntimeDirs();
  mkdirSync(RUNTIME_DIR, { recursive: true });
  writeFileSync(PASS_PATH, password, { mode: 0o600 });
  chmodSync(PASS_PATH, 0o600);
  const expiresAt = Date.now() / 1000 + Math.max(30, ttlSec);
  writeFileSync(META_PATH, JSON.stringify({ expiresAt }), { mode: 0o600 });
  chmodSync(META_PATH, 0o600);
  const script = `#!/bin/sh\ncat ${JSON.stringify(PASS_PATH)}\n`;
  writeFileSync(ASKPASS_PATH, script, { mode: 0o700 });
  chmodSync(ASKPASS_PATH, 0o700);
  return sudoStatus();
}

export function clearSudo(): { ok: boolean } {
  for (const p of [PASS_PATH, META_PATH, ASKPASS_PATH]) {
    try {
      if (existsSync(p)) unlinkSync(p);
    } catch {
      /* ignore */
    }
  }
  return { ok: true };
}

export function askpassPath(): string {
  return ASKPASS_PATH;
}
