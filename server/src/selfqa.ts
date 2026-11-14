/**
 * Self-QA sprint: one managed PTY session per project running
 * `./build.sh --selfqa` with optional webhook when the session ends.
 */
import {
  chmodSync,
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import {
  INTERRUPTED_SUMMARY,
  PENDING_MAX_AGE_MS,
  decryptPendingAuth,
  type PendingCallbackRecord,
} from "./cursor_callbacks";
import {
  ensureRuntimeDirs,
  loadProjects,
  RUNTIME_DIR,
  type Project,
} from "./config";
import {
  resolveCallbackAuth,
  redactCallbackSecrets,
} from "./cursor_jobs";
import {
  killByProject,
  listSessions,
  onSessionExit,
  readSessionOutput,
  spawnShell,
  type SessionPublic,
} from "./pty";
import { encryptSecret } from "./secrets_vault";
import { appendTrace } from "./trace";

export type SelfQaStatus =
  | "idle"
  | "running"
  | "done"
  | "error"
  | "blocked"
  | "interrupted"
  | "cancelled";

export type SelfQaRecord = {
  id: string;
  projectId: string;
  sessionId: string;
  status: SelfQaStatus;
  goal?: string;
  cycles: number;
  maxMinutes: number;
  testers: number;
  dryRun: boolean;
  startedAt: number;
  finishedAt?: number;
  exitCode?: number;
  summaryPath?: string;
  summaryTail?: string;
  error?: string;
  callbackUrl?: string;
  webhookDelivered?: boolean;
  webhookError?: string;
  callbackAuthExpected?: boolean;
  latestReportPath?: string;
};

export type SelfQaStartOpts = {
  projectId: string;
  goal?: string;
  cycles?: number;
  maxMinutes?: number;
  testers?: number;
  dryRun?: boolean;
  callbackUrl?: string;
  callbackAuth?: string;
  source?: string;
};

const runs = new Map<string, SelfQaRecord>();
const byProject = new Map<string, string>();
const authById = new Map<string, string>();
const MAX_RUNS = 40;

type SelfQaDeps = {
  getProject: (id: string) => Project | undefined;
};

function defaultDeps(): SelfQaDeps {
  return { getProject: (id) => loadProjects().get(id) };
}

let deps: SelfQaDeps = defaultDeps();

/** Test-only: stub project lookup. Pass null to restore. */
export function _setSelfQaDepsForTests(partial: Partial<SelfQaDeps> | null): void {
  deps = partial ? { ...defaultDeps(), ...partial } : defaultDeps();
}

const SELFQA_PENDING_PATH = join(
  RUNTIME_DIR,
  "selfqa_callbacks.pending.enc",
);

type SelfQaPendingFile = { v: 1; records: PendingCallbackRecord[] };

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

function loadSelfQaPending(): PendingCallbackRecord[] {
  if (!existsSync(SELFQA_PENDING_PATH)) return [];
  try {
    const raw = readFileSync(SELFQA_PENDING_PATH, "utf8");
    const o = JSON.parse(raw) as SelfQaPendingFile;
    if (!o || o.v !== 1 || !Array.isArray(o.records)) return [];
    return o.records.filter(
      (r) => r && typeof r.jobId === "string" && r.callbackUrl,
    );
  } catch {
    return [];
  }
}

function saveSelfQaPending(records: PendingCallbackRecord[]): void {
  if (!records.length) {
    try {
      if (existsSync(SELFQA_PENDING_PATH)) unlinkSync(SELFQA_PENDING_PATH);
    } catch {
      /* ignore */
    }
    return;
  }
  writePrivate(
    SELFQA_PENDING_PATH,
    JSON.stringify({ v: 1, records } satisfies SelfQaPendingFile),
  );
}

function persistSelfQaPending(input: {
  jobId: string;
  projectId: string;
  callbackUrl: string;
  startedAt: number;
  auth?: string;
}): void {
  const auth = String(input.auth || "").trim();
  const rec: PendingCallbackRecord = {
    jobId: String(input.jobId),
    projectId: String(input.projectId || ""),
    callbackUrl: String(input.callbackUrl),
    startedAt: Number(input.startedAt) || Date.now(),
    hasAuth: Boolean(auth),
    authEnc: auth ? encryptSecret(auth) : undefined,
  };
  const rest = loadSelfQaPending().filter((r) => r.jobId !== rec.jobId);
  rest.push(rec);
  saveSelfQaPending(rest);
}

function removeSelfQaPending(jobId: string): void {
  saveSelfQaPending(loadSelfQaPending().filter((r) => r.jobId !== jobId));
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
    throw new Error(e instanceof Error ? e.message : "invalid callbackUrl");
  }
}

function clampInt(
  raw: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/** Detect whether a project's build.sh documents/supports --selfqa. */
export function projectSupportsSelfQa(project: Project): {
  ok: boolean;
  message?: string;
  buildSh?: string;
} {
  const buildSh = resolve(project.path, "build.sh");
  if (!existsSync(buildSh)) {
    return {
      ok: false,
      message:
        "This project has no build.sh. Self-QA needs ./build.sh --selfqa (see Home Base docs/SELFQA.md).",
      buildSh,
    };
  }
  let text = "";
  try {
    text = readFileSync(buildSh, "utf8");
  } catch {
    return {
      ok: false,
      message: `Cannot read ${buildSh}`,
      buildSh,
    };
  }
  if (!/--selfqa\b/.test(text)) {
    return {
      ok: false,
      message:
        "This project's build.sh does not support --selfqa. Add a --selfqa flag that runs a Self-QA sprint (see Home Base docs/SELFQA.md), or copy scripts/selfqa from the Home Base repo.",
      buildSh,
    };
  }
  return { ok: true, buildSh };
}

export function projectHasActiveSelfQa(
  projectId: string,
): SelfQaRecord | null {
  const id = byProject.get(projectId);
  if (!id) return null;
  const rec = runs.get(id);
  if (!rec) return null;
  if (rec.status === "running") return publicRun(rec);
  // Also treat an alive selfqa PTY as active even if map drifted.
  const live = listSessions(projectId).find(
    (s) => s.alive && s.kind === "selfqa",
  );
  if (live && rec.sessionId === live.id) return publicRun(rec);
  return null;
}

function publicRun(rec: SelfQaRecord): SelfQaRecord {
  return {
    ...rec,
    callbackAuthExpected: Boolean(rec.callbackAuthExpected),
  };
}

function trimRuns(): void {
  if (runs.size <= MAX_RUNS) return;
  const ordered = [...runs.values()].sort((a, b) => a.startedAt - b.startedAt);
  while (runs.size > MAX_RUNS && ordered.length) {
    const old = ordered.shift();
    if (!old || old.status === "running") break;
    authById.delete(old.id);
    if (byProject.get(old.projectId) === old.id) byProject.delete(old.projectId);
    runs.delete(old.id);
  }
}

function findLatestSummary(projectPath: string): {
  path?: string;
  tail?: string;
} {
  const root = join(projectPath, "docs", "selfqa");
  if (!existsSync(root)) return {};
  let best: { path: string; mtime: number } | null = null;
  try {
    for (const name of readdirSync(root)) {
      const summary = join(root, name, "SUMMARY.md");
      if (!existsSync(summary)) continue;
      const mtime = statSync(summary).mtimeMs;
      if (!best || mtime > best.mtime) best = { path: summary, mtime };
    }
  } catch {
    return {};
  }
  if (!best) return {};
  let tail = "";
  try {
    const text = readFileSync(best.path, "utf8");
    tail = text.trim().split(/\r?\n/).slice(-40).join("\n");
  } catch {
    /* ignore */
  }
  return { path: best.path, tail };
}

function findLatestCycleReport(
  projectPath: string,
  runId?: string,
): string | undefined {
  const qaDir = join(projectPath, "docs", "qa");
  if (!existsSync(qaDir)) return undefined;
  try {
    const files = readdirSync(qaDir)
      .filter((f) =>
        runId
          ? f.startsWith(`selfqa-${runId}-cycle`) && f.endsWith(".md")
          : /^selfqa-.*-cycle\d+\.md$/.test(f),
      )
      .map((f) => {
        const p = join(qaDir, f);
        return { path: p, mtime: statSync(p).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
    return files[0]?.path;
  } catch {
    return undefined;
  }
}

function readSummaryJson(projectPath: string, summaryMdPath?: string): unknown {
  if (!summaryMdPath) return undefined;
  try {
    const dir = summaryMdPath.replace(/\/SUMMARY\.md$/i, "");
    const jsonPath = join(dir, "SUMMARY.json");
    if (!existsSync(jsonPath)) return undefined;
    return JSON.parse(readFileSync(jsonPath, "utf8"));
  } catch {
    return undefined;
  }
}

async function deliverWebhook(rec: SelfQaRecord): Promise<void> {
  const url = rec.callbackUrl;
  if (!url) return;
  const auth = authById.get(rec.id);
  const project = deps.getProject(rec.projectId);
  const summaryJson = project
    ? readSummaryJson(project.path, rec.summaryPath)
    : undefined;
  try {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "user-agent": "homebase-selfqa/1",
      "x-homebase-selfqa-id": rec.id,
    };
    if (auth) headers.authorization = auth;
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        type: "homebase.selfqa",
        // Single final summary JSON is the preferred callback payload.
        summary: summaryJson,
        selfqa: {
          id: rec.id,
          projectId: rec.projectId,
          sessionId: rec.sessionId,
          status: rec.status,
          exitCode: rec.exitCode,
          summaryPath: rec.summaryPath,
          summaryTail: rec.summaryTail,
          summaryJson,
          latestReportPath: rec.latestReportPath,
          error: rec.error,
          goal: rec.goal,
          cycles: rec.cycles,
          maxMinutes: rec.maxMinutes,
          testers: rec.testers,
          dryRun: rec.dryRun,
          startedAt: rec.startedAt,
          finishedAt: rec.finishedAt,
        },
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      rec.webhookDelivered = false;
      rec.webhookError = redactCallbackSecrets(`HTTP ${res.status}`, auth);
    } else {
      rec.webhookDelivered = true;
      rec.webhookError = undefined;
    }
  } catch (e) {
    rec.webhookDelivered = false;
    rec.webhookError = redactCallbackSecrets(
      e instanceof Error ? e.message : String(e),
      auth,
    );
  }
  runs.set(rec.id, rec);
  appendTrace(
    rec.webhookDelivered ? "info" : "warn",
    redactCallbackSecrets(
      `selfqa ${rec.id} webhook ${rec.webhookDelivered ? "ok" : rec.webhookError}`,
      auth,
    ),
    "selfqa",
  );
  authById.delete(rec.id);
  removeSelfQaPending(rec.id);
}

function finishRun(
  rec: SelfQaRecord,
  status: SelfQaStatus,
  exitCode?: number,
  error?: string,
): void {
  const project = deps.getProject(rec.projectId);
  const summary = project ? findLatestSummary(project.path) : {};
  rec.status = status;
  rec.finishedAt = Date.now();
  if (exitCode != null) rec.exitCode = exitCode;
  if (error) rec.error = redactCallbackSecrets(error);
  rec.summaryPath = summary.path;
  rec.summaryTail = summary.tail;
  rec.latestReportPath = project
    ? findLatestCycleReport(project.path)
    : undefined;
  runs.set(rec.id, rec);
  if (byProject.get(rec.projectId) === rec.id) {
    // keep mapping for status until next start
  }
  void deliverWebhook(rec);
}

let listening = false;
function ensureExitHook(): void {
  if (listening) return;
  listening = true;
  onSessionExit((sessionId, projectId, exitCode) => {
    const runId = byProject.get(projectId);
    if (!runId) return;
    const rec = runs.get(runId);
    if (!rec || rec.sessionId !== sessionId || rec.status !== "running") return;
    const status: SelfQaStatus =
      exitCode === 0
        ? "done"
        : exitCode === 2
          ? "blocked"
          : "error";
    finishRun(
      rec,
      status,
      exitCode,
      exitCode === 1
        ? "Self-QA exited with error"
        : exitCode === 2
          ? "Self-QA blocked (caps / repeat finding / guardrail)"
          : undefined,
    );
  });
}

export function buildSelfQaArgs(opts: {
  goal?: string;
  cycles?: number;
  maxMinutes?: number;
  testers?: number;
  dryRun?: boolean;
}): string[] {
  const args = ["--selfqa"];
  const goal = String(opts.goal || "").trim();
  if (goal) args.push("--goal", goal);
  args.push("--cycles", String(clampInt(opts.cycles, 3, 1, 20)));
  args.push("--max-minutes", String(clampInt(opts.maxMinutes, 90, 1, 24 * 60)));
  args.push("--testers", String(clampInt(opts.testers, 3, 1, 6)));
  if (opts.dryRun) args.push("--dry-run");
  return args;
}

export async function startSelfQa(
  opts: SelfQaStartOpts,
): Promise<SelfQaRecord & { session: SessionPublic }> {
  ensureExitHook();
  const projectId = String(opts.projectId || "").trim();
  if (!projectId) throw new Error("projectId required");
  const project = deps.getProject(projectId);
  if (!project) throw new Error(`project not found: ${projectId}`);

  const support = projectSupportsSelfQa(project);
  if (!support.ok) {
    throw new Error(support.message || "Self-QA not supported");
  }

  const active = projectHasActiveSelfQa(projectId);
  if (active) {
    throw new Error(
      `Project already has an active Self-QA session (${active.id}). Stop it before starting another.`,
    );
  }
  // Kill any stray selfqa PTYs
  killByProject(projectId, new Set(["selfqa"]));

  const cycles = clampInt(opts.cycles, 3, 1, 20);
  const maxMinutes = clampInt(opts.maxMinutes, 90, 1, 24 * 60);
  const testers = clampInt(opts.testers, 3, 1, 6);
  const dryRun = Boolean(opts.dryRun);
  const goal = String(opts.goal || "").trim() || undefined;
  const callbackUrl = normalizeCallbackUrl(opts.callbackUrl);
  const callbackAuth = resolveCallbackAuth(opts.callbackAuth);

  const scriptArgs = buildSelfQaArgs({
    goal,
    cycles,
    maxMinutes,
    testers,
    dryRun,
  });
  const buildSh = support.buildSh || resolve(project.path, "build.sh");

  const info = spawnShell({
    projectId,
    cwd: project.path,
    kind: "selfqa",
    title: "Self-QA",
    command: ["bash", buildSh, ...scriptArgs],
  });

  const rec: SelfQaRecord = {
    id: randomBytes(6).toString("hex"),
    projectId,
    sessionId: info.id,
    status: "running",
    goal,
    cycles,
    maxMinutes,
    testers,
    dryRun,
    startedAt: Date.now(),
    callbackUrl,
  };
  if (callbackUrl) {
    rec.callbackAuthExpected = Boolean(callbackAuth);
    if (callbackAuth) authById.set(rec.id, callbackAuth);
    try {
      persistSelfQaPending({
        jobId: rec.id,
        projectId,
        callbackUrl,
        startedAt: rec.startedAt,
        auth: callbackAuth,
      });
    } catch (e) {
      appendTrace(
        "error",
        `selfqa ${rec.id} failed to persist pending callback: ${
          e instanceof Error ? e.message : String(e)
        }`,
        "selfqa",
      );
    }
  }
  runs.set(rec.id, rec);
  byProject.set(projectId, rec.id);
  trimRuns();
  appendTrace(
    "info",
    `selfqa ${rec.id} start project=${projectId} session=${info.id}`,
    "selfqa",
  );

  const session: SessionPublic = {
    ...info,
    alive: true,
    label: info.title,
    cmdline: info.cmdline || ["bash", buildSh, ...scriptArgs],
  };
  return { ...publicRun(rec), session };
}

/**
 * Cancel a running Self-QA session: kill the PTY process tree, mark
 * cancelled, fire webhook if set, and release the per-project lock.
 */
export function cancelSelfQa(
  projectId: string,
  opts?: { runId?: string },
): {
  ok: boolean;
  killed: string[];
  selfqa?: SelfQaRecord | null;
} {
  const pid = String(projectId || "").trim();
  const wantId = String(opts?.runId || "").trim();
  const runId = wantId || byProject.get(pid);
  if (wantId) {
    const rec = runs.get(wantId);
    if (!rec) throw new Error(`selfqa run not found: ${wantId}`);
    if (rec.projectId !== pid) {
      throw new Error(`selfqa ${wantId} does not belong to project ${pid}`);
    }
  }
  // Mark cancelled before kill so the PTY exit hook cannot overwrite with error/done.
  let out: SelfQaRecord | null = null;
  let shouldFinish = false;
  if (runId) {
    const rec = runs.get(runId);
    if (rec && rec.status === "running") {
      rec.status = "cancelled";
      rec.error = "Cancelled by operator";
      runs.set(rec.id, rec);
      shouldFinish = true;
    } else if (rec) {
      out = publicRun(rec);
    }
  }
  const killed = killByProject(pid, new Set(["selfqa"]));
  if (shouldFinish && runId) {
    const rec = runs.get(runId);
    if (rec) {
      finishRun(rec, "cancelled", undefined, rec.error || "Cancelled by operator");
      out = publicRun(rec);
    }
  }
  return { ok: true, killed, selfqa: out };
}

/** @deprecated Prefer cancelSelfQa — same kill + cancelled webhook. */
export function stopSelfQa(projectId: string): {
  ok: boolean;
  killed: string[];
} {
  const r = cancelSelfQa(projectId);
  return { ok: r.ok, killed: r.killed };
}

export function getSelfQa(projectId: string): {
  supported: ReturnType<typeof projectSupportsSelfQa>;
  active: SelfQaRecord | null;
  latest?: SelfQaRecord | null;
  latestSummaryPath?: string;
  latestSummaryTail?: string;
  latestReportPath?: string;
  sessionOutput?: string;
} {
  const project = deps.getProject(projectId);
  const supported = project
    ? projectSupportsSelfQa(project)
    : { ok: false, message: "project not found" };
  const active = projectHasActiveSelfQa(projectId);
  const runId = byProject.get(projectId);
  const latest = runId ? runs.get(runId) || null : null;
  const summary = project ? findLatestSummary(project.path) : {};
  const report = project ? findLatestCycleReport(project.path) : undefined;
  let sessionOutput: string | undefined;
  const sid = active?.sessionId || latest?.sessionId;
  if (sid) {
    const out = readSessionOutput(sid);
    if (out) sessionOutput = out.output.slice(-12_000);
  }
  return {
    supported,
    active: active ? publicRun(active) : null,
    latest: latest ? publicRun(latest) : null,
    latestSummaryPath: summary.path,
    latestSummaryTail: summary.tail,
    latestReportPath: report,
    sessionOutput,
  };
}

export function listSelfQa(limit = 20): SelfQaRecord[] {
  return [...runs.values()]
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, Math.max(1, limit))
    .map(publicRun);
}

/** On Home Base restart: webhook interrupted for pending Self-QA callbacks. */
export async function recoverInterruptedSelfQaCallbacks(): Promise<{
  recovered: number;
  expired: number;
  lost: number;
}> {
  const now = Date.now();
  let recovered = 0;
  let expired = 0;
  let lost = 0;
  const keep: PendingCallbackRecord[] = [];
  for (const rec of loadSelfQaPending()) {
    if (now - (rec.startedAt || 0) > PENDING_MAX_AGE_MS) {
      expired++;
      continue;
    }
    const authResult = decryptPendingAuth(rec);
    if (rec.hasAuth && authResult.decryptFailed) {
      lost++;
      appendTrace(
        "warn",
        `selfqa pending callback ${rec.jobId} lost (decrypt failed)`,
        "selfqa",
      );
      continue;
    }
    const fake: SelfQaRecord = {
      id: rec.jobId,
      projectId: rec.projectId,
      sessionId: "",
      status: "interrupted",
      cycles: 0,
      maxMinutes: 0,
      testers: 0,
      dryRun: false,
      startedAt: rec.startedAt,
      finishedAt: now,
      error: INTERRUPTED_SUMMARY,
      callbackUrl: rec.callbackUrl,
      callbackAuthExpected: rec.hasAuth,
    };
    if (authResult.auth) authById.set(fake.id, authResult.auth);
    runs.set(fake.id, fake);
    await deliverWebhook(fake);
    recovered++;
  }
  saveSelfQaPending(keep);
  return { recovered, expired, lost };
}

/** Test helper */
export function _resetSelfQaForTests(): void {
  runs.clear();
  byProject.clear();
  authById.clear();
  deps = defaultDeps();
}
