import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { RUNTIME_DIR, ensureRuntimeDirs } from "./config";

export function appendDaily(
  event: string,
  fields: Record<string, unknown> = {},
): void {
  ensureRuntimeDirs();
  const day = new Date().toISOString().slice(0, 10);
  const dir = join(RUNTIME_DIR, "logs");
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    /* ignore */
  }
  const path = join(dir, `${day}.log`);
  const row = {
    ts: new Date().toISOString(),
    event,
    ...fields,
  };
  try {
    appendFileSync(path, JSON.stringify(row) + "\n", "utf8");
  } catch {
    /* ignore */
  }
}

export function readDailyLogs(limit = 200): unknown[] {
  const day = new Date().toISOString().slice(0, 10);
  const path = join(RUNTIME_DIR, "logs", `${day}.log`);
  if (!existsSync(path)) return [];
  try {
    const lines = readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
    return lines.slice(-limit).map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return { raw: l };
      }
    });
  } catch {
    return [];
  }
}
