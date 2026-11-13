/**
 * Local-seat lockout recovery eligibility.
 *
 * A human on a browser on the same machine as the service may sign in with
 * the correct PASSWORD while the human lockout is active. Eligibility is
 * decided ONLY by the real socket peer address (loopback) plus hard
 * refusals below. Never X-Forwarded-For, Host, or HOMEBASE_TRUSTED_PROXIES
 * as proof of locality — those are spoofable or would make tunneled
 * traffic look local.
 */
import { trustedProxyList } from "./config";
import { normalizeIp } from "./geo";

/** Headers that mean the request may have passed through a proxy or tunnel. */
export const FORWARDING_HEADER_NAMES = [
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "forwarded",
  "x-real-ip",
  "cf-connecting-ip",
  "true-client-ip",
] as const;

export type LocalSeatRefuseReason =
  | "trusted_proxies"
  | "forwarding_header"
  | "not_loopback"
  | "bearer_or_mcp"
  | "missing_socket_ip";

export type LocalSeatEligibility = {
  ok: boolean;
  reason?: LocalSeatRefuseReason;
  header?: string;
  socketIp: string;
};

function ipv4Parts(ip: string): number[] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const nums: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    nums.push(n);
  }
  return nums;
}

/**
 * True only for loopback: 127.0.0.0/8, ::1, and IPv4-mapped ::ffff:127.x.x.x
 * (normalizeIp unwraps :ffff:). LAN/VPN addresses are never local-seat.
 */
export function isLoopbackSocketIp(raw: string | null | undefined): boolean {
  const n = normalizeIp(raw);
  if (!n || n === "unknown") return false;
  const lower = n.toLowerCase();
  if (lower === "::1" || lower === "localhost") return true;
  const parts = ipv4Parts(n);
  if (parts) return parts[0] === 127;
  return false;
}

export function requestHasForwardingHeader(
  headers: Headers,
): { present: boolean; header?: string } {
  for (const name of FORWARDING_HEADER_NAMES) {
    if (headers.has(name)) {
      return { present: true, header: name };
    }
  }
  return { present: false };
}

export function trustedProxiesConfigured(): boolean {
  return trustedProxyList().length > 0;
}

/** Any MCP / connector / Bearer credential disqualifies local-seat recovery. */
export function requestHasBearerOrMcpToken(headers: Headers): boolean {
  const auth = (headers.get("authorization") || "").trim();
  if (!auth) return false;
  if (/^bearer\s+\S+/i.test(auth)) return true;
  if (/hb_mcp_/.test(auth)) return true;
  return false;
}

/**
 * Decide whether THIS request may use the local-password lockout bypass.
 * Only the human password login route should call this; PIN, share, and
 * MCP paths must not.
 */
export function evaluateLocalSeatPasswordBypass(opts: {
  socketIp: string | null | undefined;
  headers: Headers;
}): LocalSeatEligibility {
  const socketIp = normalizeIp(opts.socketIp);
  if (trustedProxiesConfigured()) {
    return { ok: false, reason: "trusted_proxies", socketIp };
  }
  const fwd = requestHasForwardingHeader(opts.headers);
  if (fwd.present) {
    return {
      ok: false,
      reason: "forwarding_header",
      header: fwd.header,
      socketIp,
    };
  }
  if (!socketIp || socketIp === "unknown") {
    return { ok: false, reason: "missing_socket_ip", socketIp };
  }
  if (!isLoopbackSocketIp(socketIp)) {
    return { ok: false, reason: "not_loopback", socketIp };
  }
  if (requestHasBearerOrMcpToken(opts.headers)) {
    return { ok: false, reason: "bearer_or_mcp", socketIp };
  }
  return { ok: true, socketIp };
}
