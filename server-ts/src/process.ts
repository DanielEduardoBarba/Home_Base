import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ActionDef, Project } from "./config";
import { killPortListeners, isPortListening } from "./ports";
import { killSession, listSessions, spawnShell, type SessionInfo } from "./pty";
import { appendTrace } from "./trace";

function resolveScript(project: Project, script: string): string {
  const abs = resolve(project.path, script);
  if (!abs.startsWith(resolve(project.path))) {
    throw new Error("Script escapes project directory");
  }
  return abs;
}

export function portsStatus(project: Project): Record<string, unknown>[] {
  return project.ports.map((p) => ({
    id: p.id,
    port: p.port,
    label: p.label || p.id,
    listening: isPortListening(p.port),
    health: p.health || null,
  }));
}

export function projectPublic(project: Project): Record<string, unknown> {
  return {
    id: project.id,
    name: project.name,
    path: project.path,
    exists: existsSync(project.path),
    ports: project.ports,
    actions: project.actions,
    portsStatus: portsStatus(project),
    sessions: listSessions(project.id),
    logs: tailLogs(project, 40),
    cursor: { configured: Boolean(process.env.CURSOR_API_KEY) },
  };
}

export function tailLogs(project: Project, lines = 80): string[] {
  const logPath = project.stateDir
    ? join(project.path, project.stateDir, "stack.log")
    : join(project.path, "stack.log");
  if (!existsSync(logPath)) return [];
  try {
    const text = readFileSync(logPath, "utf8");
    return text.trimEnd().split("\n").slice(-lines);
  } catch {
    return [];
  }
}

function advertiseEnv(): Record<string, string> {
  const host = (process.env.HOMEBASE_ADVERTISE_HOST || "").trim();
  const env: Record<string, string> = {};
  if (host) {
    env.HOMEBASE_ADVERTISE_HOST = host;
    env.REACT_NATIVE_PACKAGER_HOSTNAME = host;
    env.EXPO_PUBLIC_API_URL = `http://${host}`;
    env.NEXT_PUBLIC_API_URL = `http://${host}`;
  }
  return env;
}

export function runAction(
  project: Project,
  actionId: string,
  extraArgs: string[] = [],
): { type: string; session?: SessionInfo; sessions?: SessionInfo[] } {
  const action = project.actions.find((a) => a.id === actionId);
  if (!action) throw new Error(`Unknown action: ${actionId}`);

  if (action.type === "stop") {
    const killed = stopProject(project);
    return { type: "stop", sessions: killed.map((id) => ({ id } as SessionInfo)) };
  }

  if (action.type === "restart") {
    stopProject(project);
    const target = action.restartAction || action.id;
    return runAction(project, target, extraArgs);
  }

  if (action.type === "compose") {
    const sessions: SessionInfo[] = [];
    for (const id of action.compose) {
      const r = runAction(project, id, extraArgs);
      if (r.session) sessions.push(r.session);
      if (r.sessions) sessions.push(...r.sessions);
    }
    return { type: "compose", sessions };
  }

  return { type: "script", session: spawnActionPty(project, action, extraArgs) };
}

function spawnActionPty(
  project: Project,
  action: ActionDef,
  extraArgs: string[],
): SessionInfo {
  const script = resolveScript(project, action.script || "./script.sh");
  const args = [...action.args, ...extraArgs];
  const env = {
    ...advertiseEnv(),
    ...action.env,
  };
  appendTrace("info", `action ${project.id}/${action.id}`, "process");
  return spawnShell({
    projectId: project.id,
    cwd: project.path,
    kind: action.kind || "action",
    title: action.label || action.id,
    command: ["bash", script, ...args],
    env,
  });
}

export function stopProject(project: Project): string[] {
  const killed: string[] = [];
  for (const s of listSessions(project.id)) {
    if (killSession(s.id)) killed.push(s.id);
  }
  // pidfile
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
