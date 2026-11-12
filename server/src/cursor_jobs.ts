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
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { loadProjects } from "./config";
import {
  createChat,
  cursorConfigured,
  defaultModel,
  getWorkspace,
  startCursorRun,
} from "./cursor";
import { appendTrace } from "./trace";

export type CursorJobStatus =
  | "queued"
  | "running"
  | "done"
  | "error"
  | "timeout";

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
};

export type CursorJobRunOpts = {
  chatId: string;
  prompt: string;
  model: string;
  mode: string;
  cwd?: string;
  queueIfBusy?: boolean;
  onStarted?: () => void;
};

type JobDeps = {
  runner: (projectId: string, opts: CursorJobRunOpts) => Promise<void>;
  configured: () => boolean;
  getProject: (id: string) => { path: string } | undefined;
  createChat: typeof createChat;
  workspace: typeof getWorkspace;
};

function defaultDeps(): JobDeps {
  return {
    runner: startCursorRun,
    configured: cursorConfigured,
    getProject: (id) => loadProjects().get(id),
    createChat,
    workspace: getWorkspace,
  };
}

let deps: JobDeps = defaultDeps();

/** Test-only: stub the Cursor run / project lookup. Pass null to restore. */
export function _setCursorJobDepsForTests(partial: Partial<JobDeps> | null): void {
  deps = partial ? { ...defaultDeps(), ...partial } : defaultDeps();
}

/** Test-only: drop in-memory jobs between cases. */
export function _resetCursorJobsForTests(): void {
  jobs.clear();
}

const jobs = new Map<string, CursorJob>();
const MAX_JOBS = 40;
const DEFAULT_BRANCH = "development_grok";
const MAX_SUMMARY_LINES = 10;
const MAX_SUMMARY_CHARS = 1200;
const KICKOFF_WAIT_MS = 15_000;
const IDLE_POLL_MS = 200;

function trimJobs(): void {
  if (jobs.size <= MAX_JOBS) return;
  const ordered = [...jobs.values()].sort((a, b) => a.startedAt - b.startedAt);
  while (jobs.size > MAX_JOBS && ordered.length) {
    const old = ordered.shift();
    if (
      old &&
      (old.status === "done" ||
        old.status === "error" ||
        old.status === "timeout")
    ) {
      jobs.delete(old.id);
    } else {
      break;
    }
  }
}

export function gitTip(cwd: string): CursorJobCommit | null {
  if (!cwd || !existsSync(cwd)) return null;
  try {
    const hash = spawnSync("git", ["-C", cwd, "rev-parse", "HEAD"], {
      encoding: "utf8",
      timeout: 8_000,
    });
    if (hash.status !== 0) return null;
    const h = String(hash.stdout || "").trim();
    if (!/^[0-9a-f]{7,40}$/i.test(h)) return null;
    const subj = spawnSync(
      "git",
      ["-C", cwd, "log", "-1", "--pretty=%s"],
      { encoding: "utf8", timeout: 8_000 },
    );
    const dirty = spawnSync("git", ["-C", cwd, "status", "--porcelain"], {
      encoding: "utf8",
      timeout: 8_000,
    });
    const branch = spawnSync(
      "git",
      ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"],
      { encoding: "utf8", timeout: 8_000 },
    );
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

async function deliverWebhook(job: CursorJob): Promise<void> {
  const url = job.callbackUrl;
  if (!url) return;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "homebase-cursor-job/1",
        "x-homebase-job-id": job.id,
      },
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
    if (!res.ok) {
      job.webhookDelivered = false;
      job.webhookError = `HTTP ${res.status}`;
    } else {
      job.webhookDelivered = true;
      job.webhookError = undefined;
    }
  } catch (e) {
    job.webhookDelivered = false;
    job.webhookError = e instanceof Error ? e.message : String(e);
  }
  jobs.set(job.id, job);
  appendTrace(
    job.webhookDelivered ? "info" : "warn",
    `cursor job ${job.id} webhook ${job.webhookDelivered ? "ok" : job.webhookError}`,
    "cursor-job",
  );
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
  if (
    job.finishedAt &&
    (job.status === "done" || job.status === "error" || job.status === "timeout")
  ) {
    return { ...job };
  }
  job.status = status;
  job.finishedAt = Date.now();
  if (error) job.error = error;
  job.summary = lastAssistantSummary(job.projectId, job.chatId) || job.summary;
  job.commit = gitTip(job.cwd);
  jobs.set(job.id, job);
  await deliverWebhook(job);
  return { ...job };
}

async function watchUntilSettled(job: CursorJob, maxMs: number): Promise<CursorJob> {
  const outcome = await awaitChatIdle(job, maxMs);
  if (outcome === "timeout") {
    return finishJob(
      job,
      "timeout",
      `Still running after ${Math.round(maxMs / 1000)}s — use callbackUrl or poll status sparingly (≥5 min)`,
    );
  }
  if (outcome === "error") {
    return finishJob(
      job,
      "error",
      "MCP job did not start a Cursor chat run — the prompt never triggered a reply",
    );
  }
  return finishJob(job, "done");
}

/**
 * Mark a running job done only after kickoff succeeded and the chat has
 * since gone idle. Never treat "not running yet" (still queued) as finished.
 */
function maybeFinishIfIdle(job: CursorJob): void {
  if (job.status !== "running") return;
  if (chatRunning(job.projectId, job.chatId)) return;
  void finishJob(job, "done");
}

/** True if a handoff job is still queued/running for this project. */
export function projectHasActiveCursorJob(projectId: string): CursorJob | null {
  const pid = String(projectId || "").trim();
  for (const j of jobs.values()) {
    if (j.projectId !== pid) continue;
    if (j.status === "queued" || j.status === "running") {
      maybeFinishIfIdle(j);
      if (j.status === "queued" || j.status === "running") {
        return { ...j };
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
  source?: string;
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
  const callbackUrl = normalizeCallbackUrl(opts.callbackUrl);
  const title =
    String(opts.title || "").trim() ||
    `MCP · ${prompt.slice(0, 28)}${prompt.length > 28 ? "…" : ""}`;

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
  trimJobs();

  appendTrace(
    "info",
    `cursor job ${job.id} start project=${projectId} branch=${branch} chat=${tab.id}`,
    "cursor-job",
  );

  const start = { started: false, error: null as unknown, settled: false };
  detach(() => {
    void deps
      .runner(projectId, {
        chatId: tab.id,
        prompt: handoffPrompt(prompt, branch),
        model,
        mode,
        cwd,
        queueIfBusy: true,
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

  const waitMs = Math.min(
    45 * 60_000,
    Math.max(0, Number(opts.waitMs) || 0),
  );
  const watchCap = waitMs > 0 ? waitMs : 45 * 60_000;

  if (waitMs <= 0) {
    // Fire-and-forget watch: also detached so /mcp close cannot cancel it.
    detach(() => {
      void watchUntilSettled(job, watchCap);
    });
    return { ...job };
  }

  return watchUntilSettled(job, waitMs);
}

export function getCursorJob(id: string): CursorJob | null {
  const job = jobs.get(String(id || "").trim());
  if (!job) return null;
  maybeFinishIfIdle(job);
  return { ...job };
}

export function listCursorJobs(limit = 20): CursorJob[] {
  return [...jobs.values()]
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, Math.min(50, Math.max(1, limit)))
    .map((j) => {
      maybeFinishIfIdle(j);
      return { ...j };
    });
}
