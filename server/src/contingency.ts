/**
 * Contingency — human Web GUI only. No MCP tools, no Cursor homebase_* tools.
 * PIN (when enabled) → short-lived ticket → run editable bash → always attempt reboot.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  existsSync,
  readFileSync,
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
  type AuthEventCtx,
} from "./auth";
import { isAppPinEnabled, verifyAppPin } from "./app_pin";
import { logInfo, logWarn } from "./console_log";

const STATE_PATH = join(RUNTIME_DIR, "contingency.json");
const DEFAULT_SCRIPT = "echo c > /proc/sysrq-trigger";
const TICKET_TTL_MS = 120_000;
const SCRIPT_MAX = 32_000;

export type ContingencyState = {
  script: string;
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

function defaultState(): ContingencyState {
  return { script: DEFAULT_SCRIPT, updatedAt: 0 };
}

function loadState(): ContingencyState {
  ensureRuntimeDirs();
  if (!existsSync(STATE_PATH)) return defaultState();
  try {
    const raw = JSON.parse(readFileSync(STATE_PATH, "utf8")) as Partial<ContingencyState>;
    const script =
      typeof raw.script === "string" && raw.script.trim()
        ? raw.script
        : DEFAULT_SCRIPT;
    return {
      script,
      updatedAt: Number(raw.updatedAt) || 0,
    };
  } catch {
    return defaultState();
  }
}

function saveState(state: ContingencyState): void {
  ensureRuntimeDirs();
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + "\n", "utf8");
  chmodPrivate(STATE_PATH);
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
  ticketActive: boolean;
  ticketExpiresAt: number | null;
} {
  const state = loadState();
  const pinRequired = isAppPinEnabled();
  const active = Boolean(ticket && !ticket.used && ticket.expiresAt > Date.now());
  return {
    script: state.script,
    defaultScript: DEFAULT_SCRIPT,
    isDefault: state.script.trim() === DEFAULT_SCRIPT || state.updatedAt === 0,
    updatedAt: state.updatedAt,
    pinRequired,
    ticketActive: active,
    ticketExpiresAt: active && ticket ? ticket.expiresAt : null,
  };
}

export function setContingencyScript(script: string): ContingencyState {
  const next = String(script ?? "");
  if (next.length > SCRIPT_MAX) {
    throw new HttpError(400, {
      code: "script_too_long",
      message: `Script max ${SCRIPT_MAX} characters`,
    });
  }
  const state: ContingencyState = {
    script: next.trim() ? next : DEFAULT_SCRIPT,
    updatedAt: Date.now(),
  };
  saveState(state);
  // Editing invalidates any pending arm ticket.
  ticket = null;
  return state;
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
  logInfo("contingency", "authorized (ticket issued)");
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
  const state = loadState();
  const payload = buildPayload(state.script);

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

  logWarn("contingency", "EXECUTING — user script + mandatory reboot epilogue");

  // Detach: do not await process exit (host may crash / reboot mid-flight).
  try {
    const proc = Bun.spawn(["bash", "-lc", payload], {
      cwd: process.env.HOME || "/",
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
      env: { ...process.env, HOMEBASE_CONTINGENCY: "1" },
    });
    // Unref so homebased can keep serving the ack; child keeps running.
    try {
      proc.unref();
    } catch {
      /* ignore */
    }
  } catch (err) {
    logWarn("contingency", `spawn failed: ${err instanceof Error ? err.message : String(err)}`);
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
