import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  existsSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { SignJWT, jwtVerify, errors as JoseErrors } from "jose";
import {
  AUTH_PATH,
  JWT_SECRET_PATH,
  LOCKOUT_PATH,
  MCP_LOCKOUT_PATH,
  ensureRuntimeDirs,
} from "./config";
import {
  clearHumanLockout,
  expireHumanLockoutIfNeeded,
  loadHumanLockout,
  localLockoutStatus,
  recordLocalFailure,
  recordLocalSuccess,
  remainingLocalAttempts,
  saveHumanLockout,
  LOCAL_FAIL_THRESHOLD,
} from "./lockout_recovery";
import { logWarn } from "./console_log";
import { formatGeo, geoCached, warmGeo } from "./geo";
import { desktopNotify } from "./desktop_notify";
import { appendDaily } from "./logging";
import { pushNotification } from "./notifications";
import { decryptSecret, encryptSecret } from "./secrets_vault";

export const LOCKOUT_SCHEDULE = [10, 30, 60, 180, 300, 600, 1800, 3600, 86400];
export const FAIL_THRESHOLD = 5;
export const JWT_TTL_SEC = 24 * 60 * 60;
const JWT_ALG = "HS256";

const SCRYPT_N = 2 ** 14;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_DKLEN = 64;

export class HttpError extends Error {
  status: number;
  detail: unknown;
  headers: Record<string, string>;
  constructor(
    status: number,
    detail: unknown,
    headers: Record<string, string> = {},
  ) {
    super(typeof detail === "string" ? detail : JSON.stringify(detail));
    this.status = status;
    this.detail = detail;
    this.headers = headers;
  }
}

function chmodPrivate(path: string): void {
  try {
    chmodSync(path, 0o600);
  } catch {
    /* ignore */
  }
}

function stripBytes(raw: Buffer): Buffer {
  let s = 0;
  let e = raw.length;
  const ws = new Set([0x09, 0x0a, 0x0d, 0x20]);
  while (s < e && ws.has(raw[s]!)) s++;
  while (e > s && ws.has(raw[e - 1]!)) e--;
  return raw.subarray(s, e);
}

function b64e(data: Buffer): string {
  return data.toString("base64url");
}

function b64d(data: string): Buffer {
  return Buffer.from(data, "base64url");
}

function persistJwtSecret(secret: Buffer): void {
  // AES-GCM via secrets vault (0600). Legacy raw bytes are migrated on first read.
  writeFileSync(
    JWT_SECRET_PATH,
    encryptSecret(secret.toString("base64url")),
    { mode: 0o600 },
  );
  chmodPrivate(JWT_SECRET_PATH);
}

export function jwtSecret(): Uint8Array {
  const env = (process.env.HOMEBASE_JWT_SECRET || "").trim();
  if (env) return new TextEncoder().encode(env);
  ensureRuntimeDirs();
  if (existsSync(JWT_SECRET_PATH)) {
    const raw = readFileSync(JWT_SECRET_PATH);
    const asText = raw.toString("utf8").trim();
    if (asText.startsWith("{")) {
      try {
        const plain = decryptSecret(asText);
        if (plain) {
          const buf = Buffer.from(plain, "base64url");
          if (buf.length >= 32) return new Uint8Array(buf);
        }
      } catch {
        /* fall through to regenerate */
      }
    } else {
      const stripped = stripBytes(raw);
      if (stripped.length >= 32) {
        // Migrate legacy plaintext JWT secret → encrypted at rest.
        try {
          persistJwtSecret(Buffer.from(stripped));
        } catch {
          /* keep serving legacy bytes if vault write fails */
        }
        return new Uint8Array(stripped);
      }
    }
  }
  let secret = randomBytes(48);
  for (;;) {
    secret = randomBytes(48);
    if (stripBytes(secret).length === secret.length) break;
  }
  persistJwtSecret(secret);
  return new Uint8Array(secret);
}

function hashPassword(password: string, salt: Buffer): Buffer {
  return scryptSync(password, salt, SCRYPT_DKLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: 64 * 1024 * 1024,
  });
}

type AuthFile = {
  algo?: string;
  n?: number;
  r?: number;
  p?: number;
  salt?: string;
  passwordHash?: string;
  initialized?: boolean;
  authEpoch?: number;
  updatedAt?: number;
};

function loadAuth(): AuthFile {
  if (!existsSync(AUTH_PATH)) return {};
  try {
    return JSON.parse(readFileSync(AUTH_PATH, "utf8")) as AuthFile;
  } catch {
    return {};
  }
}

function saveAuth(data: AuthFile): void {
  ensureRuntimeDirs();
  const tmp = AUTH_PATH + ".tmp";
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  chmodPrivate(tmp);
  renameSync(tmp, AUTH_PATH);
  chmodPrivate(AUTH_PATH);
}

export function passwordIsSet(): boolean {
  const data = loadAuth();
  return Boolean(data.passwordHash && data.salt);
}

export function isInitialized(): boolean {
  const data = loadAuth();
  if (data.initialized) return true;
  if (data.passwordHash && data.salt) {
    data.initialized = true;
    saveAuth(data);
    return true;
  }
  return false;
}

export function canBootstrapPassword(): boolean {
  return !isInitialized() && !passwordIsSet();
}

export function validatePasswordStrength(password: string): string {
  const pw = password || "";
  const errors: string[] = [];
  if (pw.length < 10) errors.push("at least 10 characters");
  if (!/[a-z]/.test(pw)) errors.push("a lowercase letter");
  if (!/[A-Z]/.test(pw)) errors.push("an uppercase letter");
  if (!/[0-9]/.test(pw)) errors.push("a digit");
  if (!/[^A-Za-z0-9]/.test(pw)) errors.push("a special character");
  if (errors.length) {
    throw new HttpError(400, "Password must include " + errors.join(", "));
  }
  return pw;
}

export function authEpoch(): number {
  try {
    return Number(loadAuth().authEpoch || 0) || 0;
  } catch {
    return 0;
  }
}

function writePasswordHash(password: string, initialized: boolean): void {
  const pw = validatePasswordStrength(password);
  const salt = randomBytes(16);
  const digest = hashPassword(pw, salt);
  const prev = loadAuth();
  let prevEpoch = 0;
  try {
    prevEpoch = Number(prev.authEpoch || 0) || 0;
  } catch {
    prevEpoch = 0;
  }
  const rest = { ...prev };
  delete rest.salt;
  delete rest.passwordHash;
  saveAuth({
    ...rest,
    algo: "scrypt",
    n: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    salt: b64e(salt),
    passwordHash: b64e(digest),
    initialized: Boolean(initialized),
    authEpoch: prevEpoch + 1,
    updatedAt: Math.floor(Date.now() / 1000),
  });
}

export function bootstrapPassword(password: string): void {
  if (!canBootstrapPassword()) {
    throw new HttpError(
      403,
      "Password already initialized — use Share → Change password on localhost",
    );
  }
  writePasswordHash(password, true);
}

export function changePassword(
  newPassword: string,
  currentPassword: string,
): void {
  if (!passwordIsSet() || !isInitialized()) {
    throw new HttpError(400, "No password to change — complete first-time setup");
  }
  if (!currentPassword || !verifyPassword(currentPassword)) {
    throw new HttpError(401, "Current password is incorrect");
  }
  writePasswordHash(newPassword, true);
}

export function verifyPassword(password: string): boolean {
  const data = loadAuth();
  if (!data.passwordHash || !data.salt) return false;
  try {
    const salt = b64d(String(data.salt));
    const expected = b64d(String(data.passwordHash));
    const got = hashPassword(password, salt);
    if (got.length !== expected.length) return false;
    return timingSafeEqual(got, expected);
  } catch {
    return false;
  }
}

export async function issueJwt(opts: {
  subject?: string;
  kind?: string;
  ttl?: number;
}): Promise<{
  token: string;
  expiresAt: number;
  expiresIn: number;
  kind: string;
}> {
  const now = Math.floor(Date.now() / 1000);
  const ttl = Math.max(30, opts.ttl ?? JWT_TTL_SEC);
  const exp = now + ttl;
  const kind = opts.kind ?? "session";
  const token = await new SignJWT({
    kind,
    jti: randomBytes(8).toString("hex"),
    ae: authEpoch(),
  })
    .setProtectedHeader({ alg: JWT_ALG })
    .setSubject(opts.subject ?? "homebase")
    .setIssuedAt(now)
    .setExpirationTime(exp)
    .sign(jwtSecret());
  return { token, expiresAt: exp, expiresIn: exp - now, kind };
}

export async function decodeJwt(
  token: string,
): Promise<Record<string, unknown>> {
  const { payload } = await jwtVerify(token, jwtSecret(), {
    algorithms: [JWT_ALG],
    requiredClaims: ["exp", "iat", "sub"],
  });
  return payload as Record<string, unknown>;
}

type LockoutFile = { failCount: number; lockedUntil: number; schemaVersion?: number };

function loadLockout(): LockoutFile {
  const data = loadHumanLockout();
  return {
    failCount: data.failCount,
    lockedUntil: data.lockedUntil,
    schemaVersion: data.schemaVersion,
  };
}

function saveLockout(data: LockoutFile): void {
  saveHumanLockout({
    failCount: Number(data.failCount || 0) || 0,
    lockedUntil: Number(data.lockedUntil || 0) || 0,
  });
}

function bumpLockout(data: LockoutFile): {
  next: LockoutFile;
  delay: number;
  now: number;
} {
  const failCount = Number(data.failCount || 0) + 1;
  let lockedUntil = Number(data.lockedUntil || 0);
  const now = Date.now() / 1000;
  let delay = 0;
  if (failCount >= FAIL_THRESHOLD) {
    const idx = Math.min(
      failCount - FAIL_THRESHOLD,
      LOCKOUT_SCHEDULE.length - 1,
    );
    delay = LOCKOUT_SCHEDULE[idx] ?? 86400;
    lockedUntil = now + delay;
  }
  return { next: { failCount, lockedUntil }, delay, now };
}

export function remainingAttempts(failCount: number): number {
  return Math.max(0, FAIL_THRESHOLD - Number(failCount || 0));
}

function lockoutSourceKey(ip: string): string {
  const s = (ip || "unknown").trim().slice(0, 64) || "unknown";
  return s.replace(/[^A-Za-z0-9.:_-]/g, "_");
}

type McpLockoutFile = {
  sources: Record<string, LockoutFile>;
};

function loadMcpLockout(): McpLockoutFile {
  if (!existsSync(MCP_LOCKOUT_PATH)) return { sources: {} };
  try {
    const raw = JSON.parse(readFileSync(MCP_LOCKOUT_PATH, "utf8")) as Partial<McpLockoutFile>;
    const sources =
      raw && typeof raw === "object" && raw.sources && typeof raw.sources === "object"
        ? raw.sources
        : {};
    const clean: Record<string, LockoutFile> = {};
    for (const [key, val] of Object.entries(sources)) {
      if (!val || typeof val !== "object") continue;
      clean[key] = {
        failCount: Number(val.failCount || 0) || 0,
        lockedUntil: Number(val.lockedUntil || 0) || 0,
      };
    }
    return { sources: clean };
  } catch {
    return { sources: {} };
  }
}

function saveMcpLockout(data: McpLockoutFile): void {
  ensureRuntimeDirs();
  writeFileSync(MCP_LOCKOUT_PATH, JSON.stringify(data, null, 2));
  chmodPrivate(MCP_LOCKOUT_PATH);
}

export type AuthEventCtx = {
  ip?: string;
  userAgent?: string;
  path?: string;
};

function noteSecurity(input: {
  event: string;
  source: "ui" | "mcp" | "api";
  result: "success" | "failure" | "lockout" | "expired" | "invalid" | "revoked" | "info";
  ip?: string;
  userAgent?: string;
  path?: string;
  status?: number;
  failCount?: number;
  retryAfter?: number;
  remainingAttempts?: number;
  connectorId?: string;
  connectorLabel?: string;
  message?: string;
}): void {
  try {
    const { recordSecurityEvent } = require("./security_log") as typeof import("./security_log");
    recordSecurityEvent(input);
  } catch {
    /* never break auth on log failure */
  }
}

export function lockoutStatus(ctx: AuthEventCtx = {}): {
  failCount: number;
  locked: boolean;
  retryAfter: number;
  threshold: number;
} {
  expireHumanLockoutIfNeeded({
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    path: ctx.path || "lockout_status",
  });
  const data = loadLockout();
  const now = Date.now() / 1000;
  const remaining = Math.max(0, Math.floor((data.lockedUntil || 0) - now));
  return {
    failCount: Number(data.failCount || 0),
    locked: remaining > 0,
    retryAfter: remaining,
    threshold: FAIL_THRESHOLD,
  };
}

export function recordSuccess(ctx: AuthEventCtx = {}): void {
  saveLockout({ failCount: 0, lockedUntil: 0 });
  if (ctx.ip) {
    noteSecurity({
      event: "login_success",
      source: "ui",
      result: "success",
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      path: ctx.path,
      status: 200,
    });
  }
}

export function recordFailure(
  ip = "unknown",
  reason = "invalid_password",
  ctx: AuthEventCtx = {},
): { failCount: number; locked: boolean; retryAfter: number } {
  const { next, delay, now } = bumpLockout(loadLockout());
  const failCount = next.failCount;
  const lockedUntil = next.lockedUntil;
  saveLockout(next);
  appendDaily("auth_failure", { ip, reason, failCount, lockoutSeconds: delay });
  warmGeo(ip);
  const geo = formatGeo(geoCached(ip));
  logWarn(`auth failure #${failCount}`, {
    source: "auth",
    fields: {
      ip,
      geo,
      reason,
      lockoutSeconds: delay || undefined,
    },
  });
  const title =
    failCount >= FAIL_THRESHOLD
      ? "Auth lockout"
      : failCount >= 3
        ? "Repeated bad credentials"
        : "Bad credentials";
  const body =
    failCount >= FAIL_THRESHOLD
      ? `${reason} from ${ip}${geo ? ` (${geo})` : ""}. Locked ${delay}s (failure #${failCount}).`
      : `${reason} from ${ip}${geo ? ` (${geo})` : ""}. Failure #${failCount}/${FAIL_THRESHOLD} before lockout.`;
  pushNotification(title, body, {
    level: failCount >= FAIL_THRESHOLD ? "error" : "warn",
    category: "security",
    meta: { ip, failCount, delay, reason },
  });
  // Desktop: only after 3+ failures or lockout — single bubbles that replace + expire.
  if (failCount >= 3) {
    desktopNotify(title, body.slice(0, 120), {
      urgency: failCount >= FAIL_THRESHOLD ? "normal" : "low",
      replaceKey: `auth-fail:${ip}`,
      dedupeKey: `auth-fail:${ip}`,
      dedupeMs: 20_000,
      expireMs: failCount >= FAIL_THRESHOLD ? 6_000 : 4_000,
    });
  }
  const retryAfter = Math.max(0, Math.floor(lockedUntil - now));
  void import("./email_alerts")
    .then(({ maybeEmailSuspiciousAuth }) => {
      maybeEmailSuspiciousAuth({
        ip,
        reason,
        failCount,
        retryAfter,
      });
    })
    .catch(() => undefined);
  const locked = delay > 0 || lockedUntil > now;
  noteSecurity({
    event: reason.startsWith("invalid_pin") ? "pin_failure" : "login_failure",
    source: "ui",
    result: locked ? "lockout" : "failure",
    ip,
    userAgent: ctx.userAgent,
    path: ctx.path,
    status: locked ? 429 : 401,
    failCount,
    retryAfter,
    remainingAttempts: remainingAttempts(failCount),
    message: reason,
  });
  return {
    failCount,
    locked,
    retryAfter,
  };
}

export function assertNotLocked(ctx: AuthEventCtx = {}): void {
  expireHumanLockoutIfNeeded({
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    path: ctx.path || "assert_not_locked",
  });
  const data = loadLockout();
  const now = Date.now() / 1000;
  const remaining = Math.max(0, Math.floor((data.lockedUntil || 0) - now));
  if (remaining > 0) {
    throw new HttpError(
      429,
      {
        code: "auth_lockout",
        message: "Too many failed attempts",
        retryAfter: remaining,
        failCount: data.failCount || 0,
        remainingAttempts: 0,
        threshold: FAIL_THRESHOLD,
      },
      { "Retry-After": String(remaining) },
    );
  }
}


export function mcpLockoutStatus(ip = "unknown"): {
  failCount: number;
  locked: boolean;
  retryAfter: number;
  threshold: number;
  ip: string;
} {
  const key = lockoutSourceKey(ip);
  const data = loadMcpLockout().sources[key] || { failCount: 0, lockedUntil: 0 };
  const now = Date.now() / 1000;
  const remaining = Math.max(0, Math.floor((data.lockedUntil || 0) - now));
  return {
    failCount: Number(data.failCount || 0),
    locked: remaining > 0,
    retryAfter: remaining,
    threshold: FAIL_THRESHOLD,
    ip: key,
  };
}

export function recordMcpSuccess(ip = "unknown"): void {
  const key = lockoutSourceKey(ip);
  const file = loadMcpLockout();
  if (!file.sources[key]) return;
  delete file.sources[key];
  saveMcpLockout(file);
}

export function recordMcpFailure(
  ip = "unknown",
  reason = "invalid_mcp_token",
  ctx: AuthEventCtx & {
    connectorId?: string;
    connectorLabel?: string;
    status?: number;
    result?: "failure" | "expired" | "invalid" | "lockout" | "revoked";
  } = {},
): { failCount: number; locked: boolean; retryAfter: number } {
  const key = lockoutSourceKey(ip);
  const file = loadMcpLockout();
  const prev = file.sources[key] || { failCount: 0, lockedUntil: 0 };
  const { next, delay, now } = bumpLockout(prev);
  file.sources[key] = next;
  saveMcpLockout(file);
  const failCount = next.failCount;
  const lockedUntil = next.lockedUntil;
  appendDaily("mcp_auth_failure", {
    ip: key,
    reason,
    failCount,
    lockoutSeconds: delay,
  });
  warmGeo(ip);
  const geo = formatGeo(geoCached(ip));
  logWarn(`MCP auth failure #${failCount}`, {
    source: "auth",
    fields: {
      ip: key,
      geo,
      reason,
      lockoutSeconds: delay || undefined,
    },
  });
  const title =
    failCount >= FAIL_THRESHOLD
      ? "MCP token lockout"
      : failCount >= 3
        ? "Repeated bad MCP tokens"
        : "Bad MCP token";
  const body =
    failCount >= FAIL_THRESHOLD
      ? `${reason} from ${key}${geo ? ` (${geo})` : ""}. MCP locked ${delay}s (failure #${failCount}).`
      : `${reason} from ${key}${geo ? ` (${geo})` : ""}. Failure #${failCount}/${FAIL_THRESHOLD} before MCP lockout.`;
  pushNotification(title, body, {
    level: failCount >= FAIL_THRESHOLD ? "error" : "warn",
    category: "security",
    meta: { ip: key, failCount, delay, reason, scope: "mcp" },
  });
  if (failCount >= 3) {
    desktopNotify(title, body.slice(0, 120), {
      urgency: failCount >= FAIL_THRESHOLD ? "normal" : "low",
      replaceKey: `mcp-auth-fail:${key}`,
      dedupeKey: `mcp-auth-fail:${key}`,
      dedupeMs: 20_000,
      expireMs: failCount >= FAIL_THRESHOLD ? 6_000 : 4_000,
    });
  }
  const retryAfter = Math.max(0, Math.floor(lockedUntil - now));
  const locked = delay > 0 || lockedUntil > now;
  void import("./email_alerts")
    .then(({ maybeEmailSuspiciousAuth }) => {
      maybeEmailSuspiciousAuth({
        ip: key,
        reason,
        failCount,
        retryAfter,
      });
    })
    .catch(() => undefined);
  noteSecurity({
    event: reason,
    source: "mcp",
    result: locked ? "lockout" : ctx.result || "failure",
    ip: key,
    userAgent: ctx.userAgent,
    path: ctx.path,
    status: ctx.status || (locked ? 429 : 401),
    failCount,
    retryAfter,
    remainingAttempts: remainingAttempts(failCount),
    connectorId: ctx.connectorId,
    connectorLabel: ctx.connectorLabel,
    message: reason,
  });
  return {
    failCount,
    locked,
    retryAfter,
  };
}

export function assertMcpNotLocked(ip = "unknown"): void {
  const status = mcpLockoutStatus(ip);
  if (status.retryAfter > 0) {
    throw new HttpError(
      429,
      {
        code: "mcp_lockout",
        message: "Too many failed MCP token attempts",
        retryAfter: status.retryAfter,
        failCount: status.failCount,
        remainingAttempts: 0,
        threshold: FAIL_THRESHOLD,
      },
      { "Retry-After": String(status.retryAfter) },
    );
  }
}

export type LoginPasswordCtx = AuthEventCtx & {
  /** True only when evaluateLocalSeatPasswordBypass() said ok for this request. */
  localSeat?: boolean;
  socketIp?: string;
};

export async function loginWithPassword(
  password: string,
  ip = "unknown",
  ctx: LoginPasswordCtx = {},
): Promise<{
  token: string;
  expiresAt: number;
  expiresIn: number;
  kind: string;
}> {
  const eventCtx: AuthEventCtx = { ip, userAgent: ctx.userAgent, path: ctx.path };
  expireHumanLockoutIfNeeded({
    ip,
    userAgent: ctx.userAgent,
    path: ctx.path || "/api/login",
  });
  const human = lockoutStatus(eventCtx);
  const localSeat = Boolean(ctx.localSeat) && human.locked;
  if (human.locked && !localSeat) {
    assertNotLocked(eventCtx);
  }
  if (localSeat) {
    const local = localLockoutStatus();
    if (local.locked) {
      throw new HttpError(
        429,
        {
          code: "local_auth_lockout",
          message: "Too many local sign-in attempts",
          retryAfter: local.retryAfter,
          failCount: local.failCount,
          remainingAttempts: 0,
          threshold: LOCAL_FAIL_THRESHOLD,
          localSeat: true,
        },
        { "Retry-After": String(local.retryAfter) },
      );
    }
  }
  if (!passwordIsSet()) {
    throw new HttpError(
      503,
      "Password not set — open Home Base on localhost to create one",
    );
  }
  if (!verifyPassword(password)) {
    if (localSeat) {
      const info = recordLocalFailure();
      noteSecurity({
        event: "login_failure",
        source: "ui",
        result: info.locked ? "lockout" : "failure",
        ip: ctx.socketIp || ip,
        userAgent: ctx.userAgent,
        path: ctx.path,
        status: info.locked ? 429 : 401,
        failCount: info.failCount,
        retryAfter: info.retryAfter,
        remainingAttempts: remainingLocalAttempts(info.failCount),
        message: "invalid_password_local",
      });
      throw new HttpError(401, {
        code: "invalid_password",
        message: "Invalid password",
        retryAfter: info.retryAfter,
        failCount: info.failCount,
        remainingAttempts: remainingLocalAttempts(info.failCount),
        threshold: LOCAL_FAIL_THRESHOLD,
        localSeat: true,
      });
    }
    const info = recordFailure(ip, "invalid_password", eventCtx);
    throw new HttpError(401, {
      code: "invalid_password",
      message: "Invalid password",
      retryAfter: info.retryAfter,
      failCount: info.failCount,
      remainingAttempts: remainingAttempts(info.failCount),
      threshold: FAIL_THRESHOLD,
    });
  }
  if (localSeat) {
    const socketIp = ctx.socketIp || ip;
    clearHumanLockout({
      method: "local_password_signin",
      ip: socketIp,
      userAgent: ctx.userAgent,
      path: ctx.path || "/api/login",
      source: "ui",
    });
    recordLocalSuccess();
    noteSecurity({
      event: "login_success",
      source: "ui",
      result: "success",
      ip: socketIp,
      userAgent: ctx.userAgent,
      path: ctx.path || "/api/login",
      status: 200,
      message: "local_password_signin",
    });
  } else {
    recordSuccess(eventCtx);
  }
  return issueJwt({ kind: "session", ttl: JWT_TTL_SEC });
}

export async function verifyAccessToken(
  token: string | undefined | null,
  _ip = "unknown",
): Promise<Record<string, unknown>> {
  if (!passwordIsSet()) {
    throw new HttpError(
      503,
      "Password not set — open Home Base on localhost to create one",
    );
  }
  if (!token) {
    throw new HttpError(401, {
      message: "Missing session token",
      code: "missing_token",
    });
  }
  let claims: Record<string, unknown>;
  try {
    claims = await decodeJwt(token);
  } catch (e) {
    if (e instanceof JoseErrors.JWTExpired) {
      throw new HttpError(401, {
        message: "Session expired — sign in again",
        code: "expired",
      });
    }
    throw new HttpError(401, {
      message: "Invalid session token",
      code: "invalid_token",
    });
  }
  if (claims.kind !== "session" && claims.kind !== "share") {
    throw new HttpError(401, {
      message: "Invalid session token",
      code: "invalid_kind",
    });
  }
  if (claims.kind === "share") {
    throw new HttpError(401, {
      message: "Share token cannot access the API",
      code: "share_token",
    });
  }
  let tokenEpoch = 0;
  try {
    tokenEpoch = Number(claims.ae || 0) || 0;
  } catch {
    tokenEpoch = 0;
  }
  if (tokenEpoch !== authEpoch()) {
    throw new HttpError(401, {
      message: "Session invalidated — sign in again",
      code: "stale_session",
    });
  }
  const jti = typeof claims.jti === "string" ? claims.jti : "";
  if (jti) {
    const { isSessionRevoked } = require("./session_revoke") as typeof import("./session_revoke");
    if (isSessionRevoked(jti)) {
      throw new HttpError(401, {
        message: "Session ended — sign in again",
        code: "revoked_session",
      });
    }
  }
  return claims;
}

export function bearerFromHeader(
  authorization: string | null | undefined,
): string | undefined {
  if (!authorization) return undefined;
  const parts = authorization.split(" ", 2);
  if (parts.length === 2 && parts[0]!.toLowerCase() === "bearer") {
    return parts[1]!.trim();
  }
  return undefined;
}

export function authStatusPayload(
  canBootstrapLocalhost: boolean,
): Record<string, unknown> {
  return {
    passwordSet: passwordIsSet(),
    initialized: isInitialized(),
    canBootstrap: canBootstrapLocalhost && canBootstrapPassword(),
    jwtTtlSec: JWT_TTL_SEC,
    lockout: lockoutStatus(),
  };
}
