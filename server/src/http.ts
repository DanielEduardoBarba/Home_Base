import type { Context } from "hono";
import { HttpError, bearerFromHeader, verifyAccessToken } from "./auth";

export function clientIp(c: Context): string {
  const fwd = c.req.header("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]!.trim();
  return "unknown";
}

export async function requireAuth(c: Context): Promise<Record<string, unknown>> {
  const token =
    bearerFromHeader(c.req.header("authorization")) ||
    c.req.query("token") ||
    undefined;
  return verifyAccessToken(token, clientIp(c));
}

export function jsonError(c: Context, err: unknown): Response {
  if (err instanceof HttpError) {
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
  return c.json({ detail: msg }, 500);
}

export async function readJson<T>(c: Context): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    throw new HttpError(400, "invalid json");
  }
}
