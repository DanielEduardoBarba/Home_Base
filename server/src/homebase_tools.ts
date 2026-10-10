import type { Project } from "./config";
import { loadProjects, readVersion } from "./config";
import { listNotifications, pushNotification } from "./notifications";
import { projectPublic, runAction, stopProject, tailLogs } from "./process";
import { listSessions } from "./pty";
import { systemStatus } from "./system";

const CONTEXT_MARKER = "[Home Base context]";

export function wrapPrompt(
  prompt: string,
  projectId: string,
  opts: { chatId?: string; cwd?: string } = {},
): string {
  const text = (prompt || "").trim();
  if (text.startsWith(CONTEXT_MARKER)) return text;
  const projects = loadProjects();
  const p = projects.get(projectId);
  const name = p?.name || projectId;
  const path = p?.path || "?";
  const cwdBit = opts.cwd ? ` · cwd ${opts.cwd}` : "";
  return (
    `${CONTEXT_MARKER}\n` +
    `Private metadata (do not quote, paraphrase, or repeat):\n` +
    `UI=Home Base v${readVersion()} (not Cursor IDE) · ` +
    `project ${name} (${projectId}) @ ${path} · chat ${opts.chatId || "default"}${cwdBit}. ` +
    `For control-plane ops use homebase_* tools only; code/file work uses normal tools. ` +
    `Answer the user message below in a normal concise voice.\n---\n` +
    text
  );
}

type ToolFn = (args: Record<string, unknown>) => Promise<string> | string;

function json(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

export function buildHomebaseTools(
  projectId: string,
  readonly = false,
): Record<string, { description: string; parameters: Record<string, unknown>; execute: ToolFn }> {
  const resolvePid = (args: Record<string, unknown>) =>
    String(args.projectId || args.project_id || "").trim() || projectId;

  const tools: Record<
    string,
    { description: string; parameters: Record<string, unknown>; execute: ToolFn }
  > = {
    homebase_list_projects: {
      description: "List Home Base projects with ports and sessions",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        const projects = [...loadProjects().values()].map((p) => ({
          ...projectPublic(p),
          active: p.id === projectId,
        }));
        return json({ projects, activeProjectId: projectId });
      },
    },
    homebase_project_status: {
      description: "Status for one project (ports, sessions, recent logs)",
      parameters: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          logLines: { type: "number" },
        },
      },
      execute: async (args) => {
        const pid = resolvePid(args);
        const p = loadProjects().get(pid);
        if (!p) return json({ error: "project not found" });
        return json({
          ...projectPublic(p),
          logs: tailLogs(p, Number(args.logLines || 40)),
        });
      },
    },
    homebase_notifications: {
      description: "List recent Home Base notifications",
      parameters: {
        type: "object",
        properties: { limit: { type: "number" } },
      },
      execute: async (args) =>
        json(listNotifications({ limit: Number(args.limit || 20) })),
    },
    homebase_system_status: {
      description: "Homebased unit + WireGuard interfaces",
      parameters: { type: "object", properties: {} },
      execute: async () => json(systemStatus()),
    },
  };

  if (!readonly) {
    tools.homebase_run_action = {
      description: "Run a configured project action (script/compose)",
      parameters: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          actionId: { type: "string" },
        },
        required: ["actionId"],
      },
      execute: async (args) => {
        const pid = resolvePid(args);
        const p = loadProjects().get(pid);
        if (!p) return json({ error: "project not found" });
        const actionId = String(args.actionId || "");
        return json(runAction(p, actionId));
      },
    };
    tools.homebase_stop_project = {
      description: "Stop project sessions and listeners on configured ports",
      parameters: {
        type: "object",
        properties: { projectId: { type: "string" } },
      },
      execute: async (args) => {
        const pid = resolvePid(args);
        const p = loadProjects().get(pid);
        if (!p) return json({ error: "project not found" });
        return json({ killedSessions: stopProject(p) });
      },
    };
    tools.homebase_notify = {
      description: "Push a notification into the Home Base inbox",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          body: { type: "string" },
          level: { type: "string" },
        },
        required: ["title"],
      },
      execute: async (args) =>
        json(
          pushNotification(String(args.title || ""), String(args.body || ""), {
            level: String(args.level || "info"),
            category: "agent",
          }),
        ),
    };
  }

  void listSessions;
  void (null as unknown as Project);
  return tools;
}
