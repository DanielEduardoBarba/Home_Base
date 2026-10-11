import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { bindPort, isBackupBinary, readVersion } from "./config";
import { accessHosts } from "./network";
import { appendTrace } from "./trace";

export function systemStatus(): Record<string, unknown> {
  const wireguard: { id: string; unit: string; conf: string }[] = [];
  const confDir = "/etc/wireguard";
  if (existsSync(confDir)) {
    try {
      for (const name of readdirSync(confDir)) {
        if (!name.endsWith(".conf")) continue;
        const id = name.replace(/\.conf$/, "");
        wireguard.push({
          id,
          unit: `wg-quick@${id}`,
          conf: `${confDir}/${name}`,
        });
      }
    } catch {
      /* ignore */
    }
  }
  return {
    wireguard,
    homebasedUnit: "homebased.service",
    version: readVersion(),
    backup: isBackupBinary(),
    ...accessHosts(bindPort()),
  };
}

function systemctl(...args: string[]): { ok: boolean; out: string } {
  const r = spawnSync("systemctl", args, { encoding: "utf8" });
  return {
    ok: r.status === 0,
    out: (r.stdout || "") + (r.stderr || ""),
  };
}

/**
 * Restart via a transient systemd timer outside homebased's cgroup.
 * A direct `systemctl restart` from inside the unit is killed with KillMode=control-group
 * and can leave the service down (chat-driven deploy/restart).
 */
export function restartHomebased(): Record<string, unknown> {
  if (process.getuid?.() !== 0) {
    return {
      ok: false,
      unit: "homebased.service",
      active: false,
      error: "root required",
    };
  }
  const timer = `homebased-self-restart-${process.hrtime.bigint()}`;
  appendTrace("warn", `homebased restart scheduled via ${timer}`, "system");
  const r = spawnSync(
    "systemd-run",
    [
      "--collect",
      `--unit=${timer}`,
      "--on-active=1s",
      "--timer-property=AccuracySec=100ms",
      "systemctl",
      "restart",
      "homebased.service",
    ],
    { encoding: "utf8" },
  );
  if (r.status !== 0) {
    const err = ((r.stderr || "") + (r.stdout || "")).trim();
    appendTrace("warn", `systemd-run failed, falling back: ${err}`, "system");
    const fallback = systemctl("restart", "homebased.service");
    const active = systemctl("is-active", "homebased.service");
    return {
      ok: fallback.ok || active.out.trim() === "active",
      unit: "homebased.service",
      active: active.out.trim() === "active",
      scheduled: false,
      error: err || undefined,
    };
  }
  return {
    ok: true,
    unit: "homebased.service",
    active: true,
    scheduled: true,
    timer,
    stdout: (r.stdout || "").trim(),
  };
}

/** True when this process is in the homebased.service cgroup (self-deploy risk). */
export function underHomebasedService(): boolean {
  try {
    const text = readFileSync("/proc/self/cgroup", "utf8");
    return text.includes("homebased.service");
  } catch {
    return false;
  }
}

export function restartWireguard(
  iface: string | null,
): { ok: boolean; results: { ok: boolean; unit: string }[] } {
  if (process.getuid?.() !== 0) {
    return { ok: false, results: [] };
  }
  const status = systemStatus();
  const list = (status.wireguard as { id: string; unit: string }[]) || [];
  const targets = iface
    ? list.filter((w) => w.id === iface)
    : list;
  const results = targets.map((w) => {
    const r = systemctl("restart", w.unit);
    return { ok: r.ok, unit: w.unit };
  });
  return { ok: results.every((r) => r.ok), results };
}

export function journalLines(
  unit: string,
  limit: number,
): { items: { id: number; ts: number; level: string; message: string }[]; error?: string } {
  const allowed = new Set([
    "homebased.service",
    "wg-quick@wg0.service",
  ]);
  // allow any wg-quick@*
  const okUnit =
    allowed.has(unit) || /^wg-quick@[A-Za-z0-9_.-]+\.service$/.test(unit);
  if (!okUnit) {
    return { items: [], error: "unit not allowed" };
  }
  const r = spawnSync(
    "journalctl",
    ["-u", unit, "-n", String(Math.min(limit, 200)), "-o", "short-iso", "--no-pager"],
    { encoding: "utf8" },
  );
  if (r.status !== 0) {
    return { items: [], error: (r.stderr || "journalctl failed").trim() };
  }
  const lines = (r.stdout || "").trim().split("\n").filter(Boolean);
  return {
    items: lines.map((message, i) => ({
      id: i + 1,
      ts: Date.now() / 1000,
      level: "info",
      message,
    })),
  };
}
