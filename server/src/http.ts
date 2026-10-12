import type { Context } from "hono";
import { isAppPinLocked } from "./app_pin";
import { HttpError, bearerFromHeader, verifyAccessToken } from "./auth";
import { logError, logWarn } from "./console_log";
import { formatGeo, geoCached, normalizeIp, warmGeo } from "./geo";

/** Trusted peer header set by Bun.serve after stripping client spoofing. */
export const PEER_IP_HEADER = "x-homebase-peer";

export function clientIp(c: Context): string {
  const peer = c.req.header(PEER_IP_HEADER);
  if (peer) return normalizeIp(peer);
  const fwd = c.req.header("x-forwarded-for");
  if (fwd) return normalizeIp(fwd.split(",")[0]);
  const real = c.req.header("x-real-ip");
  if (real) return normalizeIp(real);
  return "unknown";
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
  const token =
    bearerFromHeader(c.req.header("authorization")) ||
    c.req.query("token") ||
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
