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
import { systemStatus } from "./system";
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
import { wireguardStatus } from "./wireguard";

const CONTEXT_MARKER = "[Home Base context]";

export type HomebaseToolSurface = "cursor" | "mcp";

export type HomebaseToolContext = {
  chatId?: string;
  getMode?: () => string;
};

export type HomebaseToolDef = {
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>) => Promise<string> | string;
};

/** Security / Settings controls — human GUI only (never AI / MCP). */
export const AI_DENIED_TOOLS = [
  "homebase_wireguard_control",
  "homebase_restart_homebased",
] as const;

export const AI_DENIED_TOOL_SET = new Set<string>(AI_DENIED_TOOLS);

/** Cursor-chat-only (needs Switch/Stay UI). */
export const CURSOR_ONLY_TOOLS = new Set(["homebase_propose_mode"]);

export const HUMAN_ONLY_CAPABILITIES = [
  "WireGuard start / stop / restart / install / clients",
  "Cloudflare Tunnel lifecycle",
  "Restart homebased",
  "Password, Share QR, App PIN, sudo vault, Cursor API key",
  "Email alerts (Resend / SMTP) — suspicious auth + AI-away only",
  "MCP Server enable / disable, feature toggles, and token mint / revoke",
  "Activity history audit (Web + MCP)",
  "Vision Arm / Disarm",
  "System soft / hard reset",
] as const;

/** Fine-tunable MCP feature groups (master toggle is separate). */
export type McpFeatureId =
  | "projects"
  | "notifications"
  | "status"
  | "homeAccess"
  | "vision"
  | "presence";

export type McpFeatures = Record<McpFeatureId, boolean>;

export const MCP_FEATURE_DEFAULTS: McpFeatures = {
  projects: true,
  notifications: true,
  status: true,
  homeAccess: true,
  vision: false,
  presence: true,
};

export const MCP_FEATURE_META: {
  id: McpFeatureId;
  label: string;
  hint: string;
  defaultOn: boolean;
}[] = [
  {
    id: "projects",
    label: "Projects & actions",
    hint: "List / upsert / delete projects, run actions, stop, Cursor job handoff, safe git",
    defaultOn: true,
  },
  {
    id: "notifications",
    label: "Notifications",
    hint: "List inbox + push agent notifications",
    defaultOn: true,
  },
  {
    id: "status",
    label: "System status",
    hint: "Read-only homebased + WireGuard status (no control)",
    defaultOn: true,
  },
  {
    id: "homeAccess",
    label: "Home Access",
    hint: "List / upsert / delete / invoke panel widgets",
    defaultOn: true,
  },
  {
    id: "vision",
    label: "Vision desktop",
    hint: "Screenshot + Armed pointer/keyboard (off by default)",
    defaultOn: false,
  },
  {
    id: "presence",
    label: "Desktop presence",
    hint: "Show AI character on operator desktop + chat with the human",
    defaultOn: true,
  },
];

export const MCP_TOOL_FEATURE: Record<string, McpFeatureId> = {
  homebase_list_projects: "projects",
  homebase_list_presets: "projects",
  homebase_project_status: "projects",
  homebase_project_upsert: "projects",
  homebase_create_mcp_workspace: "projects",
  homebase_project_delete: "projects",
  homebase_run_action: "projects",
  homebase_stop_project: "projects",
  homebase_cursor_job: "projects",
  homebase_cursor_job_status: "projects",
  homebase_cursor_job_list: "projects",
  homebase_git_status: "projects",
  homebase_git_branches: "projects",
  homebase_git_log: "projects",
  homebase_git_fetch: "projects",
  homebase_git_pull: "projects",
  homebase_git_checkout: "projects",
  homebase_git_create_branch: "projects",
  homebase_git_merge: "projects",
  homebase_git_commit: "projects",
  homebase_git_push: "projects",
  homebase_git_stash: "projects",
  homebase_github_status: "projects",
  homebase_git_env_check: "projects",
  homebase_github_list_repos: "projects",
  homebase_github_clone_workspace: "projects",
  homebase_github_connect_workspace: "projects",
  homebase_github_create_repo: "projects",
  homebase_notifications: "notifications",
  homebase_notify: "notifications",
  homebase_system_status: "status",
  homebase_ping: "status",
  homebase_wireguard_status: "status",
  homebase_access_list: "homeAccess",
  homebase_access_upsert: "homeAccess",
  homebase_access_delete: "homeAccess",
  homebase_access_invoke: "homeAccess",
  homebase_vision_status: "vision",
  homebase_vision_screenshot: "vision",
  homebase_vision_click: "vision",
  homebase_vision_type: "vision",
  homebase_vision_key: "vision",
  homebase_vision_hotkey: "vision",
  homebase_presence_status: "presence",
  homebase_presence_express: "presence",
  homebase_presence_chat_send: "presence",
  homebase_presence_chat_read: "presence",
};

export function normalizeMcpFeatures(
  raw?: Partial<McpFeatures> | null,
): McpFeatures {
  const out = { ...MCP_FEATURE_DEFAULTS };
  if (!raw || typeof raw !== "object") return out;
  for (const id of Object.keys(MCP_FEATURE_DEFAULTS) as McpFeatureId[]) {
    if (typeof raw[id] === "boolean") out[id] = raw[id]!;
  }
  return out;
}

export function filterToolsByMcpFeatures(
  tools: Record<string, HomebaseToolDef>,
  features: McpFeatures,
): Record<string, HomebaseToolDef> {
  const out: Record<string, HomebaseToolDef> = {};
  for (const [name, def] of Object.entries(tools)) {
    const feat = MCP_TOOL_FEATURE[name];
    if (!feat) continue;
    if (!features[feat]) continue;
    out[name] = def;
  }
  return out;
}

function json(data: unknown): string {
  return JSON.stringify(data, null, 2);
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
    `VPN, auth, vaults, MCP tokens, and homebased restart are Settings-only (human precedence). ` +
    `Home Access panel widgets (buttons/toggles/sliders/gauges) use homebase_access_* tools ` +
    `or edit server/src/home_access.ts / the Home Access UI — leave the framework intact once wired. ` +
    visionBit +
    `When the task needs planning vs implementing (or Ask/Debug), call homebase_propose_mode ` +
    `so the user can Switch/Stay mid-chat — do not only narrate a mode change. ` +
    `Answer the user message below in a normal concise voice.\n---\n` +
    text
  );
}

export function buildHomebaseTools(
  projectId: string,
  readonly = false,
  ctx: HomebaseToolContext = {},
  surface: HomebaseToolSurface = "cursor",
): Record<string, HomebaseToolDef> {
  const resolvePid = (args: Record<string, unknown>) =>
    String(args.projectId || args.project_id || "").trim() || projectId;

  const tools: Record<string, HomebaseToolDef> = {};

  if (surface === "cursor") {
    tools.homebase_propose_mode = {
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
          return json({
            ok: true,
            mode,
            unchanged: true,
            message: `Already in ${mode}`,
          });
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
    };
  }

  tools.homebase_list_projects = {
    description: "List Home Base projects with ports and sessions",
    parameters: { type: "object", properties: {} },
    execute: async () => {
      const projects = await Promise.all(
        [...loadProjects().values()].map(async (p) => ({
          ...(await projectPublic(p)),
          active: Boolean(projectId) && p.id === projectId,
        })),
      );
      return json({
        projects,
        activeProjectId: projectId || null,
      });
    },
  };
  tools.homebase_list_presets = {
    description:
      "List project presets (templates with ports/actions). Use with homebase_project_upsert.",
    parameters: { type: "object", properties: {} },
    execute: async () => json({ presets: listPresets() }),
  };
  tools.homebase_project_status = {
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
  };
  tools.homebase_notifications = {
    description: "List recent Home Base notifications",
    parameters: {
      type: "object",
      properties: { limit: { type: "number" } },
    },
    execute: async (args) =>
      json(listNotifications({ limit: Number(args.limit || 20) })),
  };
  tools.homebase_system_status = {
    description:
      "Homebased unit + network URLs + WireGuard summary (read-only; no restart/VPN control)",
    parameters: { type: "object", properties: {} },
    execute: async () => json(systemStatus()),
  };
  tools.homebase_ping = {
    description:
      "Lightweight liveness check: Home Base up, version, uptime, Cursor API key + agent/CLI probe, " +
      "and queued/running homebase_cursor_job per project. Never opens a chat or starts a job — " +
      "prefer this over opening a test chat.",
    parameters: { type: "object", properties: {} },
    execute: async () => {
      const { homebasePing } = await import("./ping");
      return json(homebasePing());
    },
  };
  tools.homebase_wireguard_status = {
    description:
      "WireGuard VPN install/setup status, peers, and client list (no private keys; read-only)",
    parameters: { type: "object", properties: {} },
    execute: async () => json(await wireguardStatus()),
  };
  tools.homebase_access_list = {
    description:
      "List Home Access panel widgets (button/toggle/slider/gauge) and their hooks",
    parameters: { type: "object", properties: {} },
    execute: async () => json({ widgets: listAccessWidgets() }),
  };
  tools.homebase_vision_status = {
    description:
      "Vision desktop status: X11 display, monitors, whether control is Armed, capture health. Linux only.",
    parameters: { type: "object", properties: {} },
    execute: async () => visionTool(() => visionStatus()),
  };
  tools.homebase_vision_screenshot = {
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
  };

  const runProjectGit = async (
    args: Record<string, unknown>,
    action: import("./git").GitAction,
  ) => {
    const { runGitAction } = await import("./git");
    const { mcpGitWriteAllowed } = await import("./mcp_server");
    const pid = resolvePid(args);
    const p = loadProjects().get(pid);
    if (!p) return json({ ok: false, error: "project not found" });
    const result = runGitAction(p, action, {
      surface: surface === "mcp" ? "mcp" : "gui",
      mcpWriteAllowed: surface === "mcp" ? mcpGitWriteAllowed() : true,
    });
    return json(result);
  };

  tools.homebase_github_status = {
    description:
      "Read-only check of the laptop's GitHub CLI login (gh auth status) plus git/gh env " +
      "(seat user, login-env setting, paths/versions). Returns signed-in user or a Sign in " +
      "to GitHub hint. Never returns tokens.",
    parameters: { type: "object", properties: {} },
    execute: async () => {
      const { githubAuthStatus } = await import("./github");
      return json(githubAuthStatus());
    },
  };
  tools.homebase_git_env_check = {
    description:
      "Read-only: which git/gh binaries Home Base will use, whether operator login-shell " +
      "env is on (seat HOME/PATH/setpriv), and fix hints. Never returns tokens.",
    parameters: { type: "object", properties: {} },
    execute: async () => {
      const { gitEnvCheck } = await import("./operator_git_env");
      return json({ ok: true, data: gitEnvCheck() });
    },
  };
  tools.homebase_github_list_repos = {
    description:
      "List the signed-in user's GitHub repos (name, private flag, default branch, URL). " +
      "Requires Settings → Allow MCP GitHub repo access (default Off).",
    parameters: {
      type: "object",
      properties: {
        search: { type: "string", description: "Optional name/description filter" },
        limit: { type: "number", description: "Max repos (default 30, max 100)" },
      },
    },
    execute: async (args) => {
      const { listGithubRepos } = await import("./github");
      return json(
        listGithubRepos({
          search: args.search != null ? String(args.search) : undefined,
          limit: args.limit != null ? Number(args.limit) : 30,
          surface: "mcp",
        }),
      );
    },
  };

  tools.homebase_git_status = {
    description:
      "Git status for a registered project: branch, ahead/behind, changed files, recent commits. Read-only.",
    parameters: {
      type: "object",
      properties: { projectId: { type: "string" } },
      required: ["projectId"],
    },
    execute: async (args) => runProjectGit(args, { action: "status" }),
  };
  tools.homebase_git_branches = {
    description:
      "List local and remote branches for a registered project. Read-only.",
    parameters: {
      type: "object",
      properties: { projectId: { type: "string" } },
      required: ["projectId"],
    },
    execute: async (args) => runProjectGit(args, { action: "branches" }),
  };
  tools.homebase_git_log = {
    description:
      "Recent commits for a registered project (limited). Read-only.",
    parameters: {
      type: "object",
      properties: {
        projectId: { type: "string" },
        limit: { type: "number", description: "Max commits (default 15, max 50)" },
      },
      required: ["projectId"],
    },
    execute: async (args) =>
      runProjectGit(args, {
        action: "log",
        limit: args.limit != null ? Number(args.limit) : 15,
      }),
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
    tools.homebase_create_mcp_workspace = {
      description:
        "Create a new bot workspace folder under ~/MCP_WORKSPACES and register it as a project. " +
        "Requires Settings → MCP → Allow MCP workspace creation (off by default). Name only — no paths.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description:
              "Folder name [A-Za-z0-9._-], max 64 chars, no leading dot",
          },
        },
        required: ["name"],
      },
      execute: async (args) => {
        const { createMcpWorkspace } = await import("./workspace");
        const { projectPublic: pub } = await import("./process");
        const result = createMcpWorkspace(String(args.name || ""));
        if (!result.ok) return json({ ok: false, error: result.error });
        return json({ ok: true, project: await pub(result.project) });
      },
    };
    tools.homebase_github_clone_workspace = {
      description:
        "Clone a GitHub repo into ~/MCP_WORKSPACES/<name>, register it as a project, " +
        "and ensure a development_grok branch. Requires Allow MCP GitHub repo access + " +
        "Allow MCP workspace creation. Never force-pushes; refuses non-empty existing folders.",
      parameters: {
        type: "object",
        properties: {
          repo: {
            type: "string",
            description: "owner/repo or https://github.com/owner/repo URL",
          },
          workspaceName: {
            type: "string",
            description: "Folder name under ~/MCP_WORKSPACES (defaults to repo name)",
          },
          branch: {
            type: "string",
            description: "Optional branch to clone",
          },
        },
        required: ["repo"],
      },
      execute: async (args) => {
        const { cloneGithubWorkspace } = await import("./github");
        const { projectPublic: pub } = await import("./process");
        const result = cloneGithubWorkspace({
          repo: String(args.repo || ""),
          workspaceName: args.workspaceName
            ? String(args.workspaceName)
            : undefined,
          branch: args.branch ? String(args.branch) : undefined,
          surface: "mcp",
        });
        if (!result.ok) return json(result);
        const project = result.data?.project as
          | import("./config").Project
          | undefined;
        return json({
          ...result,
          data: {
            ...result.data,
            project: project ? await pub(project) : undefined,
          },
        });
      },
    };
    tools.homebase_github_connect_workspace = {
      description:
        "Connect an existing Home Base workspace to a GitHub repo remote. " +
        "If the folder has no git: init + add origin + fetch. If origin differs: refuse (no remote removal). " +
        "Requires Allow MCP GitHub repo access.",
      parameters: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          repo: {
            type: "string",
            description: "owner/repo or github.com URL",
          },
          setUpstream: {
            type: "boolean",
            description: "Optionally set upstream for the current branch",
          },
        },
        required: ["projectId", "repo"],
      },
      execute: async (args) => {
        const { connectWorkspaceToGithub } = await import("./github");
        return json(
          connectWorkspaceToGithub({
            projectId: resolvePid(args),
            repo: String(args.repo || ""),
            setUpstream: args.setUpstream === true,
            surface: "mcp",
          }),
        );
      },
    };
    tools.homebase_github_create_repo = {
      description:
        "Create a new GitHub repo from a workspace (private by default), add origin, " +
        "and push the current branch with -u (never force). Requires confirm:true, " +
        "Allow MCP GitHub repo access, and Allow MCP git write actions. " +
        "Does not delete/archive repos, change visibility, or remove remotes.",
      parameters: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          name: { type: "string", description: "GitHub repo name (optional)" },
          visibility: {
            type: "string",
            description: "private (default) or public",
          },
          confirm: {
            type: "boolean",
            description: "Must be true — mirrors the GUI confirm dialog",
          },
        },
        required: ["projectId", "confirm"],
      },
      execute: async (args) => {
        const { createGithubRepoFromWorkspace } = await import("./github");
        const vis =
          String(args.visibility || "private").toLowerCase() === "public"
            ? "public"
            : "private";
        return json(
          createGithubRepoFromWorkspace({
            projectId: resolvePid(args),
            name: args.name ? String(args.name) : undefined,
            visibility: vis,
            confirm: args.confirm === true,
            surface: "mcp",
          }),
        );
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
    tools.homebase_cursor_job = {
      description:
        "Hand off a WHOLE coding job to Cursor on the laptop (saves Grok Bot tokens). " +
        "One active job per projectId (rejects overlaps so development_grok is not raced). " +
        "Cursor pulls/pushes development_grok by default; returns ≤10-line summary + commit. " +
        "Preferred: callbackUrl webhook (one wake) OR waitMs=600000. " +
        "If polling status, ≥5 minutes apart. Not for Vision.",
      parameters: {
        type: "object",
        properties: {
          projectId: {
            type: "string",
            description: "Registered Home Base project id (homebase_list_projects)",
          },
          prompt: {
            type: "string",
            description: "Full job instruction for the Cursor agent on the laptop",
          },
          model: { type: "string", description: "Optional Cursor model id" },
          mode: {
            type: "string",
            description: "agent (default) | ask | plan | debug",
          },
          cwd: {
            type: "string",
            description: "Optional working directory under/equal to the project path",
          },
          title: { type: "string", description: "Optional chat title in Home Base" },
          branch: {
            type: "string",
            description: "Git branch to pull/push (default development_grok)",
          },
          callbackUrl: {
            type: "string",
            description:
              "Optional http(s) URL — Home Base POSTs JSON when the job finishes (preferred over polling)",
          },
          waitMs: {
            type: "number",
            description:
              "0 = return job id immediately (webhook still fires). Prefer 600000 (10m) one-shot wait. Max 45m.",
          },
        },
        required: ["projectId", "prompt"],
      },
      execute: async (args) => {
        try {
          const { startCursorJob } = await import("./cursor_jobs");
          const { getMcpRequestContext } = await import("./mcp_context");
          const mcpCtx = getMcpRequestContext();
          const job = await startCursorJob({
            projectId: resolvePid(args),
            prompt: String(args.prompt || ""),
            model: args.model != null ? String(args.model) : undefined,
            mode: args.mode != null ? String(args.mode) : undefined,
            cwd: args.cwd != null ? String(args.cwd) : undefined,
            title: args.title != null ? String(args.title) : undefined,
            branch: args.branch != null ? String(args.branch) : undefined,
            callbackUrl:
              args.callbackUrl != null ? String(args.callbackUrl) : undefined,
            waitMs: args.waitMs != null ? Number(args.waitMs) : 0,
            source: "mcp",
            sourceLabel: mcpCtx?.actorLabel || undefined,
          });
          return json({ ok: true, job });
        } catch (e) {
          return json({
            ok: false,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      },
    };
    tools.homebase_cursor_job_status = {
      description:
        "Check a homebase_cursor_job by id (use sparingly: ≥5 min between polls). " +
        "Prefer callbackUrl or waitMs=600000 instead. When done: summary (≤10 lines) + commit.",
      parameters: {
        type: "object",
        properties: { jobId: { type: "string" } },
        required: ["jobId"],
      },
      execute: async (args) => {
        const { getCursorJob } = await import("./cursor_jobs");
        const job = getCursorJob(String(args.jobId || ""));
        if (!job) return json({ ok: false, error: "job not found" });
        return json({ ok: true, job });
      },
    };
    tools.homebase_cursor_job_list = {
      description: "List recent Cursor handoff jobs (newest first).",
      parameters: {
        type: "object",
        properties: { limit: { type: "number" } },
      },
      execute: async (args) => {
        const { listCursorJobs } = await import("./cursor_jobs");
        return json({
          ok: true,
          jobs: listCursorJobs(args.limit != null ? Number(args.limit) : 20),
        });
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
    tools.homebase_git_fetch = {
      description:
        "git fetch --all for a project. Write action — MCP requires Settings → Allow MCP git write actions.",
      parameters: {
        type: "object",
        properties: { projectId: { type: "string" } },
        required: ["projectId"],
      },
      execute: async (args) => runProjectGit(args, { action: "fetch" }),
    };
    tools.homebase_git_pull = {
      description:
        "git pull --no-rebase --ff (refuses dirty tree). MCP write toggle required.",
      parameters: {
        type: "object",
        properties: { projectId: { type: "string" } },
        required: ["projectId"],
      },
      execute: async (args) => runProjectGit(args, { action: "pull" }),
    };
    tools.homebase_git_checkout = {
      description:
        "Switch to an existing local/remote branch (refuses dirty tree). MCP write toggle required.",
      parameters: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          branch: { type: "string" },
        },
        required: ["projectId", "branch"],
      },
      execute: async (args) =>
        runProjectGit(args, {
          action: "checkout",
          branch: String(args.branch || ""),
        }),
    };
    tools.homebase_git_create_branch = {
      description:
        "Create a new branch from current HEAD or a named base, then switch to it. MCP write toggle required.",
      parameters: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          name: { type: "string" },
          base: { type: "string", description: "Optional base branch/commit" },
          checkout: {
            type: "boolean",
            description: "Switch to the new branch (default true)",
          },
        },
        required: ["projectId", "name"],
      },
      execute: async (args) =>
        runProjectGit(args, {
          action: "create_branch",
          name: String(args.name || ""),
          base: args.base != null ? String(args.base) : undefined,
          checkout: args.checkout !== false,
        }),
    };
    tools.homebase_git_merge = {
      description:
        "Merge a branch into the current branch (optional --no-ff). Aborts on conflict by default. MCP write toggle required.",
      parameters: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          branch: { type: "string", description: "Source branch to merge in" },
          noFf: { type: "boolean" },
          abortOnConflict: {
            type: "boolean",
            description: "Default true — git merge --abort on conflicts",
          },
        },
        required: ["projectId", "branch"],
      },
      execute: async (args) =>
        runProjectGit(args, {
          action: "merge",
          branch: String(args.branch || ""),
          noFf: args.noFf === true,
          abortOnConflict: args.abortOnConflict !== false,
        }),
    };
    tools.homebase_git_commit = {
      description:
        "Stage all (default) and commit with a message. MCP write toggle required. Never force.",
      parameters: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          message: { type: "string" },
          stageAll: {
            type: "boolean",
            description: "Stage all changes before commit (default true)",
          },
        },
        required: ["projectId", "message"],
      },
      execute: async (args) =>
        runProjectGit(args, {
          action: "commit",
          message: String(args.message || ""),
          stageAll: args.stageAll !== false,
        }),
    };
    tools.homebase_git_push = {
      description:
        "Push current branch to origin (never --force). MCP write toggle required.",
      parameters: {
        type: "object",
        properties: { projectId: { type: "string" } },
        required: ["projectId"],
      },
      execute: async (args) => runProjectGit(args, { action: "push" }),
    };
    tools.homebase_git_stash = {
      description:
        "Stash push / list / pop (no drop/clear). push and pop need MCP write toggle; list is read-only but still here.",
      parameters: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          mode: {
            type: "string",
            description: "push | list | pop",
          },
          message: { type: "string", description: "Optional stash message for push" },
        },
        required: ["projectId", "mode"],
      },
      execute: async (args) => {
        const mode = String(args.mode || "").toLowerCase();
        if (mode !== "push" && mode !== "list" && mode !== "pop") {
          return json({ ok: false, error: "mode must be push|list|pop" });
        }
        return runProjectGit(args, {
          action: "stash",
          mode: mode as "push" | "list" | "pop",
          message: args.message != null ? String(args.message) : undefined,
        });
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

  if (surface === "mcp") {
    tools.homebase_presence_status = {
      description:
        "Desktop presence for the human at the laptop: who is remoted in (web humans vs MCP AIs), " +
        "chat transcript, and guidance. Over VPN/LAN the operator sees a native Presence window — " +
        "front is your Grok-style blob (form/color/mood/energy/bubble); back is details+chat. " +
        "Localhost Web GUI on the laptop does not open the window. " +
        "Use homebase_presence_express to update your character; chat tools sparingly.",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        const { presencePublic } = await import("./presence");
        return json(presencePublic());
      },
    };
    tools.homebase_presence_express = {
      description:
        "Update your cartoon on the operator Presence window (Grok-style blob on the front of the card). " +
        "Call when you arrive over VPN/LAN and whenever state changes. " +
        "mood: idle|thinking|happy|alert|working|listening. " +
        "form: pill|cloud|drop|circle|hex|diamond|soft|cluster. " +
        "color: #hex. energy: 0..1 expressiveness. bubble: ≤160 chars. name: display name. " +
        "Prefer this over presence chat for status. Does not Arm Vision or bypass security.",
      parameters: {
        type: "object",
        properties: {
          mood: {
            type: "string",
            description: "idle|thinking|happy|alert|working|listening",
          },
          bubble: { type: "string", description: "Short caption ≤160 chars" },
          name: { type: "string", description: "Display name on the blob" },
          form: {
            type: "string",
            description: "pill|cloud|drop|circle|hex|diamond|soft|cluster",
          },
          color: { type: "string", description: "#hex blob color" },
          energy: {
            type: "number",
            description: "0..1 animation / expressiveness",
          },
          actorId: {
            type: "string",
            description: "Stable id for this bot (default mcp-default)",
          },
        },
      },
      execute: async (args) => {
        const {
          upsertPresence,
          expressPresence,
          parseMood,
          parseForm,
          parseColor,
          parseEnergy,
          isLocalPeerIp,
        } = await import("./presence");
        const {
          mcpPresenceActorId,
          mcpPresencePeerIp,
          getMcpRequestContext,
        } = await import("./mcp_context");
        const id = mcpPresenceActorId(
          args.actorId != null ? String(args.actorId) : undefined,
        );
        const peerIp = mcpPresencePeerIp() || "unknown";
        const form = parseForm(args.form);
        const color = parseColor(args.color);
        const energy = parseEnergy(args.energy);
        const ctx = getMcpRequestContext();
        upsertPresence({
          id,
          kind: "ai",
          name:
            args.name != null
              ? String(args.name)
              : ctx?.actorLabel || undefined,
          label: "MCP AI",
          peerIp,
          form,
          color,
          energy,
          announce: !isLocalPeerIp(peerIp),
        });
        const mood = parseMood(args.mood);
        const actor = expressPresence(id, {
          mood,
          bubble: args.bubble != null ? String(args.bubble) : undefined,
          name: args.name ? String(args.name) : undefined,
          form,
          color,
          energy,
        });
        return json({
          ok: true,
          actor,
          guidance:
            "Keep expressing (mood/form/color/energy/bubble) as you work; use chat tools sparingly.",
        });
      },
    };
    tools.homebase_presence_chat_send = {
      description:
        "Send a chat message to the operator's desktop presence window (small chat pane). " +
        "Use for questions, status, or coordination. Operator replies appear via homebase_presence_chat_read.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string" },
          actorId: { type: "string" },
          name: { type: "string" },
        },
        required: ["text"],
      },
      execute: async (args) => {
        const { upsertPresence, pushPresenceChat } = await import("./presence");
        const {
          mcpPresenceActorId,
          mcpPresencePeerIp,
          getMcpRequestContext,
        } = await import("./mcp_context");
        const id = mcpPresenceActorId(
          args.actorId != null ? String(args.actorId) : undefined,
        );
        const ctx = getMcpRequestContext();
        const name = String(
          args.name || ctx?.actorLabel || "Grok",
        ).slice(0, 48);
        upsertPresence({
          id,
          kind: "ai",
          name,
          label: "MCP AI",
          peerIp: mcpPresencePeerIp() || "unknown",
          announce: false,
        });
        const msg = pushPresenceChat({
          from: "ai",
          text: String(args.text || ""),
          actorId: id,
          actorName: name,
        });
        return json({ ok: true, message: msg });
      },
    };
    tools.homebase_presence_chat_read = {
      description:
        "Read operator (and AI) messages from the desktop presence chat. Pass since (ms epoch) to get only new messages.",
      parameters: {
        type: "object",
        properties: { since: { type: "number" } },
      },
      execute: async (args) => {
        const { listPresenceChat, upsertPresence } = await import("./presence");
        const { mcpPresenceActorId, mcpPresencePeerIp, getMcpRequestContext } =
          await import("./mcp_context");
        const ctx = getMcpRequestContext();
        upsertPresence({
          id: mcpPresenceActorId(),
          kind: "ai",
          name: ctx?.actorLabel || "Grok",
          label: "MCP AI",
          peerIp: mcpPresencePeerIp() || "unknown",
          announce: false,
        });
        const since = Number(args.since || 0) || 0;
        return json({ messages: listPresenceChat(since), now: Date.now() });
      },
    };
  }

  // Defense in depth — never return denied security tools on any AI surface.
  for (const name of AI_DENIED_TOOL_SET) {
    delete tools[name];
  }
  if (surface === "mcp") {
    for (const name of CURSOR_ONLY_TOOLS) {
      delete tools[name];
    }
  }

  return tools;
}

export function listHomebaseToolNames(
  surface: HomebaseToolSurface,
  readonly = false,
): string[] {
  return Object.keys(buildHomebaseTools("", readonly, {}, surface)).sort();
}

export function mcpToolCatalog(features?: McpFeatures): {
  allowed: { name: string; description: string; feature: McpFeatureId }[];
  disabled: { name: string; description: string; feature: McpFeatureId }[];
  humanOnly: string[];
  features: McpFeatures;
  featureMeta: typeof MCP_FEATURE_META;
} {
  const feats = normalizeMcpFeatures(features);
  const all = buildHomebaseTools("", false, {}, "mcp");
  const allowed: {
    name: string;
    description: string;
    feature: McpFeatureId;
  }[] = [];
  const disabled: {
    name: string;
    description: string;
    feature: McpFeatureId;
  }[] = [];
  for (const [name, def] of Object.entries(all)) {
    const feature = MCP_TOOL_FEATURE[name];
    if (!feature) continue;
    const row = { name, description: def.description, feature };
    if (feats[feature]) allowed.push(row);
    else disabled.push(row);
  }
  return {
    allowed,
    disabled,
    humanOnly: [...HUMAN_ONLY_CAPABILITIES],
    features: feats,
    featureMeta: MCP_FEATURE_META,
  };
}

/** MCP surface tools after feature filtering. */
export function buildMcpTools(
  features?: McpFeatures,
): Record<string, HomebaseToolDef> {
  return filterToolsByMcpFeatures(
    buildHomebaseTools("", false, {}, "mcp"),
    normalizeMcpFeatures(features),
  );
}
