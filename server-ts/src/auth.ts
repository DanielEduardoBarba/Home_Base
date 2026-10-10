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
  ensureRuntimeDirs,
} from "./config";
import { appendDaily } from "./logging";
import { pushNotification } from "./notifications";

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

export function jwtSecret(): Uint8Array {
  const env = (process.env.HOMEBASE_JWT_SECRET || "").trim();
  if (env) return new TextEncoder().encode(env);
  ensureRuntimeDirs();
  if (existsSync(JWT_SECRET_PATH)) {
    const stripped = stripBytes(readFileSync(JWT_SECRET_PATH));
    if (stripped.length >= 32) return new Uint8Array(stripped);
  }
  let secret = randomBytes(48);
  for (;;) {
    secret = randomBytes(48);
    if (stripBytes(secret).length === secret.length) break;
  }
  writeFileSync(JWT_SECRET_PATH, secret);
  chmodPrivate(JWT_SECRET_PATH);
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

type LockoutFile = { failCount: number; lockedUntil: number };

function loadLockout(): LockoutFile {
  if (!existsSync(LOCKOUT_PATH)) return { failCount: 0, lockedUntil: 0 };
  try {
    return JSON.parse(readFileSync(LOCKOUT_PATH, "utf8")) as LockoutFile;
  } catch {
    return { failCount: 0, lockedUntil: 0 };
  }
}

function saveLockout(data: LockoutFile): void {
  ensureRuntimeDirs();
  writeFileSync(LOCKOUT_PATH, JSON.stringify(data, null, 2));
  chmodPrivate(LOCKOUT_PATH);
}

export function lockoutStatus(): {
  failCount: number;
  locked: boolean;
  retryAfter: number;
  threshold: number;
} {
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

export function recordSuccess(): void {
  saveLockout({ failCount: 0, lockedUntil: 0 });
}

export function recordFailure(
  ip = "unknown",
  reason = "invalid_password",
): { failCount: number; locked: boolean; retryAfter: number } {
  const data = loadLockout();
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
  saveLockout({ failCount, lockedUntil });
  appendDaily("auth_failure", { ip, reason, failCount, lockoutSeconds: delay });
  if (failCount >= FAIL_THRESHOLD) {
    pushNotification(
      "Auth lockout",
      `Failed login from ${ip}. Wait ${delay}s (failure #${failCount}).`,
      {
        level: "warn",
        category: "security",
        meta: { ip, failCount, delay },
      },
    );
  }
  return {
    failCount,
    locked: delay > 0 || lockedUntil > now,
    retryAfter: Math.max(0, Math.floor(lockedUntil - now)),
  };
}

export function assertNotLocked(): void {
  const data = loadLockout();
  const now = Date.now() / 1000;
  const remaining = Math.max(0, Math.floor((data.lockedUntil || 0) - now));
  if (remaining > 0) {
    throw new HttpError(
      429,
      {
        message: "Too many failed attempts",
        retryAfter: remaining,
        failCount: data.failCount || 0,
      },
      { "Retry-After": String(remaining) },
    );
  }
}

export async function loginWithPassword(
  password: string,
  ip = "unknown",
): Promise<{
  token: string;
  expiresAt: number;
  expiresIn: number;
  kind: string;
}> {
  assertNotLocked();
  if (!passwordIsSet()) {
    throw new HttpError(
      503,
      "Password not set — open Home Base on localhost to create one",
    );
  }
  if (!verifyPassword(password)) {
    const info = recordFailure(ip, "invalid_password");
    throw new HttpError(401, {
      message: "Invalid password",
      retryAfter: info.retryAfter,
      failCount: info.failCount,
    });
  }
  recordSuccess();
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
