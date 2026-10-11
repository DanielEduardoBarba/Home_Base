/**
 * Reachable host IPs for Expo Metro + project API URLs.
 * Prefer native Wi‑Fi/Ethernet LAN (192.168.x) over WireGuard/VPN (10.x on wg*).
 */

const VPN_PREFIXES = ["wg", "tun", "tailscale", "zt", "nebula", "ipsec"];
const SKIP_IFACE_PREFIXES = ["docker", "br-", "veth", "virbr", "lxc", "cni", "flannel"];

function isUsableIpv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) {
    return false;
  }
  if (parts[0] === 127) return false; // loopback
  if (parts[0] === 169 && parts[1] === 254) return false; // link-local
  if (parts[0] === 0) return false;
  return true;
}

function isPrivateIpv4(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number);
  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b != null && b >= 16 && b <= 31) return true;
  return false;
}

function isVpnIface(iface: string): boolean {
  const name = iface.toLowerCase();
  return VPN_PREFIXES.some((p) => name === p || name.startsWith(p));
}

function isSkippedIface(iface: string): boolean {
  const name = iface.toLowerCase();
  if (name === "lo" || name.startsWith("lo")) return true;
  return SKIP_IFACE_PREFIXES.some((p) => name === p || name.startsWith(p));
}

/** Prefer classic home Wi‑Fi / Ethernet naming. */
function lanScore(iface: string, ip: string): number {
  const name = iface.toLowerCase();
  let score = 0;
  if (ip.startsWith("192.168.")) score += 100;
  else if (isPrivateIpv4(ip)) score += 40;
  if (
    name.startsWith("wl") ||
    name.startsWith("wlan") ||
    name.startsWith("en") ||
    name.startsWith("eth") ||
    name.startsWith("em")
  ) {
    score += 50;
  }
  return score;
}

export function listIpv4Interfaces(): { iface: string; ip: string }[] {
  try {
    const proc = Bun.spawnSync(["ip", "-o", "-4", "addr", "show"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (proc.exitCode !== 0) return [];
    const out: { iface: string; ip: string }[] = [];
    for (const line of proc.stdout.toString().split("\n")) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 4) continue;
      const iface = (parts[1] || "").split("@", 1)[0]!;
      if (isSkippedIface(iface)) continue;
      const cidr = parts[3] || "";
      const ip = cidr.split("/", 1)[0]!;
      if (isUsableIpv4(ip)) out.push({ iface, ip });
    }
    return out;
  } catch {
    return [];
  }
}

/** Pure selection used by advertiseHost (and unit tests). */
export function pickAdvertiseHost(
  addrs: { iface: string; ip: string }[],
  override = "",
): string | null {
  const o = override.trim();
  if (o && isUsableIpv4(o)) return o;
  if (o && !o.startsWith("[") && o.toLowerCase() !== "localhost" && o !== "0.0.0.0") {
    return o;
  }

  const lan = addrs
    .filter((a) => !isVpnIface(a.iface) && isPrivateIpv4(a.ip))
    .sort((a, b) => lanScore(b.iface, b.ip) - lanScore(a.iface, a.ip));
  if (lan[0]) return lan[0].ip;

  const vpn = addrs.find((a) => isVpnIface(a.iface));
  if (vpn) return vpn.ip;

  const anyPrivate = addrs.find((a) => isPrivateIpv4(a.ip));
  if (anyPrivate) return anyPrivate.ip;

  return addrs[0]?.ip ?? null;
}

/**
 * IPv4 phones on the same Wi‑Fi should use for Metro + API.
 * Order: HOMEBASE_ADVERTISE_HOST → best non-VPN LAN (192.168 preferred) → VPN → any.
 */
export function advertiseHost(): string | null {
  return pickAdvertiseHost(
    listIpv4Interfaces(),
    process.env.HOMEBASE_ADVERTISE_HOST || "",
  );
}

/** Env injected into run/expo PTYs (Metro QR + EXPO/NEXT public API). */
export function projectLanEnv(
  projectPorts: { id: string; port: number }[],
): Record<string, string> {
  const env: Record<string, string> = { HOSTNAME: "0.0.0.0" };
  const host = advertiseHost();
  if (!host) return env;

  env.HOMEBASE_ADVERTISE_HOST = host;
  env.REACT_NATIVE_PACKAGER_HOSTNAME = host;

  const ports = new Map(projectPorts.map((p) => [p.id, p.port]));
  const apiPort = ports.get("api");
  const webPort = ports.get("web");

  if (apiPort) {
    const apiBase = `http://${host}:${apiPort}/api/v1`;
    env.EXPO_PUBLIC_API_URL = apiBase;
    env.NEXT_PUBLIC_API_URL = apiBase;
  }
  if (webPort) {
    const webOrigin = `http://${host}:${webPort}`;
    env.WEB_ORIGIN = webOrigin;
    env.NEXT_PUBLIC_SITE_URL = webOrigin;
  }
  return env;
}
