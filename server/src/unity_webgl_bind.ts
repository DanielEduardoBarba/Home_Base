/**
 * Bind host selection for Unity WebGL preview (HB-U-02).
 * Keep in sync with scripts/unity/webgl-bind.mjs (copied into workspaces).
 */

const IPV4_RE = /^(?:\d{1,3}\.){3}\d{1,3}$/;

function isUsableIpv4(ip: string): boolean {
  if (!IPV4_RE.test(ip)) return false;
  const parts = ip.split(".").map(Number);
  if (parts.some((n) => n < 0 || n > 255)) return false;
  if (parts[0] === 127) return false;
  if (parts[0] === 169 && parts[1] === 254) return false;
  if (parts[0] === 0) return false;
  return true;
}

/**
 * Prefer HB_WEBGL_BIND, else wg0 IPv4, else 127.0.0.1.
 * Never defaults to 0.0.0.0 (explicit HB_WEBGL_BIND=0.0.0.0 is allowed).
 */
export function resolveWebglBind(opts: {
  env?: Record<string, string | undefined>;
  wg0Ipv4?: string | null;
}): string {
  const env = opts.env ?? {};
  const raw = String(env.HB_WEBGL_BIND || "").trim();
  if (raw) return raw;
  const wg = opts.wg0Ipv4;
  if (wg && isUsableIpv4(String(wg).trim())) return String(wg).trim();
  return "127.0.0.1";
}
