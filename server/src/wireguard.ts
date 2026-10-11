/**
 * WireGuard laptop VPN: install, setup, start/stop, clients + QR config, uninstall.
 * State (client private keys for re-QR) lives under RUNTIME_DIR/wireguard (mode 0600).
 * Server keys live in /etc/wireguard/<iface>.conf like a normal wg-quick install.
 */
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { HttpError } from "./auth";
import { RUNTIME_DIR, ensureRuntimeDirs } from "./config";
import { listIpv4Interfaces, lanHost, vpnHost } from "./network";
import { appendTrace } from "./trace";

export const DEFAULT_IFACE = "wg0";
export const DEFAULT_LISTEN_PORT = 51820;
export const DEFAULT_VPN_CIDR = "10.6.0.0/24";
export const DEFAULT_SERVER_ADDR = "10.6.0.1/24";

const WG_DIR = "/etc/wireguard";
const SYSCTL_FORWARD = "/etc/sysctl.d/99-homebase-wireguard.conf";
const SYSCTL_VPN = "/etc/sysctl.d/99-homebase-vpn.conf";

export type WgClientRecord = {
  id: string;
  name: string;
  address: string; // e.g. 10.6.0.2/32
  publicKey: string;
  privateKey: string;
  createdAt: number;
};

export type WgState = {
  iface: string;
  listenPort: number;
  vpnCidr: string;
  serverAddress: string;
  endpoint: string;
  lanCidr: string;
  lanHost: string;
  outboundIface: string;
  dns: string;
  managedByHomebase: boolean;
  createdAt: number;
  updatedAt: number;
};

function stateDir(): string {
  return join(RUNTIME_DIR, "wireguard");
}

function clientsDir(): string {
  return join(stateDir(), "clients");
}

function statePath(): string {
  return join(stateDir(), "state.json");
}

function confPath(iface: string): string {
  return join(WG_DIR, `${iface}.conf`);
}

function unitName(iface: string): string {
  return `wg-quick@${iface}`;
}

function requireRoot(): void {
  if (process.getuid?.() !== 0) {
    throw new HttpError(
      403,
      "WireGuard setup needs root (production homebased runs as root)",
    );
  }
}

function run(
  cmd: string,
  args: string[],
  opts: { timeoutMs?: number; env?: Record<string, string> } = {},
): { ok: boolean; out: string; code: number } {
  const r = spawnSync(cmd, args, {
    encoding: "utf8",
    timeout: opts.timeoutMs ?? 120_000,
    env: { ...process.env, ...opts.env },
  });
  const out = `${r.stdout || ""}${r.stderr || ""}`.trim();
  return { ok: r.status === 0, out, code: r.status ?? 1 };
}

function systemctl(...args: string[]): { ok: boolean; out: string } {
  const r = run("systemctl", args, { timeoutMs: 60_000 });
  return { ok: r.ok, out: r.out };
}

export function sanitizeIface(name: string): string {
  const s = name.trim().toLowerCase();
  if (!/^[a-z][a-z0-9_-]{0,14}$/.test(s)) {
    throw new HttpError(400, "invalid interface name");
  }
  return s;
}

export function sanitizeClientId(name: string): string {
  const s = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  if (!s) throw new HttpError(400, "invalid client name");
  return s;
}

/** Parse "10.6.0.0/24" → network parts + prefix. */
export function parseCidr(cidr: string): {
  a: number;
  b: number;
  c: number;
  d: number;
  prefix: number;
} {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(
    cidr.trim(),
  );
  if (!m) throw new HttpError(400, `invalid CIDR: ${cidr}`);
  const nums = m.slice(1, 5).map(Number);
  const prefix = Number(m[5]);
  if (nums.some((n) => n > 255) || prefix < 8 || prefix > 30) {
    throw new HttpError(400, `invalid CIDR: ${cidr}`);
  }
  return { a: nums[0]!, b: nums[1]!, c: nums[2]!, d: nums[3]!, prefix };
}

export function lanCidrFromHost(ip: string): string {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
    return "192.168.0.0/24";
  }
  return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
}

export function dnsFromLanHost(ip: string): string {
  const parts = ip.split(".");
  if (parts.length !== 4) return "1.1.1.1";
  return `${parts[0]}.${parts[1]}.${parts[2]}.1`;
}

/** Allocate next free host in /24 VPN (skip .0 and .1 server). */
export function nextClientAddress(
  vpnCidr: string,
  used: string[],
): string {
  const net = parseCidr(vpnCidr);
  if (net.prefix !== 24) {
    throw new HttpError(400, "only /24 VPN networks are supported");
  }
  const usedHosts = new Set(
    used.map((a) => {
      const ip = a.split("/")[0] || "";
      return ip.split(".").pop() || "";
    }),
  );
  usedHosts.add("0");
  usedHosts.add("1"); // server
  usedHosts.add("255");
  for (let host = 2; host <= 254; host++) {
    if (!usedHosts.has(String(host))) {
      return `${net.a}.${net.b}.${net.c}.${host}/32`;
    }
  }
  throw new HttpError(409, "no free client addresses in VPN subnet");
}

export function genKeypair(): { privateKey: string; publicKey: string } {
  const priv = run("wg", ["genkey"], { timeoutMs: 5_000 });
  if (!priv.ok || !priv.out.trim()) {
    throw new HttpError(500, `wg genkey failed: ${priv.out || "unknown"}`);
  }
  const privateKey = priv.out.trim().split("\n")[0]!.trim();
  const pub = spawnSync("wg", ["pubkey"], {
    encoding: "utf8",
    input: `${privateKey}\n`,
    timeout: 5_000,
  });
  const publicKey = (pub.stdout || "").trim();
  if (pub.status !== 0 || !publicKey) {
    throw new HttpError(500, "wg pubkey failed");
  }
  return { privateKey, publicKey };
}

export function buildServerConf(opts: {
  serverPrivateKey: string;
  serverAddress: string;
  listenPort: number;
  outboundIface: string;
  iface: string;
  peers: { publicKey: string; address: string; name?: string }[];
}): string {
  const { serverPrivateKey, serverAddress, listenPort, outboundIface, iface, peers } =
    opts;
  const lines = [
    "[Interface]",
    `Address = ${serverAddress}`,
    `ListenPort = ${listenPort}`,
    `PrivateKey = ${serverPrivateKey}`,
    `# Forward + NAT so phone can reach LAN`,
    `PostUp = sysctl -w net.ipv4.ip_forward=1; iptables -A FORWARD -i ${iface} -j ACCEPT; iptables -A FORWARD -o ${iface} -j ACCEPT; iptables -t nat -A POSTROUTING -o ${outboundIface} -j MASQUERADE`,
    `PostDown = iptables -D FORWARD -i ${iface} -j ACCEPT; iptables -D FORWARD -o ${iface} -j ACCEPT; iptables -t nat -D POSTROUTING -o ${outboundIface} -j MASQUERADE`,
    "",
  ];
  for (const p of peers) {
    lines.push("[Peer]");
    if (p.name) lines.push(`# ${p.name}`);
    lines.push(`PublicKey = ${p.publicKey}`);
    lines.push(`AllowedIPs = ${p.address.includes("/") ? p.address : `${p.address}/32`}`);
    lines.push("");
  }
  return `${lines.join("\n").trim()}\n`;
}

export function buildClientConf(opts: {
  clientPrivateKey: string;
  clientAddress: string;
  dns: string;
  serverPublicKey: string;
  endpoint: string;
  vpnCidr: string;
  lanCidr: string;
}): string {
  const allowed = [opts.vpnCidr, opts.lanCidr].filter(Boolean).join(", ");
  return [
    "[Interface]",
    `PrivateKey = ${opts.clientPrivateKey}`,
    `Address = ${opts.clientAddress}`,
    `DNS = ${opts.dns}`,
    "",
    "[Peer]",
    `PublicKey = ${opts.serverPublicKey}`,
    `Endpoint = ${opts.endpoint}`,
    `AllowedIPs = ${allowed}`,
    "PersistentKeepalive = 25",
    "",
  ].join("\n");
}

export function parseServerConf(text: string): {
  privateKey: string | null;
  address: string | null;
  listenPort: number | null;
  peers: { publicKey: string; allowedIps: string; comment: string }[];
} {
  let privateKey: string | null = null;
  let address: string | null = null;
  let listenPort: number | null = null;
  const peers: { publicKey: string; allowedIps: string; comment: string }[] = [];
  let section = "";
  let cur: { publicKey: string; allowedIps: string; comment: string } | null =
    null;

  const flushPeer = () => {
    if (cur?.publicKey) peers.push(cur);
    cur = null;
  };

  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#")) {
      const comment = line.replace(/^#\s*/, "");
      // Peer name comments sit under [Peer] (before PublicKey)
      if (section === "peer" && cur && !cur.comment) cur.comment = comment;
      continue;
    }
    if (line === "[Interface]") {
      flushPeer();
      section = "interface";
      continue;
    }
    if (line === "[Peer]") {
      flushPeer();
      section = "peer";
      cur = { publicKey: "", allowedIps: "", comment: "" };
      continue;
    }
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim().toLowerCase();
    const val = line.slice(eq + 1).trim();
    if (section === "interface") {
      if (key === "privatekey") privateKey = val;
      else if (key === "address") address = val.split(",")[0]!.trim();
      else if (key === "listenport") listenPort = Number(val) || null;
    } else if (section === "peer" && cur) {
      if (key === "publickey") cur.publicKey = val;
      else if (key === "allowedips") cur.allowedIps = val.split(",")[0]!.trim();
    }
  }
  flushPeer();
  return { privateKey, address, listenPort, peers };
}

function ensureStateDirs(): void {
  ensureRuntimeDirs();
  mkdirSync(clientsDir(), { recursive: true, mode: 0o700 });
  try {
    chmodSync(stateDir(), 0o700);
    chmodSync(clientsDir(), 0o700);
  } catch {
    /* ignore */
  }
}

export function loadState(): WgState | null {
  try {
    if (!existsSync(statePath())) return null;
    return JSON.parse(readFileSync(statePath(), "utf8")) as WgState;
  } catch {
    return null;
  }
}

function saveState(state: WgState): void {
  ensureStateDirs();
  writeFileSync(statePath(), `${JSON.stringify(state, null, 2)}\n`, {
    mode: 0o600,
  });
  chmodSync(statePath(), 0o600);
}

export function listClientRecords(): WgClientRecord[] {
  ensureStateDirs();
  const out: WgClientRecord[] = [];
  if (!existsSync(clientsDir())) return out;
  for (const name of readdirSync(clientsDir())) {
    if (!name.endsWith(".json")) continue;
    try {
      const rec = JSON.parse(
        readFileSync(join(clientsDir(), name), "utf8"),
      ) as WgClientRecord;
      if (rec?.id && rec.publicKey) out.push(rec);
    } catch {
      /* ignore */
    }
  }
  return out.sort((a, b) => a.createdAt - b.createdAt);
}

function saveClient(rec: WgClientRecord): void {
  ensureStateDirs();
  const path = join(clientsDir(), `${rec.id}.json`);
  writeFileSync(path, `${JSON.stringify(rec, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function deleteClientFile(id: string): void {
  const path = join(clientsDir(), `${id}.json`);
  if (existsSync(path)) unlinkSync(path);
}

function cmdExists(bin: string, fallbackPaths: string[]): boolean {
  for (const p of fallbackPaths) {
    if (existsSync(p)) return true;
  }
  return run("which", [bin], { timeoutMs: 2_000 }).ok;
}

export function toolsInstalled(): {
  wg: boolean;
  wgQuick: boolean;
  iptables: boolean;
} {
  return {
    wg: cmdExists("wg", ["/usr/bin/wg"]),
    wgQuick: cmdExists("wg-quick", ["/usr/bin/wg-quick"]),
    iptables: cmdExists("iptables", ["/usr/sbin/iptables", "/usr/bin/iptables"]),
  };
}

function detectOutboundIface(): { iface: string; ip: string } | null {
  const r = run("ip", ["route", "get", "1.1.1.1"], { timeoutMs: 5_000 });
  if (r.ok) {
    const m = /\bdev\s+(\S+)/.exec(r.out);
    const src = /\bsrc\s+(\S+)/.exec(r.out);
    if (m?.[1]) {
      return { iface: m[1], ip: src?.[1] || lanHost() || "" };
    }
  }
  const lan = listIpv4Interfaces()
    .filter((a) => !a.iface.startsWith("wg") && !a.iface.startsWith("tun"))
    .sort((a, b) => {
      const score = (x: { iface: string; ip: string }) =>
        (x.ip.startsWith("192.168.") ? 100 : 0) +
        (x.iface.startsWith("wl") || x.iface.startsWith("en") ? 50 : 0);
      return score(b) - score(a);
    });
  return lan[0] ? { iface: lan[0].iface, ip: lan[0].ip } : null;
}

async function detectPublicIp(): Promise<string | null> {
  const urls = [
    "https://api.ipify.org",
    "https://ifconfig.me/ip",
    "https://icanhazip.com",
  ];
  for (const url of urls) {
    try {
      const ctrl = AbortSignal.timeout(4_000);
      const res = await fetch(url, { signal: ctrl });
      if (!res.ok) continue;
      const text = (await res.text()).trim();
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(text)) return text;
    } catch {
      /* try next */
    }
  }
  // DNS fallback
  const dig = run(
    "dig",
    ["+short", "myip.opendns.com", "@resolver1.opendns.com"],
    { timeoutMs: 5_000 },
  );
  if (dig.ok) {
    const ip = dig.out.trim().split("\n")[0]?.trim();
    if (ip && /^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return ip;
  }
  return null;
}

function unitActive(iface: string): boolean {
  const r = systemctl("is-active", unitName(iface));
  return r.out.trim() === "active";
}

function unitEnabled(iface: string): boolean {
  const r = systemctl("is-enabled", unitName(iface));
  return r.out.trim() === "enabled";
}

function parseWgShow(text: string): {
  publicKey: string | null;
  listeningPort: number | null;
  peers: {
    publicKey: string;
    endpoint: string | null;
    latestHandshake: string | null;
    transfer: string | null;
    allowedIps: string | null;
  }[];
} {
  let publicKey: string | null = null;
  let listeningPort: number | null = null;
  const peers: {
    publicKey: string;
    endpoint: string | null;
    latestHandshake: string | null;
    transfer: string | null;
    allowedIps: string | null;
  }[] = [];
  let cur: (typeof peers)[0] | null = null;
  const flush = () => {
    if (cur) peers.push(cur);
    cur = null;
  };
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (t.startsWith("public key:")) {
      if (!cur) publicKey = t.slice("public key:".length).trim();
      else cur.publicKey = t.slice("public key:".length).trim();
    } else if (t.startsWith("listening port:")) {
      listeningPort = Number(t.slice("listening port:".length).trim()) || null;
    } else if (t.startsWith("peer:")) {
      flush();
      cur = {
        publicKey: t.slice("peer:".length).trim(),
        endpoint: null,
        latestHandshake: null,
        transfer: null,
        allowedIps: null,
      };
    } else if (cur) {
      if (t.startsWith("endpoint:"))
        cur.endpoint = t.slice("endpoint:".length).trim();
      else if (t.startsWith("latest handshake:"))
        cur.latestHandshake = t.slice("latest handshake:".length).trim();
      else if (t.startsWith("transfer:"))
        cur.transfer = t.slice("transfer:".length).trim();
      else if (t.startsWith("allowed ips:"))
        cur.allowedIps = t.slice("allowed ips:".length).trim();
    }
  }
  flush();
  return { publicKey, listeningPort, peers };
}

function readServerPrivateKey(iface: string): string | null {
  const path = confPath(iface);
  if (!existsSync(path)) return null;
  try {
    const parsed = parseServerConf(readFileSync(path, "utf8"));
    return parsed.privateKey;
  } catch {
    return null;
  }
}

function serverPublicKeyFromConf(iface: string): string | null {
  const priv = readServerPrivateKey(iface);
  if (!priv) return null;
  const pub = spawnSync("wg", ["pubkey"], {
    encoding: "utf8",
    input: `${priv}\n`,
    timeout: 5_000,
  });
  return pub.status === 0 ? (pub.stdout || "").trim() || null : null;
}

function writeServerConf(iface: string, text: string): void {
  mkdirSync(WG_DIR, { recursive: true, mode: 0o700 });
  try {
    chmodSync(WG_DIR, 0o700);
  } catch {
    /* ignore */
  }
  const path = confPath(iface);
  writeFileSync(path, text, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function rebuildServerConfFromState(state: WgState): void {
  const priv = readServerPrivateKey(state.iface);
  if (!priv) throw new HttpError(500, "server private key missing");
  const clients = listClientRecords();
  const text = buildServerConf({
    serverPrivateKey: priv,
    serverAddress: state.serverAddress,
    listenPort: state.listenPort,
    outboundIface: state.outboundIface,
    iface: state.iface,
    peers: clients.map((c) => ({
      publicKey: c.publicKey,
      address: c.address,
      name: c.name,
    })),
  });
  writeServerConf(state.iface, text);
}

function enableIpForward(): void {
  writeFileSync(
    SYSCTL_FORWARD,
    "# Home Base WireGuard\nnet.ipv4.ip_forward=1\n",
    { mode: 0o644 },
  );
  run("sysctl", ["-w", "net.ipv4.ip_forward=1"], { timeoutMs: 5_000 });
  // Loose rp_filter so VPN clients can reach LAN address (same as hb-vpn-access)
  writeFileSync(
    SYSCTL_VPN,
    [
      "# Home Base: loose reverse-path checks for WireGuard → LAN",
      "net.ipv4.conf.all.rp_filter=2",
      "net.ipv4.conf.default.rp_filter=2",
      "",
    ].join("\n"),
    { mode: 0o644 },
  );
  run("sysctl", ["-w", "net.ipv4.conf.all.rp_filter=2"], { timeoutMs: 5_000 });
  run("sysctl", ["-w", "net.ipv4.conf.default.rp_filter=2"], {
    timeoutMs: 5_000,
  });
}

function ufwAllowUdp(port: number): void {
  const st = run("ufw", ["status"], { timeoutMs: 10_000 });
  if (!st.ok || !/Status:\s*active/i.test(st.out)) return;
  run(
    "ufw",
    ["allow", `${port}/udp`, "comment", "Home Base WireGuard"],
    { timeoutMs: 15_000 },
  );
}

function ufwDeleteUdp(port: number): void {
  const st = run("ufw", ["status"], { timeoutMs: 10_000 });
  if (!st.ok || !/Status:\s*active/i.test(st.out)) return;
  run("ufw", ["delete", "allow", `${port}/udp`], { timeoutMs: 15_000 });
}

function applyVpnAccessHelper(): void {
  for (const script of [
    "/usr/share/homebased/hb-vpn-access.sh",
    join(process.cwd(), "scripts/hb-vpn-access.sh"),
  ]) {
    if (!existsSync(script)) continue;
    run("bash", [script, "--apply"], { timeoutMs: 60_000 });
    return;
  }
}

/** Lightweight public summary for /api/health (no secrets). */
export function wireguardHealthSummary(): {
  installed: boolean;
  configured: boolean;
  active: boolean;
  iface: string | null;
  host: string | null;
} {
  const tools = toolsInstalled();
  const installed = tools.wg && tools.wgQuick;
  const state = loadState();
  const iface =
    state?.iface ||
    (existsSync(confPath(DEFAULT_IFACE)) ? DEFAULT_IFACE : null);
  const configured = Boolean(iface && existsSync(confPath(iface)));
  const active = configured && iface ? unitActive(iface) : false;
  return {
    installed,
    configured,
    active,
    iface,
    host: active ? vpnHost() : null,
  };
}

export async function wireguardStatus(): Promise<Record<string, unknown>> {
  const tools = toolsInstalled();
  const installed = tools.wg && tools.wgQuick;
  const state = loadState();
  const ifaceCandidates = new Set<string>();
  if (state?.iface) ifaceCandidates.add(state.iface);
  if (existsSync(WG_DIR)) {
    try {
      for (const name of readdirSync(WG_DIR)) {
        if (name.endsWith(".conf"))
          ifaceCandidates.add(name.replace(/\.conf$/, ""));
      }
    } catch {
      /* ignore */
    }
  }
  if (ifaceCandidates.size === 0) ifaceCandidates.add(DEFAULT_IFACE);

  const interfaces: Record<string, unknown>[] = [];
  for (const iface of ifaceCandidates) {
    const conf = confPath(iface);
    const configured = existsSync(conf);
    const active = configured ? unitActive(iface) : false;
    const enabled = configured ? unitEnabled(iface) : false;
    let show: ReturnType<typeof parseWgShow> | null = null;
    if (active && tools.wg) {
      const r = run("wg", ["show", iface], { timeoutMs: 5_000 });
      if (r.ok) show = parseWgShow(r.out);
    }
    let confMeta: ReturnType<typeof parseServerConf> | null = null;
    if (configured) {
      try {
        confMeta = parseServerConf(readFileSync(conf, "utf8"));
      } catch {
        confMeta = null;
      }
    }
    interfaces.push({
      id: iface,
      unit: unitName(iface),
      conf,
      configured,
      active,
      enabled,
      listenPort: state?.listenPort ?? confMeta?.listenPort ?? null,
      address: state?.serverAddress ?? confMeta?.address ?? null,
      publicKey: show?.publicKey ?? serverPublicKeyFromConf(iface),
      peersLive: show?.peers ?? [],
      peersConfigured: confMeta?.peers.length ?? 0,
    });
  }

  const primary =
    interfaces.find((i) => i.id === (state?.iface || DEFAULT_IFACE)) ||
    interfaces[0];
  const lan = lanHost();
  const outbound = detectOutboundIface();
  const publicIp = await detectPublicIp();
  const clients = listClientRecords().map((c) => ({
    id: c.id,
    name: c.name,
    address: c.address,
    publicKey: c.publicKey,
    createdAt: c.createdAt,
    hasConfig: Boolean(c.privateKey),
  }));

  const access = {
    lanHost: lan,
    vpnHost: vpnHost(),
    publicIp,
    suggestedEndpoint: publicIp
      ? `${publicIp}:${state?.listenPort || DEFAULT_LISTEN_PORT}`
      : null,
    outboundIface: outbound?.iface ?? null,
    lanCidr: lan ? lanCidrFromHost(lan) : null,
    dns: lan ? dnsFromLanHost(lan) : "1.1.1.1",
  };

  const portForward = {
    proto: "UDP",
    wanPort: state?.listenPort || DEFAULT_LISTEN_PORT,
    lanIp: state?.lanHost || lan,
    lanPort: state?.listenPort || DEFAULT_LISTEN_PORT,
  };

  return {
    installed,
    tools,
    root: process.getuid?.() === 0,
    configured: Boolean(primary && primary.configured),
    active: Boolean(primary && primary.active),
    managedByHomebase: Boolean(state?.managedByHomebase),
    state,
    iface: (primary?.id as string) || DEFAULT_IFACE,
    interfaces,
    clients,
    access,
    portForward,
    appStore: {
      ios: "https://apps.apple.com/app/wireguard/id1441195209",
      android:
        "https://play.google.com/store/apps/details?id=com.wireguard.android",
    },
    defaults: {
      iface: DEFAULT_IFACE,
      listenPort: DEFAULT_LISTEN_PORT,
      vpnCidr: DEFAULT_VPN_CIDR,
      serverAddress: DEFAULT_SERVER_ADDR,
    },
  };
}

export function installWireguardPackages(): Record<string, unknown> {
  requireRoot();
  appendTrace("info", "installing WireGuard packages", "wireguard");
  const update = run(
    "apt-get",
    ["update", "-qq"],
    {
      timeoutMs: 180_000,
      env: { DEBIAN_FRONTEND: "noninteractive" },
    },
  );
  const install = run(
    "apt-get",
    ["install", "-y", "wireguard", "wireguard-tools", "iptables", "qrencode"],
    {
      timeoutMs: 300_000,
      env: { DEBIAN_FRONTEND: "noninteractive" },
    },
  );
  const tools = toolsInstalled();
  const ok = tools.wg && tools.wgQuick;
  if (!ok) {
    throw new HttpError(
      500,
      `package install failed: ${install.out || update.out || "unknown"}`,
    );
  }
  appendTrace("info", "WireGuard packages installed", "wireguard");
  return { ok: true, tools, stdout: install.out.slice(-2_000) };
}

export async function setupWireguard(input: {
  endpoint?: string;
  listenPort?: number;
  iface?: string;
  clientName?: string;
  vpnCidr?: string;
  force?: boolean;
}): Promise<Record<string, unknown>> {
  requireRoot();
  const tools = toolsInstalled();
  if (!tools.wg || !tools.wgQuick) {
    installWireguardPackages();
  }

  const iface = sanitizeIface(input.iface || DEFAULT_IFACE);
  const listenPort = Math.min(
    65535,
    Math.max(1024, Number(input.listenPort) || DEFAULT_LISTEN_PORT),
  );
  const vpnCidr = (input.vpnCidr || DEFAULT_VPN_CIDR).trim();
  parseCidr(vpnCidr);
  const serverAddress =
    vpnCidr === DEFAULT_VPN_CIDR
      ? DEFAULT_SERVER_ADDR
      : (() => {
          const n = parseCidr(vpnCidr);
          return `${n.a}.${n.b}.${n.c}.1/${n.prefix}`;
        })();

  if (existsSync(confPath(iface)) && !input.force) {
    throw new HttpError(
      409,
      `${iface} already configured — pass force=true to replace`,
    );
  }

  const outbound = detectOutboundIface();
  if (!outbound?.iface) {
    throw new HttpError(500, "could not detect outbound network interface");
  }
  const lan = outbound.ip || lanHost();
  if (!lan) throw new HttpError(500, "could not detect LAN IP");

  const publicIp = (await detectPublicIp()) || "";
  const endpointHost = (input.endpoint || publicIp || lan).trim();
  if (!endpointHost) {
    throw new HttpError(400, "endpoint (public IP or hostname) is required");
  }
  const endpoint = endpointHost.includes(":")
    ? endpointHost
    : `${endpointHost}:${listenPort}`;

  const serverKeys = genKeypair();
  const clientName = sanitizeClientId(input.clientName || "phone");
  const clientKeys = genKeypair();
  const clientAddress = nextClientAddress(vpnCidr, []);
  const lanCidr = lanCidrFromHost(lan);
  const dns = dnsFromLanHost(lan);

  const now = Date.now() / 1000;
  const state: WgState = {
    iface,
    listenPort,
    vpnCidr,
    serverAddress,
    endpoint,
    lanCidr,
    lanHost: lan,
    outboundIface: outbound.iface,
    dns,
    managedByHomebase: true,
    createdAt: now,
    updatedAt: now,
  };

  // Clear previous managed clients when forcing re-setup
  if (input.force && existsSync(clientsDir())) {
    for (const name of readdirSync(clientsDir())) {
      if (name.endsWith(".json")) unlinkSync(join(clientsDir(), name));
    }
  }

  const client: WgClientRecord = {
    id: clientName,
    name: clientName,
    address: clientAddress,
    publicKey: clientKeys.publicKey,
    privateKey: clientKeys.privateKey,
    createdAt: now,
  };

  const serverConf = buildServerConf({
    serverPrivateKey: serverKeys.privateKey,
    serverAddress,
    listenPort,
    outboundIface: outbound.iface,
    iface,
    peers: [
      {
        publicKey: client.publicKey,
        address: client.address,
        name: client.name,
      },
    ],
  });

  enableIpForward();
  ufwAllowUdp(listenPort);
  writeServerConf(iface, serverConf);
  saveState(state);
  saveClient(client);

  const enable = systemctl("enable", "--now", unitName(iface));
  if (!enable.ok) {
    // try start alone
    systemctl("start", unitName(iface));
  }
  applyVpnAccessHelper();

  const active = unitActive(iface);
  appendTrace(
    active ? "info" : "warn",
    `WireGuard setup ${active ? "active" : "started with issues"} on ${iface}`,
    "wireguard",
  );

  const serverPub = serverKeys.publicKey;
  const clientConfig = buildClientConf({
    clientPrivateKey: client.privateKey,
    clientAddress: client.address,
    dns,
    serverPublicKey: serverPub,
    endpoint,
    vpnCidr,
    lanCidr,
  });

  return {
    ok: active,
    active,
    state,
    client: {
      id: client.id,
      name: client.name,
      address: client.address,
      config: clientConfig,
    },
    portForward: {
      proto: "UDP",
      wanPort: listenPort,
      lanIp: lan,
      lanPort: listenPort,
    },
    message: active
      ? "WireGuard is up. Forward UDP on your router, then scan the phone QR."
      : `WireGuard config written but unit not active: ${enable.out}`,
  };
}

/** Adopt an existing /etc/wireguard conf into Home Base state (no key regen). */
export async function adoptWireguard(input: {
  iface?: string;
  endpoint?: string;
}): Promise<Record<string, unknown>> {
  requireRoot();
  const iface = sanitizeIface(input.iface || DEFAULT_IFACE);
  const conf = confPath(iface);
  if (!existsSync(conf)) {
    throw new HttpError(404, `${iface}.conf not found`);
  }
  const parsed = parseServerConf(readFileSync(conf, "utf8"));
  const lan = lanHost() || "";
  const outbound = detectOutboundIface();
  const publicIp = await detectPublicIp();
  const listenPort = parsed.listenPort || DEFAULT_LISTEN_PORT;
  const endpointHost = (input.endpoint || publicIp || lan).trim();
  const endpoint = endpointHost.includes(":")
    ? endpointHost
    : `${endpointHost}:${listenPort}`;

  const now = Date.now() / 1000;
  const state: WgState = {
    iface,
    listenPort,
    vpnCidr: DEFAULT_VPN_CIDR,
    serverAddress: parsed.address || DEFAULT_SERVER_ADDR,
    endpoint,
    lanCidr: lan ? lanCidrFromHost(lan) : "192.168.0.0/24",
    lanHost: lan,
    outboundIface: outbound?.iface || "eth0",
    dns: lan ? dnsFromLanHost(lan) : "1.1.1.1",
    managedByHomebase: true,
    createdAt: now,
    updatedAt: now,
  };

  // Import peer metadata (without private keys — user can add a fresh phone)
  ensureStateDirs();
  for (const peer of parsed.peers) {
    const id = sanitizeClientId(peer.comment || `peer-${peer.publicKey.slice(0, 6)}`);
    if (existsSync(join(clientsDir(), `${id}.json`))) continue;
    const rec: WgClientRecord = {
      id,
      name: peer.comment || id,
      address: peer.allowedIps.includes("/")
        ? peer.allowedIps
        : `${peer.allowedIps}/32`,
      publicKey: peer.publicKey,
      privateKey: "", // unknown — QR unavailable until rotate
      createdAt: now,
    };
    saveClient(rec);
  }
  saveState(state);
  return { ok: true, state, clients: listClientRecords().map((c) => ({
    id: c.id,
    name: c.name,
    hasConfig: Boolean(c.privateKey),
  })) };
}

export function startWireguard(iface?: string): Record<string, unknown> {
  requireRoot();
  const id = sanitizeIface(iface || loadState()?.iface || DEFAULT_IFACE);
  if (!existsSync(confPath(id))) {
    throw new HttpError(404, `${id}.conf not found — run setup first`);
  }
  const r = systemctl("enable", "--now", unitName(id));
  applyVpnAccessHelper();
  const active = unitActive(id);
  appendTrace("info", `WireGuard start ${id} active=${active}`, "wireguard");
  return { ok: active, active, unit: unitName(id), stdout: r.out };
}

export function stopWireguard(iface?: string): Record<string, unknown> {
  requireRoot();
  const id = sanitizeIface(iface || loadState()?.iface || DEFAULT_IFACE);
  const r = systemctl("stop", unitName(id));
  appendTrace("info", `WireGuard stop ${id}`, "wireguard");
  return { ok: r.ok || !unitActive(id), active: unitActive(id), unit: unitName(id), stdout: r.out };
}

export function restartWireguardIface(iface?: string): Record<string, unknown> {
  requireRoot();
  const id = sanitizeIface(iface || loadState()?.iface || DEFAULT_IFACE);
  if (!existsSync(confPath(id))) {
    throw new HttpError(404, `${id}.conf not found`);
  }
  const r = systemctl("restart", unitName(id));
  applyVpnAccessHelper();
  const active = unitActive(id);
  appendTrace("info", `WireGuard restart ${id} active=${active}`, "wireguard");
  return { ok: active, active, unit: unitName(id), stdout: r.out };
}

export function addWireguardClient(input: {
  name?: string;
  rotateId?: string;
}): Record<string, unknown> {
  requireRoot();
  const state = loadState();
  if (!state) {
    throw new HttpError(400, "WireGuard not managed yet — run setup or adopt first");
  }
  const tools = toolsInstalled();
  if (!tools.wg) throw new HttpError(500, "wg not installed");

  let id: string;
  if (input.rotateId) {
    id = sanitizeClientId(input.rotateId);
    deleteClientFile(id);
  } else {
    id = sanitizeClientId(input.name || `phone-${Date.now().toString(36)}`);
  }

  const existing = listClientRecords().filter((c) => c.id !== id);
  const address = nextClientAddress(
    state.vpnCidr,
    existing.map((c) => c.address),
  );
  const keys = genKeypair();
  const rec: WgClientRecord = {
    id,
    name: input.name?.trim() || id,
    address,
    publicKey: keys.publicKey,
    privateKey: keys.privateKey,
    createdAt: Date.now() / 1000,
  };
  saveClient(rec);
  rebuildServerConfFromState({ ...state, updatedAt: Date.now() / 1000 });
  saveState({ ...state, updatedAt: Date.now() / 1000 });
  systemctl("reload-or-restart", unitName(state.iface));

  const serverPub = serverPublicKeyFromConf(state.iface);
  if (!serverPub) throw new HttpError(500, "could not derive server public key");
  const config = buildClientConf({
    clientPrivateKey: rec.privateKey,
    clientAddress: rec.address,
    dns: state.dns,
    serverPublicKey: serverPub,
    endpoint: state.endpoint,
    vpnCidr: state.vpnCidr,
    lanCidr: state.lanCidr,
  });
  appendTrace("info", `WireGuard client added: ${rec.id}`, "wireguard");
  return {
    ok: true,
    client: {
      id: rec.id,
      name: rec.name,
      address: rec.address,
      config,
    },
  };
}

export function getWireguardClientConfig(clientId: string): Record<string, unknown> {
  const state = loadState();
  if (!state) throw new HttpError(400, "WireGuard not managed yet");
  const id = sanitizeClientId(clientId);
  const rec = listClientRecords().find((c) => c.id === id);
  if (!rec) throw new HttpError(404, "client not found");
  if (!rec.privateKey) {
    throw new HttpError(
      409,
      "client private key unknown — use rotate to issue a new QR",
    );
  }
  const serverPub = serverPublicKeyFromConf(state.iface);
  if (!serverPub) throw new HttpError(500, "could not derive server public key");
  const config = buildClientConf({
    clientPrivateKey: rec.privateKey,
    clientAddress: rec.address,
    dns: state.dns,
    serverPublicKey: serverPub,
    endpoint: state.endpoint,
    vpnCidr: state.vpnCidr,
    lanCidr: state.lanCidr,
  });
  return {
    ok: true,
    client: { id: rec.id, name: rec.name, address: rec.address, config },
  };
}

export function removeWireguardClient(clientId: string): Record<string, unknown> {
  requireRoot();
  const state = loadState();
  if (!state) throw new HttpError(400, "WireGuard not managed yet");
  const id = sanitizeClientId(clientId);
  const before = listClientRecords().length;
  deleteClientFile(id);
  rebuildServerConfFromState({ ...state, updatedAt: Date.now() / 1000 });
  saveState({ ...state, updatedAt: Date.now() / 1000 });
  systemctl("reload-or-restart", unitName(state.iface));
  appendTrace("info", `WireGuard client removed: ${id}`, "wireguard");
  return { ok: true, removed: id, remaining: before - 1 };
}

export function updateWireguardEndpoint(endpoint: string): Record<string, unknown> {
  const state = loadState();
  if (!state) throw new HttpError(400, "WireGuard not managed yet");
  const ep = endpoint.trim();
  if (!ep) throw new HttpError(400, "endpoint required");
  const next = {
    ...state,
    endpoint: ep.includes(":") ? ep : `${ep}:${state.listenPort}`,
    updatedAt: Date.now() / 1000,
  };
  saveState(next);
  return { ok: true, state: next };
}

export function uninstallWireguard(input: {
  removePackages?: boolean;
  iface?: string;
}): Record<string, unknown> {
  requireRoot();
  const state = loadState();
  const iface = sanitizeIface(
    input.iface || state?.iface || DEFAULT_IFACE,
  );
  const port = state?.listenPort || DEFAULT_LISTEN_PORT;

  systemctl("disable", "--now", unitName(iface));
  const conf = confPath(iface);
  if (existsSync(conf)) unlinkSync(conf);

  if (existsSync(stateDir())) {
    rmSync(stateDir(), { recursive: true, force: true });
  }
  for (const f of [SYSCTL_FORWARD]) {
    try {
      if (existsSync(f)) unlinkSync(f);
    } catch {
      /* ignore */
    }
  }
  ufwDeleteUdp(port);

  let packages: Record<string, unknown> | null = null;
  if (input.removePackages) {
    const r = run(
      "apt-get",
      ["remove", "-y", "wireguard", "wireguard-tools"],
      {
        timeoutMs: 180_000,
        env: { DEBIAN_FRONTEND: "noninteractive" },
      },
    );
    packages = { ok: r.ok, stdout: r.out.slice(-1_500) };
  }

  appendTrace("warn", `WireGuard uninstalled (${iface})`, "wireguard");
  return {
    ok: true,
    removedConf: conf,
    packagesRemoved: Boolean(input.removePackages),
    packages,
    active: unitActive(iface),
  };
}
