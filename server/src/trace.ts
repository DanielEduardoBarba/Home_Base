import { coerceLevel, log } from "./console_log";

export type TraceLine = {
  id: number;
  ts: number;
  level: string;
  message: string;
  source?: string;
};

const MAX = 300;
let nextId = 1;
const ring: TraceLine[] = [];

/** When false, ring-only (tests). Default mirrors every line to journal stdout. */
let mirrorConsole = true;

export function setTraceMirrorConsole(enabled: boolean): void {
  mirrorConsole = enabled;
}

export function appendTrace(
  level: string,
  message: string,
  source = "server",
): TraceLine {
  const line: TraceLine = {
    id: nextId++,
    ts: Date.now() / 1000,
    level,
    message,
    source,
  };
  ring.push(line);
  while (ring.length > MAX) ring.shift();
  if (mirrorConsole) {
    log(coerceLevel(level), message, { source });
  }
  return line;
}

export function listTrace(limit = 100, afterId = 0): {
  items: TraceLine[];
  lastId: number;
  max: number;
} {
  const lim = Math.max(1, Math.min(limit, MAX));
  let items = ring;
  if (afterId > 0) items = ring.filter((l) => l.id > afterId);
  items = items.slice(-lim);
  const lastId = ring.length ? ring[ring.length - 1]!.id : 0;
  return { items, lastId, max: MAX };
}
