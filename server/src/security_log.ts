/**
 * Append-only security event log with a hash chain (tamper-evident) and
 * daily rotation. Never write secrets, tokens, PINs, or passwords.
 */
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { SECURITY_DIR, ensureRuntimeDirs } from "./config";
import { observeDevice, type TrustedDevice } from "./devices";
import {
  attributionSummary,
  classifySource,
  type SourceAttribution,
  type SourceClass,
} from "./source_attr";
import { redactSecrets } from "./redact";

export type SecuritySource = "ui" | "mcp" | "api";
export type SecurityResult =
  | "success"
  | "failure"
  | "lockout"
  | "expired"
  | "invalid"
  | "revoked"
  | "info";

export type SecurityEvent = {
  id: string;
  ts: string;
  event: string;
  source: SecuritySource;
  ip: string;
  result: SecurityResult;
  class: SourceClass;
  classLabel: string;
  userAgent?: string;
  path?: string;
  status?: number;
  failCount?: number;
  retryAfter?: number;
  remainingAttempts?: number;
  connectorId?: string;
  connectorLabel?: string;
  wgPeerName?: string;
  presenceId?: string;
  deviceId?: string;
  deviceName?: string;
  trusted?: boolean;
  firstSeen?: boolean;
  message?: string;
  method?: string;
  previousFailCount?: number;
  previousLockedUntil?: number;
  emailSent?: boolean;
  emailGap?: string;
  prev: string;
  mac: string;
};

export type SecurityEventInput = {
  event: string;
  source: SecuritySource;
  ip?: string;
  result: SecurityResult;
  userAgent?: string;
  path?: string;
  status?: number;
  failCount?: number;
  retryAfter?: number;
  remainingAttempts?: number;
  connectorId?: string;
  connectorLabel?: string;
  message?: string;
  method?: string;
  previousFailCount?: number;
  previousLockedUntil?: number;
  emailSent?: boolean;
  emailGap?: string;
};

const HEAD_PATH = () => join(SECURITY_DIR, "head.json");
const KEY_PATH = () => join(SECURITY_DIR, ".mac-key");
const RETAIN_DAYS = 90;
const BURST_WINDOW_MS = 5 * 60 * 1000;
const BURST_THRESHOLD = 5;

type HeadFile = { lastMac: string; count: number };

function chmodPrivate(path: string): void {
  try {
    chmodSync(path, 0o600);
  } catch {
    /* ignore */
  }
}

function macKey(): Buffer {
  ensureRuntimeDirs();
  if (existsSync(KEY_PATH())) {
    try {
      const raw = readFileSync(KEY_PATH());
      if (raw.length >= 32) return raw.subarray(0, 32);
    } catch {
      /* regenerate */
    }
  }
  const key = randomBytes(32);
  writeFileSync(KEY_PATH(), key, { mode: 0o600 });
  chmodPrivate(KEY_PATH());
  return key;
}

function loadHead(): HeadFile {
  if (!existsSync(HEAD_PATH())) return { lastMac: "genesis", count: 0 };
  try {
    return JSON.parse(readFileSync(HEAD_PATH(), "utf8")) as HeadFile;
  } catch {
    return { lastMac: "genesis", count: 0 };
  }
}

function saveHead(head: HeadFile): void {
  ensureRuntimeDirs();
  const tmp = HEAD_PATH() + ".tmp";
  writeFileSync(tmp, JSON.stringify(head) + "\n");
  chmodPrivate(tmp);
  renameSync(tmp, HEAD_PATH());
  chmodPrivate(HEAD_PATH());
}

function dayPath(day: string): string {
  return join(SECURITY_DIR, `${day}.jsonl`);
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function sign(prev: string, body: Omit<SecurityEvent, "prev" | "mac">): string {
  const payload = JSON.stringify({ ...body, prev });
  return createHmac("sha256", macKey()).update(payload).digest("hex");
}

function pruneOldLogs(): void {
  try {
    const cutoff = new Date();
    cutoff.setUTCDate(cutoff.getUTCDate() - RETAIN_DAYS);
    const minDay = cutoff.toISOString().slice(0, 10);
    for (const name of readdirSync(SECURITY_DIR)) {
      if (!/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)) continue;
      const day = name.slice(0, 10);
      if (day < minDay) {
        try {
          unlinkSync(join(SECURITY_DIR, name));
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    /* ignore */
  }
}

function recentFailures(ip: string, event: string, sinceMs: number): number {
  const day = todayUtc();
  const path = dayPath(day);
  if (!existsSync(path)) return 0;
  let n = 0;
  try {
    const lines = readFileSync(path, "utf8").split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const ev = JSON.parse(line) as SecurityEvent;
        if (ev.ip !== ip) continue;
        if (ev.result !== "failure" && ev.result !== "lockout") continue;
        if (event && ev.event !== event && ev.source !== "mcp" && ev.source !== "ui") continue;
        const t = Date.parse(ev.ts);
        if (Number.isFinite(t) && t >= sinceMs) n += 1;
      } catch {
        /* skip bad line */
      }
    }
  } catch {
    /* ignore */
  }
  return n;
}

function alert(title: string, body: string, level: "warn" | "error", meta: Record<string, unknown>): void {
  try {
    const { pushNotification } = require("./notifications") as typeof import("./notifications");
    pushNotification(title, body, { level, category: "security", meta });
  } catch {
    /* ignore */
  }
}

export function recordSecurityEvent(input: SecurityEventInput): SecurityEvent {
  ensureRuntimeDirs();
  try {
    mkdirSync(SECURITY_DIR, { recursive: true });
    try {
      chmodSync(SECURITY_DIR, 0o700);
    } catch {
      /* ignore */
    }
  } catch {
    /* ignore */
  }

  const attr: SourceAttribution = classifySource({
    ip: input.ip,
    connectorId: input.connectorId,
    connectorLabel: input.connectorLabel,
    source: input.source,
  });
  let device: TrustedDevice | undefined;
  let firstSeen = false;
  if (attr.ip && attr.ip !== "unknown") {
    try {
      const obs = observeDevice({ ip: attr.ip, userAgent: input.userAgent, attr });
      device = obs.device;
      firstSeen = obs.firstSeen;
    } catch {
      /* ignore */
    }
  }

  const head = loadHead();
  const body: Omit<SecurityEvent, "prev" | "mac"> = {
    id: randomBytes(8).toString("hex"),
    ts: new Date().toISOString(),
    event: String(input.event || "event").slice(0, 64),
    source: input.source,
    ip: attr.ip,
    result: input.result,
    class: attr.class,
    classLabel: attr.classLabel,
    userAgent: input.userAgent?.slice(0, 180) || undefined,
    path: input.path?.slice(0, 120) || undefined,
    status: input.status,
    failCount: input.failCount,
    retryAfter: input.retryAfter,
    remainingAttempts: input.remainingAttempts,
    connectorId: input.connectorId || attr.connector?.id,
    connectorLabel: input.connectorLabel || attr.connector?.label,
    wgPeerName: attr.wgPeer?.name,
    presenceId: attr.presence?.id,
    deviceId: device?.id,
    deviceName: device?.name,
    trusted: device?.trusted,
    firstSeen: firstSeen || undefined,
    message: redactSecrets(input.message || "").slice(0, 240) || undefined,
    method: input.method?.slice(0, 64) || undefined,
    previousFailCount: input.previousFailCount,
    previousLockedUntil: input.previousLockedUntil,
    emailSent: input.emailSent,
    emailGap: input.emailGap?.slice(0, 180) || undefined,
  };
  const mac = sign(head.lastMac, body);
  const ev: SecurityEvent = { ...body, prev: head.lastMac, mac };

  const path = dayPath(todayUtc());
  appendFileSync(path, JSON.stringify(ev) + "\n", { mode: 0o600 });
  chmodPrivate(path);
  saveHead({ lastMac: mac, count: head.count + 1 });
  pruneOldLogs();

  const classBit = attributionSummary(attr);
  if (firstSeen && device && !device.trusted) {
    alert(
      "First-seen device",
      `New ${classBit}. Mark it trusted in Settings → Security if you recognize it.`,
      "warn",
      { deviceId: device.id, ip: attr.ip, class: attr.class },
    );
  }
  if (input.result === "lockout") {
    alert(
      input.source === "mcp" ? "MCP lockout" : "Auth lockout",
      `Lockout for ${classBit}${input.retryAfter ? ` · retry in ${input.retryAfter}s` : ""}.`,
      "error",
      { ip: attr.ip, class: attr.class, retryAfter: input.retryAfter, source: input.source },
    );
  }
  if (input.result === "failure" || input.result === "lockout") {
    const burst = recentFailures(attr.ip, input.event, Date.now() - BURST_WINDOW_MS);
    if (burst >= BURST_THRESHOLD) {
      alert(
        "Brute-force burst",
        `${burst} failed attempts in 5 min from ${classBit}.`,
        "error",
        { ip: attr.ip, class: attr.class, burst, source: input.source },
      );
    }
  }
  return ev;
}

export { redactSecrets };

export type SecurityQuery = {
  source?: string;
  event?: string;
  ip?: string;
  result?: string;
  class?: string;
  q?: string;
  from?: string;
  to?: string;
  offset?: number;
  limit?: number;
};

function listDayFiles(): string[] {
  if (!existsSync(SECURITY_DIR)) return [];
  return readdirSync(SECURITY_DIR)
    .filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n))
    .map((n) => n.slice(0, 10))
    .sort();
}

function eventMatches(ev: SecurityEvent, q: SecurityQuery): boolean {
  if (q.source && q.source !== "all" && ev.source !== q.source) return false;
  if (q.event && q.event !== "all" && ev.event !== q.event) return false;
  if (q.result && q.result !== "all" && ev.result !== q.result) return false;
  if (q.class && q.class !== "all" && ev.class !== q.class) return false;
  if (q.ip && !ev.ip.includes(q.ip)) return false;
  if (q.from && ev.ts < q.from) return false;
  if (q.to && ev.ts > q.to + (q.to.length === 10 ? "T23:59:59.999Z" : "")) return false;
  if (q.q) {
    const hay = [
      ev.ts,
      ev.event,
      ev.source,
      ev.ip,
      ev.result,
      ev.classLabel,
      ev.userAgent,
      ev.connectorLabel,
      ev.wgPeerName,
      ev.deviceName,
      ev.message,
      ev.method,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    if (!hay.includes(q.q.toLowerCase())) return false;
  }
  return true;
}

function eventMacPayload(ev: SecurityEvent): string {
  const { mac: _mac, ...rest } = ev;
  return JSON.stringify(rest);
}

function expectedMac(ev: SecurityEvent): string {
  return createHmac("sha256", macKey()).update(eventMacPayload(ev)).digest("hex");
}

function eventMacValid(ev: SecurityEvent): boolean {
  if (!ev || !ev.mac || !ev.prev) return false;
  try {
    const got = Buffer.from(String(ev.mac), "hex");
    const want = Buffer.from(expectedMac(ev), "hex");
    return got.length === want.length && got.length > 0 && timingSafeEqual(got, want);
  } catch {
    return false;
  }
}

export type SecurityIntegrity = {
  ok: boolean;
  error?: string;
  tamperedAt?: { day: string; line: number };
};

const INTEGRITY_ALERT_PATH = () => join(SECURITY_DIR, ".integrity-alert");

function maybeAlertIntegrity(result: SecurityIntegrity): void {
  if (result.ok || !result.error) return;
  let last = "";
  try {
    if (existsSync(INTEGRITY_ALERT_PATH())) {
      last = readFileSync(INTEGRITY_ALERT_PATH(), "utf8").trim();
    }
  } catch {
    /* ignore */
  }
  const key = `${result.error}:${result.tamperedAt?.day || ""}:${result.tamperedAt?.line || 0}`;
  if (key === last) return;
  try {
    writeFileSync(INTEGRITY_ALERT_PATH(), key + "\n", { mode: 0o600 });
    chmodPrivate(INTEGRITY_ALERT_PATH());
  } catch {
    /* still alert */
  }
  alert(
    "Security log tampered",
    result.error,
    "error",
    {
      day: result.tamperedAt?.day,
      line: result.tamperedAt?.line,
    },
  );
}

/**
 * Walk every daily jsonl in order and verify each entry's HMAC over its
 * canonical content plus prev hash, and that prev matches the previous mac
 * (or "genesis" for the first event).
 */
export function verifySecurityLog(): SecurityIntegrity {
  let lastMac = "genesis";
  let line = 0;
  for (const day of listDayFiles()) {
    const path = dayPath(day);
    let raw = "";
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      line += 1;
      return {
        ok: false,
        error: `tampered at line ${line}`,
        tamperedAt: { day, line: 1 },
      };
    }
    let dayLine = 0;
    for (const text of raw.split("\n")) {
      if (!text.trim()) continue;
      line += 1;
      dayLine += 1;
      try {
        const ev = JSON.parse(text) as SecurityEvent;
        const macOk = eventMacValid(ev);
        const prevOk = ev.prev === lastMac;
        if (!macOk || !prevOk) {
          return {
            ok: false,
            error: `tampered at line ${line}`,
            tamperedAt: { day, line: dayLine },
          };
        }
        lastMac = ev.mac;
      } catch {
        return {
          ok: false,
          error: `tampered at line ${line}`,
          tamperedAt: { day, line: dayLine },
        };
      }
    }
  }
  return { ok: true };
}

export function querySecurityLog(q: SecurityQuery = {}): {
  total: number;
  offset: number;
  limit: number;
  days: string[];
  integrityOk: boolean;
  integrityError?: string;
  tamperedAt?: { day: string; line: number };
  events: SecurityEvent[];
} {
  const integrity = verifySecurityLog();
  maybeAlertIntegrity(integrity);

  const days = listDayFiles();
  const fromDay = (q.from || "").slice(0, 10);
  const toDay = (q.to || "").slice(0, 10);
  const dayInRange = (d: string) => (!fromDay || d >= fromDay) && (!toDay || d <= toDay);
  const collected: SecurityEvent[] = [];
  let lastMac = "genesis";
  // Walk every day so prev-chain state is correct when the query is date-filtered.
  for (const day of days) {
    const path = dayPath(day);
    let raw = "";
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    for (const text of raw.split("\n")) {
      if (!text.trim()) continue;
      try {
        const ev = JSON.parse(text) as SecurityEvent;
        const macOk = eventMacValid(ev);
        const prevOk = ev.prev === lastMac;
        if (ev.mac) lastMac = ev.mac;
        // Mutated / broken chain entries are not treated as normal events.
        if (!macOk || !prevOk) continue;
        if (dayInRange(day) && eventMatches(ev, q)) collected.push(ev);
      } catch {
        /* unreadable line already flagged by verifySecurityLog */
      }
    }
  }
  collected.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
  const offset = Math.max(0, Number(q.offset) || 0);
  const limit = Math.min(200, Math.max(1, Number(q.limit) || 50));
  return {
    total: collected.length,
    offset,
    limit,
    days,
    integrityOk: integrity.ok,
    integrityError: integrity.error,
    tamperedAt: integrity.tamperedAt,
    events: collected.slice(offset, offset + limit),
  };
}

export function exportSecurityLog(
  q: SecurityQuery,
  format: "json" | "csv",
): { body: string; contentType: string; filename: string } {
  const { events } = querySecurityLog({ ...q, offset: 0, limit: 200 });
  // Re-query all matching (cap 5000)
  const all = querySecurityLog({ ...q, offset: 0, limit: 5000 }).events;
  const safe = all.map((ev) => ({
    time: ev.ts,
    source: ev.source,
    ip: ev.ip,
    event: ev.event,
    result: ev.result,
    class: ev.classLabel,
    userAgent: ev.userAgent || "",
    connector: ev.connectorLabel || "",
    vpnPeer: ev.wgPeerName || "",
    device: ev.deviceName || "",
    trusted: ev.trusted ? "yes" : "no",
    status: ev.status ?? "",
    message: ev.message || "",
    method: ev.method || "",
    previousFailCount: ev.previousFailCount ?? "",
  }));
  const stamp = todayUtc();
  if (format === "csv") {
    const cols = Object.keys(safe[0] || {
      time: "",
      source: "",
      ip: "",
      event: "",
      result: "",
    });
    const esc = (v: unknown) => {
      const s = String(v ?? "");
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const body =
      cols.join(",") +
      "\n" +
      safe.map((row) => cols.map((c) => esc((row as Record<string, unknown>)[c])).join(",")).join("\n") +
      "\n";
    return {
      body,
      contentType: "text/csv; charset=utf-8",
      filename: `homebase-security-${stamp}.csv`,
    };
  }
  return {
    body: JSON.stringify({ exportedAt: new Date().toISOString(), events: safe }, null, 2) + "\n",
    contentType: "application/json",
    filename: `homebase-security-${stamp}.json`,
  };
}

export function securityLogStats(): { files: number; bytes: number; headCount: number } {
  let files = 0;
  let bytes = 0;
  try {
    for (const name of readdirSync(SECURITY_DIR)) {
      if (!name.endsWith(".jsonl")) continue;
      files += 1;
      try {
        bytes += statSync(join(SECURITY_DIR, name)).size;
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
  return { files, bytes, headCount: loadHead().count };
}

void createHash;
