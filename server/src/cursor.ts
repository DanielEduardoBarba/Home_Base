/**
 * Cursor chat workspace + @cursor/sdk local agent streaming.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { AGENTS_PATH, RUNTIME_DIR, ensureRuntimeDirs, loadProjects } from "./config";
import { buildHomebaseTools, wrapPrompt } from "./homebase_tools";
import { appendTrace } from "./trace";
import { pushNotification } from "./notifications";

export type ChatMsg = {
  id: string;
  role: string;
  text: string;
  at?: number;
  streaming?: boolean;
};

export type ChatTab = {
  id: string;
  title: string;
  cwd: string;
  messages: ChatMsg[];
  model?: string;
  mode?: string;
  agentId?: string | null;
  running?: boolean;
  updatedAt?: number;
};

type Workspace = {
  tabs: ChatTab[];
  activeId: string | null;
};

type SendFn = (data: unknown) => void;

const workspaces = new Map<string, Workspace>();
const subscribers = new Map<string, Set<SendFn>>();
const agents = new Map<string, { agent: Awaited<ReturnType<typeof createAgentHandle>>; chatId: string }>();
const running = new Map<string, AbortController>();

function sessionKey(projectId: string, chatId: string): string {
  return `${projectId}::${chatId}`;
}

function chatPath(projectId: string): string {
  return join(RUNTIME_DIR, "chats", `${projectId}.json`);
}

function loadWorkspace(projectId: string): Workspace {
  if (workspaces.has(projectId)) return workspaces.get(projectId)!;
  ensureRuntimeDirs();
  mkdirSync(join(RUNTIME_DIR, "chats"), { recursive: true });
  let ws: Workspace = { tabs: [], activeId: null };
  const path = chatPath(projectId);
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
  mkdirSync(join(RUNTIME_DIR, "chats"), { recursive: true });
  writeFileSync(chatPath(projectId), JSON.stringify(ws, null, 2) + "\n");
}

function loadAgentIds(): Record<string, string> {
  if (!existsSync(AGENTS_PATH)) return {};
  try {
    return JSON.parse(readFileSync(AGENTS_PATH, "utf8")) as Record<string, string>;
  } catch {
    return {};
  }
}

function saveAgentIds(data: Record<string, string>): void {
  ensureRuntimeDirs();
  writeFileSync(AGENTS_PATH, JSON.stringify(data, null, 2) + "\n");
}

export function getWorkspace(projectId: string): Workspace {
  return loadWorkspace(projectId);
}

export function cursorConfigured(): boolean {
  return Boolean((process.env.CURSOR_API_KEY || "").trim());
}

export function defaultModel(): string {
  return (process.env.CURSOR_MODEL || "composer-2.5").trim() || "composer-2.5";
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
    const { Agent } = await import("@cursor/sdk");
    const listModels = (Agent as unknown as { listModels?: () => Promise<unknown[]> }).listModels;
    if (typeof listModels === "function") {
      const models = await listModels();
      return { configured: true, default: defaultModel(), models };
    }
  } catch (e) {
    appendTrace("warn", `listModels: ${e instanceof Error ? e.message : String(e)}`, "cursor");
  }
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
}

export function subscribeCursor(projectId: string, send: SendFn): () => void {
  let set = subscribers.get(projectId);
  if (!set) {
    set = new Set();
    subscribers.set(projectId, set);
  }
  set.add(send);
  return () => {
    set!.delete(send);
  };
}

function broadcast(projectId: string, payload: unknown): void {
  const set = subscribers.get(projectId);
  if (!set) return;
  for (const send of set) {
    try {
      send(payload);
    } catch {
      /* ignore */
    }
  }
}

async function createAgentHandle(opts: {
  projectId: string;
  chatId: string;
  cwd: string;
  model: string;
  mode: string;
  agentId?: string | null;
}): Promise<{
  agent: {
    agentId?: string;
    send: (prompt: string) => Promise<{
      stream: () => AsyncIterable<unknown>;
      wait: () => Promise<{ status?: string }>;
      cancel?: () => Promise<void> | void;
    }>;
    close?: () => Promise<void> | void;
    [Symbol.asyncDispose]?: () => Promise<void>;
  };
}> {
  const { Agent } = await import("@cursor/sdk");
  const apiKey = (process.env.CURSOR_API_KEY || "").trim();
  const readonly = opts.mode === "ask";
  const tools = buildHomebaseTools(opts.projectId, readonly);
  const customTools: Record<
    string,
    {
      description?: string;
      inputSchema?: Record<string, unknown>;
      execute: (args: Record<string, unknown>) => Promise<string>;
    }
  > = {};
  for (const [name, t] of Object.entries(tools)) {
    customTools[name] = {
      description: t.description,
      inputSchema: t.parameters,
      execute: async (args) => String(await t.execute(args)),
    };
  }

  const local = {
    cwd: opts.cwd,
    customTools,
  };

  const modelSel = { id: opts.model || defaultModel() };
  const sdkMode = opts.mode === "plan" ? "plan" : "agent";

  const createOpts = {
    apiKey,
    model: modelSel,
    local,
    mode: sdkMode,
  } as Parameters<typeof Agent.create>[0];

  let agent: Awaited<ReturnType<typeof Agent.create>>;
  if (opts.agentId) {
    try {
      agent = await Agent.resume(opts.agentId, {
        apiKey,
        model: modelSel,
        local,
      } as Parameters<typeof Agent.resume>[1]);
    } catch {
      agent = await Agent.create(createOpts);
    }
  } else {
    agent = await Agent.create(createOpts);
  }
  return { agent: agent as never };
}

function mapStreamEvent(event: unknown): Record<string, unknown> | null {
  if (!event || typeof event !== "object") return null;
  const e = event as Record<string, unknown>;
  const type = String(e.type || "");

  if (type === "assistant" || type === "message") {
    const message = (e.message || e) as Record<string, unknown>;
    const content = (message.content || []) as Array<Record<string, unknown>>;
    let text = "";
    for (const block of content) {
      if (block.type === "text" && typeof block.text === "string") text += block.text;
    }
    if (text) return { type: "text-delta", text };
  }
  if (type === "text-delta" || type === "assistant-delta") {
    const text = String(e.text || e.delta || "");
    return text ? { type: "text-delta", text } : null;
  }
  if (type === "thinking-delta") {
    const text = String(e.text || e.delta || "");
    return text ? { type: "thinking-delta", text } : null;
  }
  if (type === "thinking-completed") {
    return { type: "thinking-completed", ms: e.ms };
  }
  if (type === "tool-call" || type === "tool-delta") {
    return {
      type: "tool-delta",
      name: e.name || e.toolName,
      callId: e.callId || e.id,
      status: e.status,
      detail: e.detail || e.args,
    };
  }
  if (type === "status") {
    return { type: "status-delta", status: e.status || e.text };
  }
  return null;
}

export function handleCursorMessage(
  projectId: string,
  msg: Record<string, unknown>,
  send: SendFn,
): void {
  const ws = loadWorkspace(projectId);
  const type = String(msg.type || "");

  if (type === "workspace" || !type) {
    send({ type: "workspace", ...ws });
    return;
  }

  if (type === "import") {
    ws.tabs = (msg.tabs as ChatTab[]) || [];
    ws.activeId = (msg.activeId as string) || ws.tabs[0]?.id || null;
    saveWorkspace(projectId);
    send({ type: "import-ack", ok: true });
    broadcast(projectId, { type: "workspace", ...ws });
    return;
  }

  if (type === "new") {
    const id = randomBytes(8).toString("hex");
    const tab: ChatTab = {
      id,
      title: String(msg.title || "New chat"),
      cwd: String(msg.cwd || ""),
      messages: [],
      mode: "agent",
      running: false,
      updatedAt: Date.now(),
    };
    ws.tabs.push(tab);
    ws.activeId = id;
    saveWorkspace(projectId);
    send({ type: "tab", tab });
    broadcast(projectId, { type: "workspace", ...ws });
    return;
  }

  if (type === "select") {
    ws.activeId = String(msg.chatId || "");
    saveWorkspace(projectId);
    broadcast(projectId, { type: "workspace", ...ws });
    return;
  }

  if (type === "delete") {
    const chatId = String(msg.chatId || "");
    void cancelRun(projectId, chatId);
    ws.tabs = ws.tabs.filter((t) => t.id !== chatId);
    if (ws.activeId === chatId) ws.activeId = ws.tabs[0]?.id || null;
    saveWorkspace(projectId);
    broadcast(projectId, { type: "workspace", ...ws });
    return;
  }

  if (type === "send") {
    void startRun(projectId, {
      chatId: String(msg.chatId || ws.activeId || ""),
      prompt: String(msg.prompt || ""),
      model: String(msg.model || defaultModel()),
      mode: String(msg.mode || "agent"),
      cwd: msg.cwd != null ? String(msg.cwd) : undefined,
    });
    return;
  }

  if (type === "cancel") {
    void cancelRun(projectId, String(msg.chatId || "")).then((ok) =>
      send({ type: "cancelled", ok, chatId: msg.chatId }),
    );
    return;
  }

  if (type === "reset") {
    void cancelRun(projectId, String(msg.chatId || ""), true).then(() => {
      const tab = ws.tabs.find((t) => t.id === msg.chatId);
      if (tab) {
        tab.messages = [];
        tab.agentId = null;
        tab.running = false;
        saveWorkspace(projectId);
        send({ type: "tab", tab });
      }
    });
    return;
  }

  if (type === "approval_policy" || type === "approve" || type === "sudo" || type === "sudo_clear") {
    send({ type: `${type}-ack`, ok: true });
    return;
  }

  send({ type: "workspace", ...ws });
}

async function startRun(
  projectId: string,
  opts: {
    chatId: string;
    prompt: string;
    model: string;
    mode: string;
    cwd?: string;
  },
): Promise<void> {
  const prompt = opts.prompt.trim();
  if (!prompt) return;
  if (!cursorConfigured()) {
    broadcast(projectId, {
      type: "error",
      error: "CURSOR_API_KEY not set",
      chatId: opts.chatId,
    });
    return;
  }

  const ws = loadWorkspace(projectId);
  let tab = ws.tabs.find((t) => t.id === opts.chatId);
  if (!tab) {
    tab = {
      id: opts.chatId || randomBytes(8).toString("hex"),
      title: "New chat",
      cwd: opts.cwd || "",
      messages: [],
      mode: opts.mode,
    };
    ws.tabs.push(tab);
    ws.activeId = tab.id;
    opts.chatId = tab.id;
  }
  const key = sessionKey(projectId, opts.chatId);
  if (running.has(key)) {
    broadcast(projectId, {
      type: "error",
      error: "Agent is already working on this chat — wait or press Stop, then retry.",
      chatId: opts.chatId,
      recoverable: true,
      busy: true,
    });
    return;
  }

  if (opts.cwd) tab.cwd = opts.cwd.slice(0, 500);
  tab.mode = opts.mode;
  const userCount = tab.messages.filter((m) => m.role === "user").length;
  if (userCount === 0 && (tab.title === "New chat" || tab.title.startsWith("./"))) {
    tab.title = prompt.slice(0, 32) + (prompt.length > 32 ? "…" : "");
  }
  tab.messages.push({
    id: randomBytes(6).toString("hex"),
    role: "user",
    text: prompt,
    at: Date.now(),
  });
  tab.running = true;
  tab.updatedAt = Date.now();
  saveWorkspace(projectId);
  broadcast(projectId, { type: "tab", tab });
  broadcast(projectId, { type: "run", chatId: opts.chatId });

  const ac = new AbortController();
  running.set(key, ac);

  const project = loadProjects().get(projectId);
  const cwd = tab.cwd || project?.path || process.cwd();
  const wrapped = wrapPrompt(prompt, projectId, {
    chatId: opts.chatId,
    cwd,
  });

  try {
    const ids = loadAgentIds();
    const storedId = ids[key] || tab.agentId || null;
    const { agent } = await createAgentHandle({
      projectId,
      chatId: opts.chatId,
      cwd,
      model: opts.model,
      mode: opts.mode,
      agentId: storedId,
    });
    const agentId =
      (agent as { agentId?: string }).agentId ||
      (agent as { agent_id?: string }).agent_id;
    if (agentId) {
      tab.agentId = agentId;
      ids[key] = agentId;
      saveAgentIds(ids);
      broadcast(projectId, {
        type: "agent",
        agentId,
        chatId: opts.chatId,
        mode: opts.mode,
      });
    }

    const run = await agent.send(wrapped);
    let assistant = "";
    for await (const event of run.stream()) {
      if (ac.signal.aborted) {
        try {
          await run.cancel?.();
        } catch {
          /* ignore */
        }
        break;
      }
      const mapped = mapStreamEvent(event);
      if (!mapped) continue;
      mapped.chatId = opts.chatId;
      if (mapped.type === "text-delta") {
        assistant += String(mapped.text || "");
        let bubble = tab.messages.find(
          (m) => m.role === "assistant" && m.streaming,
        );
        if (!bubble) {
          bubble = {
            id: randomBytes(6).toString("hex"),
            role: "assistant",
            text: "",
            streaming: true,
            at: Date.now(),
          };
          tab.messages.push(bubble);
        }
        bubble.text = assistant;
        broadcast(projectId, mapped);
      } else {
        broadcast(projectId, mapped);
      }
    }
    const result = await run.wait();
    const bubble = tab.messages.find((m) => m.role === "assistant" && m.streaming);
    if (bubble) {
      bubble.streaming = false;
      bubble.text = assistant || bubble.text;
    } else if (assistant) {
      tab.messages.push({
        id: randomBytes(6).toString("hex"),
        role: "assistant",
        text: assistant,
        at: Date.now(),
      });
    }
    broadcast(projectId, {
      type: "done",
      chatId: opts.chatId,
      status: result?.status || "ok",
    });
    pushNotification("Cursor done", tab.title || "Chat finished", {
      level: "success",
      category: "cursor",
      meta: { projectId, chatId: opts.chatId },
    });
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    appendTrace("error", `cursor run ${key}: ${err}`, "cursor");
    broadcast(projectId, {
      type: "error",
      error: err,
      chatId: opts.chatId,
      recoverable: true,
    });
  } finally {
    running.delete(key);
    tab.running = false;
    tab.updatedAt = Date.now();
    saveWorkspace(projectId);
    broadcast(projectId, { type: "tab", tab });
  }
}

async function cancelRun(
  projectId: string,
  chatId: string,
  _invalidate = false,
): Promise<boolean> {
  const key = sessionKey(projectId, chatId);
  const ac = running.get(key);
  if (!ac) return false;
  ac.abort();
  return true;
}
