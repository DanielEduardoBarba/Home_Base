import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";

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

export function loginEnvForSeat(): Record<string, string> {
  const seat = detectSeatUser();
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
      ? [...prefix, "bash", "-lc", "env -0"]
      : ["bash", "-lc", "env -0"];
    const r = spawnSync(cmd[0]!, cmd.slice(1), {
      encoding: "buffer",
      env: { ...process.env, HOME: seat.home },
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
  for (const extra of [`${seat.home}/.bun/bin`, `${seat.home}/.local/bin`]) {
    if (existsSync(extra)) env.PATH = `${extra}:${env.PATH || ""}`;
  }
  return env;
}
