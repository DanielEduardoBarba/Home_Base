/**
 * Optional webhook when a project action's PTY session(s) exit.
 * Used by homebase_run_action (callbackUrl / callbackAuth backlog).
 */
import { randomBytes } from "node:crypto";
import {
  resolveCallbackAuth,
  redactCallbackSecrets,
} from "./cursor_jobs";
import { onSessionExit } from "./pty";
import { appendTrace } from "./trace";

type PendingActionCb = {
  id: string;
  projectId: string;
  actionId: string;
  sessionIds: Set<string>;
  remaining: Set<string>;
  exitCodes: Record<string, number>;
  callbackUrl: string;
  auth?: string;
  startedAt: number;
};

const pending = new Map<string, PendingActionCb>();
let hooked = false;

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

function ensureHook(): void {
  if (hooked) return;
  hooked = true;
  onSessionExit((sessionId, _projectId, exitCode) => {
    for (const cb of pending.values()) {
      if (!cb.remaining.has(sessionId)) continue;
      cb.remaining.delete(sessionId);
      cb.exitCodes[sessionId] = exitCode;
      if (cb.remaining.size === 0) {
        void deliver(cb);
        pending.delete(cb.id);
      }
    }
  });
}

async function deliver(cb: PendingActionCb): Promise<void> {
  const codes = Object.values(cb.exitCodes);
  const exitCode =
    codes.length === 0
      ? undefined
      : codes.some((c) => c !== 0)
        ? codes.find((c) => c !== 0)
        : 0;
  try {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "user-agent": "homebase-run-action/1",
      "x-homebase-action-callback": cb.id,
    };
    if (cb.auth) headers.authorization = cb.auth;
    const res = await fetch(cb.callbackUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        type: "homebase.run_action",
        action: {
          id: cb.id,
          projectId: cb.projectId,
          actionId: cb.actionId,
          sessionIds: [...cb.sessionIds],
          exitCodes: cb.exitCodes,
          exitCode,
          startedAt: cb.startedAt,
          finishedAt: Date.now(),
        },
      }),
      signal: AbortSignal.timeout(15_000),
    });
    appendTrace(
      res.ok ? "info" : "warn",
      redactCallbackSecrets(
        `run_action ${cb.actionId} webhook ${res.ok ? "ok" : `HTTP ${res.status}`}`,
        cb.auth,
      ),
      "action-callback",
    );
  } catch (e) {
    appendTrace(
      "warn",
      redactCallbackSecrets(
        `run_action ${cb.actionId} webhook ${
          e instanceof Error ? e.message : String(e)
        }`,
        cb.auth,
      ),
      "action-callback",
    );
  }
}

/** Watch session ids and POST callbackUrl when all have exited. */
export function watchActionSessions(opts: {
  projectId: string;
  actionId: string;
  sessionIds: string[];
  callbackUrl?: string;
  callbackAuth?: string;
}): { callbackId?: string; callbackUrl?: string } {
  const callbackUrl = normalizeCallbackUrl(opts.callbackUrl);
  if (!callbackUrl) return {};
  const ids = [...new Set(opts.sessionIds.filter(Boolean))];
  if (!ids.length) return { callbackUrl };
  ensureHook();
  const id = randomBytes(6).toString("hex");
  const auth = resolveCallbackAuth(opts.callbackAuth);
  pending.set(id, {
    id,
    projectId: opts.projectId,
    actionId: opts.actionId,
    sessionIds: new Set(ids),
    remaining: new Set(ids),
    exitCodes: {},
    callbackUrl,
    auth,
    startedAt: Date.now(),
  });
  return { callbackId: id, callbackUrl };
}

export function _resetActionCallbacksForTests(): void {
  pending.clear();
}
