import { randomBytes } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { hostname as osHostname } from "node:os";
import { HttpError, JWT_TTL_SEC, assertNotLocked, issueJwt, passwordIsSet, recordSuccess } from "./auth";

export const SHARE_TTL_SEC = 20;

type ShareSession = {
  id: string;
  expiresAt: number;
  consumed: boolean;
};

let session: ShareSession | null = null;

export function mdnsHostname(): string {
  for (const conf of [
    "/etc/avahi/avahi-daemon.conf",
    "/usr/local/etc/avahi/avahi-daemon.conf",
  ]) {
    try {
      if (!existsSync(conf)) continue;
      for (const line of readFileSync(conf, "utf8").split("\n")) {
        const t = line.trim();
        if (t.startsWith("#") || !t.includes("=")) continue;
        const [key, ...rest] = t.split("=");
        const val = rest.join("=").trim();
        if (key?.trim().toLowerCase() === "host-name" && val) {
          const short = val.split(".")[0]!;
          return `${short}.local`;
        }
      }
    } catch {
      /* continue */
    }
  }
  let host = "localhost";
  try {
    host = osHostname().trim() || "localhost";
  } catch {
    /* ignore */
  }
  const short = host.split(".")[0]!.trim() || "localhost";
  if (short.toLowerCase().endsWith(".local")) return short.toLowerCase();
  return `${short}.local`;
}

function urlIsLoopback(url: string): boolean {
  if (!url) return false;
  return (
    url.includes("://localhost") ||
    url.includes("://127.0.0.1") ||
    url.includes("://[::1]")
  );
}

function hostIsLoopback(h: string): boolean {
  return h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1";
}

export function isLocalhostBrowser(headers: Headers): boolean {
  const origin = (headers.get("origin") || "").trim().toLowerCase();
  const referer = (headers.get("referer") || "").trim().toLowerCase();
  const fwdHost = (headers.get("x-forwarded-host") || "").split(",")[0]!.trim().toLowerCase();
  const host = (fwdHost || headers.get("host") || "").split(":")[0]!.toLowerCase();
  if (origin) return urlIsLoopback(origin);
  if (referer) return urlIsLoopback(referer);
  return hostIsLoopback(host);
}

export function requireLocalhostBrowser(headers: Headers): void {
  if (!isLocalhostBrowser(headers)) {
    throw new HttpError(403, "This action is only available when using localhost");
  }
}

function purgeIfStale(now = Date.now() / 1000): void {
  if (!session) return;
  if (session.consumed || now >= session.expiresAt) session = null;
}

export function shareStatus(): Record<string, unknown> {
  purgeIfStale();
  if (!session) {
    return {
      active: false,
      consumed: false,
      expiresIn: 0,
      shareId: null,
      hostname: mdnsHostname(),
    };
  }
  const now = Date.now() / 1000;
  return {
    active: true,
    consumed: Boolean(session.consumed),
    expiresIn: Math.max(0, Math.floor(session.expiresAt - now)),
    shareId: session.id,
    hostname: mdnsHostname(),
  };
}

export function shareReveal(port: number, protocol: string): Record<string, unknown> {
  if (!passwordIsSet()) {
    throw new HttpError(400, "Set a password before sharing");
  }
  const id = randomBytes(12).toString("hex");
  const expiresAt = Date.now() / 1000 + SHARE_TTL_SEC;
  session = { id, expiresAt, consumed: false };
  const host = mdnsHostname();
  const proto = protocol === "https" ? "https" : "http";
  const loginUrl = `${proto}://${host}:${port}/?hb_share=${id}`;
  return {
    shareId: id,
    loginUrl,
    expiresIn: SHARE_TTL_SEC,
    hostname: host,
    port,
  };
}

export function shareHide(): { ok: boolean; active: boolean } {
  session = null;
  return { ok: true, active: false };
}

export async function shareRedeem(
  shareId: string,
): Promise<{
  ok: boolean;
  token: string;
  expiresAt: number;
  expiresIn: number;
  shareConsumed: boolean;
}> {
  assertNotLocked();
  if (!passwordIsSet()) {
    throw new HttpError(503, "Password not set");
  }
  purgeIfStale();
  if (!session || session.id !== shareId || session.consumed) {
    throw new HttpError(401, {
      message: "Share link invalid or expired",
      code: "invalid_share",
    });
  }
  session.consumed = true;
  recordSuccess();
  const jwt = await issueJwt({ kind: "session", ttl: JWT_TTL_SEC });
  session = null;
  return { ok: true, ...jwt, shareConsumed: true };
}
