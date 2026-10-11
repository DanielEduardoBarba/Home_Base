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
import {
  getPolicy,
  listPending,
  resolveApproval,
  setPolicy,
} from "./approvals";
import { listDir, readFile } from "./files";
import { buildHomebaseTools, wrapPrompt } from "./homebase_tools";
import { clearSudo, setSudo } from "./sudo";
import { appendTrace } from "./trace";
import { pushNotification } from "./notifications";

export type ChatImage = {
  mimeType: string;
  /** Raw base64 (no data: prefix). */
  data: string;
  name?: string;
  width?: number;
  height?: number;
};

export type ChatMsg = {
  id: string;
  role: string;
  text: string;
  at?: number;
  streaming?: boolean;
  durationMs?: number;
  images?: ChatImage[];
  /** Project-relative (or absolute host) paths from the @ context picker. */
  contextPaths?: string[];
  tool?: {
    name: string;
    status: string;
    detail?: string;
    callId?: string;
    sessionId?: string;
  };
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

export function cursorSubscriberCount(projectId?: string): number {
  if (projectId) return subscribers.get(projectId)?.size || 0;
  let n = 0;
  for (const set of subscribers.values()) n += set.size;
  return n;
}

export function broadcastAllCursor(payload: unknown): void {
  for (const projectId of subscribers.keys()) {
    broadcast(projectId, payload);
  }
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

type QueuedPrompt = {
  prompt: string;
  model: string;
  mode: string;
  cwd?: string;
  images?: ChatImage[];
  contextPaths?: string[];
};

const MAX_CONTEXT_PATHS = 12;
const MAX_CONTEXT_FILE_CHARS = 48_000;
const MAX_CONTEXT_TOTAL_CHARS = 160_000;

function normalizeContextPaths(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (out.length >= MAX_CONTEXT_PATHS) break;
    const p = String(item || "")
      .trim()
      .replace(/\\/g, "/")
      .slice(0, 500);
    if (!p || p.includes("\0") || seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

/** Load @-attached files/dirs into a prompt appendix (truncated). */
function buildContextAppendix(projectId: string, paths: string[]): string {
  if (!paths.length) return "";
  const project = loadProjects().get(projectId);
  if (!project) return "";
  const blocks: string[] = [];
  let total = 0;
  for (const rel of paths) {
    if (total >= MAX_CONTEXT_TOTAL_CHARS) {
      blocks.push(`… (${paths.length - blocks.length} more path(s) omitted for size)`);
      break;
    }
    try {
      const file = readFile(project, rel);
      let body = file.content;
      let note = "";
      if (body.length > MAX_CONTEXT_FILE_CHARS) {
        body = body.slice(0, MAX_CONTEXT_FILE_CHARS);
        note = "\n… (truncated)";
      }
      const block = `### File: ${file.path}\n\`\`\`\n${body}${note}\n\`\`\``;
      blocks.push(block);
      total += block.length;
      continue;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // readFile uses not_found for missing paths and directories — try listDir next.
      if (msg !== "not_found") {
        blocks.push(`### Path: ${rel}\n(unavailable: ${msg.slice(0, 120)})`);
        continue;
      }
    }
    try {
      const listing = listDir(project, rel);
      const names = (listing.entries as { name: string; type: string }[])
        .slice(0, 80)
        .map((e) => `${e.type === "dir" ? "dir " : "    "}${e.name}`)
        .join("\n");
      const block =
        `### Directory: ${listing.path}\n\`\`\`\n${names || "(empty)"}\n\`\`\``;
      blocks.push(block);
      total += block.length;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      blocks.push(`### Path: ${rel}\n(unavailable: ${msg.slice(0, 120)})`);
    }
  }
  if (!blocks.length) return "";
  return (
    "\n\n[Attached context — user selected these paths via @; prefer them when relevant]\n" +
    blocks.join("\n\n")
  );
}

const MAX_CHAT_IMAGES = 4;
const MAX_CHAT_IMAGE_BYTES = 4 * 1024 * 1024;
const ALLOWED_IMAGE_MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
]);

function normalizeChatImages(raw: unknown): ChatImage[] {
  if (!Array.isArray(raw)) return [];
  const out: ChatImage[] = [];
  for (const item of raw) {
    if (out.length >= MAX_CHAT_IMAGES) break;
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    let mime = String(o.mimeType || o.mediaType || "").toLowerCase().trim();
    let data = String(o.data || "").trim();
    if (!data && typeof o.url === "string" && o.url.startsWith("data:")) {
      const m = /^data:([^;]+);base64,(.+)$/s.exec(o.url);
      if (m) {
        mime = m[1]!.toLowerCase();
        data = m[2]!;
      }
    }
    if (mime === "image/jpg") mime = "image/jpeg";
    if (!ALLOWED_IMAGE_MIME.has(mime) || !data) continue;
    // Rough size check from base64 length.
    const approx = Math.floor((data.length * 3) / 4);
    if (approx <= 0 || approx > MAX_CHAT_IMAGE_BYTES) continue;
    const img: ChatImage = { mimeType: mime, data };
    if (typeof o.name === "string" && o.name.trim()) img.name = o.name.trim().slice(0, 120);
    const w = Number(o.width ?? (o.dimension as { width?: number } | undefined)?.width);
    const h = Number(o.height ?? (o.dimension as { height?: number } | undefined)?.height);
    if (Number.isFinite(w) && w > 0) img.width = Math.floor(w);
    if (Number.isFinite(h) && h > 0) img.height = Math.floor(h);
    out.push(img);
  }
  return out;
}

function toSdkImages(images: ChatImage[]): Array<{
  data: string;
  mimeType: string;
  dimension?: { width: number; height: number };
}> {
  return images.map((img) => {
    const row: {
      data: string;
      mimeType: string;
      dimension?: { width: number; height: number };
    } = { data: img.data, mimeType: img.mimeType };
    if (img.width && img.height) {
      row.dimension = { width: img.width, height: img.height };
    }
    return row;
  });
}

const promptQueues = new Map<string, QueuedPrompt[]>();

function workspacePayload(_projectId: string, ws: Workspace): Record<string, unknown> {
  return {
    type: "workspace",
    ...ws,
    configured: cursorConfigured(),
    importable: ws.tabs.length === 0,
    approvalPolicy: getPolicy(),
    pendingApprovals: listPending(),
  };
}

type AgentRun = {
  stream: () => AsyncIterable<unknown>;
  wait: () => Promise<{ status?: string; result?: string }>;
  cancel?: () => Promise<void> | void;
};

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
    send: (
      message:
        | string
        | {
            text: string;
            images?: Array<{
              data: string;
              mimeType: string;
              dimension?: { width: number; height: number };
            }>;
          },
      options?: {
        onDelta?: (args: { update: Record<string, unknown> }) => void | Promise<void>;
      },
    ) => Promise<AgentRun>;
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

function toolCallName(tc: unknown): string {
  if (!tc || typeof tc !== "object") return "tool";
  const o = tc as Record<string, unknown>;
  if (typeof o.name === "string" && o.name) return o.name;
  if (typeof o.toolName === "string" && o.toolName) return o.toolName;
  const nested = o.tool;
  if (nested && typeof nested === "object") {
    const n = (nested as Record<string, unknown>).name;
    if (typeof n === "string" && n) return n;
  }
  // Discriminated union often uses the variant key as the tool name.
  for (const k of Object.keys(o)) {
    if (k !== "args" && k !== "result" && typeof o[k] === "object") return k;
  }
  return "tool";
}

function toolCallDetail(tc: unknown): string | undefined {
  if (!tc || typeof tc !== "object") return undefined;
  const o = tc as Record<string, unknown>;
  const args = o.args ?? o.input;
  if (args == null) return undefined;
  try {
    const s = typeof args === "string" ? args : JSON.stringify(args);
    return s.length > 280 ? `${s.slice(0, 280)}…` : s;
  } catch {
    return undefined;
  }
}

/** Map raw SDK InteractionUpdate (onDelta) → SPA WS events. */
function mapDeltaUpdate(update: unknown): Record<string, unknown> | null {
  if (!update || typeof update !== "object") return null;
  const e = update as Record<string, unknown>;
  const type = String(e.type || "");

  if (type === "text-delta") {
    const text = String(e.text || "");
    return text ? { type: "text-delta", text } : null;
  }
  if (type === "thinking-delta") {
    const text = String(e.text || "");
    return text ? { type: "thinking-delta", text } : null;
  }
  if (type === "thinking-completed") {
    return {
      type: "thinking-completed",
      ms: e.thinkingDurationMs ?? e.ms,
    };
  }
  if (type === "tool-call-started" || type === "partial-tool-call") {
    const tc = e.toolCall;
    return {
      type: "tool-delta",
      name: toolCallName(tc),
      callId: e.callId,
      status: "running",
      detail: toolCallDetail(tc),
    };
  }
  if (type === "tool-call-completed") {
    const tc = e.toolCall;
    const err =
      tc && typeof tc === "object" && (tc as Record<string, unknown>).error
        ? "error"
        : "completed";
    return {
      type: "tool-delta",
      name: toolCallName(tc),
      callId: e.callId,
      status: err,
      detail: toolCallDetail(tc),
    };
  }
  if (type === "shell-output-delta") {
    const text = String(e.text || e.delta || e.chunk || "");
    return text
      ? {
          type: "shell-delta",
          text,
          callId: e.callId,
          sessionId: e.sessionId,
        }
      : null;
  }
  if (type === "step-started" || type === "step-completed") {
    return { type: "status-delta", status: type.replace(/-/g, " ") };
  }
  // Coarse stream() fallbacks (if consumed)
  if (type === "assistant" || type === "message") {
    const message = (e.message || e) as Record<string, unknown>;
    const content = (message.content || []) as Array<Record<string, unknown>>;
    let text = "";
    for (const block of content) {
      if (block.type === "text" && typeof block.text === "string") text += block.text;
    }
    // Full snapshot — client/server treat as replace, not append.
    return text ? { type: "text-snapshot", text } : null;
  }
  if (type === "thinking") {
    const text = String(e.text || "");
    return text
      ? {
          type: "thinking-snapshot",
          text,
          ms: e.thinking_duration_ms ?? e.thinkingDurationMs,
        }
      : null;
  }
  if (type === "tool_call" || type === "tool-call") {
    return {
      type: "tool-delta",
      name: e.name || e.toolName,
      callId: e.call_id || e.callId || e.id,
      status: e.status || "running",
      detail: e.detail || e.args,
    };
  }
  if (type === "status") {
    return { type: "status-delta", status: e.status || e.text };
  }
  return null;
}

function upsertStreamingBubble(
  tab: ChatTab,
  role: "assistant" | "thinking",
  chunk: string,
  mode: "append" | "replace" = "append",
): ChatMsg {
  // Starting assistant text closes an open thinking bubble.
  if (role === "assistant") {
    for (let i = tab.messages.length - 1; i >= 0; i--) {
      const m = tab.messages[i]!;
      if (m.role === "thinking" && m.streaming) {
        m.streaming = false;
        break;
      }
    }
  }
  let bubble = tab.messages.find((m) => m.role === role && m.streaming);
  if (!bubble) {
    bubble = {
      id: randomBytes(6).toString("hex"),
      role,
      text: "",
      streaming: true,
      at: Date.now(),
    };
    tab.messages.push(bubble);
  }
  bubble.text = mode === "replace" ? chunk : `${bubble.text || ""}${chunk}`;
  return bubble;
}

export async function handleCursorMessage(
  projectId: string,
  msg: Record<string, unknown>,
  send: SendFn,
): Promise<void> {
  const ws = loadWorkspace(projectId);
  const type = String(msg.type || "");

  if (type === "workspace" || !type) {
    send(workspacePayload(projectId, ws));
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
      images: normalizeChatImages(msg.images),
      contextPaths: normalizeContextPaths(msg.contextPaths),
      replaceLastUser: msg.replaceLastUser === true,
      queueIfBusy: msg.queueIfBusy !== false,
    });
    return;
  }

  if (type === "regenerate") {
    const chatId = String(msg.chatId || ws.activeId || "");
    const tab = ws.tabs.find((t) => t.id === chatId);
    if (!tab) {
      send({ type: "error", error: "Chat not found", chatId });
      return;
    }
    let lastUserIdx = -1;
    for (let i = tab.messages.length - 1; i >= 0; i--) {
      if (tab.messages[i]!.role === "user") {
        lastUserIdx = i;
        break;
      }
    }
    if (lastUserIdx < 0) {
      send({ type: "error", error: "Nothing to regenerate", chatId });
      return;
    }
    const lastUser = tab.messages[lastUserIdx]!;
    const prompt = lastUser.text || "";
    const images = lastUser.images ? [...lastUser.images] : [];
    const contextPaths = lastUser.contextPaths ? [...lastUser.contextPaths] : [];
    tab.messages = tab.messages.slice(0, lastUserIdx);
    saveWorkspace(projectId);
    broadcast(projectId, { type: "tab", tab });
    void startRun(projectId, {
      chatId,
      prompt,
      model: String(msg.model || tab.model || defaultModel()),
      mode: String(msg.mode || tab.mode || "agent"),
      cwd: tab.cwd || undefined,
      images,
      contextPaths,
      queueIfBusy: false,
    });
    return;
  }

  if (type === "cancel") {
    const chatId = String(msg.chatId || "");
    promptQueues.delete(sessionKey(projectId, chatId));
    void cancelRun(projectId, chatId).then((ok) =>
      send({ type: "cancelled", ok, chatId }),
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
        promptQueues.delete(sessionKey(projectId, String(msg.chatId || "")));
        saveWorkspace(projectId);
        send({ type: "tab", tab });
      }
    });
    return;
  }

  if (type === "approval_policy") {
    setPolicy(String(msg.policy || "ask"));
    const payload = {
      type: "approval-policy",
      policy: getPolicy(),
      pendingApprovals: listPending(),
    };
    send(payload);
    broadcast(projectId, payload);
    return;
  }

  if (type === "approve") {
    const id = String(msg.id || "");
    const allow = msg.allow !== false && msg.denied !== true;
    const ok = resolveApproval(id, allow);
    const payload = {
      type: "approval-resolved",
      id,
      ok,
      allow,
      pendingApprovals: listPending(),
    };
    send(payload);
    broadcast(projectId, payload);
    return;
  }

  if (type === "sudo") {
    const status = setSudo(String(msg.password || ""));
    send({
      type: "sudo-ack",
      ok: true,
      ...status,
      chatId: msg.chatId,
      sessionId: msg.sessionId,
      callId: msg.callId,
    });
    return;
  }

  if (type === "sudo_clear") {
    clearSudo();
    send({ type: "sudo-ack", ok: true, cleared: true, ttlSec: 0, cached: false });
    return;
  }

  send(workspacePayload(projectId, ws));
}

async function startRun(
  projectId: string,
  opts: {
    chatId: string;
    prompt: string;
    model: string;
    mode: string;
    cwd?: string;
    images?: ChatImage[];
    contextPaths?: string[];
    replaceLastUser?: boolean;
    queueIfBusy?: boolean;
  },
): Promise<void> {
  const images = opts.images || [];
  const contextPaths = opts.contextPaths || [];
  let prompt = opts.prompt.trim();
  if (!prompt && images.length) {
    prompt =
      images.length === 1
        ? "Please look at the attached image."
        : `Please look at the ${images.length} attached images.`;
  }
  if (!prompt && contextPaths.length) {
    prompt =
      contextPaths.length === 1
        ? "Please review the attached file."
        : `Please review the ${contextPaths.length} attached paths.`;
  }
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
    if (opts.queueIfBusy !== false) {
      const q = promptQueues.get(key) || [];
      q.push({
        prompt,
        model: opts.model,
        mode: opts.mode,
        cwd: opts.cwd,
        images,
        contextPaths,
      });
      promptQueues.set(key, q);
      broadcast(projectId, {
        type: "queued",
        chatId: opts.chatId,
        position: q.length,
        prompt: prompt.slice(0, 120),
      });
      return;
    }
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
  tab.model = opts.model;

  if (opts.replaceLastUser) {
    let lastUserIdx = -1;
    for (let i = tab.messages.length - 1; i >= 0; i--) {
      if (tab.messages[i]!.role === "user") {
        lastUserIdx = i;
        break;
      }
    }
    if (lastUserIdx >= 0) tab.messages = tab.messages.slice(0, lastUserIdx);
  }

  const userCount = tab.messages.filter((m) => m.role === "user").length;
  if (userCount === 0 && (tab.title === "New chat" || tab.title.startsWith("./"))) {
    tab.title = prompt.slice(0, 32) + (prompt.length > 32 ? "…" : "");
  }
  tab.messages.push({
    id: randomBytes(6).toString("hex"),
    role: "user",
    text: prompt,
    at: Date.now(),
    ...(images.length ? { images } : {}),
    ...(contextPaths.length ? { contextPaths } : {}),
  });
  tab.running = true;
  tab.updatedAt = Date.now();
  saveWorkspace(projectId);
  broadcast(projectId, { type: "tab", tab });
  broadcast(projectId, { type: "run", chatId: opts.chatId, model: opts.model });

  const ac = new AbortController();
  running.set(key, ac);

  const project = loadProjects().get(projectId);
  const cwd = tab.cwd || project?.path || process.cwd();
  const withContext = prompt + buildContextAppendix(projectId, contextPaths);
  const wrapped = wrapPrompt(withContext, projectId, {
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

    // Token-level streaming requires onDelta — run.stream() only emits coarse steps.
    const sdkMessage =
      images.length > 0
        ? { text: wrapped, images: toSdkImages(images) }
        : wrapped;
    const run = await agent.send(sdkMessage, {
      onDelta: async ({ update }) => {
        if (ac.signal.aborted) return;
        const mapped = mapDeltaUpdate(update);
        if (!mapped) return;
        mapped.chatId = opts.chatId;

        if (mapped.type === "text-delta") {
          upsertStreamingBubble(tab, "assistant", String(mapped.text || ""), "append");
          broadcast(projectId, mapped);
          return;
        }
        if (mapped.type === "thinking-delta") {
          upsertStreamingBubble(tab, "thinking", String(mapped.text || ""), "append");
          broadcast(projectId, mapped);
          return;
        }
        if (mapped.type === "thinking-completed") {
          const thinking = tab.messages.find((m) => m.role === "thinking" && m.streaming);
          if (thinking) {
            thinking.streaming = false;
            if (typeof mapped.ms === "number") thinking.durationMs = mapped.ms as number;
          }
          broadcast(projectId, mapped);
          return;
        }
        if (mapped.type === "tool-delta") {
          const callId = mapped.callId ? String(mapped.callId) : "";
          const name = String(mapped.name || "tool");
          const status = String(mapped.status || "running");
          const detail =
            mapped.detail != null ? String(mapped.detail) : undefined;
          let toolMsg = callId
            ? tab.messages.find((m) => m.role === "tool" && m.tool?.callId === callId)
            : undefined;
          if (!toolMsg) {
            toolMsg = {
              id: randomBytes(6).toString("hex"),
              role: "tool",
              text: "",
              at: Date.now(),
              tool: { name, status, detail, callId: callId || undefined },
            };
            tab.messages.push(toolMsg);
          } else {
            toolMsg.tool = {
              name,
              status,
              detail: detail ?? toolMsg.tool?.detail,
              callId: callId || toolMsg.tool?.callId,
            };
          }
          broadcast(projectId, mapped);
          return;
        }
        broadcast(projectId, mapped);
      },
    });

    // Abort → cancel the run; otherwise wait for completion.
    const abortWait = new Promise<void>((resolve) => {
      if (ac.signal.aborted) {
        resolve();
        return;
      }
      ac.signal.addEventListener("abort", () => resolve(), { once: true });
    });
    const waitPromise = run.wait().catch((e) => {
      throw e;
    });
    const raced = await Promise.race([
      waitPromise.then((r) => ({ kind: "done" as const, r })),
      abortWait.then(() => ({ kind: "abort" as const })),
    ]);
    if (raced.kind === "abort") {
      try {
        await run.cancel?.();
      } catch {
        /* ignore */
      }
    }
    const result: { status?: string; result?: string } =
      raced.kind === "done"
        ? raced.r
        : await waitPromise.catch(() => ({ status: "cancelled" as const }));

    for (const m of tab.messages) {
      if (m.streaming) m.streaming = false;
    }
    // Prefer final assistant text from the run when present.
    const finalText =
      typeof result.result === "string" ? result.result.trim() : "";
    if (finalText) {
      const lastAssistant = [...tab.messages]
        .reverse()
        .find((m) => m.role === "assistant");
      if (lastAssistant) lastAssistant.text = finalText;
      else {
        tab.messages.push({
          id: randomBytes(6).toString("hex"),
          role: "assistant",
          text: finalText,
          at: Date.now(),
        });
      }
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
    const next = promptQueues.get(key)?.shift();
    const remaining = promptQueues.get(key)?.length || 0;
    if (!remaining) promptQueues.delete(key);
    broadcast(projectId, {
      type: "queued",
      chatId: opts.chatId,
      position: remaining,
    });
    if (next) {
      void startRun(projectId, {
        chatId: opts.chatId,
        prompt: next.prompt,
        model: next.model,
        mode: next.mode,
        cwd: next.cwd,
        images: next.images,
        contextPaths: next.contextPaths,
        queueIfBusy: false,
      });
    }
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
