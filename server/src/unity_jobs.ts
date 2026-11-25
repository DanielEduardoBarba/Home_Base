/**
 * Async Unity long-ops (WebGL build, batchmode tests) that must not block MCP.
 */
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { loadProjects, RUNTIME_DIR, type Project } from "./config";
import { runAction, stopProject } from "./process";
import { resolveSeatHome } from "./unity_paths";
import { resolveWebglBind } from "./unity_webgl_bind";
import { appendTrace } from "./trace";
import { redactUnityText } from "./unity";

export type UnityJobKind = "webgl_build" | "tests" | "screenshot";

export type UnityJobStatus =
  | "queued"
  | "running"
  | "done"
  | "error"
  | "cancelled";

export type UnityJob = {
  id: string;
  projectId: string;
  kind: UnityJobKind;
  status: UnityJobStatus;
  startedAt: number;
  finishedAt?: number;
  summary?: string;
  error?: string;
  result?: Record<string, unknown>;
};

const jobs = new Map<string, UnityJob>();
const MAX_JOBS = 80;

function trimJobs(): void {
  if (jobs.size <= MAX_JOBS) return;
  const sorted = [...jobs.values()].sort((a, b) => a.startedAt - b.startedAt);
  for (const j of sorted.slice(0, jobs.size - MAX_JOBS)) {
    jobs.delete(j.id);
  }
}

function newId(): string {
  return `uj_${randomBytes(6).toString("hex")}`;
}

export function getUnityJob(id: string): UnityJob | undefined {
  return jobs.get(String(id || "").trim());
}

export function listUnityJobs(limit = 20): UnityJob[] {
  return [...jobs.values()]
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, Math.min(50, Math.max(1, limit)));
}

function dirSizeBytes(root: string): number {
  let total = 0;
  const walk = (p: string) => {
    let entries: string[];
    try {
      entries = readdirSync(p);
    } catch {
      return;
    }
    for (const name of entries) {
      const full = join(p, name);
      try {
        const st = statSync(full);
        if (st.isDirectory()) walk(full);
        else total += st.size;
      } catch {
        /* ignore */
      }
    }
  };
  if (existsSync(root)) walk(root);
  return total;
}

function lastBuildLogTail(lines = 40): string {
  const home = resolveSeatHome();
  const log = join(home, ".cache/homebase-unity/webgl-build.log");
  if (!existsSync(log)) return "";
  try {
    const text = readFileSync(log, "utf8");
    return redactUnityText(text.split("\n").slice(-lines).join("\n"));
  } catch {
    return "";
  }
}

function webglPreviewInfo(project: Project): {
  url: string | null;
  port: number | null;
  sizeBytes: number;
  outDir: string;
} {
  const webgl = (project.ports || []).find((p) => p.id === "webgl");
  const port = webgl?.port ?? null;
  const outDir = join(project.path, "Builds/WebGL");
  const bind = resolveWebglBind();
  const host = bind === "0.0.0.0" ? "127.0.0.1" : bind;
  const url = port != null ? `http://${host}:${port}/` : null;
  return {
    url,
    port,
    sizeBytes: dirSizeBytes(outDir),
    outDir,
  };
}

async function runWebglBuildJob(job: UnityJob, project: Project): Promise<void> {
  job.status = "running";
  try {
    // Stop bridge so batchmode can take the project lock.
    const stop = (project.actions || []).find((a) => a.id === "stop");
    if (stop) {
      try {
        await runAction(project, "stop");
      } catch {
        try {
          stopProject(project);
        } catch {
          /* ignore */
        }
      }
    } else {
      try {
        stopProject(project);
      } catch {
        /* ignore */
      }
    }

    const build = (project.actions || []).find((a) => a.id === "webgl_build");
    if (!build) {
      throw new Error("project has no webgl_build action");
    }
    await runAction(project, "webgl_build");

    // Prefer static preview (does not fight the bridge) over live-webgl.
    const webgl = (project.actions || []).find(
      (a) =>
        a.id === "webgl_serve" || a.id === "webgl" || a.id === "webgl_live",
    );
    let previewStarted = false;
    if (webgl) {
      try {
        await runAction(project, webgl.id);
        previewStarted = true;
      } catch (e) {
        appendTrace(
          "warn",
          `unity job ${job.id}: preview restart failed: ${
            e instanceof Error ? e.message : String(e)
          }`,
          "unity",
        );
      }
    }

    // Restart bridge after build (project lock released).
    let bridgeRestarted = false;
    const editor = (project.actions || []).find((a) => a.id === "editor");
    if (editor) {
      try {
        await runAction(project, "editor");
        bridgeRestarted = true;
      } catch (e) {
        appendTrace(
          "warn",
          `unity job ${job.id}: bridge restart failed: ${
            e instanceof Error ? e.message : String(e)
          }`,
          "unity",
        );
      }
    }

    const preview = webglPreviewInfo(project);
    const logTail = lastBuildLogTail(30);
    const indexOk = existsSync(join(preview.outDir, "index.html"));
    const errHint =
      (!indexOk || /error|failed|exception/i.test(logTail)) &&
      preview.sizeBytes === 0
        ? logTail.slice(-500) || "WebGL build produced no Builds/WebGL/index.html"
        : null;

    job.status = errHint ? "error" : "done";
    job.finishedAt = Date.now();
    job.summary =
      job.status === "done"
        ? `WebGL build ok · ${Math.round(preview.sizeBytes / 1024)} KiB` +
          (bridgeRestarted ? " · bridge restarted" : "")
        : "WebGL build failed — see logTail / Build WebGL on the project card";
    job.error = errHint || undefined;
    job.result = {
      ...preview,
      previewStarted,
      bridgeRestarted,
      buildExists: indexOk,
      logTail: logTail.slice(-1200),
    };
  } catch (e) {
    job.status = "error";
    job.finishedAt = Date.now();
    job.error = redactUnityText(e instanceof Error ? e.message : String(e));
    job.summary = "WebGL build failed";
    job.result = { logTail: lastBuildLogTail(40) };
  }
}

async function runTestsJob(
  job: UnityJob,
  project: Project,
  opts: { mode?: string },
): Promise<void> {
  job.status = "running";
  try {
    const home = resolveSeatHome();
    const cache = join(home, ".cache/homebase-unity");
    mkdirSync(cache, { recursive: true });
    const mode = opts.mode === "PlayMode" ? "PlayMode" : "EditMode";
    const resultsXml = join(cache, `tests-${job.id}.xml`);
    const logFile = join(cache, `tests-${job.id}.log`);

    // Batchmode test run via Editor — use project's first editor binary path via script env.
    const { spawnSync } = await import("node:child_process");
    const { wrapArgvForSeat } = await import("./shell_env");
    const { resolveEditorBinary } = await import("./unity");
    const bin = resolveEditorBinary();
    if (!bin) throw new Error("Unity Editor binary not found");

    // Stop bridge first (project lock).
    try {
      await runAction(project, "stop");
    } catch {
      try {
        stopProject(project);
      } catch {
        /* ignore */
      }
    }

    const args = [
      "-batchmode",
      "-nographics",
      "-projectPath",
      project.path,
      "-runTests",
      "-testPlatform",
      mode,
      "-testResults",
      resultsXml,
      "-logFile",
      logFile,
      "-quit",
    ];
    const argv = wrapArgvForSeat([bin, ...args]);
    const r = spawnSync(argv[0]!, argv.slice(1), {
      encoding: "utf8",
      timeout: 600_000,
      env: {
        ...process.env,
        HOME: home,
      },
    });

    let summary = {
      mode,
      exitCode: r.status,
      resultsPath: existsSync(resultsXml) ? resultsXml : null,
      logPath: existsSync(logFile) ? logFile : null,
      passed: null as number | null,
      failed: null as number | null,
      total: null as number | null,
      logTail: "",
    };
    if (existsSync(logFile)) {
      try {
        summary.logTail = redactUnityText(
          readFileSync(logFile, "utf8").split("\n").slice(-40).join("\n"),
        );
      } catch {
        /* ignore */
      }
    }
    if (existsSync(resultsXml)) {
      try {
        const xml = readFileSync(resultsXml, "utf8");
        const total = xml.match(/\btotal="(\d+)"/i);
        const passed = xml.match(/\bpassed="(\d+)"/i);
        const failed = xml.match(/\bfailed="(\d+)"/i);
        if (total) summary.total = Number(total[1]);
        if (passed) summary.passed = Number(passed[1]);
        if (failed) summary.failed = Number(failed[1]);
      } catch {
        /* ignore */
      }
    }

    const failed = summary.failed != null && summary.failed > 0;
    job.status = r.status === 0 && !failed ? "done" : "error";
    job.finishedAt = Date.now();
    job.summary =
      summary.total != null
        ? `${mode}: ${summary.passed ?? "?"}/${summary.total} passed` +
          (failed ? ` (${summary.failed} failed)` : "")
        : `${mode} exit ${r.status}`;
    job.error =
      job.status === "error"
        ? redactUnityText((r.stderr || summary.logTail || "tests failed").slice(0, 500))
        : undefined;
    job.result = summary;
  } catch (e) {
    job.status = "error";
    job.finishedAt = Date.now();
    job.error = redactUnityText(e instanceof Error ? e.message : String(e));
    job.summary = "tests failed";
  }
}

/** Start an async Unity job; returns immediately with job id. */
export function startUnityJob(opts: {
  projectId: string;
  kind: UnityJobKind;
  mode?: string;
}): { ok: boolean; job?: UnityJob; error?: string } {
  const project = loadProjects().get(String(opts.projectId || "").trim());
  if (!project) return { ok: false, error: "project not found" };
  const active = [...jobs.values()].find(
    (j) =>
      j.projectId === project.id &&
      (j.status === "queued" || j.status === "running"),
  );
  if (active) {
    return {
      ok: false,
      error: `Unity job already active for this project (${active.id})`,
      job: active,
    };
  }

  const job: UnityJob = {
    id: newId(),
    projectId: project.id,
    kind: opts.kind,
    status: "queued",
    startedAt: Date.now(),
  };
  jobs.set(job.id, job);
  trimJobs();

  // Persist lightweight index (optional observability).
  try {
    const dir = join(RUNTIME_DIR, "unity_jobs");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${job.id}.json`), JSON.stringify(job) + "\n", {
      mode: 0o600,
    });
  } catch {
    /* ignore */
  }

  void (async () => {
    if (opts.kind === "webgl_build") await runWebglBuildJob(job, project);
    else if (opts.kind === "tests") await runTestsJob(job, project, { mode: opts.mode });
    else {
      job.status = "error";
      job.finishedAt = Date.now();
      job.error = `unsupported job kind: ${opts.kind}`;
    }
    try {
      const dir = join(RUNTIME_DIR, "unity_jobs");
      writeFileSync(join(dir, `${job.id}.json`), JSON.stringify(job) + "\n", {
        mode: 0o600,
      });
    } catch {
      /* ignore */
    }
  })();

  return { ok: true, job };
}

/** Test-only: clear in-memory jobs. */
export function _resetUnityJobsForTests(): void {
  jobs.clear();
}

/** Test-only: inject a finished job record. */
export function _putUnityJobForTests(job: UnityJob): void {
  jobs.set(job.id, job);
}
