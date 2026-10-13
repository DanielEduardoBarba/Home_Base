/**
 * Hono middleware: API request access log for journalctl.
 * Quiets high-frequency poll/static paths at info; always logs errors.
 */

import type { Context, Next } from "hono";
import { log, type LogLevel } from "./console_log";
import { clientIpFields } from "./http";

const QUIET_EXACT = new Set([
  "/api/health",
  "/api/version",
  "/api/lockout",
  "/api/trace",
  "/api/notifications",
  "/api/view/status",
  "/api/auth/status",
  "/api/legal",
  "/api/sudo/status",
  "/api/share/status",
  "/api/system/status",
]);

const QUIET_PREFIX = ["/api/trace/", "/assets/", "/_next/"];

function isQuietPath(path: string): boolean {
  if (QUIET_EXACT.has(path)) return true;
  return QUIET_PREFIX.some((p) => path.startsWith(p));
}

function shortUa(ua: string | undefined): string | undefined {
  if (!ua) return undefined;
  const s = ua.length > 48 ? `${ua.slice(0, 45)}…` : ua;
  return s.replace(/\s+/g, " ");
}

export async function requestLogMiddleware(c: Context, next: Next): Promise<void> {
  const started = performance.now();
  const path = new URL(c.req.url).pathname;
  const method = c.req.method;
  const quiet = isQuietPath(path) || !path.startsWith("/api/");

  try {
    await next();
  } catch (err) {
    // jsonError / onError already emit a journal line — avoid a duplicate.
    throw err;
  }

  const status = c.res?.status ?? 0;
  const ms = Math.round(performance.now() - started);
  // Thrown HttpErrors that onError already logged still produce a response;
  // skip a second access line for those auth/server failures.
  if (status === 401 || status === 403 || status === 429 || status >= 500) {
    return;
  }

  const fields = {
    ...clientIpFields(c),
    status,
    ms,
    ua: shortUa(c.req.header("user-agent")),
  };

  let level: LogLevel = "info";
  if (quiet && status < 400) level = "debug";
  else if (status >= 400) level = "warn";

  log(level, `${method} ${path}`, { source: "http", fields });
}
