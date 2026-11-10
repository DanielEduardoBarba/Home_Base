import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { sudoAskpassEnv } from "./sudo";

export type SeatUser = {
  uid: number;
  gid: number;
  name: string;
  home: string;
  shell: string;
};

function passwdByKey(key: string): SeatUser | null {
  try {
    const out = execFileSync("getent", ["passwd", key], { encoding: "utf8" }).trim();
    const [name, , uid, gid, , home, shell] = out.split(":");
    return {
      uid: Number(uid),
      gid: Number(gid),
      name: name || key,
      home: home || `/home/${name}`,
      shell: shell || "/bin/bash",
    };
  } catch {
    return null;
  }
}

export function detectSeatUser(): SeatUser {
  const override = (process.env.HOMEBASE_VIEW_UID || "").trim();
  if (override && /^\d+$/.test(override)) {
    return (
      passwdByKey(override) || {
        uid: Number(override),
        gid: Number(override),
        name: "user",
        home: "/home/user",
        shell: "/bin/bash",
      }
    );
  }

  for (const display of [
    process.env.HOMEBASE_DISPLAY,
    process.env.DISPLAY,
    ":0",
  ]) {
    if (!display) continue;
    const name = display.replace(/^:/, "").split(".")[0] || "0";
    const sock = `/tmp/.X11-unix/X${name}`;
    if (!existsSync(sock)) continue;
    const stat = spawnSync("stat", ["-c", "%u:%g", sock], { encoding: "utf8" });
    if (stat.status !== 0) continue;
    const [u, g] = (stat.stdout || "").trim().split(":").map(Number);
    if (u == null || u <= 0) continue;
    return (
      passwdByKey(String(u)) || {
        uid: u,
        gid: g || u,
        name: "user",
        home: homedir(),
        shell: "/bin/bash",
      }
    );
  }

  if (process.getuid?.() === 0) {
    let name = process.env.SUDO_USER || "";
    if (!name) {
      try {
        name = execFileSync("logname", { encoding: "utf8" }).trim();
      } catch {
        name = "";
      }
    }
    if (name && name !== "root") {
      const seat = passwdByKey(name);
      if (seat) return seat;
    }
  }

  const uid = process.getuid?.() ?? 1000;
  const gid = process.getgid?.() ?? uid;
  return {
    uid,
    gid,
    name: process.env.USER || "user",
    home: process.env.HOME || homedir(),
    shell: process.env.SHELL || "/bin/bash",
  };
}

function setprivPrefix(seat: SeatUser): string[] | null {
  if (process.getuid?.() !== 0 || seat.uid === 0) return null;
  const setpriv = spawnSync("which", ["setpriv"], { encoding: "utf8" });
  if (setpriv.status === 0 && setpriv.stdout?.trim()) {
    return [
      setpriv.stdout.trim(),
      "--reuid",
      String(seat.uid),
      "--regid",
      String(seat.gid),
      "--init-groups",
      "--",
    ];
  }
  const runuser = spawnSync("which", ["runuser"], { encoding: "utf8" });
  if (runuser.status === 0 && runuser.stdout?.trim()) {
    return [runuser.stdout.trim(), "-u", seat.name, "--"];
  }
  return null;
}

export function wrapArgvForSeat(argv: string[]): string[] {
  const prefix = setprivPrefix(detectSeatUser());
  if (!prefix) return argv;
  return [...prefix, ...argv];
}

/**
 * Overlay seat-user identity onto `process.env` so Cursor SDK local shells
 * (which inherit the homebased process env, often as root under systemd) see
 * the laptop owner's HOME/PATH/git credentials instead of /root.
 *
 * Also injects a one-shot `safe.directory=*` via GIT_CONFIG_* so root can read
 * seat-owned worktrees without writing git config. Idempotent.
 */
export function applySeatEnvForAgents(): {
  applied: boolean;
  seat?: SeatUser;
} {
  if (typeof process.getuid === "function" && process.getuid() !== 0) {
    return { applied: false };
  }
  const seat = detectSeatUser();
  if (!seat.uid || seat.uid === 0) return { applied: false };

  const login = loginEnvForSeat();
  process.env.HOME = seat.home;
  process.env.USER = seat.name;
  process.env.LOGNAME = seat.name;
  if (seat.shell) process.env.SHELL = seat.shell;
  if (login.PATH) process.env.PATH = login.PATH;
  // Common credential / tooling paths from the seat login probe.
  for (const key of [
    "SSH_AUTH_SOCK",
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "GIT_ASKPASS",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
  ] as const) {
    const v = login[key];
    if (v) process.env[key] = v;
  }

  // Prefer additive GIT_CONFIG_* so we do not clobber a caller that already
  // injected keys. safe.directory=* is laptop-local and matches the control-
  // plane threat model (JWT-gated, not public).
  const existing = Number(process.env.GIT_CONFIG_COUNT || "0");
  let hasSafe = false;
  for (let i = 0; i < existing; i++) {
    if (process.env[`GIT_CONFIG_KEY_${i}`] === "safe.directory") {
      hasSafe = true;
      break;
    }
  }
  if (!hasSafe) {
    const n = Number.isFinite(existing) && existing > 0 ? existing : 0;
    process.env.GIT_CONFIG_COUNT = String(n + 1);
    process.env[`GIT_CONFIG_KEY_${n}`] = "safe.directory";
    process.env[`GIT_CONFIG_VALUE_${n}`] = "*";
  }

  return { applied: true, seat };
}

/** Interactive PTY needs UTF-8 + a real TERM (systemd/root often has LANG=C, TERM=dumb). */
export function enrichPtyEnv(env: Record<string, string>): Record<string, string> {
  const out = { ...env };
  const isUtf8 = (v: string | undefined) => !!v && /utf-?8/i.test(v);
  if (!isUtf8(out.LC_ALL) && !isUtf8(out.LC_CTYPE) && !isUtf8(out.LANG)) {
    // C.UTF-8 is always available on modern glibc; matches locale -a "C.utf8".
    out.LANG = "C.UTF-8";
    out.LC_CTYPE = "C.UTF-8";
  } else if (!out.LC_ALL && !isUtf8(out.LC_CTYPE)) {
    out.LC_CTYPE = isUtf8(out.LANG) ? out.LANG! : "C.UTF-8";
  }
  if (!out.TERM || out.TERM === "dumb") {
    out.TERM = "xterm-256color";
  }
  if (!out.COLORTERM) {
    out.COLORTERM = "truecolor";
  }
  // Route sudo password prompts through Chat (SUDO_ASKPASS), not a raw TTY.
  Object.assign(out, sudoAskpassEnv());
  return out;
}

/**
 * Non-interactive `bash -lc` sources ~/.profile, which sources ~/.bashrc, which
 * returns immediately when the shell is not interactive — so nvm/pnpm/node never
 * land on PATH. systemd's PATH is just /usr/bin:/bin, and `./build.sh --run`
 * then dies in ~15ms with "Missing command pnpm".
 * Source the toolchains explicitly inside the login probe.
 */
export const LOGIN_ENV_PROBE = [
  "set +e",
  'if [ -s "$HOME/.nvm/nvm.sh" ]; then . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1; fi',
  'if [ -s "$HOME/.cargo/env" ]; then . "$HOME/.cargo/env"; fi',
  'export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"',
  'export PNPM_HOME="${PNPM_HOME:-$HOME/.local/share/pnpm}"',
  'export PATH="$PNPM_HOME:$BUN_INSTALL/bin:$HOME/.local/bin:$PATH"',
  "env -0",
].join("; ");

function cmpVersionNames(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

/** Resolve ~/.nvm/alias/default ("24", "v24.14.1", "node", "lts/…") to a version dir name. */
export function pickNvmVersion(versions: string[], alias: string): string | undefined {
  const sorted = [...versions].filter((v) => v.startsWith("v")).sort(cmpVersionNames);
  if (!sorted.length) return undefined;
  const raw = alias.trim();
  if (!raw || raw === "node" || raw === "stable" || raw.startsWith("lts")) {
    return sorted[sorted.length - 1];
  }
  const want = raw.startsWith("v") ? raw : `v${raw}`;
  const matches = sorted.filter((v) => v === want || v.startsWith(`${want}.`));
  return matches.length ? matches[matches.length - 1] : sorted[sorted.length - 1];
}

/**
 * Toolchain bins that must be on PATH even when the login probe fails.
 * nvm's node bin is first so `pnpm` / `node` from the default Node win.
 */
export function discoverToolBins(home: string): string[] {
  const bins: string[] = [];
  const add = (p: string) => {
    if (p && existsSync(p) && !bins.includes(p)) bins.push(p);
  };
  const nodeRoot = join(home, ".nvm", "versions", "node");
  let versions: string[] = [];
  if (existsSync(nodeRoot)) {
    try {
      versions = readdirSync(nodeRoot);
    } catch {
      versions = [];
    }
  }
  let alias = "";
  const aliasPath = join(home, ".nvm", "alias", "default");
  if (existsSync(aliasPath)) {
    try {
      alias = readFileSync(aliasPath, "utf8").trim();
    } catch {
      alias = "";
    }
  }
  const chosen = pickNvmVersion(versions, alias);
  if (chosen) add(join(nodeRoot, chosen, "bin"));
  add(join(home, ".local", "share", "pnpm"));
  add(join(home, ".bun", "bin"));
  add(join(home, ".local", "bin"));
  add(join(home, ".cargo", "bin"));
  return bins;
}

function prependPath(current: string, bins: string[]): string {
  const merged: string[] = [];
  for (const p of [...bins, ...current.split(":")]) {
    if (p && !merged.includes(p)) merged.push(p);
  }
  return merged.join(":");
}

let loginEnvCache: { key: string; at: number; env: Record<string, string> } | null = null;
const LOGIN_ENV_CACHE_MS = 60_000;

export function clearLoginEnvCache(): void {
  loginEnvCache = null;
}

export function loginEnvForSeat(): Record<string, string> {
  const seat = detectSeatUser();
  const cacheKey = `${seat.uid}:${seat.home}`;
  const now = Date.now();
  if (
    loginEnvCache &&
    loginEnvCache.key === cacheKey &&
    now - loginEnvCache.at < LOGIN_ENV_CACHE_MS
  ) {
    return { ...loginEnvCache.env };
  }
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    HOME: seat.home,
    USER: seat.name,
    LOGNAME: seat.name,
    SHELL: seat.shell,
  };
  try {
    const prefix = setprivPrefix(seat);
    const cmd = prefix
      ? [...prefix, "bash", "-lc", LOGIN_ENV_PROBE]
      : ["bash", "-lc", LOGIN_ENV_PROBE];
    const probeEnv: Record<string, string> = {
      ...(process.env as Record<string, string>),
      HOME: seat.home,
      USER: seat.name,
      LOGNAME: seat.name,
      SHELL: seat.shell || "/bin/bash",
      TERM: "dumb",
    };
    delete probeEnv.BASH_ENV;
    delete probeEnv.ENV;
    const r = spawnSync(cmd[0]!, cmd.slice(1), {
      encoding: "buffer",
      env: probeEnv,
      timeout: 8000,
    });
    if (r.status === 0 && r.stdout) {
      for (const part of r.stdout.toString("utf8").split("\0")) {
        const eq = part.indexOf("=");
        if (eq > 0) env[part.slice(0, eq)] = part.slice(eq + 1);
      }
    }
  } catch {
    /* keep base */
  }
  env.HOME = seat.home;
  env.USER = seat.name;
  env.LOGNAME = seat.name;
  env.PATH = prependPath(env.PATH || "", discoverToolBins(seat.home));
  const out = enrichPtyEnv(env);
  loginEnvCache = { key: cacheKey, at: now, env: out };
  return { ...out };
}

/** True when the seat user's PATH can see node and pnpm (Run/Expo). */
export function seatToolHealth(): { node: boolean; pnpm: boolean } {
  const path = loginEnvForSeat().PATH || "";
  const bins = path.split(":");
  const has = (cmd: string) => bins.some((b) => existsSync(join(b, cmd)));
  return { node: has("node"), pnpm: has("pnpm") };
}
