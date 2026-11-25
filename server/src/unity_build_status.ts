/**
 * Per-project WebGL build status for the Apps Unity card (building / last error).
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { RUNTIME_DIR } from "./config";
import { onSessionExit, readSessionOutput } from "./pty";

export type UnityBuildState = "idle" | "building" | "ok" | "error";

export type UnityBuildStatus = {
  state: UnityBuildState;
  /** Short human message (error or last summary). */
  message?: string;
  /** Epoch ms of last state change. */
  at: number;
  sessionId?: string;
  jobId?: string;
};

const mem = new Map<string, UnityBuildStatus>();
const sessionToProject = new Map<string, string>();
let hooked = false;

function storePath(projectId: string): string {
  return join(RUNTIME_DIR, "unity_build", `${projectId}.json`);
}

function persist(projectId: string, status: UnityBuildStatus): void {
  mem.set(projectId, status);
  try {
    const dir = join(RUNTIME_DIR, "unity_build");
    mkdirSync(dir, { recursive: true });
    writeFileSync(storePath(projectId), `${JSON.stringify(status)}\n`, {
      mode: 0o600,
    });
  } catch {
    /* ignore */
  }
}

function load(projectId: string): UnityBuildStatus | undefined {
  const hit = mem.get(projectId);
  if (hit) return hit;
  try {
    const p = storePath(projectId);
    if (!existsSync(p)) return undefined;
    const raw = JSON.parse(readFileSync(p, "utf8")) as UnityBuildStatus;
    if (raw && typeof raw.at === "number") {
      mem.set(projectId, raw);
      return raw;
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

function clipMsg(msg: string, max = 240): string {
  const t = String(msg || "")
    .replace(/\x1b\[[0-9;]*m/g, "")
    .replace(/\r/g, "")
    .trim();
  return t.slice(0, max);
}

function hintFromSession(sessionId: string): string {
  try {
    const rec = readSessionOutput(sessionId);
    const raw = String(rec?.output || "")
      .replace(/\x1b\[[0-9;]*m/g, "")
      .replace(/\r/g, "")
      .trim();
    const lines = raw
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    const errLine =
      [...lines]
        .reverse()
        .find((l) => /error:|die |missing |failed|fatal|Unity not found/i.test(l)) ||
      lines[lines.length - 1] ||
      "";
    return clipMsg(errLine || "WebGL build failed");
  } catch {
    return "WebGL build failed";
  }
}

export function ensureUnityBuildStatusHook(): void {
  if (hooked) return;
  hooked = true;
  onSessionExit((sessionId, projectId, exitCode) => {
    const tracked = sessionToProject.get(sessionId);
    const pid = tracked || projectId;
    if (!pid) return;
    const cur = mem.get(pid);
    if (!cur || cur.state !== "building") {
      sessionToProject.delete(sessionId);
      return;
    }
    if (cur.sessionId && cur.sessionId !== sessionId) {
      sessionToProject.delete(sessionId);
      return;
    }
    sessionToProject.delete(sessionId);
    if (exitCode === 0) {
      persist(pid, {
        state: "ok",
        message: "WebGL build ok",
        at: Date.now(),
        sessionId,
      });
    } else {
      persist(pid, {
        state: "error",
        message: hintFromSession(sessionId),
        at: Date.now(),
        sessionId,
      });
    }
  });
}

export function markUnityBuildBuilding(
  projectId: string,
  opts: { sessionId?: string; jobId?: string } = {},
): UnityBuildStatus {
  ensureUnityBuildStatusHook();
  const id = String(projectId || "").trim();
  const status: UnityBuildStatus = {
    state: "building",
    message: "building",
    at: Date.now(),
    sessionId: opts.sessionId,
    jobId: opts.jobId,
  };
  if (opts.sessionId) sessionToProject.set(opts.sessionId, id);
  persist(id, status);
  return status;
}

export function markUnityBuildFinished(
  projectId: string,
  opts: { ok: boolean; message?: string; jobId?: string },
): UnityBuildStatus {
  ensureUnityBuildStatusHook();
  const id = String(projectId || "").trim();
  const status: UnityBuildStatus = {
    state: opts.ok ? "ok" : "error",
    message: clipMsg(
      opts.message || (opts.ok ? "WebGL build ok" : "WebGL build failed"),
    ),
    at: Date.now(),
    jobId: opts.jobId,
  };
  persist(id, status);
  return status;
}

export function getUnityBuildStatus(
  projectId: string,
): UnityBuildStatus | null {
  ensureUnityBuildStatusHook();
  const id = String(projectId || "").trim();
  if (!id) return null;
  return load(id) || null;
}

/** Test helper. */
export function _resetUnityBuildStatusForTests(): void {
  mem.clear();
  sessionToProject.clear();
}
