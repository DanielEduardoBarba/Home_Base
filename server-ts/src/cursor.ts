/**
 * Cursor chat workspace — disk-backed tabs + SDK integration.
 * Full streaming parity is in progress; models/list and workspace persistence work.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { RUNTIME_DIR, ensureRuntimeDirs } from "./config";

export type ChatMsg = {
  id: string;
  role: string;
  text: string;
  ts: number;
};

export type ChatTab = {
  id: string;
  title: string;
  cwd: string;
  messages: ChatMsg[];
  model?: string;
  mode?: string;
};

type Workspace = {
  tabs: ChatTab[];
  activeId: string | null;
};

const workspaces = new Map<string, Workspace>();

function chatPath(projectId: string): string {
  return join(RUNTIME_DIR, "chats", `${projectId}.json`);
}

function loadWorkspace(projectId: string): Workspace {
  if (workspaces.has(projectId)) return workspaces.get(projectId)!;
  ensureRuntimeDirs();
  const dir = join(RUNTIME_DIR, "chats");
  mkdirSync(dir, { recursive: true });
  const path = chatPath(projectId);
  let ws: Workspace = { tabs: [], activeId: null };
  if (existsSync(path)) {
    try {
      ws = JSON.parse(readFileSync(path, "utf8")) as Workspace;
    } catch {
      /* empty */
    }
  }
  workspaces.set(projectId, ws);
  return ws;
}

function saveWorkspace(projectId: string): void {
  const ws = loadWorkspace(projectId);
  const path = chatPath(projectId);
  mkdirSync(join(RUNTIME_DIR, "chats"), { recursive: true });
  writeFileSync(path, JSON.stringify(ws, null, 2) + "\n");
}

export function getWorkspace(projectId: string): Workspace {
  return loadWorkspace(projectId);
}

export function cursorConfigured(): boolean {
  return Boolean((process.env.CURSOR_API_KEY || "").trim());
}

export function defaultModel(): string {
  return (process.env.CURSOR_MODEL || "composer-2.5").trim();
}

export async function listModels(): Promise<Record<string, unknown>> {
  const configured = cursorConfigured();
  if (!configured) {
    return {
      configured: false,
      default: defaultModel(),
      models: [],
      error: "CURSOR_API_KEY not set",
    };
  }
  try {
    // Lazy import — SDK optional at boot
    const { Agent } = await import("@cursor/sdk");
    void Agent;
    return {
      configured: true,
      default: defaultModel(),
      models: [
        {
          id: defaultModel(),
          displayName: defaultModel(),
          description: "Configured default model",
        },
      ],
    };
  } catch (e) {
    return {
      configured: true,
      default: defaultModel(),
      models: [{ id: defaultModel(), displayName: defaultModel(), description: "" }],
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export function handleCursorMessage(
  projectId: string,
  msg: Record<string, unknown>,
  send: (data: unknown) => void,
): void {
  const ws = loadWorkspace(projectId);
  const type = String(msg.type || "");

  if (type === "import") {
    const tabs = (msg.tabs as ChatTab[]) || [];
    ws.tabs = tabs;
    ws.activeId = (msg.activeId as string) || tabs[0]?.id || null;
    saveWorkspace(projectId);
    send({ type: "import-ack", ok: true });
    send({ type: "workspace", ...ws });
    return;
  }

  if (type === "new") {
    const id = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
    const tab: ChatTab = {
      id,
      title: String(msg.title || "Chat"),
      cwd: String(msg.cwd || ""),
      messages: [],
    };
    ws.tabs.push(tab);
    ws.activeId = id;
    saveWorkspace(projectId);
    send({ type: "tab", tab });
    send({ type: "workspace", ...ws });
    return;
  }

  if (type === "select") {
    ws.activeId = String(msg.chatId || "");
    saveWorkspace(projectId);
    send({ type: "workspace", ...ws });
    return;
  }

  if (type === "delete") {
    const chatId = String(msg.chatId || "");
    ws.tabs = ws.tabs.filter((t) => t.id !== chatId);
    if (ws.activeId === chatId) ws.activeId = ws.tabs[0]?.id || null;
    saveWorkspace(projectId);
    send({ type: "workspace", ...ws });
    return;
  }

  if (type === "send") {
    send({
      type: "error",
      error:
        "Cursor agent streaming not fully ported yet — workspace persistence works; see PARITY P-CURSOR",
      chatId: msg.chatId,
    });
    return;
  }

  if (type === "approval_policy" || type === "approve" || type === "sudo" || type === "sudo_clear" || type === "cancel" || type === "reset") {
    send({ type: "error", error: `Cursor message '${type}' acknowledged but SDK run path incomplete` });
    return;
  }

  send({ type: "workspace", ...ws });
}
