import type { Project } from "./config";
import {
  deleteProject,
  listPresets,
  loadProjects,
  readVersion,
  upsertProjectFromInput,
} from "./config";
import { requestApproval } from "./approvals";
import {
  deleteAccessWidget,
  invokeAccessWidget,
  listAccessWidgets,
  upsertAccessWidget,
} from "./home_access";
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

export type HomebaseToolContext = {
  chatId?: string;
  getMode?: () => string;
};

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
    `Home Access panel widgets (buttons/toggles/sliders/gauges) use homebase_access_* tools ` +
    `or edit server/src/home_access.ts / the Home Access UI — leave the framework intact once wired. ` +
    `When the task needs planning vs implementing (or Ask/Debug), call homebase_propose_mode ` +
    `so the user can Switch/Stay mid-chat — do not only narrate a mode change. ` +
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
  ctx: HomebaseToolContext = {},
): Record<string, { description: string; parameters: Record<string, unknown>; execute: ToolFn }> {
  const resolvePid = (args: Record<string, unknown>) =>
    String(args.projectId || args.project_id || "").trim() || projectId;

  const tools: Record<
    string,
    { description: string; parameters: Record<string, unknown>; execute: ToolFn }
  > = {
    homebase_propose_mode: {
      description:
        "Ask the user to switch chat mode mid-conversation (agent|ask|plan|debug). " +
        "Shows a Switch/Stay card; waits for their decision. Use when planning vs implementing " +
        "or when Ask/Debug fits better — like Cursor SwitchMode.",
      parameters: {
        type: "object",
        properties: {
          mode: {
            type: "string",
            description: "Target mode: agent | ask | plan | debug",
          },
          reason: {
            type: "string",
            description: "Short reason shown on the Switch/Stay card",
          },
        },
        required: ["mode"],
      },
      execute: async (args) => {
        const mode = String(args.mode || "").toLowerCase();
        if (!["agent", "ask", "plan", "debug"].includes(mode)) {
          return json({ ok: false, error: "mode must be agent|ask|plan|debug" });
        }
        const current = ctx.getMode?.() || "agent";
        if (current === mode) {
          return json({ ok: true, mode, unchanged: true, message: `Already in ${mode}` });
        }
        const reason = String(args.reason || `Switch to ${mode}?`);
        const decision = await requestApproval({
          kind: "mode_switch",
          tool: mode,
          detail: reason,
          command: `mode:${current}->${mode}`,
        });
        if (decision.permission !== "allow") {
          return json({
            ok: false,
            mode: current,
            denied: true,
            message: `User stayed on ${current}`,
          });
        }
        const { applyChatMode } = await import("./cursor");
        const chatId = ctx.chatId || "";
        if (!chatId) {
          return json({
            ok: false,
            error: "No chatId in tool context",
            mode: current,
          });
        }
        const applied = applyChatMode({
          projectId,
          chatId,
          mode,
          reason,
        });
        return json({
          ok: applied.ok,
          mode: applied.mode,
          previous: applied.previous,
          message: `Switched ${applied.previous} → ${applied.mode}`,
        });
      },
    },
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
    homebase_list_presets: {
      description:
        "List project presets (templates with ports/actions). Use with homebase_project_upsert.",
      parameters: { type: "object", properties: {} },
      execute: async () => json({ presets: listPresets() }),
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
    homebase_access_list: {
      description:
        "List Home Access panel widgets (button/toggle/slider/gauge) and their hooks",
      parameters: { type: "object", properties: {} },
      execute: async () => json({ widgets: listAccessWidgets() }),
    },
  };

  if (!readonly) {
    tools.homebase_project_upsert = {
      description:
        "Add or update a Home Base project. Pass absolute path; optional preset (example|homebase), id, name, ports, actions.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          preset: { type: "string" },
          id: { type: "string" },
          name: { type: "string" },
          ports: { type: "array" },
          actions: { type: "array" },
        },
        required: ["path"],
      },
      execute: async (args) => {
        try {
          const project = upsertProjectFromInput({
            path: String(args.path || ""),
            preset: args.preset ? String(args.preset) : undefined,
            id: args.id ? String(args.id) : undefined,
            name: args.name ? String(args.name) : undefined,
            ports: Array.isArray(args.ports) ? args.ports : undefined,
            actions: Array.isArray(args.actions) ? args.actions : undefined,
          });
          return json({ ok: true, project: await projectPublic(project) });
        } catch (e) {
          return json({
            error: e instanceof Error ? e.message : String(e),
          });
        }
      },
    };
    tools.homebase_project_delete = {
      description: "Remove a project from Home Base (does not delete files on disk)",
      parameters: {
        type: "object",
        properties: { projectId: { type: "string" } },
        required: ["projectId"],
      },
      execute: async (args) => {
        const id = String(args.projectId || "");
        return json({ ok: deleteProject(id), id });
      },
    };
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
    tools.homebase_access_upsert = {
      description:
        "Create or update a Home Access widget. kind=button|toggle|slider|gauge. " +
        "Optional group (section) and hook.detailPath (gauge subtitle from JSON). " +
        "hook.type=script|http|websocket|static. Templates: {{value}} {{on}} {{json}}.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string" },
          kind: { type: "string" },
          label: { type: "string" },
          description: { type: "string" },
          group: { type: "string" },
          order: { type: "number" },
          value: {},
          min: { type: "number" },
          max: { type: "number" },
          step: { type: "number" },
          unit: { type: "string" },
          hook: { type: "object" },
        },
        required: ["kind", "label"],
      },
      execute: async (args) =>
        json({ widget: upsertAccessWidget(args as Record<string, unknown>) }),
    };
    tools.homebase_access_delete = {
      description: "Delete a Home Access widget by id",
      parameters: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      },
      execute: async (args) => {
        const id = String(args.id || "");
        return json({ ok: deleteAccessWidget(id), id });
      },
    };
    tools.homebase_access_invoke = {
      description:
        "Invoke a Home Access widget (button press, set toggle/slider, refresh gauge)",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string" },
          value: {},
        },
        required: ["id"],
      },
      execute: async (args) =>
        json({
          widget: await invokeAccessWidget(String(args.id || ""), {
            value: args.value,
          }),
        }),
    };
  }

  void listSessions;
  void (null as unknown as Project);
  return tools;
}
