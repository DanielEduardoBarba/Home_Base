import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RUNTIME_DIR, ensureRuntimeDirs } from "./config";

const SECRET_PATH = join(RUNTIME_DIR, "hook_secret");

let policy: "ask" | "auto" = "ask";

type Pending = {
  id: string;
  kind: string;
  tool: string;
  detail: string;
  command?: string;
  cwd?: string;
  agentId?: string;
  createdAt: number;
  resolve: (r: {
    permission: string;
    user_message: string;
    agent_message: string;
  }) => void;
  timer: ReturnType<typeof setTimeout>;
};

const pending = new Map<string, Pending>();

export function ensureHookSecret(): string {
  ensureRuntimeDirs();
  mkdirSync(RUNTIME_DIR, { recursive: true });
  if (existsSync(SECRET_PATH)) {
    const val = readFileSync(SECRET_PATH, "utf8").trim();
    if (val) return val;
  }
  const val = randomBytes(24).toString("hex");
  writeFileSync(SECRET_PATH, val, { mode: 0o600 });
  chmodSync(SECRET_PATH, 0o600);
  return val;
}

export function verifySecret(provided: string): boolean {
  const expected = ensureHookSecret();
  return Boolean(provided) && provided === expected;
}

export function getPolicy(): "ask" | "auto" {
  return policy;
}

export function setPolicy(p: string): "ask" | "auto" {
  policy = p === "auto" ? "auto" : "ask";
  return policy;
}

export function listPending(): Array<{
  id: string;
  kind: string;
  tool: string;
  detail: string;
  command?: string;
  cwd?: string;
  agentId?: string;
  createdAt: number;
}> {
  return [...pending.values()].map(
    ({ id, kind, tool, detail, command, cwd, agentId, createdAt }) => ({
      id,
      kind,
      tool,
      detail,
      command,
      cwd,
      agentId,
      createdAt,
    }),
  );
}

export function resolveApproval(id: string, allow: boolean): boolean {
  const p = pending.get(id);
  if (!p) return false;
  clearTimeout(p.timer);
  pending.delete(id);
  p.resolve(
    allow
      ? {
          permission: "allow",
          user_message: "Allowed in Home Base Chat",
          agent_message: "Allowed",
        }
      : {
          permission: "deny",
          user_message: "Denied in Home Base Chat",
          agent_message: "Denied by user",
        },
  );
  return true;
}

/** Ask Chat UI when listeners exist; auto-allow when policy is auto or nobody is watching. */
export async function requestApproval(opts: {
  kind: string;
  tool: string;
  detail: string;
  command?: string;
  cwd?: string;
  agentId?: string;
}): Promise<{ permission: string; user_message: string; agent_message: string }> {
  // Mode switches must always get an explicit Switch/Stay — never auto-run.
  const forceAsk = opts.kind === "mode_switch";

  if (policy === "auto" && !forceAsk) {
    return {
      permission: "allow",
      user_message: "Auto-run tools enabled",
      agent_message: "Auto-run tools enabled",
    };
  }

  // Lazy import avoids circular init with cursor.ts
  const { cursorSubscriberCount, broadcastAllCursor } = await import("./cursor");
  if (cursorSubscriberCount() === 0 && !forceAsk) {
    return {
      permission: "allow",
      user_message: "No Chat listener — allowed (ask policy fail-open)",
      agent_message: "Allowed without UI listener",
    };
  }
  if (cursorSubscriberCount() === 0 && forceAsk) {
    return {
      permission: "deny",
      user_message: "No Chat listener — cannot confirm mode switch",
      agent_message: "Denied — open Chat to Switch/Stay",
    };
  }

  const id = randomBytes(8).toString("hex");
  const createdAt = Date.now() / 1000;
  const payload = {
    type: "approval",
    id,
    kind: opts.kind || "tool",
    tool: opts.tool || "tool",
    detail: opts.detail || "",
    command: opts.command,
    cwd: opts.cwd,
    agentId: opts.agentId,
    createdAt,
  };
  broadcastAllCursor(payload);

  return await new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      broadcastAllCursor({ type: "approval-resolved", id, timedOut: true });
      resolve({
        permission: "deny",
        user_message: "Approval timed out",
        agent_message: "Denied — approval timed out",
      });
    }, 560_000);
    pending.set(id, {
      id,
      kind: String(opts.kind || "tool"),
      tool: String(opts.tool || "tool"),
      detail: String(opts.detail || ""),
      command: opts.command,
      cwd: opts.cwd,
      agentId: opts.agentId,
      createdAt,
      resolve,
      timer,
    });
  });
}
