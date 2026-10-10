import {
  chmodSync,
  existsSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { NOTIFICATIONS_PATH, ensureRuntimeDirs } from "./config";

const MAX_NOTIFICATIONS = 2000;

export type NotificationItem = {
  id: string;
  ts: string;
  title: string;
  body: string;
  level: string;
  category: string;
  read: boolean;
  meta: Record<string, unknown>;
};

function readAll(): NotificationItem[] {
  if (!existsSync(NOTIFICATIONS_PATH)) return [];
  const items: NotificationItem[] = [];
  for (const line of readFileSync(NOTIFICATIONS_PATH, "utf8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      items.push(JSON.parse(t) as NotificationItem);
    } catch {
      /* skip */
    }
  }
  return items;
}

function rewrite(items: NotificationItem[]): void {
  ensureRuntimeDirs();
  const kept = items.length > MAX_NOTIFICATIONS ? items.slice(-MAX_NOTIFICATIONS) : items;
  const tmp = NOTIFICATIONS_PATH + ".tmp";
  writeFileSync(tmp, kept.map((i) => JSON.stringify(i)).join("\n") + (kept.length ? "\n" : ""));
  try {
    chmodSync(tmp, 0o600);
  } catch {
    /* ignore */
  }
  renameSync(tmp, NOTIFICATIONS_PATH);
  try {
    chmodSync(NOTIFICATIONS_PATH, 0o600);
  } catch {
    /* ignore */
  }
}

export function pushNotification(
  title: string,
  body = "",
  opts: {
    level?: string;
    category?: string;
    meta?: Record<string, unknown>;
  } = {},
): NotificationItem {
  const item: NotificationItem = {
    id: randomBytes(16).toString("hex"),
    ts: new Date().toISOString(),
    title,
    body,
    level: opts.level || "info",
    category: opts.category || "system",
    read: false,
    meta: opts.meta || {},
  };
  const items = readAll();
  items.push(item);
  rewrite(items);
  return item;
}

export function listNotifications(opts: {
  offset?: number;
  limit?: number;
  unreadOnly?: boolean;
  history?: boolean;
}): {
  total: number;
  unread: number;
  offset: number;
  limit: number;
  items: NotificationItem[];
} {
  const limit = Math.max(1, Math.min(opts.limit ?? 30, 100));
  const offset = Math.max(0, opts.offset ?? 0);
  let items = [...readAll()].reverse();
  if (opts.unreadOnly) items = items.filter((i) => !i.read);
  else if (opts.history) items = items.filter((i) => i.read);
  const all = readAll();
  const unread = all.filter((i) => !i.read).length;
  const total = items.length;
  return {
    total,
    unread,
    offset,
    limit,
    items: items.slice(offset, offset + limit),
  };
}

export function markRead(ids: string[] | null, allRead = false): number {
  const items = readAll();
  let changed = 0;
  const idSet = new Set(ids || []);
  for (const item of items) {
    if (allRead || idSet.has(item.id)) {
      if (!item.read) {
        item.read = true;
        changed++;
      }
    }
  }
  if (changed) rewrite(items);
  return changed;
}

export function clearRead(): number {
  const items = readAll();
  const kept = items.filter((i) => !i.read);
  const removed = items.length - kept.length;
  if (removed) rewrite(kept);
  return removed;
}
