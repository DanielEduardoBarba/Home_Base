/**
 * MCP job handoff: Grok bots enqueue whole coding jobs; Cursor on the laptop
 * does the long work (operator Cursor usage pool). Prefer waitMs or webhook —
 * avoid tight status polling (each poll is a paid Grok turn).
 *
 * Kickoff contract: an MCP-submitted job must actually start the Home Base
 * chat run (user prompt posted, tab marked running) before the tool returns
 * "running". The run itself is detached from the /mcp HTTP request so closing
 * the transport cannot cancel it. Status helpers must not treat "chat not
 * running yet" as "job done".
 */
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { loadProjects } from "./config";
import { runOperatorCmd } from "./operator_git_env";
import {
  ownershipQaAfterGitOp,
  repairProjectOwnership,
} from "./project_owner";
import {
  INTERRUPTED_SUMMARY,
  PENDING_MAX_AGE_MS,
  WEBHOOK_MAX_ATTEMPTS,
  clearAllPendingCallbacks,
  clearCursorJobsState,
  decryptPendingAuth,
  loadCursorJobsState,
  loadDefaultCallbackUrl,
  loadPendingCallbacks,
  persistCursorJobsState,
  persistPendingCallback,
  redactCallbackUrl,
  removePendingCallback,
  updatePendingCallback,
  webhookBackoffMs,
  type PendingCallbackRecord,
  type WebhookAttempt,
} from "./cursor_callbacks";
import { loadCallbackAuthFromVault } from "./secrets_vault";
import { redactSecrets } from "./redact";
import {
  assertKnownCursorModel,
  cancelRun,
  createChat,
  cursorConfigured,
  defaultModel,
  getLastCursorRunError,
  getWorkspace,
  startCursorRun,
  trimAgentError,
} from "./cursor";
import { appendTrace } from "./trace";

export type CursorJobStatus =
  | "queued"
  | "running"
  | "done"
  | "error"
  | "timeout"
  | "interrupted"
  | "cancelled";

export type CursorJobCommit = {
  hash: string;
  short: string;
  subject: string;
  dirty: boolean;
  branch?: string;
};

export type CursorJob = {
  id: string;
  projectId: string;
  chatId: string;
  status: CursorJobStatus;
  prompt: string;
  model: string;
  mode: string;
  cwd: string;
  branch: string;
  summary?: string;
  commit?: CursorJobCommit | null;
  error?: string;
  startedAt: number;
  finishedAt?: number;
  source?: string;
  callbackUrl?: string;
  webhookDelivered?: boolean;
  webhookError?: string;
  /** Epoch ms of the successful delivery (if any). */
  webhookSentAt?: number;
  /** Number of POST attempts so far. */
  webhookAttempts?: number;
  webhookLastStatusCode?: number;
  webhookLastAttemptAt?: number;
  webhookAttemptLog?: WebhookAttempt[];
  /** True when a webhook auth value was set for this job (never the value itself). */
  callbackAuthExpected?: boolean;
  /** HB-OWN-01: .git ownership probe after the job settles. */
  ownershipQa?: {
    ok: boolean;
    foreignCount?: number;
    samples?: string[];
    error?: string;
  };
};

export type CursorJobRunOpts = {
  chatId: string;
  prompt: string;
  model: string;
  mode: string;
  cwd?: string;
  queueIfBusy?: boolean;
  source?: "web" | "mcp" | "system";
  sourceLabel?: string;
  jobId?: string;
  onStarted?: () => void;
};

type JobDeps = {
  runner: (projectId: string, opts: CursorJobRunOpts) => Promise<void>;
  configured: () => boolean;
  getProject: (id: string) => { path: string } | undefined;
  createChat: typeof createChat;
  workspace: typeof getWorkspace;
  validateModel: (model: string) => Promise<void>;
  lastRunError: (projectId: string, chatId: string) => string | undefined;
};

function defaultDeps(): JobDeps {
  return {
    runner: startCursorRun,
    configured: cursorConfigured,
    getProject: (id) => loadProjects().get(id),
    createChat,
    workspace: getWorkspace,
    validateModel: assertKnownCursorModel,
    lastRunError: getLastCursorRunError,
  };
}

let deps: JobDeps = defaultDeps();

/** Test-only: stub the Cursor run / project lookup. Pass null to restore. */
export function _setCursorJobDepsForTests(partial: Partial<JobDeps> | null): void {
  deps = partial ? { ...defaultDeps(), ...partial } : defaultDeps();
}

/** Test-only: drop in-memory jobs between cases. */
export function _resetCursorJobsForTests(): void {
  for (const t of retryTimers.values()) clearTimeout(t);
  retryTimers.clear();
  jobs.clear();
  callbackAuthByJobId.clear();
  clearAllPendingCallbacks();
  clearCursorJobsState();
  jobsHydrated = false;
}

/** Drop in-memory state only (leave pending + job files) — simulates a process restart. */
export function _forgetInMemoryJobsForTests(): void {
  for (const t of retryTimers.values()) clearTimeout(t);
  retryTimers.clear();
  jobs.clear();
  callbackAuthByJobId.clear();
  jobsHydrated = false;
}

const jobs = new Map<string, CursorJob>();
/** Webhook Authorization header values — memory only; never on CursorJob / disk JSON. */
const callbackAuthByJobId = new Map<string, string>();
const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
let jobsHydrated = false;
const MAX_JOBS = 40;
const DEFAULT_BRANCH = "development_grok";
const MAX_SUMMARY_LINES = 10;
const MAX_SUMMARY_CHARS = 1200;
const KICKOFF_WAIT_MS = 15_000;
const IDLE_POLL_MS = 200;

const TERMINAL_STATUSES: ReadonlySet<CursorJobStatus> = new Set([
  "done",
  "error",
  "timeout",
  "interrupted",
  "cancelled",
]);

function isTerminalStatus(status: unknown): status is CursorJobStatus {
  return (
    typeof status === "string" &&
    TERMINAL_STATUSES.has(status as CursorJobStatus)
  );
}

function persistJobsNow(): void {
  try {
    const ordered = [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt);
    persistCursorJobsState(
      ordered.slice(0, MAX_JOBS).map((j) => ({ ...j }) as Record<string, unknown>),
    );
  } catch (e) {
    appendTrace(
      "warn",
      `cursor jobs persist failed: ${e instanceof Error ? e.message : String(e)}`,
      "cursor-job",
    );
  }
}

function hydrateJobsFromDisk(): void {
  if (jobsHydrated) return;
  jobsHydrated = true;
  try {
    for (const raw of loadCursorJobsState()) {
      const id = String(raw.id || "").trim();
      if (!id || jobs.has(id)) continue;
      const status = String(raw.status || "error") as CursorJobStatus;
      const job: CursorJob = {
        id,
        projectId: String(raw.projectId || ""),
        chatId: String(raw.chatId || ""),
        status,
        prompt: String(raw.prompt || ""),
        model: String(raw.model || ""),
        mode: String(raw.mode || ""),
        cwd: String(raw.cwd || ""),
        branch: String(raw.branch || ""),
        summary: typeof raw.summary === "string" ? raw.summary : undefined,
        commit: (raw.commit as CursorJobCommit | null | undefined) ?? undefined,
        error: typeof raw.error === "string" ? raw.error : undefined,
        startedAt: Number(raw.startedAt) || 0,
        finishedAt:
          raw.finishedAt != null ? Number(raw.finishedAt) : undefined,
        source: typeof raw.source === "string" ? raw.source : undefined,
        callbackUrl:
          typeof raw.callbackUrl === "string" ? raw.callbackUrl : undefined,
        webhookDelivered:
          raw.webhookDelivered != null
            ? Boolean(raw.webhookDelivered)
            : undefined,
        webhookError:
          typeof raw.webhookError === "string" ? raw.webhookError : undefined,
        webhookSentAt:
          raw.webhookSentAt != null ? Number(raw.webhookSentAt) : undefined,
        webhookAttempts:
          raw.webhookAttempts != null
            ? Number(raw.webhookAttempts)
            : undefined,
        webhookLastStatusCode:
          raw.webhookLastStatusCode != null
            ? Number(raw.webhookLastStatusCode)
            : undefined,
        webhookLastAttemptAt:
          raw.webhookLastAttemptAt != null
            ? Number(raw.webhookLastAttemptAt)
            : undefined,
        webhookAttemptLog: Array.isArray(raw.webhookAttemptLog)
          ? (raw.webhookAttemptLog as WebhookAttempt[])
          : undefined,
        callbackAuthExpected: Boolean(raw.callbackAuthExpected),
        ownershipQa: raw.ownershipQa as CursorJob["ownershipQa"],
      };
      jobs.set(id, job);
    }
  } catch (e) {
    appendTrace(
      "warn",
      `cursor jobs hydrate failed: ${e instanceof Error ? e.message : String(e)}`,
      "cursor-job",
    );
  }
}

/**
 * Resolve webhook Authorization header value.
 * Per-job `callbackAuth` wins; else the Settings vault default.
 * `HOMEBASE_CALLBACK_AUTH` env is never read for delivery.
 * Value is sent exactly (e.g. "Bearer abc") — do not add a Bearer prefix here.
 */
export function resolveCallbackAuth(param?: string | null): string | undefined {
  const fromParam = String(param ?? "").trim();
  if (fromParam) return fromParam;
  const fromVault = loadCallbackAuthFromVault();
  return fromVault || undefined;
}

/** Strip known callback auth material from error/log strings. */
export function redactCallbackSecrets(
  raw: unknown,
  ...secrets: Array<string | undefined | null>
): string {
  let s = String(raw ?? "");
  if (!s) return s;
  for (const secret of secrets) {
    const v = String(secret || "").trim();
    if (v.length < 4) continue;
    if (s.includes(v)) s = s.split(v).join("[redacted]");
  }
  s = redactSecrets(s);
  // Generic Authorization / Bearer shapes (trimAgentError-compatible).
  s = s.replace(
    /(authorization)\s*[=:]\s*\S+/gi,
    "$1=***",
  );
  s = s.replace(/\bBearer\s+[A-Za-z0-9._\-+/=]{8,}/gi, "Bearer ***");
  return s;
}

function publicJob(job: CursorJob): CursorJob {
  // callbackAuth lives only in callbackAuthByJobId / pending authEnc — never copy it onto the job.
  return {
    ...job,
    callbackAuthExpected: Boolean(job.callbackAuthExpected),
  };
}

function forgetCallbackAuth(jobId: string): void {
  callbackAuthByJobId.delete(jobId);
}

function clearRetryTimer(jobId: string): void {
  const t = retryTimers.get(jobId);
  if (t) clearTimeout(t);
  retryTimers.delete(jobId);
}

function trimJobs(): void {
  if (jobs.size <= MAX_JOBS) return;
  const ordered = [...jobs.values()].sort((a, b) => a.startedAt - b.startedAt);
  while (jobs.size > MAX_JOBS && ordered.length) {
    const old = ordered.shift();
    if (!old) break;
    if (!isTerminalStatus(old.status)) break;
    // Prefer dropping successful/no-webhook terminals first; failed health last.
    const keepFailedHealth =
      old.callbackUrl &&
      old.webhookDelivered === false &&
      (old.webhookAttempts || 0) >= WEBHOOK_MAX_ATTEMPTS &&
      ordered.some(
        (j) =>
          isTerminalStatus(j.status) &&
          !(
            j.callbackUrl &&
            j.webhookDelivered === false &&
            (j.webhookAttempts || 0) >= WEBHOOK_MAX_ATTEMPTS
          ),
      );
    if (keepFailedHealth) continue;
    forgetCallbackAuth(old.id);
    clearRetryTimer(old.id);
    jobs.delete(old.id);
  }
  persistJobsNow();
}

export function gitTip(cwd: string): CursorJobCommit | null {
  if (!cwd || !existsSync(cwd)) return null;
  try {
    // Never run git as root in a user checkout (HB-OWN-01).
    const hash = runOperatorCmd("git", ["rev-parse", "HEAD"], {
      cwd,
      timeoutMs: 8_000,
    });
    if (hash.code !== 0) return null;
    const h = String(hash.stdout || "").trim();
    if (!/^[0-9a-f]{7,40}$/i.test(h)) return null;
    const subj = runOperatorCmd("git", ["log", "-1", "--pretty=%s"], {
      cwd,
      timeoutMs: 8_000,
    });
    const dirty = runOperatorCmd("git", ["status", "--porcelain"], {
      cwd,
      timeoutMs: 8_000,
    });
    const branch = runOperatorCmd("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd,
      timeoutMs: 8_000,
    });
    return {
      hash: h,
      short: h.slice(0, 7),
      subject: String(subj.stdout || "").trim().slice(0, 200),
      dirty: Boolean(String(dirty.stdout || "").trim()),
      branch: String(branch.stdout || "").trim() || undefined,
    };
  } catch {
    return null;
  }
}

/** Hard cap so Grok never pays to re-read a novel. */
export function capSummary(raw: string): string {
  const lines = String(raw || "")
    .trim()
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l, i, arr) => l.length > 0 || (i > 0 && arr[i - 1]!.length > 0));
  const sliced = lines.slice(0, MAX_SUMMARY_LINES).join("\n").trim();
  if (sliced.length <= MAX_SUMMARY_CHARS) return sliced;
  return `${sliced.slice(0, MAX_SUMMARY_CHARS - 1).trimEnd()}…`;
}

function lastAssistantSummary(projectId: string, chatId: string): string {
  const ws = deps.workspace(projectId);
  const tab = ws.tabs.find((t) => t.id === chatId);
  if (!tab) return "";
  for (let i = (tab.messages || []).length - 1; i >= 0; i--) {
    const m = tab.messages[i]!;
    if (
      m.role === "assistant" ||
      m.role === "ask" ||
      m.role === "plan" ||
      m.role === "debug"
    ) {
      const t = String(m.text || "").trim();
      if (t) return capSummary(t);
    }
  }
  return "";
}

function chatRunning(projectId: string, chatId: string): boolean {
  const ws = deps.workspace(projectId);
  const tab = ws.tabs.find((t) => t.id === chatId);
  return Boolean(tab?.running);
}

/** Schedule work off the current MCP/HTTP request (and its abort signal). */
function detach(work: () => void): void {
  setImmediate(work);
}

function handoffPrompt(userPrompt: string, branch: string): string {
  return (
    `${userPrompt.trim()}\n\n` +
    `---\n` +
    `Home Base MCP handoff rules (mandatory):\n` +
    `1) Git source of truth: fetch/pull latest \`${branch}\` on this laptop repo first; do the work on \`${branch}\`; ` +
    `commit and push \`${branch}\` when done so the Grok host copy (~/APP_PROJECTS) can pull the same tip. ` +
    `Do not leave laptop-only commits unpushed.\n` +
    `2) Final reply ONLY — at most ${MAX_SUMMARY_LINES} short lines, no logs dumps:\n` +
    `   - What changed (1–3 lines)\n` +
    `   - Tests/commands run + pass/fail\n` +
    `   - Commit hash (short) + branch\n` +
    `   - Blocker / human next step (or "none")\n` +
    `The Grok bot pays tokens to re-read your summary — keep it tiny.`
  );
}

function normalizeCallbackUrl(raw: unknown): string | undefined {
  const u = String(raw || "").trim();
  if (!u) return undefined;
  try {
    const parsed = new URL(u);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("callbackUrl must be http(s)");
    }
    return parsed.toString();
  } catch (e) {
    throw new Error(
      e instanceof Error ? e.message : "invalid callbackUrl",
    );
  }
}

function resolveJobCallbackUrl(param?: string | null): string | undefined {
  const fromParam = String(param ?? "").trim();
  if (fromParam) return normalizeCallbackUrl(fromParam);
  const fromDefault = loadDefaultCallbackUrl();
  if (!fromDefault) return undefined;
  return normalizeCallbackUrl(fromDefault);
}

function syncPendingFromJob(job: CursorJob, auth?: string): void {
  if (!job.callbackUrl) return;
  try {
    persistPendingCallback({
      jobId: job.id,
      projectId: job.projectId,
      callbackUrl: job.callbackUrl,
      startedAt: job.startedAt,
      auth,
      jobStatus: job.status,
      finishedAt: job.finishedAt,
      summary: job.summary,
      error: job.error,
      branch: job.branch,
      chatId: job.chatId,
    });
  } catch (e) {
    appendTrace(
      "error",
      `cursor job ${job.id} failed to persist pending callback: ${
        e instanceof Error ? e.message : String(e)
      }`,
      "cursor-job",
    );
  }
}

function scheduleWebhookRetry(jobId: string, attemptJustFinished: number): void {
  clearRetryTimer(jobId);
  if (attemptJustFinished >= WEBHOOK_MAX_ATTEMPTS) return;
  const delay = webhookBackoffMs(attemptJustFinished - 1);
  const timer = setTimeout(() => {
    retryTimers.delete(jobId);
    const job = jobs.get(jobId);
    if (!job?.callbackUrl) return;
    if (job.webhookDelivered) return;
    void deliverWebhook(job);
  }, delay);
  retryTimers.set(jobId, timer);
}

/**
 * POST the job webhook once. Retries with backoff up to WEBHOOK_MAX_ATTEMPTS.
 * Pending + auth are kept until success or final failure — never logged.
 */
async function deliverWebhook(job: CursorJob): Promise<void> {
  const url = job.callbackUrl;
  if (!url) return;
  if (job.webhookDelivered) {
    forgetCallbackAuth(job.id);
    removePendingCallback(job.id);
    return;
  }
  const auth = callbackAuthByJobId.get(job.id);
  const attempt = (job.webhookAttempts || 0) + 1;
  const at = Date.now();
  let ok = false;
  let statusCode: number | undefined;
  let errMsg: string | undefined;

  try {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "user-agent": "homebase-cursor-job/1",
      "x-homebase-job-id": job.id,
    };
    if (auth) {
      headers.authorization = auth;
    }
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        type: "homebase.cursor_job",
        job: {
          id: job.id,
          projectId: job.projectId,
          chatId: job.chatId,
          status: job.status,
          summary: job.summary,
          commit: job.commit,
          error: job.error,
          branch: job.branch,
          startedAt: job.startedAt,
          finishedAt: job.finishedAt,
        },
      }),
      signal: AbortSignal.timeout(15_000),
    });
    statusCode = res.status;
    if (!res.ok) {
      errMsg = redactCallbackSecrets(`HTTP ${res.status}`, auth);
    } else {
      ok = true;
    }
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    errMsg = redactCallbackSecrets(raw, auth);
  }

  const entry: WebhookAttempt = {
    at,
    attempt,
    ok,
    statusCode,
    error: errMsg,
  };
  const log = [...(job.webhookAttemptLog || []), entry].slice(-WEBHOOK_MAX_ATTEMPTS);
  job.webhookAttempts = attempt;
  job.webhookLastAttemptAt = at;
  job.webhookLastStatusCode = statusCode;
  job.webhookAttemptLog = log;
  if (ok) {
    job.webhookDelivered = true;
    job.webhookError = undefined;
    job.webhookSentAt = at;
  } else {
    job.webhookDelivered = false;
    job.webhookError = errMsg;
  }
  jobs.set(job.id, job);
  persistJobsNow();

  const redactedUrl = redactCallbackUrl(url) || url;
  const logMsg = redactCallbackSecrets(
    `cursor job ${job.id} webhook attempt=${attempt}/${WEBHOOK_MAX_ATTEMPTS} ` +
      `url=${redactedUrl} ` +
      (ok
        ? `ok status=${statusCode ?? 200}`
        : `fail status=${statusCode ?? "n/a"} error=${errMsg || "unknown"}`),
    auth,
  );
  appendTrace(ok ? "info" : "warn", logMsg, "cursor-job");

  updatePendingCallback(job.id, {
    jobStatus: job.status,
    finishedAt: job.finishedAt,
    summary: job.summary,
    error: job.error,
    attempts: attempt,
    lastAttemptAt: at,
    lastStatusCode: statusCode,
    lastError: errMsg,
    webhookDelivered: job.webhookDelivered,
    webhookSentAt: job.webhookSentAt,
    attemptLog: log,
  });

  if (ok || attempt >= WEBHOOK_MAX_ATTEMPTS) {
    clearRetryTimer(job.id);
    forgetCallbackAuth(job.id);
    removePendingCallback(job.id);
    if (!ok) {
      appendTrace(
        "warn",
        `cursor job ${job.id} webhook gave up after ${attempt} attempts`,
        "cursor-job",
      );
    }
    return;
  }

  // Keep auth + pending for retries.
  scheduleWebhookRetry(job.id, attempt);
}

async function awaitChatIdle(
  job: CursorJob,
  waitMs: number,
): Promise<"done" | "timeout" | "error"> {
  const projectId = job.projectId;
  const chatId = job.chatId;
  // Kickoff already succeeded and the chat is idle: the run finished
  // (possibly in the same tick). That is "done", not a missed start.
  if (job.status === "running" && !chatRunning(projectId, chatId)) {
    return "done";
  }
  const startDeadline = Date.now() + KICKOFF_WAIT_MS;
  while (!chatRunning(projectId, chatId) && Date.now() < startDeadline) {
    await Bun.sleep(50);
  }
  if (!chatRunning(projectId, chatId)) return "error";

  const deadline = Date.now() + Math.max(5_000, waitMs);
  while (Date.now() < deadline) {
    if (!chatRunning(projectId, chatId)) return "done";
    await Bun.sleep(IDLE_POLL_MS);
  }
  return chatRunning(projectId, chatId) ? "timeout" : "done";
}

async function finishJob(
  job: CursorJob,
  status: CursorJobStatus,
  error?: string,
): Promise<CursorJob> {
  if (job.finishedAt && isTerminalStatus(job.status)) {
    return publicJob(job);
  }
  job.status = status;
  job.finishedAt = Date.now();
  if (error) {
    const trimmed = trimAgentError(error) || error;
    job.error = redactCallbackSecrets(
      trimmed,
      callbackAuthByJobId.get(job.id),
      process.env.HOMEBASE_CALLBACK_AUTH,
    );
  }
  job.summary = lastAssistantSummary(job.projectId, job.chatId) || job.summary;
  try {
    repairProjectOwnership(job.cwd);
    const qa = ownershipQaAfterGitOp(job.cwd);
    if (!qa.ok) {
      appendTrace(
        "warn",
        `cursor_job ${job.id} ownership QA: ${qa.error}`,
        "ownership",
      );
    }
    job.ownershipQa = {
      ok: qa.ok,
      foreignCount: qa.health.foreignCount,
      samples: qa.health.samples,
      error: qa.error,
    };
  } catch {
    /* best-effort */
  }
  job.commit = gitTip(job.cwd);
  jobs.set(job.id, job);
  persistJobsNow();
  if (job.callbackUrl) {
    syncPendingFromJob(job, callbackAuthByJobId.get(job.id));
  }
  await deliverWebhook(job);
  return publicJob(job);
}

/** After the chat goes idle: fail on run error or empty assistant output. */
export function evaluateIdleJobOutcome(opts: {
  summary: string;
  lastError?: string;
}): { status: "done" | "error"; error?: string } {
  const err = trimAgentError(opts.lastError || "");
  if (err) return { status: "error", error: err };
  if (!String(opts.summary || "").trim()) {
    return {
      status: "error",
      error:
        "Cursor job finished with no assistant output (model may be invalid, or the agent exited without a reply)",
    };
  }
  return { status: "done" };
}

async function finishIdleJob(job: CursorJob): Promise<CursorJob> {
  const summary = lastAssistantSummary(job.projectId, job.chatId);
  const lastError = deps.lastRunError(job.projectId, job.chatId);
  const outcome = evaluateIdleJobOutcome({ summary, lastError });
  if (outcome.status === "error") {
    return finishJob(job, "error", outcome.error);
  }
  return finishJob(job, "done");
}

/**
 * Watch until the agent chat goes idle (no deadline). Used after the waitMs
 * window ends while the process is still alive, and for fire-and-forget jobs.
 * Marks timeout only via finishJob("timeout") when the process was killed.
 */
async function watchUntilIdle(job: CursorJob): Promise<CursorJob> {
  while (true) {
    if (isTerminalStatus(job.status)) return publicJob(job);
    if (!chatRunning(job.projectId, job.chatId)) {
      return finishIdleJob(job);
    }
    await Bun.sleep(IDLE_POLL_MS);
  }
}

async function watchUntilSettled(job: CursorJob, maxMs: number): Promise<CursorJob> {
  const outcome = await awaitChatIdle(job, maxMs);
  if (outcome === "timeout") {
    // Wait window ended but the agent process is still alive — keep status
    // "running", preserve startedAt/elapsed, continue watching, and fire the
    // callback only on the real exit (summary/commit). Do not mark "timeout"
    // unless the process is actually killed.
    detach(() => {
      void watchUntilIdle(job);
    });
    return publicJob(job);
  }
  if (outcome === "error") {
    return finishJob(
      job,
      "error",
      "MCP job did not start a Cursor chat run — the prompt never triggered a reply",
    );
  }
  return finishIdleJob(job);
}

/**
 * Mark a running job done only after kickoff succeeded and the chat has
 * since gone idle. Never treat "not running yet" (still queued) as finished.
 * Empty assistant output / last run error → error (HB-R3-01).
 */
function maybeFinishIfIdle(job: CursorJob): void {
  if (job.status !== "running") return;
  if (chatRunning(job.projectId, job.chatId)) return;
  void finishIdleJob(job);
}

/** True if a handoff job is still queued/running for this project. */
export function projectHasActiveCursorJob(projectId: string): CursorJob | null {
  const pid = String(projectId || "").trim();
  for (const j of jobs.values()) {
    if (j.projectId !== pid) continue;
    if (j.status === "queued" || j.status === "running") {
      maybeFinishIfIdle(j);
      if (j.status === "queued" || j.status === "running") {
        return publicJob(j);
      }
    }
  }
  return null;
}

async function waitForKickoff(
  job: CursorJob,
  start: { started: boolean; error: unknown; settled: boolean },
): Promise<CursorJob | null> {
  const deadline = Date.now() + KICKOFF_WAIT_MS;
  while (Date.now() < deadline) {
    if (chatRunning(job.projectId, job.chatId) || start.started) {
      return null;
    }
    if (start.error) {
      return finishJob(
        job,
        "error",
        start.error instanceof Error ? start.error.message : String(start.error),
      );
    }
    if (start.settled) {
      return finishJob(
        job,
        "error",
        "MCP job did not start a Cursor chat run — the prompt never triggered a reply",
      );
    }
    await Bun.sleep(20);
  }
  return finishJob(
    job,
    "error",
    "Timed out waiting for the Cursor chat run to start",
  );
}

/** Start a Cursor agent job for a registered project. Optionally wait / webhook. */
export async function startCursorJob(opts: {
  projectId: string;
  prompt: string;
  model?: string;
  mode?: string;
  cwd?: string;
  title?: string;
  waitMs?: number;
  branch?: string;
  callbackUrl?: string;
  /**
   * Exact Authorization header value for the job webhook (e.g. "Bearer abc").
   * Overrides the Settings vault default. Kept in memory and in the
   * encrypted pending-callback file — never on job JSON or in plaintext logs.
   */
  callbackAuth?: string;
  source?: string;
  /** MCP token label / bot name for chat bubble meta. */
  sourceLabel?: string;
}): Promise<CursorJob> {
  const projectId = String(opts.projectId || "").trim();
  const prompt = String(opts.prompt || "").trim();
  if (!projectId) throw new Error("projectId required");
  if (!prompt) throw new Error("prompt required");
  if (!deps.configured()) {
    throw new Error(
      "Cursor API key not set on Home Base — human must add it in Settings",
    );
  }
  const project = deps.getProject(projectId);
  if (!project) throw new Error(`project not found: ${projectId}`);

  const active = projectHasActiveCursorJob(projectId);
  if (active) {
    throw new Error(
      `Project already has an active Home Base job (${active.id}, status=${active.status}). ` +
        `One job at a time — wait for it to finish (or status it) before starting another, ` +
        `and do not push to the same branch from the Grok host while it runs.`,
    );
  }

  const cwd = String(opts.cwd || project.path || "").trim() || project.path;
  const model = String(opts.model || defaultModel()).trim() || defaultModel();
  const mode = String(opts.mode || "agent").trim() || "agent";
  const branch =
    String(opts.branch || DEFAULT_BRANCH).trim() || DEFAULT_BRANCH;
  const callbackUrl = resolveJobCallbackUrl(opts.callbackUrl);
  const callbackAuth = resolveCallbackAuth(opts.callbackAuth);
  const title =
    String(opts.title || "").trim() ||
    `MCP · ${prompt.slice(0, 28)}${prompt.length > 28 ? "…" : ""}`;

  await deps.validateModel(model);

  hydrateJobsFromDisk();
  const tab = deps.createChat(projectId, { title, cwd });
  const job: CursorJob = {
    id: randomBytes(6).toString("hex"),
    projectId,
    chatId: tab.id,
    status: "queued",
    prompt,
    model,
    mode,
    cwd,
    branch,
    startedAt: Date.now(),
    source: opts.source || "mcp",
    callbackUrl,
  };
  jobs.set(job.id, job);
  if (callbackUrl) {
    job.callbackAuthExpected = Boolean(callbackAuth);
    if (callbackAuth) callbackAuthByJobId.set(job.id, callbackAuth);
    syncPendingFromJob(job, callbackAuth);
  }
  persistJobsNow();
  trimJobs();

  appendTrace(
    "info",
    `cursor job ${job.id} start project=${projectId} branch=${branch} chat=${tab.id}`,
    "cursor-job",
  );

  const start = { started: false, error: null as unknown, settled: false };
  const source =
    opts.source === "web" || opts.source === "system" ? opts.source : "mcp";
  const sourceLabel = String(opts.sourceLabel || "")
    .trim()
    .slice(0, 64);

  detach(() => {
    void deps
      .runner(projectId, {
        chatId: tab.id,
        prompt: handoffPrompt(prompt, branch),
        model,
        mode,
        cwd,
        queueIfBusy: true,
        source,
        sourceLabel: sourceLabel || undefined,
        jobId: job.id,
        onStarted: () => {
          start.started = true;
        },
      })
      .then(
        () => {
          start.settled = true;
        },
        (e) => {
          start.error = e;
          start.settled = true;
          if (job.status === "queued" || job.status === "running") {
            void finishJob(job, "error", e instanceof Error ? e.message : String(e));
          }
        },
      );
  });

  const failed = await waitForKickoff(job, start);
  if (failed) return failed;

  job.status = "running";
  jobs.set(job.id, job);
  persistJobsNow();
  if (job.callbackUrl) {
    syncPendingFromJob(job, callbackAuthByJobId.get(job.id));
  }

  const waitMs = Math.min(
    45 * 60_000,
    Math.max(0, Number(opts.waitMs) || 0),
  );

  if (waitMs <= 0) {
    // Fire-and-forget: watch until the agent exits (no artificial timeout).
    // Detached so /mcp close cannot cancel it. Callback fires on real exit.
    detach(() => {
      void watchUntilIdle(job);
    });
    return publicJob(job);
  }

  return watchUntilSettled(job, waitMs);
}

/**
 * Cancel a queued/running cursor job: abort the agent chat run, mark
 * status cancelled, fire webhook if set, and release the per-project lock.
 */
export async function cancelCursorJob(opts: {
  projectId: string;
  jobId: string;
}): Promise<CursorJob> {
  const projectId = String(opts.projectId || "").trim();
  const jobId = String(opts.jobId || "").trim();
  if (!projectId) throw new Error("projectId required");
  if (!jobId) throw new Error("jobId required");
  const job = jobs.get(jobId);
  if (!job) throw new Error(`job not found: ${jobId}`);
  if (job.projectId !== projectId) {
    throw new Error(`job ${jobId} does not belong to project ${projectId}`);
  }
  if (isTerminalStatus(job.status)) {
    return publicJob(job);
  }
  if (job.chatId) {
    try {
      await cancelRun(projectId, job.chatId, true);
    } catch (e) {
      appendTrace(
        "warn",
        `cursor job ${job.id} cancelRun: ${
          e instanceof Error ? e.message : String(e)
        }`,
        "cursor-job",
      );
    }
  }
  return finishJob(job, "cancelled", "Cancelled by operator");
}

/** Cancel active job for a chat (used when the UI stops a job chat). */
export async function cancelCursorJobByChat(
  projectId: string,
  chatId: string,
): Promise<CursorJob | null> {
  const pid = String(projectId || "").trim();
  const cid = String(chatId || "").trim();
  if (!pid || !cid) return null;
  for (const j of jobs.values()) {
    if (j.projectId !== pid || j.chatId !== cid) continue;
    if (j.status !== "queued" && j.status !== "running") continue;
    return cancelCursorJob({ projectId: pid, jobId: j.id });
  }
  return null;
}

export function getCursorJob(id: string): CursorJob | null {
  hydrateJobsFromDisk();
  const job = jobs.get(String(id || "").trim());
  if (!job) return null;
  maybeFinishIfIdle(job);
  return publicJob(job);
}

export function listCursorJobs(limit = 20): CursorJob[] {
  hydrateJobsFromDisk();
  return [...jobs.values()]
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, Math.min(50, Math.max(1, limit)))
    .map((j) => {
      maybeFinishIfIdle(j);
      return publicJob(j);
    });
}

function synthesizeRecoveredJob(
  rec: PendingCallbackRecord,
  status: CursorJobStatus,
  extra?: Partial<CursorJob>,
): CursorJob {
  const existing = jobs.get(rec.jobId);
  return {
    id: rec.jobId,
    projectId: rec.projectId || existing?.projectId || "",
    chatId: rec.chatId || existing?.chatId || "",
    status,
    prompt: existing?.prompt || "",
    model: existing?.model || "",
    mode: existing?.mode || "",
    cwd: existing?.cwd || "",
    branch: rec.branch || existing?.branch || "",
    summary:
      status === "interrupted"
        ? INTERRUPTED_SUMMARY
        : rec.summary || existing?.summary || INTERRUPTED_SUMMARY,
    error: rec.error || existing?.error,
    commit: existing?.commit,
    startedAt: rec.startedAt || existing?.startedAt || Date.now(),
    finishedAt: rec.finishedAt || existing?.finishedAt || Date.now(),
    source: existing?.source || "system",
    callbackUrl: rec.callbackUrl,
    callbackAuthExpected: rec.hasAuth || Boolean(existing?.callbackAuthExpected),
    webhookDelivered: existing?.webhookDelivered,
    webhookError: existing?.webhookError,
    webhookSentAt: existing?.webhookSentAt,
    webhookAttempts: rec.attempts || existing?.webhookAttempts,
    webhookLastStatusCode:
      rec.lastStatusCode ?? existing?.webhookLastStatusCode,
    webhookLastAttemptAt: rec.lastAttemptAt ?? existing?.webhookLastAttemptAt,
    webhookAttemptLog: rec.attemptLog || existing?.webhookAttemptLog,
    ...extra,
  };
}

export type WebhookHealthRow = {
  jobId: string;
  projectId: string;
  jobStatus: string;
  callbackUrlRedacted?: string;
  callbackAuthExpected: boolean;
  webhookDelivered?: boolean;
  webhookSentAt?: number;
  webhookAttempts?: number;
  webhookLastStatusCode?: number;
  webhookLastAttemptAt?: number;
  webhookError?: string;
  /** True when delivery failed after all retries (or lost/decrypt). */
  failed: boolean;
  pending: boolean;
  startedAt: number;
  finishedAt?: number;
};

/** Public health view — URLs redacted; never includes auth. */
export function listWebhookHealth(limit = 40): WebhookHealthRow[] {
  hydrateJobsFromDisk();
  const pendingIds = new Set(loadPendingCallbacks().map((r) => r.jobId));
  return [...jobs.values()]
    .filter((j) => j.callbackUrl)
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, Math.min(80, Math.max(1, limit)))
    .map((j) => {
      const attempts = j.webhookAttempts || 0;
      const failed =
        j.webhookDelivered === false &&
        (attempts >= WEBHOOK_MAX_ATTEMPTS ||
          Boolean(j.webhookError && !pendingIds.has(j.id)));
      return {
        jobId: j.id,
        projectId: j.projectId,
        jobStatus: j.status,
        callbackUrlRedacted: redactCallbackUrl(j.callbackUrl),
        callbackAuthExpected: Boolean(j.callbackAuthExpected),
        webhookDelivered: j.webhookDelivered,
        webhookSentAt: j.webhookSentAt,
        webhookAttempts: j.webhookAttempts,
        webhookLastStatusCode: j.webhookLastStatusCode,
        webhookLastAttemptAt: j.webhookLastAttemptAt,
        webhookError: j.webhookError
          ? redactCallbackSecrets(j.webhookError)
          : undefined,
        failed,
        pending: pendingIds.has(j.id),
        startedAt: j.startedAt,
        finishedAt: j.finishedAt,
      };
    });
}

export function webhookHealthHasFailures(): boolean {
  return listWebhookHealth(80).some((r) => r.failed);
}

/**
 * Send a one-shot test ping to the given URL (or Settings default).
 * Uses vault callback auth when configured. Never returns the auth value.
 */
export async function sendWebhookTestPing(opts?: {
  callbackUrl?: string;
}): Promise<{
  ok: boolean;
  urlRedacted?: string;
  statusCode?: number;
  error?: string;
  at: number;
}> {
  const url =
    resolveJobCallbackUrl(opts?.callbackUrl) ||
    normalizeCallbackUrl(loadDefaultCallbackUrl());
  if (!url) {
    return {
      ok: false,
      error: "No callbackUrl and no Settings default callback URL",
      at: Date.now(),
    };
  }
  const auth = resolveCallbackAuth(undefined);
  const at = Date.now();
  try {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "user-agent": "homebase-webhook-test/1",
    };
    if (auth) headers.authorization = auth;
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        type: "homebase.webhook_test_ping",
        at,
        message: "Home Base webhook test ping",
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const ok = res.ok;
    const err = ok
      ? undefined
      : redactCallbackSecrets(`HTTP ${res.status}`, auth);
    appendTrace(
      ok ? "info" : "warn",
      `webhook test ping url=${redactCallbackUrl(url)} status=${res.status} ok=${ok}`,
      "cursor-job",
    );
    return {
      ok,
      urlRedacted: redactCallbackUrl(url),
      statusCode: res.status,
      error: err,
      at,
    };
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    const error = redactCallbackSecrets(raw, auth);
    appendTrace(
      "warn",
      `webhook test ping url=${redactCallbackUrl(url)} fail error=${error}`,
      "cursor-job",
    );
    return {
      ok: false,
      urlRedacted: redactCallbackUrl(url),
      error,
      at,
    };
  }
}

/**
 * On Home Base startup: hydrate persisted jobs, then deliver leftover pending
 * callbacks. Still-running jobs → status `interrupted`. Already-finished jobs
 * with undelivered webhooks → resume delivery with the original terminal status
 * (never re-labeled interrupted). Retries use the same backoff as live delivery.
 * Records older than 24h are expired. Decrypt failures → lost-callback entry.
 */
export async function recoverInterruptedCallbacks(): Promise<{
  recovered: number;
  resumed: number;
  expired: number;
  lost: number;
}> {
  hydrateJobsFromDisk();
  const pending = loadPendingCallbacks();
  let recovered = 0;
  let resumed = 0;
  let expired = 0;
  let lost = 0;
  const now = Date.now();
  for (const rec of pending) {
    if (now - rec.startedAt > PENDING_MAX_AGE_MS) {
      appendTrace(
        "warn",
        `pending cursor job callback ${rec.jobId} expired after 24h; not delivered`,
        "cursor-job",
      );
      removePendingCallback(rec.jobId);
      expired++;
      continue;
    }
    const { auth, decryptFailed } = decryptPendingAuth(rec);
    if (decryptFailed) {
      appendTrace(
        "error",
        `pending cursor job callback ${rec.jobId}: failed to decrypt auth; webhook not sent`,
        "cursor-job",
      );
      const lostJob = synthesizeRecoveredJob(rec, "error", {
        webhookDelivered: false,
        webhookError:
          "Callback token could not be decrypted after Home Base restarted; webhook was not sent.",
        callbackAuthExpected: true,
      });
      jobs.set(lostJob.id, lostJob);
      persistJobsNow();
      removePendingCallback(rec.jobId);
      lost++;
      continue;
    }

    const known = jobs.get(rec.jobId);
    const priorStatus = String(rec.jobStatus || known?.status || "");
    const alreadyTerminal = isTerminalStatus(priorStatus);

    let job: CursorJob;
    if (alreadyTerminal) {
      // Resume undelivered finished job — do NOT re-label as interrupted.
      job = synthesizeRecoveredJob(rec, priorStatus as CursorJobStatus, {
        summary: rec.summary || known?.summary,
        finishedAt: rec.finishedAt || known?.finishedAt || Date.now(),
        webhookDelivered: false,
      });
      resumed++;
    } else {
      job = synthesizeRecoveredJob(rec, "interrupted");
      recovered++;
    }

    if (auth) callbackAuthByJobId.set(job.id, auth);
    // Carry prior attempt count so retries continue toward WEBHOOK_MAX_ATTEMPTS.
    if (rec.attempts > 0) {
      job.webhookAttempts = rec.attempts;
      job.webhookAttemptLog = rec.attemptLog;
      job.webhookLastStatusCode = rec.lastStatusCode;
      job.webhookLastAttemptAt = rec.lastAttemptAt;
      job.webhookError = rec.lastError;
    }
    jobs.set(job.id, job);
    persistJobsNow();
    syncPendingFromJob(job, auth);
    await deliverWebhook(job);
  }
  return { recovered, resumed, expired, lost };
}

export { INTERRUPTED_SUMMARY, WEBHOOK_MAX_ATTEMPTS, redactCallbackUrl };
