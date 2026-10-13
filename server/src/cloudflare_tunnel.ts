/**
 * Cloudflare Tunnel (cloudflared) — guided install/status for remote HTTPS access.
 * Prefer token-based quick tunnels or named tunnels; never expose plaintext tokens in APIs.
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { RUNTIME_DIR, ensureRuntimeDirs, bindPort } from "./config";
import { HttpError } from "./auth";
import {
  decryptFromFile,
  encryptToFile,
  isValidSecretHint,
  secretDisplayHint,
} from "./secrets_vault";
import { appendTrace } from "./trace";

const STATE_PATH = join(RUNTIME_DIR, "cloudflare_tunnel.json");
const TOKEN_PATH = join(RUNTIME_DIR, "cloudflare_token.enc");

type CfState = {
  tunnelName?: string;
  hostname?: string;
  tunnelId?: string;
  installedAt?: number;
  mode?: "token" | "named" | null;
  /** Client-safe first/last-4 placeholder; never the full token. */
  tokenHint?: string | null;
};

function loadState(): CfState {
  if (!existsSync(STATE_PATH)) return {};
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf8")) as CfState;
  } catch {
    return {};
  }
}

function saveState(s: CfState): void {
  ensureRuntimeDirs();
  writeFileSync(STATE_PATH, JSON.stringify(s, null, 2) + "\n", { mode: 0o600 });
  try {
    chmodSync(STATE_PATH, 0o600);
  } catch {
    /* ignore */
  }
}

function which(bin: string): string | null {
  try {
    const r = spawnSync("bash", ["-lc", `command -v ${bin}`], {
      encoding: "utf8",
    });
    const p = (r.stdout || "").trim();
    return p || null;
  } catch {
    return null;
  }
}

function isLinux(): boolean {
  return process.platform === "linux";
}

function isRootish(): boolean {
  try {
    return typeof process.getuid === "function" ? process.getuid() === 0 : false;
  } catch {
    return false;
  }
}

function run(
  cmd: string,
  args: string[],
  opts?: { timeoutMs?: number },
): { ok: boolean; out: string; code: number } {
  try {
    const out = execFileSync(cmd, args, {
      encoding: "utf8",
      timeout: opts?.timeoutMs ?? 120_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    return { ok: true, out: String(out || ""), code: 0 };
  } catch (e) {
    const err = e as {
      status?: number;
      stdout?: string;
      stderr?: string;
      message?: string;
    };
    return {
      ok: false,
      out: String(err.stderr || err.stdout || err.message || e),
      code: Number(err.status ?? 1),
    };
  }
}

export function cloudflaredPath(): string | null {
  return which("cloudflared");
}

function unitActive(): boolean {
  if (!isLinux()) return false;
  const r = run("systemctl", ["is-active", "cloudflared"], { timeoutMs: 5_000 });
  return r.ok && r.out.trim() === "active";
}

/** Returns a client-safe hint; decrypts at most once for legacy migration. */
function resolveTokenHint(state: CfState): string | null {
  if (!existsSync(TOKEN_PATH)) return null;
  const stored = state.tokenHint?.trim() || "";
  if (stored && isValidSecretHint(stored)) return stored;
  const plain = decryptFromFile(TOKEN_PATH);
  if (!plain) return null;
  const hint = secretDisplayHint(plain);
  saveState({ ...state, tokenHint: hint });
  return hint;
}

export function cloudflareStatus(): Record<string, unknown> {
  const bin = cloudflaredPath();
  const state = loadState();
  const tokenHint = resolveTokenHint(state);
  const hasToken = !!tokenHint || existsSync(TOKEN_PATH);
  const running = unitActive();
  const hostname = state.hostname || null;
  return {
    installed: !!bin,
    binary: bin,
    loggedIn: hasToken || !!state.tunnelId,
    /** Client-safe placeholder only — never the full tunnel token. */
    tokenHint,
    tunnelName: state.tunnelName || null,
    tunnelId: state.tunnelId || null,
    hostname,
    running,
    publicUrl: hostname ? `https://${hostname}` : null,
    mode: state.mode || null,
    platform: process.platform,
    linux: isLinux(),
    localPort: bindPort(),
    guidance: {
      installMac: "brew install cloudflare/cloudflare/cloudflared",
      installLinux: "Home Base can install the official cloudflared package.",
      dashboard: "https://one.dash.cloudflare.com/",
      docs: "https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/",
    },
  };
}

export function installCloudflared(): Record<string, unknown> {
  if (cloudflaredPath()) {
    return { ok: true, already: true, ...cloudflareStatus() };
  }
  if (!isLinux()) {
    throw new HttpError(
      400,
      "On Mac, install with: brew install cloudflare/cloudflare/cloudflared — then return here.",
    );
  }
  if (!isRootish()) {
    throw new HttpError(400, "Installing cloudflared needs root (production homebased runs as root)");
  }
  appendTrace("info", "installing cloudflared", "cloudflare");
  // Prefer official Cloudflare package when apt is available
  let r = run("bash", [
    "-lc",
    [
      "set -e",
      "if ! command -v cloudflared >/dev/null 2>&1; then",
      "  if command -v apt-get >/dev/null 2>&1; then",
      "    mkdir -p /usr/share/keyrings",
      "    curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null",
      "    echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' > /etc/apt/sources.list.d/cloudflared.list",
      "    apt-get update -qq",
      "    apt-get install -y cloudflared",
      "  else",
      "    exit 2",
      "  fi",
      "fi",
    ].join("\n"),
  ], { timeoutMs: 300_000 });
  if (!r.ok && !cloudflaredPath()) {
    throw new HttpError(500, `cloudflared install failed: ${r.out.slice(0, 400)}`);
  }
  appendTrace("info", "cloudflared installed", "cloudflare");
  return { ok: true, ...cloudflareStatus() };
}

/** Save a Cloudflare tunnel token (from Zero Trust dashboard) and install systemd service. */
export function configureCloudflareToken(input: {
  token: string;
  hostname?: string;
  tunnelName?: string;
}): Record<string, unknown> {
  const token = String(input.token || "").trim();
  if (!token) throw new HttpError(400, "token required");
  const bin = cloudflaredPath();
  if (!bin) throw new HttpError(400, "cloudflared not installed");
  encryptToFile(TOKEN_PATH, token);
  const state: CfState = {
    ...loadState(),
    mode: "token",
    hostname: input.hostname?.trim() || loadState().hostname,
    tunnelName: input.tunnelName?.trim() || loadState().tunnelName || "homebase",
    installedAt: Date.now(),
    tokenHint: secretDisplayHint(token),
  };
  saveState(state);

  if (isLinux() && isRootish()) {
    // cloudflared service install with token
    const r = run(bin, ["service", "install", token], { timeoutMs: 60_000 });
    if (!r.ok) {
      // Fallback: write a simple unit that runs tunnel run --token
      ensureRuntimeDirs();
      const unit = `[Unit]
Description=Cloudflare Tunnel (Home Base)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${bin} tunnel run --token ${token}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
`;
      // Don't embed token in unit if service install failed — use EnvironmentFile
      const envPath = "/etc/cloudflared/homebase.env";
      try {
        mkdirSync("/etc/cloudflared", { recursive: true });
        writeFileSync(envPath, `TUNNEL_TOKEN=${token}\n`, { mode: 0o600 });
        chmodSync(envPath, 0o600);
        writeFileSync(
          "/etc/systemd/system/cloudflared.service",
          `[Unit]
Description=Cloudflare Tunnel (Home Base)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=${envPath}
ExecStart=${bin} tunnel run --token $TUNNEL_TOKEN
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
`,
          { mode: 0o644 },
        );
        run("systemctl", ["daemon-reload"]);
        run("systemctl", ["enable", "--now", "cloudflared"]);
      } catch (e) {
        throw new HttpError(
          500,
          `Could not install tunnel service: ${e instanceof Error ? e.message : String(e)} (${r.out.slice(0, 200)})`,
        );
      }
    } else {
      run("systemctl", ["enable", "--now", "cloudflared"]);
    }
  }

  appendTrace("info", "Cloudflare tunnel token configured", "cloudflare");
  return {
    ok: true,
    message: state.hostname
      ? `Tunnel ready — open https://${state.hostname} on your phone`
      : "Token saved. Set your public hostname (from Cloudflare dashboard) next.",
    ...cloudflareStatus(),
  };
}

export function updateCloudflareHostname(hostname: string): Record<string, unknown> {
  const h = String(hostname || "")
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "");
  if (!h) throw new HttpError(400, "hostname required");
  const state = { ...loadState(), hostname: h };
  saveState(state);
  return { ok: true, ...cloudflareStatus() };
}

export function startCloudflareTunnel(): Record<string, unknown> {
  if (!isLinux()) {
    throw new HttpError(400, "Start the tunnel service on a Linux host running homebased");
  }
  const r = run("systemctl", ["start", "cloudflared"]);
  if (!r.ok) throw new HttpError(500, r.out.slice(0, 300));
  return { ok: true, ...cloudflareStatus() };
}

export function stopCloudflareTunnel(): Record<string, unknown> {
  if (!isLinux()) {
    return { ok: true, ...cloudflareStatus() };
  }
  run("systemctl", ["stop", "cloudflared"]);
  return { ok: true, ...cloudflareStatus() };
}

export function clearCloudflareTunnel(): Record<string, unknown> {
  try {
    if (existsSync(TOKEN_PATH)) unlinkSync(TOKEN_PATH);
  } catch {
    /* ignore */
  }
  try {
    if (existsSync(STATE_PATH)) unlinkSync(STATE_PATH);
  } catch {
    /* ignore */
  }
  if (isLinux() && isRootish()) {
    run("systemctl", ["disable", "--now", "cloudflared"]);
  }
  return { ok: true, ...cloudflareStatus() };
}
