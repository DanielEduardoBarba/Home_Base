/**
 * Bright, journalctl-friendly console logging.
 * Writes to stdout/stderr so systemd (`journalctl -u homebased -f`) captures it.
 * Forces ANSI when attached to the journal (stdout is not a TTY).
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";

/** Bright / bold ANSI for readable journal -f output */
const C = {
  gray: "\x1b[90m",
  white: "\x1b[97m",
  green: "\x1b[92m",
  yellow: "\x1b[93m",
  red: "\x1b[91m",
  cyan: "\x1b[96m",
  magenta: "\x1b[95m",
  blue: "\x1b[94m",
} as const;

const LEVEL_STYLE: Record<LogLevel, string> = {
  debug: C.cyan,
  info: C.green,
  warn: C.yellow,
  error: C.red,
};

const SOURCE_STYLE = C.magenta;

let minLevel: LogLevel = parseLevel(process.env.HOMEBASE_LOG_LEVEL) || "info";

function parseLevel(raw: string | undefined): LogLevel | null {
  const v = (raw || "").trim().toLowerCase();
  if (v === "debug" || v === "info" || v === "warn" || v === "error") return v;
  return null;
}

export function setLogLevel(level: LogLevel): void {
  minLevel = level;
}

export function getLogLevel(): LogLevel {
  return minLevel;
}

/** Color when TTY, under systemd journal, or HOMEBASE_FORCE_COLOR=1. */
export function useColor(): boolean {
  if (process.env.HOMEBASE_FORCE_COLOR === "0" || process.env.NO_COLOR === "1") {
    return false;
  }
  if (process.env.HOMEBASE_FORCE_COLOR === "1" || process.env.FORCE_COLOR) {
    return true;
  }
  // systemd sets JOURNAL_STREAM when stdout/stderr are connected to the journal
  if (process.env.JOURNAL_STREAM) return true;
  return Boolean(process.stdout.isTTY || process.stderr.isTTY);
}

function paint(text: string, style: string, enabled: boolean): string {
  if (!enabled || !style) return text;
  return `${style}${text}${RESET}`;
}

function tsStamp(d = new Date()): string {
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return `${hh}:${mm}:${ss}.${ms}`;
}

function levelTag(level: LogLevel): string {
  return level.toUpperCase().padEnd(5, " ");
}

function sourceTag(source: string): string {
  const s = (source || "server").slice(0, 10);
  return s.padEnd(10, " ");
}

/** Format key=value fields for the trailing meta segment. */
export function formatFields(fields?: Record<string, unknown>): string {
  if (!fields) return "";
  const parts: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null || v === "") continue;
    if (typeof v === "string" && /\s/.test(v)) {
      parts.push(`${k}="${v.replace(/"/g, '\\"')}"`);
    } else if (typeof v === "object") {
      try {
        parts.push(`${k}=${JSON.stringify(v)}`);
      } catch {
        parts.push(`${k}=[object]`);
      }
    } else {
      parts.push(`${k}=${v}`);
    }
  }
  return parts.join(" ");
}

export function formatLogLine(
  level: LogLevel,
  message: string,
  source = "server",
  fields?: Record<string, unknown>,
  color = useColor(),
  when = new Date(),
): string {
  const meta = formatFields(fields);
  const head = [
    paint(tsStamp(when), `${DIM}${C.gray}`, color),
    paint(levelTag(level), `${BOLD}${LEVEL_STYLE[level]}`, color),
    paint(sourceTag(source), `${BOLD}${SOURCE_STYLE}`, color),
    paint(message, level === "error" ? `${BOLD}${C.white}` : C.white, color),
  ].join(" ");
  if (!meta) return head;
  return `${head}  ${paint(meta, C.cyan, color)}`;
}

export type LogOpts = {
  source?: string;
  fields?: Record<string, unknown>;
};

export function log(
  level: LogLevel,
  message: string,
  opts: LogOpts | string = {},
): void {
  const source = typeof opts === "string" ? opts : opts.source || "server";
  const fields = typeof opts === "string" ? undefined : opts.fields;
  if (LEVEL_RANK[level] < LEVEL_RANK[minLevel]) return;
  const line = formatLogLine(level, message, source, fields);
  if (level === "error" || level === "warn") {
    console.error(line);
  } else {
    console.log(line);
  }
}

export const logDebug = (msg: string, opts?: LogOpts | string) =>
  log("debug", msg, opts ?? {});
export const logInfo = (msg: string, opts?: LogOpts | string) =>
  log("info", msg, opts ?? {});
export const logWarn = (msg: string, opts?: LogOpts | string) =>
  log("warn", msg, opts ?? {});
export const logError = (msg: string, opts?: LogOpts | string) =>
  log("error", msg, opts ?? {});

/** Normalize any level string from appendTrace / client into LogLevel. */
export function coerceLevel(raw: string): LogLevel {
  const v = (raw || "").toLowerCase();
  if (v === "debug" || v === "trace" || v === "verbose") return "debug";
  if (v === "warn" || v === "warning") return "warn";
  if (v === "error" || v === "fatal" || v === "critical") return "error";
  return "info";
}
