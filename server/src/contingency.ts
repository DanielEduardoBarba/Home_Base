/**
 * Contingency — human Web GUI only. No MCP tools, no Cursor homebase_* tools.
 * PIN (when enabled) → short-lived ticket → run bash → always attempt reboot.
 * Script is AES-GCM encrypted at rest (same vault as Cursor key / secrets).
 * Editing requires Home Base password + App PIN (when PIN is enabled).
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  existsSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { RUNTIME_DIR, ensureRuntimeDirs } from "./config";
import {
  assertNotLocked,
  FAIL_THRESHOLD,
  HttpError,
  recordFailure,
  remainingAttempts,
  verifyPassword,
  type AuthEventCtx,
} from "./auth";
import { isAppPinEnabled, verifyAppPin } from "./app_pin";
import { logInfo, logWarn } from "./console_log";
import { decryptSecret, encryptSecret } from "./secrets_vault";

const META_PATH = join(RUNTIME_DIR, "contingency.json");
const SCRIPT_ENC_PATH = join(RUNTIME_DIR, "contingency.script.enc");
const DEFAULT_SCRIPT = "echo c > /proc/sysrq-trigger";
const TICKET_TTL_MS = 120_000;
const SCRIPT_MAX = 32_000;

export type ContingencyMeta = {
  updatedAt: number;
};

type Ticket = {
  id: string;
  expiresAt: number;
  used: boolean;
};

let ticket: Ticket | null = null;

function chmodPrivate(path: string): void {
  try {
    chmodSync(path, 0o600);
  } catch {
    /* ignore */
  }
}

function loadMeta(): ContingencyMeta {
  ensureRuntimeDirs();
  if (!existsSync(META_PATH)) return { updatedAt: 0 };
  try {
    const raw = JSON.parse(readFileSync(META_PATH, "utf8")) as Partial<ContingencyMeta> & {
      script?: string;
    };
    // Legacy plaintext migration: contingency.json used to hold `script`.
    if (typeof raw.script === "string" && raw.script.trim() && !existsSync(SCRIPT_ENC_PATH)) {
      const script = raw.script.trim();
      const updatedAt = Number(raw.updatedAt) || Date.now();
      writeEncryptedScript(script);
      saveMeta({ updatedAt });
      return { updatedAt };
    }
    return { updatedAt: Number(raw.updatedAt) || 0 };
  } catch {
    return { updatedAt: 0 };
  }
}

function saveMeta(meta: ContingencyMeta): void {
  ensureRuntimeDirs();
  writeFileSync(META_PATH, JSON.stringify({ updatedAt: meta.updatedAt }, null, 2) + "\n", "utf8");
  chmodPrivate(META_PATH);
}

function writeEncryptedScript(script: string): void {
  ensureRuntimeDirs();
  writeFileSync(SCRIPT_ENC_PATH, encryptSecret(script), { mode: 0o600 });
  chmodPrivate(SCRIPT_ENC_PATH);
}

function readScriptPlain(): string {
  ensureRuntimeDirs();
  // Prefer encrypted vault.
  if (existsSync(SCRIPT_ENC_PATH)) {
    try {
      const blob = readFileSync(SCRIPT_ENC_PATH, "utf8");
      const plain = decryptSecret(blob);
      if (plain != null && plain.trim()) return plain;
    } catch {
      /* fall through */
    }
  }
  // Legacy plaintext in meta (pre-encrypt) — migrate on read.
  if (existsSync(META_PATH)) {
    try {
      const raw = JSON.parse(readFileSync(META_PATH, "utf8")) as { script?: string; updatedAt?: number };
      if (typeof raw.script === "string" && raw.script.trim()) {
        const script = raw.script;
        writeEncryptedScript(script);
        saveMeta({ updatedAt: Number(raw.updatedAt) || Date.now() });
        return script;
      }
    } catch {
      /* ignore */
    }
  }
  return DEFAULT_SCRIPT;
}

export function contingencyDefaultScript(): string {
  return DEFAULT_SCRIPT;
}

export function contingencyStatus(): {
  script: string;
  defaultScript: string;
  isDefault: boolean;
  updatedAt: number;
  pinRequired: boolean;
  encryptedAtRest: boolean;
  ticketActive: boolean;
  ticketExpiresAt: number | null;
} {
  const meta = loadMeta();
  const script = readScriptPlain();
  const pinRequired = isAppPinEnabled();
  const active = Boolean(ticket && !ticket.used && ticket.expiresAt > Date.now());
  return {
    script,
    defaultScript: DEFAULT_SCRIPT,
    isDefault: script.trim() === DEFAULT_SCRIPT || meta.updatedAt === 0,
    updatedAt: meta.updatedAt,
    pinRequired,
    encryptedAtRest: existsSync(SCRIPT_ENC_PATH),
    ticketActive: active,
    ticketExpiresAt: active && ticket ? ticket.expiresAt : null,
  };
}

function authScriptEdit(
  password: string,
  pin: string | undefined,
  ip: string,
  ctx: AuthEventCtx,
): void {
  assertNotLocked(ctx);
  if (!password || !verifyPassword(password)) {
    const info = recordFailure(ip, "invalid_password", {
      userAgent: ctx.userAgent,
      path: ctx.path || "/api/contingency/script",
    });
    throw new HttpError(401, {
      code: "bad_password",
      message: "Incorrect password",
      failCount: info.failCount,
      retryAfter: info.retryAfter,
      remainingAttempts: remainingAttempts(info.failCount),
      threshold: FAIL_THRESHOLD,
    });
  }
  if (isAppPinEnabled()) {
    if (!pin || !verifyAppPin(pin)) {
      const info = recordFailure(ip, "invalid_pin", {
        userAgent: ctx.userAgent,
        path: ctx.path || "/api/contingency/script",
      });
      throw new HttpError(401, {
        code: "bad_pin",
        message: "Incorrect PIN",
        failCount: info.failCount,
        retryAfter: info.retryAfter,
        remainingAttempts: remainingAttempts(info.failCount),
        threshold: FAIL_THRESHOLD,
      });
    }
  }
}

/**
 * Replace Contingency script. Requires Home Base password, and App PIN when enabled.
 * Persists AES-GCM ciphertext under `.runtime/contingency.script.enc`.
 */
export function setContingencyScript(
  script: string,
  creds: { password: string; pin?: string },
  ip = "unknown",
  ctx: AuthEventCtx = {},
): { script: string; updatedAt: number } {
  authScriptEdit(creds.password, creds.pin, ip, ctx);

  const next = String(script ?? "");
  if (next.length > SCRIPT_MAX) {
    throw new HttpError(400, {
      code: "script_too_long",
      message: `Script max ${SCRIPT_MAX} characters`,
    });
  }
  const plain = next.trim() ? next : DEFAULT_SCRIPT;
  const updatedAt = Date.now();
  writeEncryptedScript(plain);
  saveMeta({ updatedAt });
  // Drop any leftover plaintext field from legacy meta.
  try {
    if (existsSync(META_PATH)) {
      const raw = JSON.parse(readFileSync(META_PATH, "utf8")) as Record<string, unknown>;
      if ("script" in raw) {
        saveMeta({ updatedAt });
      }
    }
  } catch {
    /* ignore */
  }
  ticket = null;
  try {
    const { recordSecurityEvent } = require("./security_log") as typeof import("./security_log");
    recordSecurityEvent({
      event: "contingency_script_edit",
      source: "ui",
      result: "success",
      ip,
      userAgent: ctx.userAgent,
      path: ctx.path,
      status: 200,
    });
  } catch {
    /* ignore */
  }
  logInfo("script updated (encrypted at rest)", "contingency");
  return { script: plain, updatedAt };
}

function clearTicket(): void {
  ticket = null;
}

function issueTicket(): { ticket: string; expiresAt: number } {
  const id = randomBytes(24).toString("hex");
  const expiresAt = Date.now() + TICKET_TTL_MS;
  ticket = { id, expiresAt, used: false };
  return { ticket: id, expiresAt };
}

function safeEqualStr(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * Authorize Contingency arm. When App PIN is enabled, `pin` must match.
 * Returns a short-lived single-use ticket for execute.
 */
export function authorizeContingency(
  pin: string | undefined,
  ip = "unknown",
  ctx: AuthEventCtx = {},
): { ticket: string; expiresAt: number; pinRequired: boolean } {
  assertNotLocked(ctx);
  const pinRequired = isAppPinEnabled();
  if (pinRequired) {
    if (!pin || !verifyAppPin(pin)) {
      const info = recordFailure(ip, "invalid_pin", {
        userAgent: ctx.userAgent,
        path: ctx.path || "/api/contingency/authorize",
      });
      throw new HttpError(401, {
        code: "bad_pin",
        message: "Incorrect PIN",
        failCount: info.failCount,
        retryAfter: info.retryAfter,
        remainingAttempts: remainingAttempts(info.failCount),
        threshold: FAIL_THRESHOLD,
      });
    }
  }
  const issued = issueTicket();
  try {
    const { recordSecurityEvent } = require("./security_log") as typeof import("./security_log");
    recordSecurityEvent({
      event: "contingency_authorize",
      source: "ui",
      result: "success",
      ip,
      userAgent: ctx.userAgent,
      path: ctx.path,
      status: 200,
    });
  } catch {
    /* ignore */
  }
  logInfo("authorized (ticket issued)", "contingency");
  return { ...issued, pinRequired };
}

function consumeTicket(presented: string): void {
  if (!ticket || ticket.used || ticket.expiresAt <= Date.now()) {
    clearTicket();
    throw new HttpError(403, {
      code: "contingency_locked",
      message: "Contingency is locked — enter PIN and arm again",
    });
  }
  if (!safeEqualStr(ticket.id, presented)) {
    throw new HttpError(403, {
      code: "contingency_ticket_invalid",
      message: "Invalid contingency ticket",
    });
  }
  ticket.used = true;
}

function buildPayload(userScript: string): string {
  const body = userScript.trim() || DEFAULT_SCRIPT;
  return [
    "#!/bin/bash",
    "# Home Base Contingency — user payload",
    "set +e",
    body,
    "",
    "# Home Base Contingency — mandatory epilogue (reboot if still alive)",
    "sync 2>/dev/null || true",
    "if command -v systemctl >/dev/null 2>&1; then",
    "  systemctl reboot --force --force 2>/dev/null || systemctl reboot -i 2>/dev/null || true",
    "fi",
    "reboot -f 2>/dev/null || reboot 2>/dev/null || true",
    "# Last-resort hard reboot via sysrq if reboot helpers are gone",
    "echo b > /proc/sysrq-trigger 2>/dev/null || true",
    "",
  ].join("\n");
}

/**
 * Fire Contingency. Consumes the ticket. Starts detached bash so the HTTP
 * response can return before the host dies.
 */
export async function executeContingency(
  presentedTicket: string,
  ip = "unknown",
  ctx: AuthEventCtx = {},
): Promise<{ ok: true; started: true; message: string }> {
  consumeTicket(presentedTicket);
  const script = readScriptPlain();
  const payload = buildPayload(script);

  try {
    const { recordSecurityEvent } = require("./security_log") as typeof import("./security_log");
    recordSecurityEvent({
      event: "contingency_execute",
      source: "ui",
      result: "success",
      ip,
      userAgent: ctx.userAgent,
      path: ctx.path,
      status: 200,
    });
  } catch {
    /* ignore */
  }
  try {
    const { recordActivity } = await import("./activity_audit");
    recordActivity({
      source: "auth",
      kind: "contingency_execute",
      summary: "Contingency executed from Web GUI",
      peerIp: ip,
    });
  } catch {
    /* ignore */
  }

  logWarn("EXECUTING — user script + mandatory reboot epilogue", "contingency");

  try {
    const proc = Bun.spawn(["bash", "-lc", payload], {
      cwd: process.env.HOME || "/",
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
      env: { ...process.env, HOMEBASE_CONTINGENCY: "1" },
    });
    try {
      proc.unref();
    } catch {
      /* ignore */
    }
  } catch (err) {
    logWarn(
      `spawn failed: ${err instanceof Error ? err.message : String(err)}`,
      "contingency",
    );
    throw new HttpError(500, {
      code: "contingency_spawn_failed",
      message: "Failed to start contingency script",
    });
  }

  clearTicket();
  return {
    ok: true,
    started: true,
    message: "Contingency started — host should halt or reboot shortly",
  };
}

export function revokeContingencyTicket(): void {
  clearTicket();
}

/** Soft-reset helper: wipe Contingency script vault (optional). */
export function clearContingencyScript(): void {
  for (const p of [SCRIPT_ENC_PATH, META_PATH]) {
    try {
      if (existsSync(p)) unlinkSync(p);
    } catch {
      /* ignore */
    }
  }
  ticket = null;
}
