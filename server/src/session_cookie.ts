import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { HttpError } from "./auth";

/** HttpOnly session JWT. Not readable by JavaScript. */
export const SESSION_COOKIE = "hb_session";
/** Readable CSRF cookie for double-submit (header must match). */
export const CSRF_COOKIE = "hb_csrf";
export const CSRF_HEADER = "x-csrf-token";

const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** State-changing routes that run before a session cookie exists. */
export const CSRF_EXEMPT_PATHS = new Set([
  "/api/login",
  "/api/auth/bootstrap",
  "/api/legal/accept",
  "/api/share/redeem",
]);

export function mintCsrfToken(): string {
  return randomBytes(32).toString("base64url");
}

export function readSessionCookie(c: Context): string | undefined {
  const v = getCookie(c, SESSION_COOKIE);
  return v && v.trim() ? v.trim() : undefined;
}

export function readCsrfCookie(c: Context): string | undefined {
  const v = getCookie(c, CSRF_COOKIE);
  return v && v.trim() ? v.trim() : undefined;
}

function cookieBase(secure: boolean, httpOnly: boolean, maxAge: number) {
  return {
    path: "/",
    httpOnly,
    sameSite: "Strict" as const,
    secure,
    maxAge: Math.max(0, Math.floor(maxAge)),
  };
}

function expireCookie(c: Context, name: string, httpOnly: boolean, secure: boolean): void {
  setCookie(c, name, "", cookieBase(secure, httpOnly, 0));
}

/**
 * Clear session + CSRF cookies. Expires both the Secure and non-Secure
 * variants so a hop between http (LAN/VPN) and https still signs out.
 */
export function clearSessionCookies(c: Context): void {
  for (const secure of [true, false]) {
    expireCookie(c, SESSION_COOKIE, true, secure);
    expireCookie(c, CSRF_COOKIE, false, secure);
  }
}

export function applySessionCookies(
  c: Context,
  token: string,
  expiresAt: number,
  secure: boolean,
  csrfToken?: string,
): { csrfToken: string } {
  const ttl = Math.max(0, expiresAt - Math.floor(Date.now() / 1000));
  const csrf = csrfToken && csrfToken.length >= 16 ? csrfToken : mintCsrfToken();
  setCookie(c, SESSION_COOKIE, token, cookieBase(secure, true, ttl));
  setCookie(c, CSRF_COOKIE, csrf, cookieBase(secure, false, ttl));
  return { csrfToken: csrf };
}

/** Reuse an existing CSRF cookie, or mint and set a new one. */
export function ensureCsrfCookie(
  c: Context,
  expiresAt: number,
  secure: boolean,
): string {
  const existing = readCsrfCookie(c);
  if (existing && existing.length >= 16) return existing;
  const csrf = mintCsrfToken();
  const ttl = Math.max(0, expiresAt - Math.floor(Date.now() / 1000));
  setCookie(c, CSRF_COOKIE, csrf, cookieBase(secure, false, ttl));
  return csrf;
}

export function timingSafeStringEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length || left.length === 0) {
    return false;
  }
  return timingSafeEqual(left, right);
}

export function assertCsrf(c: Context): void {
  const cookie = readCsrfCookie(c) || "";
  const header = (c.req.header(CSRF_HEADER) || "").trim();
  if (!cookie || !header || !timingSafeStringEqual(cookie, header)) {
    throw new HttpError(403, {
      code: "csrf",
      message: "CSRF token missing or invalid",
    });
  }
}

/**
 * CSRF is required for unsafe methods when the request presents a session
 * cookie and is not authenticating with an Authorization Bearer header
 * (MCP, presence, CLI). Exempt pre-session form routes.
 */
export function csrfRequired(c: Context, hasBearer: boolean): boolean {
  const method = c.req.method.toUpperCase();
  if (!UNSAFE.has(method)) return false;
  if (hasBearer) return false;
  let path = c.req.path;
  try {
    path = new URL(c.req.url).pathname;
  } catch {
    /* keep path */
  }
  if (CSRF_EXEMPT_PATHS.has(path)) return false;
  return Boolean(readSessionCookie(c));
}
