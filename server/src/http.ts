import type { Context } from "hono";
import { ZodError } from "zod";
import { isAppPinLocked } from "./app_pin";
import { HttpError, bearerFromHeader, verifyAccessToken } from "./auth";
import { trustedProxyList } from "./config";
import { readSessionCookie } from "./session_cookie";
import { logError, logWarn } from "./console_log";
import { formatGeo, geoCached, normalizeIp, warmGeo } from "./geo";

/** Trusted peer header set by Bun.serve after stripping client spoofing. */
export const PEER_IP_HEADER = "x-homebase-peer";

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (!Number.isInteger(v) || v < 0 || v > 255) return null;
    n = (n << 8) + v;
  }
  return n >>> 0;
}

/** IPv4 address or CIDR match. IPv6 only exact (or exact with zone stripped). */
export function ipMatchesAllowlist(ip: string, entries: string[]): boolean {
  const n = normalizeIp(ip);
  if (!n || n === "unknown") return false;
  for (const raw of entries) {
    const entry = raw.trim();
    if (!entry) continue;
    if (entry.includes("/")) {
      const [base, bitsStr] = entry.split("/", 2);
      const bits = Number(bitsStr);
      const a = ipv4ToInt(normalizeIp(base));
      const b = ipv4ToInt(n);
      if (a == null || b == null || !Number.isInteger(bits) || bits < 0 || bits > 32) {
        continue;
      }
      const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
      if ((a & mask) === (b & mask)) return true;
    } else if (normalizeIp(entry) === n) {
      return true;
    }
  }
  return false;
}

export function isTrustedProxyIp(ip: string): boolean {
  return ipMatchesAllowlist(ip, trustedProxyList());
}

/**
 * Client IP from the socket (injected as x-homebase-peer after spoofed
 * headers are stripped). X-Forwarded-For / X-Real-IP are used only when
 * that socket address is in HOMEBASE_TRUSTED_PROXIES.
 */
export function clientIp(c: Context): string {
  const socket = normalizeIp(c.req.header(PEER_IP_HEADER) || "");
  if (socket && socket !== "unknown" && isTrustedProxyIp(socket)) {
    const fwd = c.req.header("x-forwarded-for");
    const real = c.req.header("x-real-ip");
    const cand = (fwd || real || "").split(",")[0];
    const forwarded = normalizeIp(cand);
    if (forwarded !== "unknown") return forwarded;
  }
  if (socket && socket !== "unknown") return socket;
  return "unknown";
}

export function clientUserAgent(c: Context): string {
  return (c.req.header("user-agent") || "").trim().slice(0, 180);
}

/**
 * True when the client reached us over HTTPS (direct TLS, or
 * X-Forwarded-Proto: https from a socket in HOMEBASE_TRUSTED_PROXIES).
 * Session cookies are marked Secure only in this case. Plain HTTP
 * (localhost, LAN, WireGuard VPN IPs) must use a non-Secure cookie or
 * the browser will refuse to store it — only do that on a trusted network.
 */
export function requestIsHttps(c: Context): boolean {
  try {
    if (new URL(c.req.url).protocol === "https:") return true;
  } catch {
    /* ignore bad url */
  }
  const socket = normalizeIp(c.req.header(PEER_IP_HEADER) || "");
  if (!socket || socket === "unknown" || !isTrustedProxyIp(socket)) return false;
  const proto = ((c.req.header("x-forwarded-proto") || "").split(",")[0] || "")
    .trim()
    .toLowerCase();
  return proto === "https";
}

export function cookieSecure(c: Context): boolean {
  return requestIsHttps(c);
}

/** Browser requests with a mismatched Origin are rejected. Non-browser (no Origin) is allowed. */
export function assertSameOrigin(c: Context): void {
  const origin = (c.req.header("origin") || "").trim();
  if (!origin) return;
  let expected = "";
  try {
    const url = new URL(c.req.url);
    expected = `${url.protocol}//${url.host}`;
  } catch {
    return;
  }
  if (origin !== expected) {
    throw new HttpError(403, {
      code: "csrf_origin",
      message: "Request origin does not match this server",
    });
  }
}

export function clientIpFields(c: Context): Record<string, unknown> {
  const ip = clientIp(c);
  warmGeo(ip);
  const geo = geoCached(ip);
  return { ip, geo: formatGeo(geo) };
}

export async function requireAuth(
  c: Context,
  opts?: { allowPinLocked?: boolean },
): Promise<Record<string, unknown>> {
  // Prefer Authorization Bearer (MCP / presence / CLI). Otherwise the
  // HttpOnly session cookie. Query-string JWTs are no longer accepted.
  const token =
    bearerFromHeader(c.req.header("authorization")) ||
    readSessionCookie(c) ||
    undefined;
  const claims = await verifyAccessToken(token, clientIp(c));
  if (!opts?.allowPinLocked && isAppPinLocked()) {
    throw new HttpError(423, {
      code: "pin_locked",
      message: "App PIN required",
    });
  }
  return claims;
}

export function jsonError(c: Context, err: unknown): Response {
  const ipFields = (() => {
    try {
      return clientIpFields(c);
    } catch {
      return {};
    }
  })();
  const path = (() => {
    try {
      return new URL(c.req.url).pathname;
    } catch {
      return c.req.path;
    }
  })();
  const method = c.req.method;

  if (err instanceof HttpError) {
    const detail =
      typeof err.detail === "string"
        ? err.detail
        : JSON.stringify(err.detail);
    if (err.status >= 500) {
      logError(`${method} ${path} → ${err.status} ${detail}`, {
        source: "http",
        fields: ipFields,
      });
    } else if (
      err.status === 401 ||
      err.status === 403 ||
      err.status === 423 ||
      err.status === 429
    ) {
      // /api/login failures are already journaled by auth.recordFailure
      if (!(err.status === 401 && path === "/api/login")) {
        logWarn(`${method} ${path} → ${err.status} ${detail}`, {
          source: "http",
          fields: ipFields,
        });
      }
    }
    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...err.headers,
    };
    return new Response(JSON.stringify({ detail: err.detail }), {
      status: err.status,
      headers,
    });
  }
  // Zod validation (e.g. blocked/unknown git action enum) → clean 400, not 500.
  if (err instanceof ZodError) {
    const issue = err.issues[0];
    const where = issue?.path?.length ? `${issue.path.join(".")}: ` : "";
    const detail = `${where}${issue?.message || "invalid request"}`.slice(0, 400);
    logWarn(`${method} ${path} → 400 ${detail}`, {
      source: "http",
      fields: ipFields,
    });
    return c.json({ detail }, 400);
  }
  const msg = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;
  logError(`${method} ${path} → 500 ${msg}`, {
    source: "http",
    fields: { ...ipFields, ...(stack ? { stack: stack.split("\n").slice(0, 4).join(" | ") } : {}) },
  });
  return c.json({ detail: msg }, 500);
}

export async function readJson<T>(c: Context): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    throw new HttpError(400, "invalid json");
  }
}
