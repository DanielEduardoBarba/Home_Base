import type { Project } from "./config";
import { loadProjects, readVersion } from "./config";
import { listNotifications, pushNotification } from "./notifications";
import { projectPublic, runAction, stopProject, tailLogs } from "./process";
import { listSessions } from "./pty";
import { restartHomebased, systemStatus } from "./system";
import {
  restartWireguardIface,
  startWireguard,
  stopWireguard,
  wireguardStatus,
} from "./wireguard";

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
    `To redeploy this control plane from Chat, run ./build.sh --deploy in the Home Base ` +
    `repo (it auto-schedules a detached systemd job so restart does not kill the deploy). ` +
    `Prefer homebase_restart_homebased over a raw systemctl restart. ` +
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
        const projects = await Promise.all(
          [...loadProjects().values()].map(async (p) => ({
            ...(await projectPublic(p)),
            active: p.id === projectId,
          })),
        );
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
          ...(await projectPublic(p)),
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
    homebase_wireguard_status: {
      description:
        "WireGuard VPN install/setup status, peers, and client list (no private keys)",
      parameters: { type: "object", properties: {} },
      execute: async () => json(await wireguardStatus()),
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
        return json(await runAction(p, actionId));
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
    tools.homebase_restart_homebased = {
      description:
        "Schedule a detached restart of homebased.service (survives self-stop; do not use raw systemctl restart from inside Home Base)",
      parameters: { type: "object", properties: {} },
      execute: async () => json(restartHomebased()),
    };
    tools.homebase_wireguard_control = {
      description: "Start, stop, or restart the WireGuard VPN interface",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", description: "start | stop | restart" },
          iface: { type: "string" },
        },
        required: ["action"],
      },
      execute: async (args) => {
        const action = String(args.action || "").toLowerCase();
        const iface = args.iface ? String(args.iface) : undefined;
        if (action === "start") return json(startWireguard(iface));
        if (action === "stop") return json(stopWireguard(iface));
        if (action === "restart") return json(restartWireguardIface(iface));
        return json({ error: "action must be start, stop, or restart" });
      },
    };
  }

  void listSessions;
  void (null as unknown as Project);
  return tools;
}
