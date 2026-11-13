/**
 * Human lockout clear, 1.19.x → 1.20.3 migration, and local-seat backoff.
 * Email + hash-chained security log happen in one place so every clear is audited.
 */
import {
  chmodSync,
  existsSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import {
  LOCKOUT_PATH,
  LOCAL_LOCKOUT_PATH,
  LOCKOUT_SCHEMA_VERSION,
  MCP_LOCKOUT_PATH,
  ensureRuntimeDirs,
} from "./config";
import type { EmailPayload } from "./email_template";

export const LOCAL_FAIL_THRESHOLD = 5;
/** Small escalating delays (seconds) after the local try limit. */
export const LOCAL_LOCKOUT_SCHEDULE = [5, 15, 30, 60, 120, 300];

export type LockoutClearMethod =
  | "local_password_signin"
  | "cli_unlock"
  | "upgrade_migration"
  | "expired";

export type LockoutFile = {
  schemaVersion?: number;
  failCount: number;
  lockedUntil: number;
};

export type LockoutClearResult = {
  cleared: boolean;
  method: LockoutClearMethod;
  previousFailCount: number;
  previousLockedUntil: number;
  hadLegacySchema: boolean;
  emailed: boolean;
  emailGap?: string;
  mcpSourcesCleared?: number;
};

function chmodPrivate(path: string): void {
  try {
    chmodSync(path, 0o600);
  } catch {
    /* ignore */
  }
}

function emptyLockout(): LockoutFile {
  return { schemaVersion: LOCKOUT_SCHEMA_VERSION, failCount: 0, lockedUntil: 0 };
}

export function isLegacyLockoutFile(raw: unknown): boolean {
  if (!raw || typeof raw !== "object") return true;
  const v = (raw as { schemaVersion?: unknown }).schemaVersion;
  return !(typeof v === "number" && v >= LOCKOUT_SCHEMA_VERSION);
}

export function readLockoutFile(path: string = LOCKOUT_PATH): LockoutFile {
  if (!existsSync(path)) return emptyLockout();
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<LockoutFile>;
    return {
      schemaVersion:
        typeof raw.schemaVersion === "number" ? raw.schemaVersion : undefined,
      failCount: Number(raw.failCount || 0) || 0,
      lockedUntil: Number(raw.lockedUntil || 0) || 0,
    };
  } catch {
    return emptyLockout();
  }
}

export function writeLockoutFile(
  data: LockoutFile,
  path: string = LOCKOUT_PATH,
): void {
  ensureRuntimeDirs();
  const out: LockoutFile = {
    schemaVersion: LOCKOUT_SCHEMA_VERSION,
    failCount: Number(data.failCount || 0) || 0,
    lockedUntil: Number(data.lockedUntil || 0) || 0,
  };
  writeFileSync(path, JSON.stringify(out, null, 2) + "\n");
  chmodPrivate(path);
}

export function loadHumanLockout(): LockoutFile {
  return readLockoutFile(LOCKOUT_PATH);
}

export function saveHumanLockout(data: LockoutFile): void {
  writeLockoutFile(data, LOCKOUT_PATH);
}

export function loadLocalLockout(): LockoutFile {
  return readLockoutFile(LOCAL_LOCKOUT_PATH);
}

export function saveLocalLockout(data: LockoutFile): void {
  writeLockoutFile(data, LOCAL_LOCKOUT_PATH);
}

export function bumpLocalLockout(data: LockoutFile): {
  next: LockoutFile;
  delay: number;
  now: number;
} {
  const failCount = Number(data.failCount || 0) + 1;
  let lockedUntil = Number(data.lockedUntil || 0);
  const now = Date.now() / 1000;
  let delay = 0;
  if (failCount >= LOCAL_FAIL_THRESHOLD) {
    const idx = Math.min(
      failCount - LOCAL_FAIL_THRESHOLD,
      LOCAL_LOCKOUT_SCHEDULE.length - 1,
    );
    delay = LOCAL_LOCKOUT_SCHEDULE[idx] ?? 300;
    lockedUntil = now + delay;
  }
  return {
    next: {
      schemaVersion: LOCKOUT_SCHEMA_VERSION,
      failCount,
      lockedUntil,
    },
    delay,
    now,
  };
}

export function localLockoutStatus(): {
  failCount: number;
  locked: boolean;
  retryAfter: number;
  threshold: number;
} {
  const data = loadLocalLockout();
  const now = Date.now() / 1000;
  const remaining = Math.max(0, Math.floor((data.lockedUntil || 0) - now));
  return {
    failCount: Number(data.failCount || 0),
    locked: remaining > 0,
    retryAfter: remaining,
    threshold: LOCAL_FAIL_THRESHOLD,
  };
}

export function recordLocalFailure(): {
  failCount: number;
  locked: boolean;
  retryAfter: number;
} {
  const { next, now } = bumpLocalLockout(loadLocalLockout());
  saveLocalLockout(next);
  const retryAfter = Math.max(0, Math.floor((next.lockedUntil || 0) - now));
  return {
    failCount: next.failCount,
    locked: retryAfter > 0,
    retryAfter,
  };
}

export function recordLocalSuccess(): void {
  if (!existsSync(LOCAL_LOCKOUT_PATH)) return;
  saveLocalLockout(emptyLockout());
}

export function remainingLocalAttempts(failCount: number): number {
  return Math.max(0, LOCAL_FAIL_THRESHOLD - Number(failCount || 0));
}

function noteClear(input: {
  method: LockoutClearMethod;
  previousFailCount: number;
  previousLockedUntil: number;
  ip?: string;
  userAgent?: string;
  path?: string;
  source?: "ui" | "mcp" | "api";
  emailSent?: boolean;
  emailGap?: string;
  message?: string;
}): void {
  try {
    const { recordSecurityEvent } = require("./security_log") as typeof import("./security_log");
    const until = input.previousLockedUntil
      ? new Date(input.previousLockedUntil * 1000).toISOString()
      : undefined;
    const bits = [
      `method=${input.method}`,
      `previousFailCount=${input.previousFailCount}`,
      until ? `previousLockedUntil=${until}` : null,
      input.emailSent ? "email=sent" : input.emailGap ? `email=not_sent (${input.emailGap})` : null,
    ].filter(Boolean);
    recordSecurityEvent({
      event: "lockout_cleared",
      source: input.source || (input.method === "local_password_signin" ? "ui" : "api"),
      result: input.method === "expired" ? "info" : "success",
      ip: input.ip,
      userAgent: input.userAgent,
      path: input.path,
      failCount: input.previousFailCount,
      method: input.method,
      previousFailCount: input.previousFailCount,
      previousLockedUntil: input.previousLockedUntil || undefined,
      emailSent: input.emailSent,
      emailGap: input.emailGap,
      message: input.message || bits.join(" · "),
    });
  } catch {
    /* never break auth on log failure */
  }
}

export function buildLockoutClearedEmail(opts: {
  method: LockoutClearMethod;
  previousFailCount: number;
  previousLockedUntil: number;
  ip?: string;
  userAgent?: string;
  when?: Date;
  mcpSourcesCleared?: number;
}): EmailPayload {
  const when = (opts.when || new Date()).toISOString();
  const until = opts.previousLockedUntil
    ? new Date(opts.previousLockedUntil * 1000).toISOString()
    : "n/a";
  const methodLabel: Record<LockoutClearMethod, string> = {
    local_password_signin: "Local password sign-in",
    cli_unlock: "sudo homebase unlock",
    upgrade_migration: "Upgrade migration (legacy lockout file)",
    expired: "Lockout expired",
  };
  const fields = [
    { label: "Method", value: methodLabel[opts.method] },
    { label: "Time", value: when },
    { label: "Previous fail count", value: String(opts.previousFailCount) },
    { label: "Previous locked until", value: until },
    { label: "Source IP", value: opts.ip || "unknown" },
    ...(opts.userAgent ? [{ label: "Device / user agent", value: opts.userAgent }] : []),
    ...(opts.mcpSourcesCleared
      ? [{ label: "MCP sources cleared", value: String(opts.mcpSourcesCleared) }]
      : []),
  ];
  return {
    subject: "Home Base · lockout cleared",
    eyebrow: "Security",
    title: "A login lockout was cleared",
    lead: "A human login/PIN lockout on this Home Base was cleared. If you did not do this, change the password on the laptop and review Settings → Security.",
    tone: "warn",
    fields,
    tips: [
      "This message never includes passwords, PINs, or tokens.",
      "From the laptop you can also run sudo homebase unlock.",
    ],
  };
}

function peekEmailStatus(): { ready: boolean; gap?: string } {
  try {
    const { emailAlertDeliveryStatus } = require("./email_alerts") as typeof import("./email_alerts");
    return emailAlertDeliveryStatus();
  } catch (e) {
    return { ready: false, gap: e instanceof Error ? e.message : String(e) };
  }
}

let emailFlush: Promise<void> = Promise.resolve();

function reportEmailGap(method: LockoutClearMethod, gap: string): void {
  try {
    const { appendTrace } = require("./trace") as typeof import("./trace");
    appendTrace(
      "warn",
      `lockout cleared (${method}) but email was not sent: ${gap}`,
      "email",
    );
  } catch {
    /* ignore */
  }
}

function queueClearEmail(payload: EmailPayload, method: LockoutClearMethod): void {
  emailFlush = emailFlush
    .then(async () => {
      const { deliverEmailAlert } = await import("./email_alerts");
      const result = await deliverEmailAlert(payload);
      if (!result.ok) {
        reportEmailGap(method, result.error || "email alerts not configured or no recipient");
      }
    })
    .catch((e) => {
      reportEmailGap(method, e instanceof Error ? e.message : String(e));
    });
}

/** Await outstanding lockout-cleared email attempts (tests). */
export function flushLockoutEmails(): Promise<void> {
  return emailFlush;
}

export function clearHumanLockout(opts: {
  method: LockoutClearMethod;
  ip?: string;
  userAgent?: string;
  path?: string;
  source?: "ui" | "mcp" | "api";
  /** When true, write the audit event even if the file was already clear (migration). */
  forceLog?: boolean;
  /** Email even when the file had no fail state (used only if forceLog). */
  forceEmail?: boolean;
  mcpSourcesCleared?: number;
  skipEmail?: boolean;
}): LockoutClearResult {
  const prev = loadHumanLockout();
  const hadLegacySchema = isLegacyLockoutFile(prev);
  const previousFailCount = Number(prev.failCount || 0) || 0;
  const previousLockedUntil = Number(prev.lockedUntil || 0) || 0;
  const hadState = previousFailCount > 0 || previousLockedUntil > 0;
  const shouldAudit = hadState || opts.forceLog;
  const shouldEmail = !opts.skipEmail && (hadState || opts.forceEmail);
  saveHumanLockout(emptyLockout());

  let emailed = false;
  let emailGap: string | undefined;
  if (shouldEmail) {
    const peek = peekEmailStatus();
    emailed = peek.ready;
    emailGap = peek.ready ? undefined : peek.gap || "email alerts not configured or no recipient";
    if (!emailed && emailGap) reportEmailGap(opts.method, emailGap);
    const payload = buildLockoutClearedEmail({
      method: opts.method,
      previousFailCount,
      previousLockedUntil,
      ip: opts.ip,
      userAgent: opts.userAgent,
      mcpSourcesCleared: opts.mcpSourcesCleared,
    });
    if (peek.ready) queueClearEmail(payload, opts.method);
  }

  if (shouldAudit) {
    noteClear({
      method: opts.method,
      previousFailCount,
      previousLockedUntil,
      ip: opts.ip,
      userAgent: opts.userAgent,
      path: opts.path,
      source: opts.source,
      emailSent: shouldEmail ? emailed : undefined,
      emailGap: shouldEmail ? emailGap : undefined,
    });
  }

  return {
    cleared: hadState,
    method: opts.method,
    previousFailCount,
    previousLockedUntil,
    hadLegacySchema,
    emailed,
    emailGap,
    mcpSourcesCleared: opts.mcpSourcesCleared,
  };
}

/**
 * If the human lockout window has ended, clear it once (log + email) with
 * method `expired`. Safe to call on every status / login check.
 */
export function expireHumanLockoutIfNeeded(ctx: {
  ip?: string;
  userAgent?: string;
  path?: string;
} = {}): LockoutClearResult | null {
  const data = loadHumanLockout();
  const now = Date.now() / 1000;
  if (
    data.lockedUntil > 0 &&
    data.lockedUntil <= now &&
    data.failCount > 0
  ) {
    return clearHumanLockout({
      method: "expired",
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      path: ctx.path,
      source: "api",
    });
  }
  return null;
}

/**
 * On first start of 1.20.3, reset a pre-schema (1.19.x / 1.20.0–1.20.2)
 * lockout.json once so a shared bot+human lock cannot survive the upgrade.
 */
export function migrateLegacyLockoutIfNeeded(): LockoutClearResult | null {
  if (!existsSync(LOCKOUT_PATH)) return null;
  let raw: unknown = null;
  try {
    raw = JSON.parse(readFileSync(LOCKOUT_PATH, "utf8"));
  } catch {
    raw = {};
  }
  if (!isLegacyLockoutFile(raw)) return null;
  return clearHumanLockout({
    method: "upgrade_migration",
    ip: "local",
    path: "startup",
    source: "api",
    forceLog: true,
  });
}

export type McpLockoutFile = {
  schemaVersion?: number;
  sources: Record<string, { failCount: number; lockedUntil: number }>;
};

export function loadMcpLockoutFile(): McpLockoutFile {
  if (!existsSync(MCP_LOCKOUT_PATH)) return { schemaVersion: LOCKOUT_SCHEMA_VERSION, sources: {} };
  try {
    const raw = JSON.parse(readFileSync(MCP_LOCKOUT_PATH, "utf8")) as Partial<McpLockoutFile>;
    const sources =
      raw && typeof raw === "object" && raw.sources && typeof raw.sources === "object"
        ? raw.sources
        : {};
    const clean: Record<string, { failCount: number; lockedUntil: number }> = {};
    for (const [key, val] of Object.entries(sources)) {
      if (!val || typeof val !== "object") continue;
      clean[key] = {
        failCount: Number(val.failCount || 0) || 0,
        lockedUntil: Number(val.lockedUntil || 0) || 0,
      };
    }
    return {
      schemaVersion: typeof raw.schemaVersion === "number" ? raw.schemaVersion : undefined,
      sources: clean,
    };
  } catch {
    return { schemaVersion: LOCKOUT_SCHEMA_VERSION, sources: {} };
  }
}

export function saveMcpLockoutFile(data: McpLockoutFile): void {
  ensureRuntimeDirs();
  writeFileSync(
    MCP_LOCKOUT_PATH,
    JSON.stringify(
      { schemaVersion: LOCKOUT_SCHEMA_VERSION, sources: data.sources || {} },
      null,
      2,
    ) + "\n",
  );
  chmodPrivate(MCP_LOCKOUT_PATH);
}

export function clearMcpLockouts(): { sourcesCleared: number } {
  const file = loadMcpLockoutFile();
  const sourcesCleared = Object.keys(file.sources).length;
  if (existsSync(MCP_LOCKOUT_PATH)) {
    try {
      unlinkSync(MCP_LOCKOUT_PATH);
    } catch {
      saveMcpLockoutFile({ schemaVersion: LOCKOUT_SCHEMA_VERSION, sources: {} });
    }
  }
  return { sourcesCleared };
}

export function unlockFromCli(opts: {
  includeMcp?: boolean;
}): {
  human: LockoutClearResult;
  mcpSourcesCleared: number;
  emailed: boolean;
  emailGap?: string;
  lockoutPath: string;
  mcpLockoutPath: string;
} {
  const mcpSourcesCleared = opts.includeMcp ? clearMcpLockouts().sourcesCleared : 0;
  const humanPrev = loadHumanLockout();
  const hadState = Number(humanPrev.failCount || 0) > 0 || Number(humanPrev.lockedUntil || 0) > 0;
  const human = clearHumanLockout({
    method: "cli_unlock",
    ip: "local",
    path: "cli:homebase unlock",
    source: "api",
    forceLog: true,
    forceEmail: hadState || mcpSourcesCleared > 0,
    mcpSourcesCleared,
    skipEmail: !(hadState || mcpSourcesCleared > 0),
  });
  return {
    human,
    mcpSourcesCleared,
    emailed: human.emailed,
    emailGap: human.emailGap,
    lockoutPath: LOCKOUT_PATH,
    mcpLockoutPath: MCP_LOCKOUT_PATH,
  };
}
