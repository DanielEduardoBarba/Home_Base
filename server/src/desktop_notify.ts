/**
 * Fire a seat-user desktop notification (notify-send) so the physical operator
 * sees security / presence events even without the SPA open.
 */
import { spawn } from "node:child_process";
import { discoverX11Env } from "./view";
import { detectSeatUser } from "./shell_env";

let lastKey = "";
let lastAt = 0;

export function desktopNotify(
  title: string,
  body: string,
  opts?: { urgency?: "low" | "normal" | "critical"; dedupeKey?: string; dedupeMs?: number },
): void {
  const urgency = opts?.urgency || "normal";
  const key = opts?.dedupeKey || `${title}|${body}`;
  const dedupeMs = opts?.dedupeMs ?? 8_000;
  const now = Date.now();
  if (key === lastKey && now - lastAt < dedupeMs) return;
  lastKey = key;
  lastAt = now;

  try {
    const { display, xauthority } = discoverX11Env();
    const seat = detectSeatUser();
    const uid = seat.uid;
    const gid = seat.gid;
    const notify = Bun.which("notify-send");
    if (!notify) return;

    let cmd: string[] = [
      notify,
      `--urgency=${urgency}`,
      "--app-name=Home Base",
      "--expire-time=12000",
      title,
      body,
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
        if (!runuser) return;
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
      detached: true,
    });
    child.unref();
  } catch {
    /* desktop notify is best-effort */
  }
}
