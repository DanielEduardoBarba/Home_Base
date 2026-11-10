/**
 * Seat-user Chromium/Chrome/Brave --app window for remote presence.
 * Shows when humans/AIs are remoted in; closes when the registry is empty.
 */
import { spawn, type Subprocess } from "node:child_process";
import { bindHost, bindPort } from "./config";
import { detectSeatUser } from "./shell_env";
import { appendTrace } from "./trace";
import { discoverX11Env } from "./view";
import {
  presenceUiToken,
  presenceWindowWanted,
  setPresenceChangeHandler,
} from "./presence";

let proc: Subprocess | null = null;
let starting = false;
let syncTimer: ReturnType<typeof setTimeout> | null = null;

function findBrowser(): string | null {
  for (const name of [
    "google-chrome-stable",
    "google-chrome",
    "chromium-browser",
    "chromium",
    "brave-browser",
    "microsoft-edge",
  ]) {
    const p = Bun.which(name);
    if (p) return p;
  }
  return null;
}

function presenceUrl(): string {
  const port = bindPort();
  const host = bindHost();
  const loop =
    host === "0.0.0.0" || host === "::" || host === ""
      ? "127.0.0.1"
      : host === "::1"
        ? "[::1]"
        : host;
  const k = encodeURIComponent(presenceUiToken());
  return `http://${loop}:${port}/presence?k=${k}`;
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
  const browser = findBrowser();
  if (!browser) {
    appendTrace(
      "warn",
      "presence window: no Chromium/Chrome/Brave found — install chromium for desktop presence UI",
      "presence",
    );
    return;
  }
  starting = true;
  try {
    const { display, xauthority } = discoverX11Env();
    const seat = detectSeatUser();
    const uid = seat.uid;
    const gid = seat.gid;
    const url = presenceUrl();
    let cmd: string[] = [
      browser,
      `--app=${url}`,
      "--new-window",
      "--window-size=380,560",
      "--class=HomeBasePresence",
      "--name=Home Base Presence",
      "--disable-extensions",
      "--no-first-run",
    ];
    if (typeof process.getuid === "function" && process.getuid() === 0 && uid !== 0) {
      const setpriv = Bun.which("setpriv");
      if (setpriv) {
        cmd = [
          setpriv,
          `--reuid=${uid}`,
          `--regid=${gid}`,
          "--init-groups",
          "--",
          ...cmd,
        ];
      } else {
        const runuser = Bun.which("runuser");
        if (!runuser) {
          appendTrace("warn", "presence window: setpriv/runuser missing", "presence");
          starting = false;
          return;
        }
        cmd = [runuser, "-u", seat.name, "--", ...cmd];
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
    };

    const child = spawn(cmd[0]!, cmd.slice(1), {
      env,
      stdio: "ignore",
      detached: false,
    });
    proc = child;
    child.on("exit", () => {
      if (proc === child) proc = null;
      // Operator closed the window — reopen if remotes still active.
      scheduleSync(800);
    });
    appendTrace(
      "info",
      `presence window started uid=${uid} display=${display}`,
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
