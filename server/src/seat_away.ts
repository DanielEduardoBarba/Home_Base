/**
 * Detect whether the seat user is away from the laptop:
 * screen locked, no graphical session / DE, or idle input ≥ 10 minutes.
 */
import { spawnSync } from "node:child_process";
import { detectSeatUser } from "./shell_env";

export const SEAT_IDLE_AWAY_MS = 10 * 60_000;
const CACHE_MS = 4_000;

export type SeatAwayReason =
  | "locked"
  | "no_session"
  | "idle"
  | "present";

export type SeatAwayStatus = {
  away: boolean;
  reason: SeatAwayReason;
  idleMs: number | null;
  locked: boolean;
  checkedAt: number;
  detail?: string;
};

let cache: SeatAwayStatus | null = null;

function run(cmd: string[], env?: Record<string, string>): string {
  const r = spawnSync(cmd[0]!, cmd.slice(1), {
    encoding: "utf8",
    env: env || (process.env as Record<string, string>),
    timeout: 3_000,
  });
  if (r.status !== 0) return "";
  return String(r.stdout || "").trim();
}

function parseLoginctlProps(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    out[line.slice(0, eq)] = line.slice(eq + 1).trim();
  }
  return out;
}

function pickGraphicalSession(user: string): string | null {
  const list = run(["loginctl", "list-sessions", "--no-legend"]);
  if (!list) return null;
  let fallback: string | null = null;
  for (const line of list.split("\n")) {
    const parts = line.trim().split(/\s+/);
    // SESSION UID USER SEAT TTY …
    if (parts.length < 3) continue;
    const id = parts[0]!;
    const name = parts[2]!;
    if (name !== user) continue;
    const props = parseLoginctlProps(
      run([
        "loginctl",
        "show-session",
        id,
        "-p",
        "Type",
        "-p",
        "State",
        "-p",
        "Class",
      ]),
    );
    const typ = (props.Type || "").toLowerCase();
    const state = (props.State || "").toLowerCase();
    const cls = (props.Class || "").toLowerCase();
    if (cls === "manager") continue;
    if (typ === "wayland" || typ === "x11" || typ === "mir") {
      if (state === "active" || state === "online") return id;
      fallback = fallback || id;
    } else if (!fallback && state === "active") {
      fallback = id;
    }
  }
  return fallback;
}

function idleMsFromLoginctl(props: Record<string, string>): number | null {
  const hint = (props.IdleHint || "").toLowerCase();
  if (hint !== "yes") return 0;
  const since = Number(props.IdleSinceHint || 0);
  if (!Number.isFinite(since) || since <= 0) return null;
  // systemd: CLOCK_REALTIME microseconds
  const idleMs = Date.now() - Math.floor(since / 1000);
  return idleMs >= 0 ? idleMs : null;
}

function screensaverActive(uid: number): boolean | null {
  const gdbus = Bun.which("gdbus");
  if (!gdbus) return null;
  const bus = `unix:path=/run/user/${uid}/bus`;
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    DBUS_SESSION_BUS_ADDRESS: bus,
  };
  const seat = detectSeatUser();
  let argv = [
    gdbus,
    "call",
    "--session",
    "--dest",
    "org.freedesktop.ScreenSaver",
    "--object-path",
    "/org/freedesktop/ScreenSaver",
    "--method",
    "org.freedesktop.ScreenSaver.GetActive",
  ];
  if (typeof process.getuid === "function" && process.getuid() === 0 && seat.uid !== 0) {
    const setpriv = Bun.which("setpriv");
    if (setpriv) {
      argv = [
        setpriv,
        `--reuid=${seat.uid}`,
        `--regid=${seat.gid}`,
        "--init-groups",
        "--",
        ...argv,
      ];
    }
  }
  const out = run(argv, env);
  // (true,) or (false,)
  if (/\btrue\b/i.test(out)) return true;
  if (/\bfalse\b/i.test(out)) return false;
  return null;
}

function probeAway(): SeatAwayStatus {
  const checkedAt = Date.now();
  try {
    const seat = detectSeatUser();
    const sessionId = pickGraphicalSession(seat.name);
    if (!sessionId) {
      return {
        away: true,
        reason: "no_session",
        idleMs: null,
        locked: false,
        checkedAt,
        detail: "No graphical desktop session",
      };
    }
    const props = parseLoginctlProps(
      run([
        "loginctl",
        "show-session",
        sessionId,
        "-p",
        "LockedHint",
        "-p",
        "IdleHint",
        "-p",
        "IdleSinceHint",
        "-p",
        "Type",
        "-p",
        "State",
        "-p",
        "Active",
      ]),
    );
    const lockedHint = (props.LockedHint || "").toLowerCase() === "yes";
    const ss = screensaverActive(seat.uid);
    const locked = lockedHint || ss === true;
    if (locked) {
      return {
        away: true,
        reason: "locked",
        idleMs: idleMsFromLoginctl(props),
        locked: true,
        checkedAt,
        detail: lockedHint ? "Session LockedHint" : "Screen saver active",
      };
    }
    const idleMs = idleMsFromLoginctl(props);
    if (idleMs != null && idleMs >= SEAT_IDLE_AWAY_MS) {
      return {
        away: true,
        reason: "idle",
        idleMs,
        locked: false,
        checkedAt,
        detail: `Idle ${Math.round(idleMs / 60_000)}m`,
      };
    }
    return {
      away: false,
      reason: "present",
      idleMs: idleMs ?? 0,
      locked: false,
      checkedAt,
      detail: props.Type || "active",
    };
  } catch (e) {
    // Fail closed for AI-away alerts only when we cannot tell — treat as away
    // so a locked/offline seat still gets notified; auth emails ignore this.
    return {
      away: true,
      reason: "no_session",
      idleMs: null,
      locked: false,
      checkedAt,
      detail: e instanceof Error ? e.message : String(e),
    };
  }
}

/** Cached seat-away probe (few seconds). */
export function getSeatAwayStatus(opts?: { force?: boolean }): SeatAwayStatus {
  const now = Date.now();
  if (!opts?.force && cache && now - cache.checkedAt < CACHE_MS) return cache;
  cache = probeAway();
  return cache;
}

export function isSeatAway(): boolean {
  return getSeatAwayStatus().away;
}
