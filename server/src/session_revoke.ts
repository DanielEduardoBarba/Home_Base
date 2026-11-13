/**
 * Server-side session revocation. Logout clears the cookie and records the
 * JWT's jti so a captured token cannot be reused until it expires.
 * JTIs are stored hashed; never write the raw JWT here.
 */
import {
  chmodSync,
  existsSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { createHash, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { RUNTIME_DIR, ensureRuntimeDirs } from "./config";

const PATH = () => join(RUNTIME_DIR, "revoked_sessions.json");

type RevokedEntry = { jtiHash: string; exp: number };
type RevokedFile = { entries: RevokedEntry[] };

function chmodPrivate(path: string): void {
  try {
    chmodSync(path, 0o600);
  } catch {
    /* ignore */
  }
}

function hashJti(jti: string): string {
  return createHash("sha256").update(String(jti || ""), "utf8").digest("hex");
}

function load(): RevokedFile {
  if (!existsSync(PATH())) return { entries: [] };
  try {
    const raw = JSON.parse(readFileSync(PATH(), "utf8")) as Partial<RevokedFile>;
    const entries = Array.isArray(raw.entries) ? raw.entries.filter((e) => e && e.jtiHash && e.exp) : [];
    return { entries };
  } catch {
    return { entries: [] };
  }
}

function save(data: RevokedFile): void {
  ensureRuntimeDirs();
  const now = Math.floor(Date.now() / 1000);
  const entries = data.entries.filter((e) => Number(e.exp || 0) > now);
  const tmp = PATH() + ".tmp";
  writeFileSync(tmp, JSON.stringify({ entries }, null, 2) + "\n");
  chmodPrivate(tmp);
  renameSync(tmp, PATH());
  chmodPrivate(PATH());
}

export function revokeSessionJti(jti: string, exp: number): boolean {
  const id = String(jti || "").trim();
  if (!id) return false;
  const until = Number(exp || 0) || 0;
  if (until <= Math.floor(Date.now() / 1000)) return false;
  const file = load();
  const jtiHash = hashJti(id);
  if (file.entries.some((e) => e.jtiHash === jtiHash)) {
    save(file);
    return true;
  }
  file.entries.push({ jtiHash, exp: until });
  save(file);
  return true;
}

export function isSessionRevoked(jti: string): boolean {
  const id = String(jti || "").trim();
  if (!id) return false;
  const file = load();
  const now = Math.floor(Date.now() / 1000);
  let stale = false;
  const want = hashJti(id);
  const wantBuf = Buffer.from(want, "hex");
  let hit = false;
  for (const e of file.entries) {
    if (Number(e.exp || 0) <= now) {
      stale = true;
      continue;
    }
    try {
      const got = Buffer.from(String(e.jtiHash || ""), "hex");
      if (got.length === wantBuf.length && got.length > 0 && timingSafeEqual(got, wantBuf)) {
        hit = true;
      }
    } catch {
      /* ignore bad row */
    }
  }
  if (stale) save(file);
  return hit;
}
