/**
 * Seat-user Home Visitor window (Tauri mini-app).
 * Falls back to Chromium --app if the Tauri binary is not installed yet.
 * No separate systemd unit — child of homebased.
 */
import { existsSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { BUNDLE_ROOT, bindHost, bindPort } from "./config";
import { detectSeatUser } from "./shell_env";
import { appendTrace } from "./trace";
import { discoverSessionType, discoverWaylandEnv, discoverX11Env } from "./view";
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

/** Prefer built Tauri binary locations (homevisitor; legacy homebase-presence). */
function findPresenceBinary(): string | null {
  const env = (
    process.env.HOMEBASE_VISITOR_BIN ||
    process.env.HOMEBASE_PRESENCE_BIN ||
    ""
  ).trim();
  if (env && existsSync(env)) return env;
  const candidates = [
    join(BUNDLE_ROOT, "dist", "homevisitor"),
    "/usr/share/homebased/homevisitor",
    "/usr/local/bin/homevisitor",
    join(process.env.HOME || "", ".local/share/homebase/homevisitor"),
    join(BUNDLE_ROOT, "homevisitor", "src-tauri", "target", "release", "homevisitor"),
    // Legacy names
    join(BUNDLE_ROOT, "dist", "homebase-presence"),
    "/usr/share/homebased/homebase-presence",
    "/usr/local/bin/homebase-presence",
    join(process.env.HOME || "", ".local/share/homebase/homebase-presence"),
    join(
      BUNDLE_ROOT,
      "homevisitor",
      "src-tauri",
      "target",
      "release",
      "homebase-presence",
    ),
    join(
      BUNDLE_ROOT,
      "presence-app",
      "src-tauri",
      "target",
      "release",
      "homebase-presence",
    ),
  ];
  for (const p of candidates) {
    if (p && existsSync(p)) return p;
  }
  return Bun.which("homevisitor") || Bun.which("homebase-presence") || null;
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
  const { waylandDisplay, runtimeDir } = discoverWaylandEnv(uid);
  const sessionType = discoverSessionType(uid);
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
      if (!runuser) throw new Error("setpriv/runuser required for Home Visitor as root");
      out = [runuser, "-u", seat.name, "--", ...cmd];
    }
  }
  const token = presenceUiToken();
  const base = presenceBaseUrl();
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    DISPLAY: display,
    XAUTHORITY: xauthority,
    HOME: seat.home,
    USER: seat.name,
    LOGNAME: seat.name,
    XDG_RUNTIME_DIR: runtimeDir,
    XDG_SESSION_TYPE: sessionType === "unknown" ? "wayland" : sessionType,
    DBUS_SESSION_BUS_ADDRESS:
      process.env.DBUS_SESSION_BUS_ADDRESS ||
      `unix:path=${runtimeDir}/bus`,
    HOMEBASE_VISITOR_BASE: base,
    HOMEBASE_VISITOR_TOKEN: token,
    // Legacy env names (one release)
    HOMEBASE_PRESENCE_BASE: base,
    HOMEBASE_PRESENCE_TOKEN: token,
    HOMEBASE_URL: base,
  };
  if (waylandDisplay) env.WAYLAND_DISPLAY = waylandDisplay;
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
  appendTrace("info", `homevisitor window stopped (${reason})`, "presence");
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
          "homevisitor: build homevisitor (Tauri) or install Chromium",
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
        "--class=HomeVisitor",
        "--name=Home Visitor",
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
      `homevisitor window started mode=${mode} uid=${seat.uid}`,
      "presence",
    );
  } catch (e) {
    appendTrace(
      "warn",
      `homevisitor window failed: ${e instanceof Error ? e.message : String(e)}`,
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

function scheduleSync(ms: number): void {
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
