import { execSync } from "node:child_process";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

export function isPortListening(port: number): boolean {
  try {
    const out = execSync(`ss -ltn 2>/dev/null | awk '{print $4}' || true`, {
      encoding: "utf8",
    });
    return out.split("\n").some((line) => line.endsWith(`:${port}`));
  } catch {
    return false;
  }
}

export function homebaseListenPort(): number {
  const n = Number(process.env.HOMEBASE_PORT || "8888");
  return Number.isFinite(n) ? n : 8888;
}

/** Never kill listeners on homebased's own port. */
export function isProtectedPort(port: number): boolean {
  return port === homebaseListenPort() || port === 8888;
}

export function pidsOnPort(port: number): number[] {
  if (isProtectedPort(port)) return [];
  try {
    const out = execSync(`ss -ltnp 2>/dev/null | grep -E ':${port}\\b' || true`, {
      encoding: "utf8",
    });
    const pids = new Set<number>();
    for (const m of out.matchAll(/pid=(\d+)/g)) {
      pids.add(Number(m[1]));
    }
    return [...pids];
  } catch {
    return [];
  }
}

export function killPortListeners(port: number): string[] {
  if (isProtectedPort(port)) return [];
  const killed: string[] = [];
  for (const pid of pidsOnPort(port)) {
    try {
      process.kill(pid, "SIGTERM");
      killed.push(String(pid));
    } catch {
      /* ignore */
    }
  }
  return killed;
}

export function inHomebasedCgroup(pid: number): boolean {
  try {
    const path = `/proc/${pid}/cgroup`;
    if (!existsSync(path)) return false;
    const text = readFileSync(path, "utf8");
    return text.includes("homebased");
  } catch {
    return false;
  }
}

export function listProc(): string[] {
  try {
    return readdirSync("/proc").filter((n) => /^\d+$/.test(n));
  } catch {
    return [];
  }
}

void join;
