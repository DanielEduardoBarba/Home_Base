import type { Project } from "./config";
import {
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
  VISION_GUIDANCE,
  ensureVisionWorkspace,
  visionHotkey,
  visionKey,
  visionPointer,
  visionScreenshot,
  visionStatus,
  visionType,
} from "./vision";
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
  let visionWorkspace = "";
  try {
    visionWorkspace = ensureVisionWorkspace();
  } catch {
    visionWorkspace = "";
  }
  const cwdNorm = (opts.cwd || "").replace(/\/+$/, "");
  const inVisionWs =
    Boolean(visionWorkspace) &&
    (cwdNorm === visionWorkspace || cwdNorm.endsWith("/.homebase"));
  const visionBit = inVisionWs
    ? `Vision workspace chat (cwd ${visionWorkspace || "~/.homebase"}): ${VISION_GUIDANCE} ` +
      `Use homebase_vision_screenshot then click/type/hotkey while Armed. `
    : `Vision (Linux X11 desktop): use homebase_vision_screenshot then homebase_vision_click/type/hotkey ` +
      `while the user has Armed desktop control in the Vision UI. ${VISION_GUIDANCE} `;
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
    visionBit +
    `When the task needs planning vs implementing (or Ask/Debug), call homebase_propose_mode ` +
    `so the user can Switch/Stay mid-chat — do not only narrate a mode change. ` +
    `Answer the user message below in a normal concise voice.\n---\n` +
    text
  );
}

async function visionTool(
  fn: () => Promise<Record<string, unknown>>,
): Promise<string> {
  try {
    return json(await fn());
  } catch (e) {
    return json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
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
    homebase_vision_status: {
      description:
        "Vision desktop status: X11 display, monitors, whether control is Armed, capture health. Linux only.",
      parameters: { type: "object", properties: {} },
      execute: async () => visionTool(() => visionStatus()),
    },
    homebase_vision_screenshot: {
      description:
        "Capture the Linux desktop (JPEG) via X11. Returns a filesystem path — Read that image " +
        "before clicking. Works while Vision is disarmed (look-only). Prefer after each GUI action.",
      parameters: {
        type: "object",
        properties: {
          monitor: {
            type: "number",
            description: "0 = all displays / primary region; else monitor index",
          },
          maxWidth: { type: "number", description: "Max encode width (default 1280)" },
          quality: { type: "number", description: "JPEG quality 30–85 (default 62)" },
        },
      },
      execute: async (args) =>
        visionTool(() =>
          visionScreenshot({
            monitor: args.monitor != null ? Number(args.monitor) : undefined,
            maxWidth: args.maxWidth != null ? Number(args.maxWidth) : undefined,
            quality: args.quality != null ? Number(args.quality) : undefined,
          }),
        ),
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
      description:
        "Remove a project from Home Base: stop sessions/ports, wipe chat runtime, drop registry entry (does not delete files on disk)",
      parameters: {
        type: "object",
        properties: { projectId: { type: "string" } },
        required: ["projectId"],
      },
      execute: async (args) => {
        // Dynamic import avoids a static cycle (cursor → homebase_tools).
        const { removeRegisteredProject } = await import("./project_remove");
        return json(removeRegisteredProject(String(args.projectId || "")));
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
    tools.homebase_vision_click = {
      description:
        "Click or move the X11 pointer (requires Vision Armed). Use normalized x,y in 0..1 " +
        "or px,py in monitor pixels. action=click|move|down|up|wheel. button: 0 left, 1 middle, 2 right.",
      parameters: {
        type: "object",
        properties: {
          x: { type: "number", description: "Normalized 0..1" },
          y: { type: "number", description: "Normalized 0..1" },
          px: { type: "number" },
          py: { type: "number" },
          action: { type: "string" },
          button: { type: "number" },
          deltaY: { type: "number", description: "For wheel" },
          monitor: { type: "number" },
        },
      },
      execute: async (args) =>
        visionTool(() =>
          visionPointer({
            ...args,
            action: String(args.action || "click"),
          }),
        ),
    };
    tools.homebase_vision_type = {
      description:
        "Type text into the focused X11 window (requires Vision Armed). ASCII/US-layout. " +
        "Prefer GUI apps via Vision; use Shell/Files/CLI when that is clearly better.",
      parameters: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
      execute: async (args) => visionTool(() => visionType(args)),
    };
    tools.homebase_vision_key = {
      description:
        "Press a key on the X11 display (requires Vision Armed). key: Enter, Escape, Tab, " +
        "Backspace, super, ctrl, a-z, F1… action: press|down|up.",
      parameters: {
        type: "object",
        properties: {
          key: { type: "string" },
          action: { type: "string" },
        },
        required: ["key"],
      },
      execute: async (args) => visionTool(() => visionKey(args)),
    };
    tools.homebase_vision_hotkey = {
      description:
        "Chord keys on X11 (requires Vision Armed). keys e.g. [\"ctrl\",\"c\"] or [\"super\",\"a\"] " +
        "for GNOME Activities. Prefer this over clicking OS chrome when possible.",
      parameters: {
        type: "object",
        properties: {
          keys: {
            type: "array",
            items: { type: "string" },
            description: 'e.g. ["super","a"] or ["ctrl","shift","t"]',
          },
        },
        required: ["keys"],
      },
      execute: async (args) => visionTool(() => visionHotkey(args)),
    };
  }

  void listSessions;
  void (null as unknown as Project);
  return tools;
}
