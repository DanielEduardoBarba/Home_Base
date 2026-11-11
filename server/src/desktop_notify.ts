/**
 * Seat-user desktop notifications (notify-send) — sparse, short-lived, replaceable.
 * Prefer the Presence window for day-to-day remotes; only ping the tray for security
 * or the first interesting remote join.
 */
import { spawn, spawnSync } from "node:child_process";
import { discoverX11Env } from "./view";
import { detectSeatUser } from "./shell_env";

type Urgency = "low" | "normal" | "critical";

type NotifyOpts = {
  urgency?: Urgency;
  /** Collapse repeats of the same logical event. */
  dedupeKey?: string;
  dedupeMs?: number;
  /** Milliseconds on screen (critical still auto-expires here). */
  expireMs?: number;
  /**
   * Stable replace id namespace — re-notify replaces the previous bubble;
   * desktopClose(replaceKey) dismisses it when no longer relevant.
   */
  replaceKey?: string;
  /** Hint libnotify this is transient (easier to dismiss). Default true. */
  transient?: boolean;
};

const lastByKey = new Map<string, number>();
/** replaceKey → freedesktop notification id */
const openIds = new Map<string, number>();

let globalLastAt = 0;
const GLOBAL_MIN_GAP_MS = 4_000;

type SeatRun = {
  wrap: (argv: string[]) => string[];
  env: Record<string, string>;
};

function seatRun(): SeatRun | null {
  try {
    const { display, xauthority } = discoverX11Env();
    const seat = detectSeatUser();
    const uid = seat.uid;
    const gid = seat.gid;

    const wrap = (argv: string[]): string[] => {
      if (typeof process.getuid === "function" && process.getuid() === 0 && uid !== 0) {
        const setpriv = Bun.which("setpriv");
        if (setpriv) {
          return [
            setpriv,
            `--reuid=${uid}`,
            `--regid=${gid}`,
            "--init-groups",
            "--",
            ...argv,
          ];
        }
        const runuser = Bun.which("runuser");
        if (!runuser) return argv;
        return [runuser, "-u", seat.name, "--", ...argv];
      }
      return argv;
    };

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
    return { wrap, env };
  } catch {
    return null;
  }
}

function closeNotificationId(id: number): void {
  if (!Number.isFinite(id) || id <= 0) return;
  const seat = seatRun();
  const gdbus = Bun.which("gdbus");
  if (!seat || !gdbus) return;
  try {
    const cmd = seat.wrap([
      gdbus,
      "call",
      "--session",
      "--dest",
      "org.freedesktop.Notifications",
      "--object-path",
      "/org/freedesktop/Notifications",
      "--method",
      "org.freedesktop.Notifications.CloseNotification",
      String(id),
    ]);
    spawnSync(cmd[0]!, cmd.slice(1), {
      env: seat.env,
      stdio: "ignore",
      timeout: 3_000,
    });
  } catch {
    /* best-effort */
  }
}

/** Dismiss a previously shown notification (by replaceKey). */
export function desktopClose(replaceKey: string): void {
  const key = String(replaceKey || "").trim();
  if (!key) return;
  const id = openIds.get(key);
  if (id == null) return;
  openIds.delete(key);
  closeNotificationId(id);
}

export function desktopNotify(
  title: string,
  body: string,
  opts?: NotifyOpts,
): void {
  const urgency: Urgency = opts?.urgency || "low";
  const dedupeKey = opts?.dedupeKey || opts?.replaceKey || `${title}|${body}`;
  const dedupeMs = opts?.dedupeMs ?? 30_000;
  const expireMs =
    opts?.expireMs ??
    (urgency === "critical" ? 8_000 : urgency === "normal" ? 5_000 : 3_500);
  const now = Date.now();

  const last = lastByKey.get(dedupeKey) || 0;
  if (now - last < dedupeMs) return;
  if (now - globalLastAt < GLOBAL_MIN_GAP_MS && urgency !== "critical") return;

  lastByKey.set(dedupeKey, now);
  globalLastAt = now;
  if (lastByKey.size > 80) {
    for (const [k, t] of lastByKey) {
      if (now - t > 10 * 60_000) lastByKey.delete(k);
    }
  }

  const seat = seatRun();
  const notify = Bun.which("notify-send");
  if (!seat || !notify) return;

  const replaceKey = opts?.replaceKey ? String(opts.replaceKey) : "";
  const prevId = replaceKey ? openIds.get(replaceKey) : undefined;

  const args = [
    notify,
    `--urgency=${urgency}`,
    "--app-name=Home Base",
    `--expire-time=${Math.max(1_500, expireMs)}`,
    "--print-id",
  ];
  if (opts?.transient !== false) {
    args.push("--hint", "int:transient:1");
  }
  if (prevId != null) {
    args.push("--replace-id", String(prevId));
  }
  args.push(String(title).slice(0, 80), String(body).slice(0, 160));

  const cmd = seat.wrap(args);

  try {
    const child = spawn(cmd[0]!, cmd.slice(1), {
      env: seat.env,
      stdio: ["ignore", "pipe", "ignore"],
      detached: false,
    });
    let out = "";
    child.stdout?.on("data", (buf: Buffer) => {
      out += buf.toString("utf8");
    });
    child.on("close", () => {
      const id = Number(String(out).trim().split(/\s+/)[0]);
      if (replaceKey && Number.isFinite(id) && id > 0) {
        openIds.set(replaceKey, id);
      }
    });
    const t = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    }, 4_000);
    if (typeof t === "object" && t && "unref" in t) t.unref();
  } catch {
    /* desktop notify is best-effort */
  }
}
