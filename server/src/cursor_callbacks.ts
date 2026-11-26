/**
 * Encrypted pending job-webhook records + job snapshot persistence under RUNTIME_DIR.
 * Auth is stored only as encryptSecret (AES-256-GCM) output — never plaintext.
 * Pending file mode 0600. Dropped only after webhook success or final failure.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { RUNTIME_DIR, ensureRuntimeDirs } from "./config";
import { decryptSecret, encryptSecret } from "./secrets_vault";

export const PENDING_CALLBACKS_PATH = join(
  RUNTIME_DIR,
  "cursor_callbacks.pending.enc",
);
export const CURSOR_JOBS_STATE_PATH = join(RUNTIME_DIR, "cursor_jobs.state.json");
export const DEFAULT_CALLBACK_URL_PATH = join(
  RUNTIME_DIR,
  "callback_url.default",
);
export const PENDING_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const WEBHOOK_MAX_ATTEMPTS = 5;
/** Default backoff between retry attempts (ms). Overridable in tests. */
export const WEBHOOK_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000] as const;
export const INTERRUPTED_SUMMARY =
  "Home Base restarted while this job was running; the job did not finish";

export type WebhookAttempt = {
  at: number;
  attempt: number;
  ok: boolean;
  statusCode?: number;
  error?: string;
};

export type PendingCallbackRecord = {
  jobId: string;
  projectId: string;
  callbackUrl: string;
  startedAt: number;
  hasAuth: boolean;
  /** encryptSecret blob only — never plaintext. */
  authEnc?: string;
  /** Last known job status (for boot: running → interrupted; terminal → resume). */
  jobStatus?: string;
  finishedAt?: number;
  summary?: string;
  error?: string;
  branch?: string;
  chatId?: string;
  /** Delivery bookkeeping — survives across attempts until success/final fail. */
  attempts: number;
  lastAttemptAt?: number;
  lastStatusCode?: number;
  lastError?: string;
  webhookDelivered?: boolean;
  webhookSentAt?: number;
  attemptLog?: WebhookAttempt[];
};

type PendingFileShape = { v: 1; records: PendingCallbackRecord[] };

type JobsFileShape = {
  v: 1;
  jobs: Array<Record<string, unknown>>;
};

let backoffMsForTests: number[] | null = null;

/** Test-only: shorten retry delays. Pass null to restore defaults. */
export function _setWebhookBackoffForTests(ms: number[] | null): void {
  backoffMsForTests = ms;
}

export function webhookBackoffMs(attemptIndex: number): number {
  const table = backoffMsForTests ?? [...WEBHOOK_BACKOFF_MS];
  if (!table.length) return 0;
  const i = Math.max(0, Math.min(table.length - 1, attemptIndex));
  return Math.max(0, Number(table[i]) || 0);
}

export function redactCallbackUrl(raw: unknown): string | undefined {
  const u = String(raw || "").trim();
  if (!u) return undefined;
  try {
    const parsed = new URL(u);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return "[invalid-url]";
    }
    // Host + path only — strip userinfo, query, and hash (may hold tokens).
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return "[invalid-url]";
  }
}

function writePrivate(path: string, body: string): void {
  ensureRuntimeDirs();
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, body, { mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    /* ignore */
  }
  renameSync(tmp, path);
  try {
    chmodSync(path, 0o600);
  } catch {
    /* ignore */
  }
}

function loadPendingFile(): PendingCallbackRecord[] {
  if (!existsSync(PENDING_CALLBACKS_PATH)) return [];
  try {
    const raw = readFileSync(PENDING_CALLBACKS_PATH, "utf8");
    const o = JSON.parse(raw) as PendingFileShape;
    if (!o || o.v !== 1 || !Array.isArray(o.records)) return [];
    return o.records
      .filter((r) => r && typeof r.jobId === "string" && r.callbackUrl)
      .map((r) => normalizePending(r));
  } catch {
    return [];
  }
}

function normalizePending(r: PendingCallbackRecord): PendingCallbackRecord {
  const attempts = Math.max(0, Number(r.attempts) || 0);
  const attemptLog = Array.isArray(r.attemptLog)
    ? r.attemptLog
        .filter((a) => a && typeof a.attempt === "number")
        .map((a) => ({
          at: Number(a.at) || 0,
          attempt: Number(a.attempt) || 0,
          ok: Boolean(a.ok),
          statusCode:
            a.statusCode != null ? Number(a.statusCode) : undefined,
          error: typeof a.error === "string" ? a.error : undefined,
        }))
    : undefined;
  return {
    jobId: String(r.jobId),
    projectId: String(r.projectId || ""),
    callbackUrl: String(r.callbackUrl),
    startedAt: Number(r.startedAt) || 0,
    hasAuth: Boolean(r.hasAuth),
    authEnc: typeof r.authEnc === "string" ? r.authEnc : undefined,
    jobStatus: typeof r.jobStatus === "string" ? r.jobStatus : undefined,
    finishedAt: r.finishedAt != null ? Number(r.finishedAt) : undefined,
    summary: typeof r.summary === "string" ? r.summary : undefined,
    error: typeof r.error === "string" ? r.error : undefined,
    branch: typeof r.branch === "string" ? r.branch : undefined,
    chatId: typeof r.chatId === "string" ? r.chatId : undefined,
    attempts,
    lastAttemptAt:
      r.lastAttemptAt != null ? Number(r.lastAttemptAt) : undefined,
    lastStatusCode:
      r.lastStatusCode != null ? Number(r.lastStatusCode) : undefined,
    lastError: typeof r.lastError === "string" ? r.lastError : undefined,
    webhookDelivered:
      r.webhookDelivered != null ? Boolean(r.webhookDelivered) : undefined,
    webhookSentAt:
      r.webhookSentAt != null ? Number(r.webhookSentAt) : undefined,
    attemptLog,
  };
}

function savePendingFile(records: PendingCallbackRecord[]): void {
  if (!records.length) {
    clearAllPendingCallbacks();
    return;
  }
  writePrivate(
    PENDING_CALLBACKS_PATH,
    JSON.stringify({ v: 1, records } satisfies PendingFileShape),
  );
}

export function loadPendingCallbacks(): PendingCallbackRecord[] {
  return loadPendingFile();
}

export function persistPendingCallback(input: {
  jobId: string;
  projectId: string;
  callbackUrl: string;
  startedAt: number;
  auth?: string;
  jobStatus?: string;
  finishedAt?: number;
  summary?: string;
  error?: string;
  branch?: string;
  chatId?: string;
}): void {
  const auth = String(input.auth || "").trim();
  const existing = loadPendingFile().find((r) => r.jobId === String(input.jobId));
  const rec: PendingCallbackRecord = {
    jobId: String(input.jobId),
    projectId: String(input.projectId || ""),
    callbackUrl: String(input.callbackUrl),
    startedAt: Number(input.startedAt) || Date.now(),
    hasAuth: Boolean(auth) || Boolean(existing?.hasAuth),
    authEnc: auth
      ? encryptSecret(auth)
      : existing?.authEnc,
    jobStatus: input.jobStatus ?? existing?.jobStatus,
    finishedAt: input.finishedAt ?? existing?.finishedAt,
    summary: input.summary ?? existing?.summary,
    error: input.error ?? existing?.error,
    branch: input.branch ?? existing?.branch,
    chatId: input.chatId ?? existing?.chatId,
    attempts: existing?.attempts ?? 0,
    lastAttemptAt: existing?.lastAttemptAt,
    lastStatusCode: existing?.lastStatusCode,
    lastError: existing?.lastError,
    webhookDelivered: existing?.webhookDelivered,
    webhookSentAt: existing?.webhookSentAt,
    attemptLog: existing?.attemptLog,
  };
  if (!auth && existing?.hasAuth) {
    rec.hasAuth = true;
    rec.authEnc = existing.authEnc;
  }
  const rest = loadPendingFile().filter((r) => r.jobId !== rec.jobId);
  rest.push(rec);
  savePendingFile(rest);
}

/** Patch delivery / status fields on an existing pending record (keeps authEnc). */
export function updatePendingCallback(
  jobId: string,
  patch: Partial<
    Pick<
      PendingCallbackRecord,
      | "jobStatus"
      | "finishedAt"
      | "summary"
      | "error"
      | "branch"
      | "chatId"
      | "attempts"
      | "lastAttemptAt"
      | "lastStatusCode"
      | "lastError"
      | "webhookDelivered"
      | "webhookSentAt"
      | "attemptLog"
      | "callbackUrl"
      | "projectId"
    >
  >,
): PendingCallbackRecord | null {
  const id = String(jobId || "");
  if (!id) return null;
  const records = loadPendingFile();
  const idx = records.findIndex((r) => r.jobId === id);
  if (idx < 0) return null;
  const next = { ...records[idx]!, ...patch, jobId: id };
  records[idx] = normalizePending(next);
  savePendingFile(records);
  return records[idx]!;
}

export function removePendingCallback(jobId: string): void {
  const id = String(jobId || "");
  if (!id) return;
  savePendingFile(loadPendingFile().filter((r) => r.jobId !== id));
}

export function clearAllPendingCallbacks(): void {
  try {
    if (existsSync(PENDING_CALLBACKS_PATH)) unlinkSync(PENDING_CALLBACKS_PATH);
  } catch {
    /* ignore */
  }
  try {
    if (existsSync(`${PENDING_CALLBACKS_PATH}.tmp`)) {
      unlinkSync(`${PENDING_CALLBACKS_PATH}.tmp`);
    }
  } catch {
    /* ignore */
  }
}

/** Decrypt auth for a pending record. null = decrypt failed (hasAuth was set). */
export function decryptPendingAuth(
  rec: PendingCallbackRecord,
): { auth?: string; decryptFailed: boolean } {
  if (!rec.hasAuth) return { decryptFailed: false };
  if (!rec.authEnc) return { decryptFailed: true };
  const plain = decryptSecret(rec.authEnc);
  if (plain == null) return { decryptFailed: true };
  return { auth: plain, decryptFailed: false };
}

/** Persist public job snapshots (never includes auth plaintext). */
export function persistCursorJobsState(
  jobs: Array<Record<string, unknown>>,
): void {
  ensureRuntimeDirs();
  const safe = jobs.map((j) => stripAuthFromJobRecord(j));
  writePrivate(
    CURSOR_JOBS_STATE_PATH,
    JSON.stringify({ v: 1, jobs: safe } satisfies JobsFileShape),
  );
}

export function loadCursorJobsState(): Array<Record<string, unknown>> {
  if (!existsSync(CURSOR_JOBS_STATE_PATH)) return [];
  try {
    const raw = readFileSync(CURSOR_JOBS_STATE_PATH, "utf8");
    const o = JSON.parse(raw) as JobsFileShape;
    if (!o || o.v !== 1 || !Array.isArray(o.jobs)) return [];
    return o.jobs
      .filter((j) => j && typeof j.id === "string")
      .map((j) => stripAuthFromJobRecord(j));
  } catch {
    return [];
  }
}

export function clearCursorJobsState(): void {
  try {
    if (existsSync(CURSOR_JOBS_STATE_PATH)) unlinkSync(CURSOR_JOBS_STATE_PATH);
  } catch {
    /* ignore */
  }
  try {
    if (existsSync(`${CURSOR_JOBS_STATE_PATH}.tmp`)) {
      unlinkSync(`${CURSOR_JOBS_STATE_PATH}.tmp`);
    }
  } catch {
    /* ignore */
  }
}

function stripAuthFromJobRecord(
  job: Record<string, unknown>,
): Record<string, unknown> {
  const out = { ...job };
  delete out.callbackAuth;
  delete out.authorization;
  delete out.auth;
  // Never persist raw callbackUrl query (tokens) — keep full URL for delivery
  // only on pending.enc; job state may keep callbackUrl for health (host/path).
  return out;
}

export function loadDefaultCallbackUrl(): string {
  if (!existsSync(DEFAULT_CALLBACK_URL_PATH)) return "";
  try {
    return String(readFileSync(DEFAULT_CALLBACK_URL_PATH, "utf8") || "").trim();
  } catch {
    return "";
  }
}

export function setDefaultCallbackUrl(url: string): { url: string } {
  const trimmed = String(url || "").trim();
  if (!trimmed) throw new Error("url required");
  const parsed = new URL(trimmed);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("callbackUrl must be http(s)");
  }
  ensureRuntimeDirs();
  writePrivate(DEFAULT_CALLBACK_URL_PATH, parsed.toString());
  return { url: parsed.toString() };
}

export function clearDefaultCallbackUrl(): void {
  try {
    if (existsSync(DEFAULT_CALLBACK_URL_PATH)) {
      unlinkSync(DEFAULT_CALLBACK_URL_PATH);
    }
  } catch {
    /* ignore */
  }
  try {
    if (existsSync(`${DEFAULT_CALLBACK_URL_PATH}.tmp`)) {
      unlinkSync(`${DEFAULT_CALLBACK_URL_PATH}.tmp`);
    }
  } catch {
    /* ignore */
  }
}

export function getDefaultCallbackUrlMeta(): {
  configured: boolean;
  urlRedacted: string | null;
} {
  const url = loadDefaultCallbackUrl();
  if (!url) return { configured: false, urlRedacted: null };
  return {
    configured: true,
    urlRedacted: redactCallbackUrl(url) || null,
  };
}

/** Test helper: write records as they would appear on disk (authEnc only). */
export function _writePendingRecordsForTests(
  records: PendingCallbackRecord[],
): void {
  savePendingFile(records.map(normalizePending));
}

/** Ensure runtime dir exists (used by tests that wipe trees). */
export function _ensureCallbackDirsForTests(): void {
  ensureRuntimeDirs();
  try {
    mkdirSync(RUNTIME_DIR, { recursive: true });
  } catch {
    /* ignore */
  }
}
