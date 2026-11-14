/**
 * Local CA + server cert for VPN/LAN HTTPS (iOS secure context).
 * Certs live under .runtime/tls/ — never commit private keys.
 *
 * HTTP keeps working for MCP clients; HTTPS is an optional second listener.
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { RUNTIME_DIR, bindPort } from "./config";
import { lanHost, vpnHost } from "./network";

export const TLS_DIR = join(RUNTIME_DIR, "tls");
export const CA_KEY_PATH = join(TLS_DIR, "ca.key");
export const CA_CERT_PATH = join(TLS_DIR, "ca.crt");
export const SERVER_KEY_PATH = join(TLS_DIR, "server.key");
export const SERVER_CERT_PATH = join(TLS_DIR, "server.crt");

const DEFAULT_HTTPS_PORT = 8443;

export function httpsPort(): number {
  const raw = (process.env.HOMEBASE_HTTPS_PORT || "").trim();
  if (raw === "0" || raw.toLowerCase() === "off" || raw.toLowerCase() === "disabled") {
    return 0;
  }
  if (!raw) return DEFAULT_HTTPS_PORT;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_HTTPS_PORT;
}

export function tlsMaterialPresent(): boolean {
  return (
    existsSync(CA_CERT_PATH) &&
    existsSync(SERVER_KEY_PATH) &&
    existsSync(SERVER_CERT_PATH)
  );
}

function opensslAvailable(): boolean {
  const r = spawnSync("openssl", ["version"], { encoding: "utf8" });
  return r.status === 0;
}

function sanHosts(): string[] {
  const hosts = new Set<string>([
    "localhost",
    "127.0.0.1",
    "::1",
    "homebase.local",
    "10.6.0.1",
  ]);
  const lan = lanHost();
  const vpn = vpnHost();
  if (lan) hosts.add(lan);
  if (vpn) hosts.add(vpn);
  const extra = (process.env.HOMEBASE_TLS_SANS || "")
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const h of extra) hosts.add(h);
  return [...hosts];
}

function writeSanExt(path: string, hosts: string[]): void {
  const dns: string[] = [];
  const ip: string[] = [];
  for (const h of hosts) {
    if (/^\d+\.\d+\.\d+\.\d+$/.test(h) || h.includes(":")) ip.push(h);
    else dns.push(h);
  }
  const lines = ["subjectAltName = @alt_names", "[alt_names]"];
  dns.forEach((d, i) => lines.push(`DNS.${i + 1} = ${d}`));
  ip.forEach((addr, i) => lines.push(`IP.${i + 1} = ${addr}`));
  writeFileSync(path, lines.join("\n") + "\n", { mode: 0o600 });
}

/**
 * Idempotent: create local CA + server cert if missing.
 * Returns { ok, created, error? }.
 */
export function ensureLocalTlsCerts(opts: { force?: boolean } = {}): {
  ok: boolean
  created: boolean
  dir: string
  error?: string
  hosts?: string[]
} {
  try {
    mkdirSync(TLS_DIR, { recursive: true });
  } catch (e) {
    return {
      ok: false,
      created: false,
      dir: TLS_DIR,
      error: e instanceof Error ? e.message : String(e),
    };
  }

  if (!opts.force && tlsMaterialPresent()) {
    return { ok: true, created: false, dir: TLS_DIR, hosts: sanHosts() };
  }

  if (!opensslAvailable()) {
    return {
      ok: false,
      created: false,
      dir: TLS_DIR,
      error: "openssl not found — install openssl to generate local HTTPS certs",
    };
  }

  const hosts = sanHosts();
  const sanPath = join(TLS_DIR, "san.cnf");
  writeSanExt(sanPath, hosts);

  const run = (args: string[]): { ok: boolean; err: string } => {
    const r = spawnSync("openssl", args, { encoding: "utf8" });
    if (r.status !== 0) {
      return {
        ok: false,
        err: ((r.stderr || r.stdout || "") + "").trim().slice(0, 400) || "openssl failed",
      };
    }
    return { ok: true, err: "" };
  };

  // CA
  let step = run([
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-sha256",
    "-days",
    "3650",
    "-nodes",
    "-keyout",
    CA_KEY_PATH,
    "-out",
    CA_CERT_PATH,
    "-subj",
    "/O=Home Base/CN=Home Base Local CA",
  ]);
  if (!step.ok) {
    return { ok: false, created: false, dir: TLS_DIR, error: step.err };
  }

  // Server key + CSR
  step = run([
    "req",
    "-newkey",
    "rsa:2048",
    "-sha256",
    "-nodes",
    "-keyout",
    SERVER_KEY_PATH,
    "-out",
    join(TLS_DIR, "server.csr"),
    "-subj",
    "/O=Home Base/CN=homebase.local",
  ]);
  if (!step.ok) {
    return { ok: false, created: false, dir: TLS_DIR, error: step.err };
  }

  // Sign with CA + SANs
  step = run([
    "x509",
    "-req",
    "-in",
    join(TLS_DIR, "server.csr"),
    "-CA",
    CA_CERT_PATH,
    "-CAkey",
    CA_KEY_PATH,
    "-CAcreateserial",
    "-out",
    SERVER_CERT_PATH,
    "-days",
    "825",
    "-sha256",
    "-extfile",
    sanPath,
  ]);
  if (!step.ok) {
    return { ok: false, created: false, dir: TLS_DIR, error: step.err };
  }

  try {
    for (const p of [CA_KEY_PATH, SERVER_KEY_PATH]) {
      spawnSync("chmod", ["600", p]);
    }
  } catch {
    /* ignore */
  }

  return { ok: true, created: true, dir: TLS_DIR, hosts };
}

export function loadTlsServeMaterial(): {
  key: Buffer
  cert: Buffer
  ca: Buffer
} | null {
  if (!tlsMaterialPresent()) return null;
  try {
    return {
      key: readFileSync(SERVER_KEY_PATH),
      cert: readFileSync(SERVER_CERT_PATH),
      ca: readFileSync(CA_CERT_PATH),
    };
  } catch {
    return null;
  }
}

export function readCaCertPem(): string | null {
  if (!existsSync(CA_CERT_PATH)) return null;
  try {
    return readFileSync(CA_CERT_PATH, "utf8");
  } catch {
    return null;
  }
}

export function tlsStatusPublic(): {
  enabled: boolean
  httpsPort: number | null
  httpPort: number
  materialPresent: boolean
  caDownloadPath: string
  trustHint: string
  urls: {
    vpnHttp: string | null
    vpnHttps: string | null
    lanHttp: string | null
    lanHttps: string | null
  }
} {
  const http = bindPort();
  const https = httpsPort();
  const present = tlsMaterialPresent();
  const enabled = present && https > 0;
  const vpn = vpnHost();
  const lan = lanHost();
  return {
    enabled,
    httpsPort: enabled ? https : null,
    httpPort: http,
    materialPresent: present,
    caDownloadPath: "/api/tls/ca.crt",
    trustHint:
      "On iPhone/iPad: download the CA over HTTP, install the profile, then Settings → General → About → Certificate Trust Settings → enable full trust for Home Base Local CA. Open the https:// VPN URL for Talk.",
    urls: {
      vpnHttp: vpn ? `http://${vpn}:${http}/` : null,
      vpnHttps: enabled && vpn ? `https://${vpn}:${https}/` : null,
      lanHttp: lan ? `http://${lan}:${http}/` : null,
      lanHttps: enabled && lan ? `https://${lan}:${https}/` : null,
    },
  };
}
