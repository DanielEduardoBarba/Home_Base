/**
 * Client IP classification + optional public geo lookup (cached).
 * Private / VPN / loopback addresses are labeled locally — no external call.
 */

import { logDebug, logWarn } from "./console_log";

export type GeoInfo = {
  ip: string;
  label: string;
  kind: "loopback" | "private" | "linklocal" | "cgnat" | "public" | "unknown";
  country?: string;
  region?: string;
  city?: string;
};

const cache = new Map<string, { info: GeoInfo; expires: number }>();
const inflight = new Map<string, Promise<GeoInfo>>();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const NEGATIVE_TTL_MS = 60 * 60 * 1000;

export function normalizeIp(raw: string | null | undefined): string {
  let ip = (raw || "").trim();
  if (!ip) return "unknown";
  // Strip IPv6 zone / brackets, unwrap :ffff: mapped IPv4
  if (ip.startsWith("[") && ip.endsWith("]")) ip = ip.slice(1, -1);
  const zone = ip.indexOf("%");
  if (zone >= 0) ip = ip.slice(0, zone);
  if (ip.startsWith("::ffff:")) ip = ip.slice(7);
  return ip || "unknown";
}

export function classifyIp(ip: string): GeoInfo {
  const n = normalizeIp(ip);
  if (n === "unknown") {
    return { ip: n, label: "unknown", kind: "unknown" };
  }
  if (n === "127.0.0.1" || n === "::1" || n === "localhost") {
    return { ip: n, label: "loopback", kind: "loopback" };
  }
  if (n.includes(":")) {
    const lower = n.toLowerCase();
    if (lower.startsWith("fc") || lower.startsWith("fd")) {
      return { ip: n, label: "private/ULA", kind: "private" };
    }
    if (lower.startsWith("fe80:")) {
      return { ip: n, label: "link-local", kind: "linklocal" };
    }
    return { ip: n, label: "public", kind: "public" };
  }
  const parts = n.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isFinite(p))) {
    return { ip: n, label: "unknown", kind: "unknown" };
  }
  const [a, b] = parts;
  if (a === 127) return { ip: n, label: "loopback", kind: "loopback" };
  if (a === 10) return { ip: n, label: "private/VPN", kind: "private" };
  if (a === 192 && b === 168) return { ip: n, label: "LAN", kind: "private" };
  if (a === 172 && b != null && b >= 16 && b <= 31) {
    return { ip: n, label: "private", kind: "private" };
  }
  if (a === 169 && b === 254) {
    return { ip: n, label: "link-local", kind: "linklocal" };
  }
  if (a === 100 && b != null && b >= 64 && b <= 127) {
    return { ip: n, label: "CGNAT", kind: "cgnat" };
  }
  return { ip: n, label: "public", kind: "public" };
}

export function formatGeo(info: GeoInfo): string {
  if (info.kind !== "public") return info.label;
  const bits = [info.city, info.region, info.country].filter(Boolean);
  return bits.length ? bits.join(", ") : info.label;
}

async function lookupPublic(ip: string): Promise<GeoInfo> {
  const base = classifyIp(ip);
  try {
    // Free, no-key JSON API; fields trimmed for size. Fail soft.
    const url = `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,message,country,countryCode,regionName,city,query`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(2500),
      headers: { accept: "application/json" },
    });
    if (!res.ok) {
      logDebug(`geo lookup HTTP ${res.status}`, {
        source: "geo",
        fields: { ip },
      });
      return base;
    }
    const data = (await res.json()) as {
      status?: string;
      message?: string;
      country?: string;
      countryCode?: string;
      regionName?: string;
      city?: string;
    };
    if (data.status !== "success") {
      logDebug(`geo lookup miss: ${data.message || "failed"}`, {
        source: "geo",
        fields: { ip },
      });
      return base;
    }
    const country = data.countryCode || data.country || undefined;
    return {
      ...base,
      country,
      region: data.regionName || undefined,
      city: data.city || undefined,
      label: formatGeo({
        ...base,
        country,
        region: data.regionName || undefined,
        city: data.city || undefined,
      }),
    };
  } catch (e) {
    logWarn(`geo lookup error: ${e instanceof Error ? e.message : String(e)}`, {
      source: "geo",
      fields: { ip },
    });
    return base;
  }
}

/** Sync best-effort (cache / private). Does not start a network lookup. */
export function geoCached(ip: string): GeoInfo {
  const n = normalizeIp(ip);
  const hit = cache.get(n);
  if (hit && hit.expires > Date.now()) return hit.info;
  return classifyIp(n);
}

/**
 * Resolve geo for an IP. Private addresses return immediately.
 * Public IPs are looked up once and cached (24h).
 */
export async function resolveGeo(ip: string): Promise<GeoInfo> {
  const n = normalizeIp(ip);
  const hit = cache.get(n);
  if (hit && hit.expires > Date.now()) return hit.info;

  const classified = classifyIp(n);
  if (classified.kind !== "public") {
    cache.set(n, { info: classified, expires: Date.now() + CACHE_TTL_MS });
    return classified;
  }

  const pending = inflight.get(n);
  if (pending) return pending;

  const job = lookupPublic(n).then((info) => {
    const ttl = info.city || info.country ? CACHE_TTL_MS : NEGATIVE_TTL_MS;
    cache.set(n, { info, expires: Date.now() + ttl });
    inflight.delete(n);
    return info;
  });
  inflight.set(n, job);
  return job;
}

/** Fire-and-forget warm of the geo cache (never throws). */
export function warmGeo(ip: string): void {
  void resolveGeo(ip).catch(() => {});
}

/** Test helper */
export function clearGeoCache(): void {
  cache.clear();
  inflight.clear();
}
