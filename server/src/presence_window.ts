/**
 * Seat-user native presence window (Tauri mini-app).
 * Falls back to Chromium --app if the Tauri binary is not installed yet.
 */
import { existsSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { BUNDLE_ROOT, bindHost, bindPort } from "./config";
import { detectSeatUser } from "./shell_env";
import { appendTrace } from "./trace";
import { discoverX11Env } from "./view";
import {
  presenceUiToken,
  presenceWindowWanted,
  setPresenceChangeHandler,
} from "./presence";

let proc: ChildProcess | null = null;
let starting = false;
let syncTimer: ReturnType<typeof setTimeout> | null = null;

function presenceBaseUrl(): string {
  const port = bindPort();
  const host = bindHost();
  const loop =
    host === "0.0.0.0" || host === "::" || host === ""
      ? "127.0.0.1"
      : host === "::1"
        ? "[::1]"
        : host;
  return `http://${loop}:${port}`;
}

function presenceUrl(): string {
  const k = encodeURIComponent(presenceUiToken());
  return `${presenceBaseUrl()}/presence?k=${k}`;
}

/** Prefer built Tauri binary locations. */
function findPresenceBinary(): string | null {
  const env = (process.env.HOMEBASE_PRESENCE_BIN || "").trim();
  if (env && existsSync(env)) return env;
  const candidates = [
    // Prefer packaged/dist + system install over possibly stale cargo target.
    join(BUNDLE_ROOT, "dist", "homebase-presence"),
    "/usr/share/homebased/homebase-presence",
    "/usr/local/bin/homebase-presence",
    join(
      process.env.HOME || "",
      ".local/share/homebase/homebase-presence",
    ),
    join(BUNDLE_ROOT, "presence-app", "src-tauri", "target", "release", "homebase-presence"),
  ];
  for (const p of candidates) {
    if (p && existsSync(p)) return p;
  }
  const which = Bun.which("homebase-presence");
  return which || null;
}

function findBrowser(): string | null {
  for (const name of [
    "google-chrome-stable",
    "google-chrome",
    "chromium-browser",
    "chromium",
    "brave-browser",
  ]) {
    const p = Bun.which(name);
    if (p) return p;
  }
  return null;
}

function wrapSeat(cmd: string[]): { cmd: string[]; env: Record<string, string> } {
  const { display, xauthority } = discoverX11Env();
  const seat = detectSeatUser();
  const uid = seat.uid;
  const gid = seat.gid;
  let out = cmd;
  if (typeof process.getuid === "function" && process.getuid() === 0 && uid !== 0) {
    const setpriv = Bun.which("setpriv");
    if (setpriv) {
      out = [
        setpriv,
        `--reuid=${uid}`,
        `--regid=${gid}`,
        "--init-groups",
        "--",
        ...cmd,
      ];
    } else {
      const runuser = Bun.which("runuser");
      if (!runuser) throw new Error("setpriv/runuser required for presence as root");
      out = [runuser, "-u", seat.name, "--", ...cmd];
    }
  }
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    DISPLAY: display,
    XAUTHORITY: xauthority,
    HOME: seat.home,
    USER: seat.name,
    LOGNAME: seat.name,
    DBUS_SESSION_BUS_ADDRESS:
      process.env.DBUS_SESSION_BUS_ADDRESS ||
      `unix:path=/run/user/${uid}/bus`,
    HOMEBASE_PRESENCE_BASE: presenceBaseUrl(),
    HOMEBASE_PRESENCE_TOKEN: presenceUiToken(),
    HOMEBASE_URL: presenceBaseUrl(),
  };
  return { cmd: out, env };
}

function stopWindow(reason: string): void {
  if (!proc) return;
  try {
    proc.kill("SIGTERM");
  } catch {
    /* ignore */
  }
  proc = null;
  appendTrace("info", `presence window stopped (${reason})`, "presence");
}

function startWindow(): void {
  if (proc || starting) return;
  starting = true;
  try {
    const seat = detectSeatUser();
    const binary = findPresenceBinary();
    let cmd: string[];
    let mode: "tauri" | "chromium";
    if (binary) {
      mode = "tauri";
      cmd = [binary];
    } else {
      const browser = findBrowser();
      if (!browser) {
        appendTrace(
          "warn",
          "presence window: build presence-app (Tauri) or install Chromium",
          "presence",
        );
        starting = false;
        return;
      }
      mode = "chromium";
      cmd = [
        browser,
        `--app=${presenceUrl()}`,
        "--new-window",
        "--window-size=400,620",
        "--class=HomeBasePresence",
        "--name=Home Base Presence",
        "--disable-extensions",
        "--no-first-run",
      ];
    }

    const wrapped = wrapSeat(cmd);
    const child = spawn(wrapped.cmd[0]!, wrapped.cmd.slice(1), {
      env: wrapped.env,
      stdio: "ignore",
      detached: false,
    });
    proc = child;
    child.on("exit", () => {
      if (proc === child) proc = null;
      scheduleSync(800);
    });
    appendTrace(
      "info",
      `presence window started mode=${mode} uid=${seat.uid}`,
      "presence",
    );
  } catch (e) {
    appendTrace(
      "warn",
      `presence window failed: ${e instanceof Error ? e.message : String(e)}`,
      "presence",
    );
  } finally {
    starting = false;
  }
}

function syncWindow(): void {
  const wanted = presenceWindowWanted();
  if (wanted && !proc && !starting) startWindow();
  if (!wanted && proc) stopWindow("idle");
}

function scheduleSync(ms = 200): void {
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    syncTimer = null;
    syncWindow();
  }, ms);
}

export function startPresenceWindowManager(): void {
  setPresenceChangeHandler(() => scheduleSync(100));
  scheduleSync(500);
}

export function stopPresenceWindowManager(): void {
  setPresenceChangeHandler(null);
  stopWindow("shutdown");
}
