/**
 * Read the Cursor IDE login access token from the seat user's state.vscdb.
 *
 * Older Cursor builds stored a plaintext JWT in `cursorAuth/accessToken`.
 * Current builds wrap it as `cursor-safe-storage:v1:` + Electron safeStorage
 * (Chromium OSCrypt) ciphertext. On Linux that uses the libsecret entry
 * `application=Cursor` / schema `chrome_libsecret_os_crypt_password_v2`
 * (label "Chromium Safe Storage"), or the basic_text "peanuts" password for v10.
 *
 * The token never leaves this process and is never returned to HTTP clients.
 */
import { createDecipheriv, pbkdf2Sync } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { detectSeatUser, wrapArgvForUser, type SeatUser } from "./shell_env";

const SAFE_PREFIX = "cursor-safe-storage:v1:";
const SALT = Buffer.from("saltysalt");
const IV = Buffer.alloc(16, 0x20);
const LINUX_ITERATIONS = 1;
const LINUX_BASIC_PASSWORD = "peanuts";
const OSCRYPT_SCHEMA = "chrome_libsecret_os_crypt_password_v2";
const CACHE_MS = 60_000;

let tokenCache: { fingerprint: string; token: string; at: number } | null = null;

/** Chromium OSCrypt AES-128-CBC decrypt (v10/v11 body including version prefix). */
export function decryptOsCryptAes(blob: Buffer, masterPassword: string): string | null {
  if (blob.length < 4) return null;
  const version = blob.subarray(0, 3).toString("latin1");
  if (version !== "v10" && version !== "v11") return null;
  try {
    const key = pbkdf2Sync(masterPassword, SALT, LINUX_ITERATIONS, 16, "sha1");
    const decipher = createDecipheriv("aes-128-cbc", key, IV);
    const plain = Buffer.concat([decipher.update(blob.subarray(3)), decipher.final()]);
    return plain.toString("utf8");
  } catch {
    return null;
  }
}

/** Decode `cursor-safe-storage:v1:<base64>` → OSCrypt blob, or null. */
export function parseSafeStorageEnvelope(raw: string): Buffer | null {
  const value = raw.trim();
  if (!value.startsWith(SAFE_PREFIX)) return null;
  try {
    const blob = Buffer.from(value.slice(SAFE_PREFIX.length), "base64");
    return blob.length >= 4 ? blob : null;
  } catch {
    return null;
  }
}

export function isJwtAccessToken(value: string): boolean {
  return value.split(".").length >= 3 && !value.startsWith(SAFE_PREFIX);
}

function stateDbPaths(seat: SeatUser): string[] {
  const homes = new Set<string>();
  if (seat.home) homes.add(seat.home);
  if (process.env.HOME) homes.add(process.env.HOME);
  homes.add(homedir());
  return [...homes].map((home) =>
    join(home, ".config", "Cursor", "User", "globalStorage", "state.vscdb"),
  );
}

function readRawAccessToken(seat: SeatUser): string | null {
  for (const path of stateDbPaths(seat)) {
    if (!existsSync(path)) continue;
    try {
      const db = new Database(path, { readonly: true });
      const row = db
        .query("SELECT value FROM ItemTable WHERE key = ?")
        .get("cursorAuth/accessToken") as { value?: string } | null;
      db.close();
      const token = String(row?.value || "").trim();
      if (token) return token;
    } catch {
      /* locked or unreadable */
    }
  }
  return null;
}

/**
 * Read Cursor's OSCrypt master password from the seat user's Secret Service.
 * Prefer secret-tool; fall back to PyGObject (gi.repository.Secret).
 */
function readLinuxOsCryptPassword(seat: SeatUser): string | null {
  const runtime = `/run/user/${seat.uid}`;
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    HOME: seat.home,
    USER: seat.name,
    LOGNAME: seat.name,
    XDG_RUNTIME_DIR: runtime,
    DBUS_SESSION_BUS_ADDRESS:
      process.env.DBUS_SESSION_BUS_ADDRESS || `unix:path=${runtime}/bus`,
  };

  const apps = ["Cursor", "cursor"];

  const secretTool = Bun.which("secret-tool");
  if (secretTool) {
    for (const application of apps) {
      const argv = wrapArgvForUser(seat, [
        secretTool,
        "lookup",
        "xdg:schema",
        OSCRYPT_SCHEMA,
        "application",
        application,
      ]);
      const r = spawnSync(argv[0]!, argv.slice(1), {
        encoding: "utf8",
        env,
        timeout: 5_000,
      });
      const pw = (r.stdout || "").replace(/\n$/, "");
      if (r.status === 0 && pw) return pw;
    }
  }

  // PyGObject is commonly present on GNOME seats even when secret-tool is not.
  const python = Bun.which("python3") || Bun.which("python");
  if (!python) return null;
  const script = [
    "import os, sys",
    "app = os.environ.get('HB_CURSOR_APP', '')",
    "schema = os.environ.get('HB_CURSOR_SCHEMA', '')",
    "try:",
    "  import gi",
    "  gi.require_version('Secret', '1')",
    "  from gi.repository import Secret",
    "except Exception:",
    "  raise SystemExit(0)",
    "try:",
    "  service = Secret.Service.get_sync(",
    "    Secret.ServiceFlags.OPEN_SESSION | Secret.ServiceFlags.LOAD_COLLECTIONS)",
    "  items = Secret.Service.search_sync(",
    "    service,",
    "    Secret.Schema.new(schema, Secret.SchemaFlags.NONE, {",
    "      'application': Secret.SchemaAttributeType.STRING,",
    "    }),",
    "    {'application': app},",
    "    Secret.SearchFlags.UNLOCK | Secret.SearchFlags.LOAD_SECRETS,",
    "  )",
    "  if not items: raise SystemExit(0)",
    "  secret = items[0].get_secret()",
    "  if secret is None: raise SystemExit(0)",
    "  text = secret.get_text()",
    "  if text: sys.stdout.write(text)",
    "except Exception:",
    "  raise SystemExit(0)",
  ].join("\n");

  for (const application of apps) {
    const argv = wrapArgvForUser(seat, [python, "-c", script]);
    const r = spawnSync(argv[0]!, argv.slice(1), {
      encoding: "utf8",
      env: {
        ...env,
        HB_CURSOR_APP: application,
        HB_CURSOR_SCHEMA: OSCRYPT_SCHEMA,
      },
      timeout: 8_000,
    });
    const pw = (r.stdout || "").replace(/\n$/, "");
    if (r.status === 0 && pw) return pw;
  }
  return null;
}

function unlockSafeStorageToken(raw: string, seat: SeatUser): string | null {
  const blob = parseSafeStorageEnvelope(raw);
  if (!blob) return null;
  const version = blob.subarray(0, 3).toString("latin1");

  const keyringPw = process.platform === "linux" ? readLinuxOsCryptPassword(seat) : null;
  if (keyringPw) {
    const plain = decryptOsCryptAes(blob, keyringPw);
    if (plain && isJwtAccessToken(plain)) return plain;
  }

  // basic_text backend (no keyring): v10 + hardcoded "peanuts".
  if (version === "v10") {
    const plain = decryptOsCryptAes(blob, LINUX_BASIC_PASSWORD);
    if (plain && isJwtAccessToken(plain)) return plain;
  }
  return null;
}

export type CursorIdeSessionStatus =
  | { ok: true; token: string }
  | {
      ok: false;
      /** Machine-readable reason for UI copy. */
      reason: "missing" | "encrypted_locked" | "unreadable";
      message: string;
    };

/**
 * Resolve the Cursor IDE session JWT for dashboard Spending calls.
 * Never logs or returns the token outside this module's callers.
 */
export function resolveCursorIdeAccessToken(): CursorIdeSessionStatus {
  const seat = detectSeatUser();
  const raw = readRawAccessToken(seat);
  if (!raw) {
    return {
      ok: false,
      reason: "missing",
      message: "Sign in to Cursor on this laptop.",
    };
  }

  if (isJwtAccessToken(raw)) {
    return { ok: true, token: raw };
  }

  const fingerprint = raw.slice(-24);
  if (
    tokenCache &&
    tokenCache.fingerprint === fingerprint &&
    Date.now() - tokenCache.at < CACHE_MS
  ) {
    return { ok: true, token: tokenCache.token };
  }

  if (raw.startsWith(SAFE_PREFIX)) {
    const token = unlockSafeStorageToken(raw, seat);
    if (token) {
      tokenCache = { fingerprint, token, at: Date.now() };
      return { ok: true, token };
    }
    return {
      ok: false,
      reason: "encrypted_locked",
      message:
        "Cursor login is encrypted on this laptop. Open Cursor once (unlock the login keyring), then refresh Usage.",
    };
  }

  return {
    ok: false,
    reason: "unreadable",
    message: "Cursor login on this laptop could not be read.",
  };
}

/** Clear the short-lived decrypted token cache (tests). */
export function clearCursorIdeSessionCache(): void {
  tokenCache = null;
}
