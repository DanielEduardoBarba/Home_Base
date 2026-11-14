import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { RUNTIME_DIR, type ActionDef, type Project } from "./config";
import { watchActionSessions } from "./action_callbacks";
import { projectLanEnv } from "./network";
import { homebaseListenPort, killPortListeners, isPortListening } from "./ports";
import {
  killByProject,
  listSessions,
  spawnShell,
  type SessionPublic,
} from "./pty";
import { appendTrace } from "./trace";
import {
  buildSelfQaArgs,
  projectHasActiveSelfQa,
  projectSupportsSelfQa,
  startSelfQa,
} from "./selfqa";

export type RunActionOpts = {
  extraArgs?: string[];
  callbackUrl?: string;
  callbackAuth?: string;
  /** Self-QA options when actionId is selfqa (also accepted via MCP homebase_selfqa). */
  selfqa?: {
    goal?: string;
    cycles?: number;
    maxMinutes?: number;
    testers?: number;
    dryRun?: boolean;
  };
};

function resolveScript(project: Project, script: string): string {
  const abs = resolve(project.path, script);
  if (!abs.startsWith(resolve(project.path))) {
    throw new Error("Script escapes project directory");
  }
  return abs;
}

async function probeHealth(
  port: number,
  path: string,
): Promise<{ ok: boolean; url: string; status: number | null }> {
  const url = `http://127.0.0.1:${port}${path}`;
  if (port === homebaseListenPort() || port === 8888) {
    return { ok: true, url, status: 200 };
  }
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1000);
    const r = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    return { ok: r.status < 500, url, status: r.status };
  } catch {
    return { ok: false, url, status: null };
  }
}

export async function portsStatus(
  project: Project,
): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for (const p of project.ports) {
    const up = isPortListening(p.port);
    let health: Record<string, unknown> | null = null;
    if (up && p.health) {
      health = await probeHealth(p.port, p.health);
    }
    out.push({
      id: p.id,
      port: p.port,
      label: p.label || p.id,
      up,
      listening: up,
      health,
    });
  }
  return out;
}

export async function projectPublic(
  project: Project,
): Promise<Record<string, unknown>> {
  return {
    id: project.id,
    name: project.name,
    path: project.path,
    exists: existsSync(project.path),
    ports: project.ports,
    actions: project.actions,
    portsStatus: await portsStatus(project),
    sessions: listSessions(project.id),
    logs: tailLogs(project, 40),
    cursor: { configured: Boolean(process.env.CURSOR_API_KEY) },
  };
}

export function tailLogs(project: Project, lines = 80): string[] {
  const stackPath = project.stateDir
    ? join(project.path, project.stateDir, "stack.log")
    : join(project.path, "stack.log");
  const activityPath = join(RUNTIME_DIR, "project-logs", `${project.id}.log`);
  const chunks: string[] = [];
  for (const logPath of [stackPath, activityPath]) {
    if (!existsSync(logPath)) continue;
    try {
      const text = readFileSync(logPath, "utf8");
      chunks.push(...text.trimEnd().split("\n").filter(Boolean));
    } catch {
      /* ignore */
    }
  }
  return chunks.slice(-lines);
}

function advertiseEnv(project: Project): Record<string, string> {
  return projectLanEnv(project.ports.map((p) => ({ id: p.id, port: p.port })));
}

async function waitForComposeGate(
  project: Project,
  timeoutSec = 75,
): Promise<{ ready: boolean; waited: boolean }> {
  let prefer = project.ports.filter((p) => p.id === "api");
  if (!prefer.length) {
    prefer = project.ports.filter((p) => p.id !== "expo").slice(0, 1);
  }
  if (!prefer.length) return { ready: true, waited: false };

  const deadline = Date.now() + timeoutSec * 1000;
  while (Date.now() < deadline) {
    let ready = true;
    for (const p of prefer) {
      if (!isPortListening(p.port)) {
        ready = false;
        break;
      }
      if (p.health) {
        const h = await probeHealth(p.port, p.health);
        if (!h.ok) {
          ready = false;
          break;
        }
      }
    }
    if (ready) return { ready: true, waited: true };
    await Bun.sleep(1000);
  }
  return { ready: false, waited: true };
}

export async function runAction(
  project: Project,
  actionId: string,
  extraArgsOrOpts: string[] | RunActionOpts = [],
): Promise<{
  type: string;
  session?: SessionPublic;
  sessions?: SessionPublic[];
  gate?: { ready: boolean; waited: boolean };
  selfqa?: Record<string, unknown>;
  callbackId?: string;
  callbackUrl?: string;
}> {
  const opts: RunActionOpts = Array.isArray(extraArgsOrOpts)
    ? { extraArgs: extraArgsOrOpts }
    : extraArgsOrOpts || {};
  const extraArgs = opts.extraArgs || [];

  // Built-in Self-QA even when the project JSON lacks a selfqa action row.
  if (actionId === "selfqa") {
    const support = projectSupportsSelfQa(project);
    if (!support.ok) {
      throw new Error(support.message || "Self-QA not supported");
    }
    if (projectHasActiveSelfQa(project.id)) {
      throw new Error(
        "Project already has an active Self-QA session. Stop it before starting another.",
      );
    }
    const started = await startSelfQa({
      projectId: project.id,
      goal: opts.selfqa?.goal,
      cycles: opts.selfqa?.cycles,
      maxMinutes: opts.selfqa?.maxMinutes,
      testers: opts.selfqa?.testers,
      dryRun: opts.selfqa?.dryRun,
      callbackUrl: opts.callbackUrl,
      callbackAuth: opts.callbackAuth,
      source: "action",
    });
    const { session, ...selfqa } = started;
    return { type: "selfqa", session, selfqa };
  }

  const action = project.actions.find((a) => a.id === actionId);
  if (!action) throw new Error(`Unknown action: ${actionId}`);

  if (action.type === "stop") {
    const killed = stopProject(project);
    return {
      type: "stop",
      sessions: killed.map((id) => ({ id } as SessionPublic)),
    };
  }

  if (action.type === "restart") {
    stopProject(project);
    const target = action.restartAction || action.id;
    return runAction(project, target, opts);
  }

  if (action.type === "compose") {
    const ids = action.compose || [];
    if (!ids.length) {
      throw new Error(`Action ${action.id} type=compose needs compose: [actionId,…]`);
    }
    const sessions: SessionPublic[] = [];
    let gate: { ready: boolean; waited: boolean } | undefined;
    for (let i = 0; i < ids.length; i++) {
      const aid = ids[i]!;
      const target = project.actions.find((a) => a.id === aid);
      if (!target) throw new Error(`Unknown compose action: ${aid}`);
      if (target.type === "compose") {
        throw new Error("Nested compose actions are not supported");
      }
      // Do not fan out callbacks to every compose step — only the outer call.
      const stepOpts: RunActionOpts = { extraArgs: opts.extraArgs };
      const r = await runAction(project, aid, stepOpts);
      if (r.session) sessions.push(r.session);
      if (r.sessions) sessions.push(...r.sessions);
      if (target.kind === "run" && i < ids.length - 1) {
        gate = await waitForComposeGate(project);
        if (!gate.ready) {
          appendTrace(
            "warn",
            `${project.id}: compose gate not ready — starting next step anyway`,
            "process",
          );
        }
      }
    }
    const watched = watchActionSessions({
      projectId: project.id,
      actionId,
      sessionIds: sessions.map((s) => s.id),
      callbackUrl: opts.callbackUrl,
      callbackAuth: opts.callbackAuth,
    });
    return {
      type: "compose",
      sessions,
      gate,
      callbackId: watched.callbackId,
      callbackUrl: watched.callbackUrl,
    };
  }

  // Configured action id selfqa with kind selfqa / args --selfqa
  if (
    action.id === "selfqa" ||
    action.kind === "selfqa" ||
    action.args.includes("--selfqa")
  ) {
    const support = projectSupportsSelfQa(project);
    if (!support.ok) {
      throw new Error(support.message || "Self-QA not supported");
    }
    const started = await startSelfQa({
      projectId: project.id,
      goal: opts.selfqa?.goal,
      cycles: opts.selfqa?.cycles,
      maxMinutes: opts.selfqa?.maxMinutes,
      testers: opts.selfqa?.testers,
      dryRun: opts.selfqa?.dryRun,
      callbackUrl: opts.callbackUrl,
      callbackAuth: opts.callbackAuth,
      source: "action",
    });
    const { session, ...selfqa } = started;
    return { type: "selfqa", session, selfqa };
  }

  const session = spawnActionPty(project, action, extraArgs);
  const watched = watchActionSessions({
    projectId: project.id,
    actionId,
    sessionIds: [session.id],
    callbackUrl: opts.callbackUrl,
    callbackAuth: opts.callbackAuth,
  });
  return {
    type: "script",
    session,
    callbackId: watched.callbackId,
    callbackUrl: watched.callbackUrl,
  };
}

function spawnActionPty(
  project: Project,
  action: ActionDef,
  extraArgs: string[],
): SessionPublic {
  const kind =
    action.kind === "run" ||
    action.kind === "expo" ||
    action.kind === "ship" ||
    action.kind === "selfqa" ||
    action.kind === "action"
      ? action.kind
      : "action";
  // Replace prior sessions of same kind so Start is idempotent.
  if (kind === "run" || kind === "expo" || kind === "selfqa") {
    if (kind === "selfqa" && projectHasActiveSelfQa(project.id)) {
      throw new Error(
        "Project already has an active Self-QA session. Stop it before starting another.",
      );
    }
    killByProject(project.id, new Set([kind]));
  }

  const script = resolveScript(project, action.script || "./script.sh");
  let args = [...action.args, ...extraArgs];
  // If the preset only has --selfqa, allow callers to pass structured opts via extraArgs only.
  if (action.kind === "selfqa" && !args.some((a) => a === "--selfqa")) {
    args = [...buildSelfQaArgs({}), ...extraArgs];
  }
  const lan = advertiseEnv(project);
  const env = {
    ...lan,
    ...action.env,
  };
  appendTrace(
    "info",
    `action ${project.id}/${action.id} advertise=${lan.HOMEBASE_ADVERTISE_HOST || "none"}`,
    "process",
  );
  const info = spawnShell({
    projectId: project.id,
    cwd: project.path,
    kind,
    title: action.label || action.id,
    command: ["bash", script, ...args],
    env,
  });
  return {
    ...info,
    alive: true,
    label: info.title,
    cmdline: info.cmdline || ["bash", script, ...args],
  };
}

/** Stop managed run/expo/ship/action/selfqa PTYs + pidfile + port listeners. Keep Shell tab PTYs. */
export function stopProject(project: Project): string[] {
  const killed = killByProject(
    project.id,
    new Set(["run", "expo", "ship", "action", "selfqa"]),
  );
  const pidFile = project.stateDir
    ? join(project.path, project.stateDir, "devall.pids")
    : join(project.path, "devall.pids");
  if (existsSync(pidFile)) {
    try {
      for (const line of readFileSync(pidFile, "utf8").split("\n")) {
        const pid = Number(line.trim());
        if (pid > 1) {
          try {
            process.kill(pid, "SIGTERM");
            killed.push(String(pid));
          } catch {
            /* ignore */
          }
        }
      }
    } catch {
      /* ignore */
    }
  }
  for (const p of project.ports) {
    killed.push(...killPortListeners(p.port));
  }
  return killed;
}
