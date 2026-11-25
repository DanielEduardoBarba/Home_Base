/**
 * Bind host selection for Unity WebGL preview (HB-U-02).
 * Keep in sync with scripts/unity/webgl-bind.mjs (copied into workspaces).
 */
import { networkInterfaces } from "node:os";
import { spawnSync } from "node:child_process";

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

/** Read wg0 IPv4 from `ip` or os.networkInterfaces (no privileged ops). */
export function readWg0Ipv4(): string | null {
  try {
    const proc = spawnSync("ip", ["-o", "-4", "addr", "show", "dev", "wg0"], {
      encoding: "utf8",
    });
    if (proc.status === 0 && proc.stdout) {
      for (const line of proc.stdout.split("\n")) {
        const m = line.match(/\binet\s+(\d{1,3}(?:\.\d{1,3}){3})\b/);
        if (m && isUsableIpv4(m[1]!)) return m[1]!;
      }
    }
  } catch {
    /* fall through */
  }
  try {
    const ifaces = networkInterfaces();
    const addrs = ifaces.wg0 || [];
    for (const a of addrs) {
      if (a && a.family === "IPv4" && isUsableIpv4(a.address)) return a.address;
    }
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * Prefer HB_WEBGL_BIND, else wg0 IPv4, else 127.0.0.1.
 * Never defaults to 0.0.0.0 (explicit HB_WEBGL_BIND=0.0.0.0 is allowed).
 */
export function resolveWebglBind(opts: {
  env?: Record<string, string | undefined>;
  wg0Ipv4?: string | null;
} = {}): string {
  const env = opts.env ?? process.env;
  const raw = String(env.HB_WEBGL_BIND || "").trim();
  if (raw) return raw;
  const wg =
    opts.wg0Ipv4 !== undefined ? opts.wg0Ipv4 : readWg0Ipv4();
  if (wg && isUsableIpv4(String(wg).trim())) return String(wg).trim();
  return "127.0.0.1";
}
