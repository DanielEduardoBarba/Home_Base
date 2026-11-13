/**
 * Human-only activity history (MCP + Web GUI).
 * Stored under .runtime/activity/ — never exposed via MCP tools.
 */
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { RUNTIME_DIR, ensureRuntimeDirs } from "./config";
import { redactDeep, redactSecrets } from "./redact";

const DIR = join(RUNTIME_DIR, "activity");
const MAX_DAYS = 30;
const MAX_LINES_PER_DAY = 20_000;

export type ActivitySource = "web" | "mcp" | "system" | "auth";

export type ActivityEvent = {
  at: number;
  source: ActivitySource;
  kind: string;
  summary: string;
  detail?: Record<string, unknown>;
  actor?: string;
  peerIp?: string;
};

function dayFile(day: string): string {
  return join(DIR, `${day}.jsonl`);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function ensureDir(): void {
  ensureRuntimeDirs();
  if (!existsSync(DIR)) {
    mkdirSync(DIR, { recursive: true, mode: 0o700 });
  }
  try {
    chmodSync(DIR, 0o700);
  } catch {
    /* ignore */
  }
}

function pruneOld(): void {
  if (!existsSync(DIR)) return;
  try {
    const names = readdirSync(DIR)
      .filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n))
      .sort();
    while (names.length > MAX_DAYS) {
      const old = names.shift();
      if (!old) break;
      try {
        unlinkSync(join(DIR, old));
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
}

/** Append one activity row. Never call from MCP tool responses as a data dump. */
export function recordActivity(ev: {
  source: ActivitySource;
  kind: string;
  summary: string;
  detail?: Record<string, unknown>;
  actor?: string;
  peerIp?: string;
}): void {
  try {
    ensureDir();
    pruneOld();
    const row: ActivityEvent = {
      at: Date.now(),
      source: ev.source,
      kind: String(ev.kind || "event").slice(0, 64),
      summary: redactSecrets(String(ev.summary || "")).slice(0, 400),
      detail: ev.detail
        ? (redactDeep(ev.detail) as Record<string, unknown>)
        : undefined,
      actor: ev.actor ? String(ev.actor).slice(0, 80) : undefined,
      peerIp: ev.peerIp ? String(ev.peerIp).slice(0, 64) : undefined,
    };
    const path = dayFile(today());
    appendFileSync(path, JSON.stringify(row) + "\n", { mode: 0o600 });
    try {
      chmodSync(path, 0o600);
    } catch {
      /* ignore */
    }
  } catch {
    /* audit must never break the request path */
  }
}

export function listActivity(opts?: {
  day?: string;
  limit?: number;
  source?: ActivitySource | "all";
  offset?: number;
}): {
  day: string;
  days: string[];
  events: ActivityEvent[];
  total: number;
} {
  ensureDir();
  pruneOld();
  const days = existsSync(DIR)
    ? readdirSync(DIR)
        .filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n))
        .map((n) => n.replace(/\.jsonl$/, ""))
        .sort()
        .reverse()
    : [];
  const day = opts?.day && /^\d{4}-\d{2}-\d{2}$/.test(opts.day) ? opts.day : days[0] || today();
  const path = dayFile(day);
  let events: ActivityEvent[] = [];
  if (existsSync(path)) {
    try {
      const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
      const capped =
        lines.length > MAX_LINES_PER_DAY
          ? lines.slice(lines.length - MAX_LINES_PER_DAY)
          : lines;
      for (const line of capped) {
        try {
          const row = JSON.parse(line) as ActivityEvent;
          if (opts?.source && opts.source !== "all" && row.source !== opts.source) {
            continue;
          }
          events.push(row);
        } catch {
          /* skip bad line */
        }
      }
    } catch {
      events = [];
    }
  }
  events.reverse(); // newest first
  const total = events.length;
  const offset = Math.max(0, Number(opts?.offset) || 0);
  const limit = Math.min(500, Math.max(1, Number(opts?.limit) || 100));
  events = events.slice(offset, offset + limit);
  return { day, days, events, total };
}

export function clearActivityDay(day: string): { ok: boolean; removed: boolean } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return { ok: false, removed: false };
  const path = dayFile(day);
  if (!existsSync(path)) return { ok: true, removed: false };
  try {
    unlinkSync(path);
    return { ok: true, removed: true };
  } catch {
    return { ok: false, removed: false };
  }
}

/** Soft-reset helper: wipe activity dir. */
export function clearAllActivity(): number {
  if (!existsSync(DIR)) return 0;
  let n = 0;
  for (const name of readdirSync(DIR)) {
    try {
      unlinkSync(join(DIR, name));
      n += 1;
    } catch {
      /* ignore */
    }
  }
  writeFileSync(join(DIR, ".keep"), "", { mode: 0o600 });
  return n;
}
