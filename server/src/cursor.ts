/**
 * Cursor chat workspace + @cursor/sdk local agent streaming.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
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
import {
  allowSudoUse,
  clearPersistentSudo,
  clearSudo,
  denySudoUse,
  setPersistentSudo,
  setSudo,
} from "./sudo";
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

export type TodoStatus = "pending" | "inProgress" | "completed" | "cancelled";

export type ChatTodoItem = {
  id?: string;
  content: string;
  status: TodoStatus;
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
    path?: string;
    command?: string;
    output?: string;
    before?: string;
    after?: string;
  };
  file?: {
    path: string;
    action: string;
    before?: string;
    after?: string;
  };
  todos?: ChatTodoItem[];
  planState?: "open" | "building" | "cancelled" | "done";
  modePrompt?: {
    from?: string;
    to: string;
    reason?: string;
    status?: "pending" | "accepted" | "denied";
    approvalId?: string;
  };
  task?: {
    status?: string;
    name?: string;
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

type AgentRun = {
  id?: string;
  status?: string;
  stream: () => AsyncIterable<unknown>;
  wait: () => Promise<{ status?: string; result?: string }>;
  cancel?: () => Promise<void> | void;
};

const workspaces = new Map<string, Workspace>();
const subscribers = new Map<string, Set<SendFn>>();
const running = new Map<string, AbortController>();
/** Live SDK Run handles — cancel must hit these even when AbortController races. */
const liveRuns = new Map<string, AgentRun>();
/** Debounced disk flushes so mid-run deploys keep assistant/tool history. */
const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
const SAVE_DEBOUNCE_MS = 400;

function sessionKey(projectId: string, chatId: string): string {
  return `${projectId}::${chatId}`;
}

function chatPath(projectId: string): string {
  return join(RUNTIME_DIR, "chats", `${projectId}.json`);
}

/** Align persisted tab.running with in-memory AbortControllers (clears stale busy after restart). */
function reconcileTabRunning(projectId: string, ws: Workspace): boolean {
  let changed = false;
  for (const tab of ws.tabs) {
    const live = running.has(sessionKey(projectId, tab.id));
    if (!!tab.running !== live) {
      tab.running = live;
      changed = true;
    }
  }
  return changed;
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
  // Disk may still say running after a crash/restart — no live controllers yet.
  let dirty = reconcileTabRunning(projectId, ws);
  // Also clear tool/task bubbles left "running" when the chat itself is idle
  // (classic post-crash / locking-protocol hang left overnight).
  for (const tab of ws.tabs) {
    if (tab.running) continue;
    const before = JSON.stringify(
      tab.messages.map((m) => [m.streaming, m.tool?.status, m.task?.status]),
    );
    finalizeInterruptedTools(tab, "error");
    const after = JSON.stringify(
      tab.messages.map((m) => [m.streaming, m.tool?.status, m.task?.status]),
    );
    if (before !== after) dirty = true;
  }
  if (dirty) {
    try {
      saveWorkspaceNow(projectId, ws);
    } catch {
      /* ignore */
    }
  }
  workspaces.set(projectId, ws);
  return ws;
}

function saveWorkspaceNow(projectId: string, ws?: Workspace): void {
  const data = ws || loadWorkspace(projectId);
  mkdirSync(join(RUNTIME_DIR, "chats"), { recursive: true });
  const path = chatPath(projectId);
  const tmp = `${path}.${process.pid}.tmp`;
  // Compact JSON — chats can grow large; pretty-print only slows I/O.
  writeFileSync(tmp, JSON.stringify(data) + "\n");
  try {
    chmodSync(tmp, 0o600);
  } catch {
    /* ignore */
  }
  renameSync(tmp, path);
  try {
    chmodSync(path, 0o600);
  } catch {
    /* ignore */
  }
}

/** Immediate durable write (cancels a pending debounce for this project). */
function saveWorkspace(projectId: string): void {
  const pending = saveTimers.get(projectId);
  if (pending) {
    clearTimeout(pending);
    saveTimers.delete(projectId);
  }
  saveWorkspaceNow(projectId);
}

/**
 * Queue a durable write. Streaming tokens call this often; we coalesce so a
 * --deploy / SIGTERM mid-run still leaves assistant/thinking/tool bubbles on disk
 * (not only the user prompt that was flushed at send time).
 */
function scheduleSaveWorkspace(projectId: string): void {
  if (saveTimers.has(projectId)) return;
  saveTimers.set(
    projectId,
    setTimeout(() => {
      saveTimers.delete(projectId);
      try {
        saveWorkspaceNow(projectId);
      } catch {
        /* ignore */
      }
    }, SAVE_DEBOUNCE_MS),
  );
}

/** Flush every in-memory chat workspace — call on SIGTERM/SIGINT before exit. */
export function flushAllChatWorkspaces(): void {
  for (const [projectId, timer] of saveTimers) {
    clearTimeout(timer);
    saveTimers.delete(projectId);
  }
  for (const projectId of workspaces.keys()) {
    try {
      saveWorkspaceNow(projectId);
    } catch {
      /* ignore */
    }
  }
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
  writeFileSync(AGENTS_PATH, JSON.stringify(data) + "\n");
}

/** Historical keys used `project:chat`; current uses `project::chat`. */
function agentMapKeys(projectId: string, chatId: string): string[] {
  return [`${projectId}::${chatId}`, `${projectId}:${chatId}`];
}

function unmapAgentId(projectId: string, chatId: string): string | null {
  const ids = loadAgentIds();
  let agentId: string | null = null;
  let dirty = false;
  for (const k of agentMapKeys(projectId, chatId)) {
    const v = ids[k];
    if (!v) continue;
    if (!agentId) agentId = v;
    delete ids[k];
    dirty = true;
  }
  if (dirty) saveAgentIds(ids);
  return agentId;
}

function resolveChatCwd(projectId: string, tabCwd?: string | null): string {
  const project = loadProjects().get(projectId);
  const raw = (tabCwd || "").trim();
  if (!raw) return project?.path || process.cwd();
  if (raw.startsWith("/")) return raw;
  return project?.path ? join(project.path, raw) : raw;
}

const AGENT_CLEANUP_MS = 8_000;

/** Best-effort SDK cleanup — never block the delete response. */
async function disposeAgentBackground(agentId: string, cwd: string): Promise<void> {
  if (!agentId) return;
  const work = async () => {
    try {
      await clearStuckAgentRuns(agentId, cwd);
    } catch {
      /* ignore */
    }
    try {
      const { Agent } = await import("@cursor/sdk");
      if (typeof Agent.delete === "function") {
        await Agent.delete(agentId, { runtime: "local", cwd } as never);
      }
    } catch {
      /* local delete may be unsupported — ignore */
    }
  };
  await Promise.race([
    work(),
    new Promise<void>((resolve) => setTimeout(resolve, AGENT_CLEANUP_MS)),
  ]);
}

export type ChatSummary = {
  id: string;
  title: string;
  cwd: string;
  updatedAt: number;
  running: boolean;
  messageCount: number;
  recent: Array<{
    role: string;
    streaming?: boolean;
    text?: string;
    tool?: {
      name?: string;
      status?: string;
      detail?: string;
      path?: string;
      command?: string;
    };
    file?: { path?: string; action?: string };
    task?: { status?: string; name?: string };
  }>;
};

function slimRecentMessages(messages: ChatMsg[] | undefined): ChatSummary["recent"] {
  const src = messages || [];
  const start = Math.max(0, src.length - 24);
  const out: ChatSummary["recent"] = [];
  for (let i = start; i < src.length; i++) {
    const m = src[i]!;
    const row: ChatSummary["recent"][number] = { role: m.role };
    if (m.streaming) row.streaming = true;
    if (m.text) row.text = m.text.length > 160 ? `${m.text.slice(0, 160)}…` : m.text;
    if (m.tool) {
      row.tool = {
        name: m.tool.name,
        status: m.tool.status,
        detail: m.tool.detail
          ? m.tool.detail.length > 80
            ? `${m.tool.detail.slice(0, 80)}…`
            : m.tool.detail
          : undefined,
        path: m.tool.path,
        command: m.tool.command
          ? m.tool.command.length > 80
            ? `${m.tool.command.slice(0, 80)}…`
            : m.tool.command
          : undefined,
      };
    }
    if (m.file) row.file = { path: m.file.path, action: m.file.action };
    if (m.task) row.task = { status: m.task.status, name: m.task.name };
    out.push(row);
  }
  return out;
}

export function getWorkspace(projectId: string): Workspace {
  return loadWorkspace(projectId);
}

/** Lean chat list for Home Agent — no full message bodies / images. */
export function listChatSummaries(projectId: string): {
  configured: boolean;
  activeId: string | null;
  chats: ChatSummary[];
} {
  const ws = loadWorkspace(projectId);
  return {
    configured: cursorConfigured(),
    activeId: ws.activeId,
    chats: ws.tabs.map((tab) => ({
      id: tab.id,
      title: tab.title || "Chat",
      cwd: tab.cwd || "",
      updatedAt: tab.updatedAt || 0,
      running: running.has(sessionKey(projectId, tab.id)),
      messageCount: tab.messages?.length || 0,
      recent: slimRecentMessages(tab.messages),
    })),
  };
}

export function createChat(
  projectId: string,
  opts: { title?: string; cwd?: string } = {},
): ChatTab {
  const ws = loadWorkspace(projectId);
  const tab: ChatTab = {
    id: randomBytes(8).toString("hex"),
    title: String(opts.title || "New chat"),
    cwd: String(opts.cwd || ""),
    messages: [],
    mode: "agent",
    running: false,
    updatedAt: Date.now(),
  };
  ws.tabs.push(tab);
  ws.activeId = tab.id;
  saveWorkspace(projectId);
  broadcast(projectId, { type: "tab", tab });
  broadcast(projectId, workspacePayload(projectId, ws));
  return tab;
}

/**
 * Fast chat delete: persist + ack immediately; SDK agent cleanup is background.
 */
export function deleteChat(
  projectId: string,
  chatId: string,
): { ok: boolean; deleted: boolean; activeId: string | null } {
  const id = String(chatId || "").trim();
  if (!id) return { ok: false, deleted: false, activeId: loadWorkspace(projectId).activeId };

  const ws = loadWorkspace(projectId);
  const tab = ws.tabs.find((t) => t.id === id);
  const key = sessionKey(projectId, id);
  const mappedId = unmapAgentId(projectId, id);
  const agentId = (tab?.agentId || mappedId || "").trim() || null;
  const cwd = resolveChatCwd(projectId, tab?.cwd);

  // Sync abort so the chat unlocks immediately.
  const ac = running.get(key);
  if (ac) {
    try {
      ac.abort();
    } catch {
      /* ignore */
    }
  }
  promptQueues.delete(key);

  let deleted = false;
  if (tab) {
    ws.tabs = ws.tabs.filter((t) => t.id !== id);
    if (ws.activeId === id) ws.activeId = ws.tabs[0]?.id || null;
    saveWorkspace(projectId);
    deleted = true;
  }

  const activeId = ws.activeId;
  broadcast(projectId, { type: "deleted", chatId: id, activeId, deleted });
  // Keep open Chat panels in sync without waiting for SDK cleanup.
  if (deleted) broadcast(projectId, workspacePayload(projectId, ws));

  void (async () => {
    const live = liveRuns.get(key);
    liveRuns.delete(key);
    running.delete(key);
    if (live?.cancel) {
      try {
        await live.cancel();
      } catch {
        /* ignore */
      }
    }
    if (agentId) await disposeAgentBackground(agentId, cwd);
  })();

  return { ok: true, deleted, activeId };
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

function workspacePayload(projectId: string, ws: Workspace): Record<string, unknown> {
  if (reconcileTabRunning(projectId, ws)) {
    try {
      saveWorkspace(projectId);
    } catch {
      /* ignore */
    }
  }
  return {
    type: "workspace",
    ...ws,
    // Always advertise live run state, never a stale persisted flag.
    tabs: ws.tabs.map((t) => ({
      ...t,
      running: running.has(sessionKey(projectId, t.id)),
    })),
    configured: cursorConfigured(),
    importable: ws.tabs.length === 0,
    approvalPolicy: getPolicy(),
    pendingApprovals: listPending(),
  };
}

function isAgentBusyError(err: unknown): boolean {
  if (!err) return false;
  const name =
    typeof err === "object" && err && "name" in err
      ? String((err as { name?: string }).name || "")
      : "";
  const msg = err instanceof Error ? err.message : String(err);
  // "locking protocol" surfaces after restart / orphaned SDK runs when sqlite
  // still holds an active-run lock even though Home Base's in-memory map is clear.
  return (
    name === "AgentBusyError" ||
    /already has active run/i.test(msg) ||
    /locking protocol/i.test(msg)
  );
}

/** Mark in-flight tool/task bubbles terminal so a crashed run cannot look forever-live. */
function finalizeInterruptedTools(tab: ChatTab, status: "error" | "cancelled" = "error"): void {
  for (const m of tab.messages) {
    if (m.streaming) m.streaming = false;
    if (m.role === "tool" && m.tool) {
      const st = String(m.tool.status || "").toLowerCase();
      if (st === "running" || st === "pending") m.tool.status = status;
    }
    if (m.role === "task" && m.task) {
      const st = String(m.task.status || "").toLowerCase();
      if (st === "running" || st === "pending") m.task.status = status;
    }
  }
}

/** Cancel orphaned SDK runs left after crash/restart (Home Base lock is free). */
async function clearStuckAgentRuns(agentId: string, cwd: string): Promise<number> {
  if (!agentId) return 0;
  let cleared = 0;
  try {
    const { Agent } = await import("@cursor/sdk");
    const listed = await Agent.listRuns(agentId, { runtime: "local", cwd });
    for (const run of listed.items || []) {
      const status = String((run as { status?: string }).status || "").toLowerCase();
      // Anything non-terminal blocks the next send (SDK activeRunId).
      if (status === "finished" || status === "error" || status === "cancelled") continue;
      const runId = String((run as { id?: string }).id || "");
      try {
        if (runId && typeof Agent.cancelRun === "function") {
          await Agent.cancelRun(runId, { runtime: "local", cwd });
        } else if (typeof (run as AgentRun).cancel === "function") {
          await (run as AgentRun).cancel!();
        } else {
          continue;
        }
        cleared += 1;
      } catch (e) {
        appendTrace(
          "warn",
          `cancel stuck run ${runId || "?"} for ${agentId}: ${
            e instanceof Error ? e.message : String(e)
          }`,
          "cursor",
        );
      }
    }
  } catch (e) {
    appendTrace(
      "warn",
      `listRuns for stuck agent ${agentId}: ${
        e instanceof Error ? e.message : String(e)
      }`,
      "cursor",
    );
  }
  return cleared;
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
  const tools = buildHomebaseTools(opts.projectId, readonly, {
    chatId: opts.chatId,
    getMode: () => {
      const tab = loadWorkspace(opts.projectId).tabs.find((t) => t.id === opts.chatId);
      return tab?.mode || opts.mode || "agent";
    },
  });
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
        mode: sdkMode,
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
  if (typeof o.type === "string" && o.type && o.type !== "object") return o.type;
  if (typeof o.name === "string" && o.name) return o.name;
  if (typeof o.toolName === "string" && o.toolName) return o.toolName;
  const nested = o.tool;
  if (nested && typeof nested === "object") {
    const n = nested as Record<string, unknown>;
    if (typeof n.type === "string" && n.type) return n.type;
    if (typeof n.name === "string" && n.name) return n.name;
  }
  // Discriminated union often uses the variant key as the tool name.
  for (const k of Object.keys(o)) {
    if (k !== "args" && k !== "result" && k !== "error" && typeof o[k] === "object") {
      return k;
    }
  }
  return "tool";
}

function toolCallArgs(tc: unknown): Record<string, unknown> | null {
  if (!tc || typeof tc !== "object") return null;
  const o = tc as Record<string, unknown>;
  const direct = o.args ?? o.input;
  if (direct && typeof direct === "object" && !Array.isArray(direct)) {
    return direct as Record<string, unknown>;
  }
  // Nested under variant key: { updateTodos: { args: {...} } }
  for (const v of Object.values(o)) {
    if (!v || typeof v !== "object" || Array.isArray(v)) continue;
    const nested = v as Record<string, unknown>;
    const args = nested.args ?? nested.input ?? nested;
    if (args && typeof args === "object" && !Array.isArray(args)) {
      return args as Record<string, unknown>;
    }
  }
  return null;
}

function normalizeTodoStatus(raw: unknown): TodoStatus {
  const s = String(raw || "pending");
  if (s === "in_progress" || s === "inProgress") return "inProgress";
  if (s === "completed" || s === "cancelled" || s === "pending") return s;
  return "pending";
}

function extractTodos(tc: unknown): ChatTodoItem[] | null {
  const name = toolCallName(tc).toLowerCase();
  if (name !== "updatetodos" && name !== "update_todos" && name !== "readtodos") {
    return null;
  }
  const args = toolCallArgs(tc);
  const list = (args?.todos ?? args?.items) as unknown;
  if (!Array.isArray(list)) return null;
  return list
    .map((item, i) => {
      if (!item || typeof item !== "object") return null;
      const o = item as Record<string, unknown>;
      const content = String(o.content || o.text || o.title || "").trim();
      if (!content) return null;
      return {
        id: o.id != null ? String(o.id) : String(i),
        content,
        status: normalizeTodoStatus(o.status),
      } satisfies ChatTodoItem;
    })
    .filter(Boolean) as ChatTodoItem[];
}

function extractPlanText(tc: unknown): string | null {
  const name = toolCallName(tc).toLowerCase();
  if (name !== "createplan" && name !== "create_plan") return null;
  const args = toolCallArgs(tc);
  const plan = args?.plan ?? args?.content ?? args?.text;
  if (typeof plan === "string" && plan.trim()) return plan.trim();
  return null;
}

function pickToolArgLine(obj: Record<string, unknown>): string | undefined {
  const keys = [
    "command",
    "cmd",
    "path",
    "file_path",
    "filePath",
    "target_file",
    "targetFile",
    "pattern",
    "query",
    "url",
    "glob",
    "glob_pattern",
    "globPattern",
    "description",
    "prompt",
    "title",
    "plan",
    "name",
  ];
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  for (const v of Object.values(obj)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const nested = pickToolArgLine(v as Record<string, unknown>);
      if (nested) return nested;
    }
  }
  return undefined;
}

function summarizeTodos(todos: ChatTodoItem[]): string {
  const n = todos.length;
  const done = todos.filter((t) => t.status === "completed").length;
  const active = todos.find((t) => t.status === "inProgress");
  if (active) return `${done}/${n} · ${active.content}`;
  return `${done}/${n} tasks`;
}

function toolCallDetail(tc: unknown): string | undefined {
  const todos = extractTodos(tc);
  if (todos) return summarizeTodos(todos);
  const plan = extractPlanText(tc);
  if (plan) {
    const first = plan.split("\n").find((l) => l.trim()) || "Plan";
    return first.replace(/^#+\s*/, "").slice(0, 120);
  }
  if (!tc || typeof tc !== "object") return undefined;
  const o = tc as Record<string, unknown>;
  const args = toolCallArgs(tc) ?? ((o.args ?? o.input) as unknown);
  if (args == null) return undefined;
  try {
    if (typeof args === "string") {
      const s = args.trim();
      return s.length > 280 ? `${s.slice(0, 280)}…` : s;
    }
    if (typeof args === "object" && !Array.isArray(args)) {
      const nice = pickToolArgLine(args as Record<string, unknown>);
      if (nice) return nice.length > 280 ? `${nice.slice(0, 280)}…` : nice;
      // Avoid dumping raw JSON into the transcript.
      const keys = Object.keys(args as Record<string, unknown>);
      return keys.length ? `${keys.slice(0, 4).join(", ")}${keys.length > 4 ? "…" : ""}` : undefined;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function pickArgString(
  args: Record<string, unknown> | null,
  keys: string[],
): string | undefined {
  if (!args) return undefined;
  for (const k of keys) {
    const v = args[k];
    if (typeof v === "string" && v.trim()) return v;
  }
  return undefined;
}

function toolFilePath(args: Record<string, unknown> | null): string | undefined {
  return pickArgString(args, [
    "path",
    "file_path",
    "filePath",
    "target_file",
    "targetFile",
    "file",
  ]);
}

function isFileEditTool(name: string): boolean {
  const n = name.toLowerCase().replace(/[^a-z]/g, "");
  return (
    n === "write" ||
    n === "edit" ||
    n === "strreplace" ||
    n === "searchreplace" ||
    n === "delete" ||
    n === "applypatch" ||
    n === "editfile" ||
    n === "writefile" ||
    n.includes("strreplace") ||
    n.includes("searchreplace")
  );
}

function isShellToolName(name: string): boolean {
  const n = name.toLowerCase().replace(/[^a-z]/g, "");
  return n === "shell" || n === "bash" || n === "awaitshell";
}

/** Pre-edit snapshots keyed by tool callId (cleared on complete). */
const pendingFileBefore = new Map<string, string>();
/** Accumulated shell stdout keyed by callId. */
const shellOutputBuf = new Map<string, string>();

function mapToolCallUpdate(
  tc: unknown,
  callId: unknown,
  status: string,
): Record<string, unknown> {
  const name = toolCallName(tc);
  const todos = extractTodos(tc);
  if (todos) {
    return {
      type: "todo-delta",
      name,
      callId,
      status,
      todos,
      detail: summarizeTodos(todos),
    };
  }
  const plan = extractPlanText(tc);
  if (plan) {
    return {
      type: "plan-delta",
      name,
      callId,
      status,
      plan,
      detail: toolCallDetail(tc),
    };
  }
  const lower = name.toLowerCase();
  if (lower === "task" || lower === "await") {
    const args = toolCallArgs(tc);
    const desc =
      (args && typeof args.description === "string" && args.description) ||
      (args && typeof args.prompt === "string" && args.prompt) ||
      toolCallDetail(tc) ||
      name;
    return {
      type: "task-delta",
      name,
      callId,
      status,
      detail: String(desc).slice(0, 280),
      taskName: String(desc).slice(0, 120),
    };
  }
  const args = toolCallArgs(tc);
  const path = toolFilePath(args);
  const command = isShellToolName(name)
    ? pickArgString(args, ["command", "cmd"])
    : undefined;
  const oldStr = pickArgString(args, [
    "old_string",
    "oldString",
    "old_str",
    "search",
  ]);
  const newStr = pickArgString(args, [
    "new_string",
    "newString",
    "new_str",
    "replace",
  ]);
  const contents = pickArgString(args, ["contents", "content", "text", "new_text"]);
  return {
    type: "tool-delta",
    name,
    callId,
    status,
    detail: toolCallDetail(tc),
    path,
    command,
    oldString: oldStr,
    newString: newStr,
    contents,
    editTool: isFileEditTool(name),
    shellTool: isShellToolName(name),
  };
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
    return mapToolCallUpdate(e.toolCall, e.callId, "running");
  }
  if (type === "tool-call-completed") {
    const tc = e.toolCall;
    const err =
      tc && typeof tc === "object" && (tc as Record<string, unknown>).error
        ? "error"
        : "completed";
    return mapToolCallUpdate(tc, e.callId, err);
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
  if (type === "summary-started" || type === "summary-completed" || type === "summary") {
    const text = String(e.text || e.summary || "").trim();
    return text
      ? { type: "status-delta", status: text.slice(0, 160) }
      : { type: "status-delta", status: type.replace(/-/g, " ") };
  }
  if (type === "token-delta" || type === "turn-ended" || type === "user-message-appended") {
    return null;
  }
  if (type === "nested-task" || type === "nested-task-update") {
    return {
      type: "task-delta",
      name: "task",
      status: String(e.status || "running"),
      detail: String(e.text || e.description || "Subagent"),
      taskName: String(e.name || e.text || "Subagent").slice(0, 120),
      callId: e.callId || e.id,
    };
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
  if (type === "task") {
    return {
      type: "task-delta",
      name: "task",
      status: String(e.status || "running"),
      detail: String(e.text || "Task"),
      taskName: String(e.text || "Task").slice(0, 120),
    };
  }
  if (type === "tool_call" || type === "tool-call") {
    return mapToolCallUpdate(
      e.toolCall || e,
      e.call_id || e.callId || e.id,
      String(e.status || "running"),
    );
  }
  if (type === "status") {
    return { type: "status-delta", status: e.status || e.text };
  }
  if (type === "usage" || type === "request" || type === "system") {
    return null;
  }
  // Unknown — never dump raw JSON into the transcript.
  return type
    ? { type: "status-delta", status: `update: ${type.replace(/-/g, " ")}` }
    : null;
}

function assistantRoleForMode(mode: string): string {
  if (mode === "ask") return "ask";
  if (mode === "debug") return "debug";
  if (mode === "plan") return "plan";
  return "assistant";
}

function normalizeChatMode(raw: string): string {
  const m = String(raw || "agent").toLowerCase();
  if (m === "ask" || m === "plan" || m === "debug" || m === "agent") return m;
  return "agent";
}

/** Apply a chat mode mid-conversation (used by homebase_propose_mode). */
export function applyChatMode(opts: {
  projectId: string;
  chatId: string;
  mode: string;
  reason?: string;
}): { ok: boolean; mode: string; previous?: string } {
  const ws = loadWorkspace(opts.projectId);
  const tab = ws.tabs.find((t) => t.id === opts.chatId);
  if (!tab) return { ok: false, mode: normalizeChatMode(opts.mode) };
  const previous = tab.mode || "agent";
  const mode = normalizeChatMode(opts.mode);
  tab.mode = mode;
  tab.updatedAt = Date.now();
  tab.messages.push({
    id: randomBytes(6).toString("hex"),
    role: "status",
    text: `Switched to ${mode}${opts.reason ? ` — ${opts.reason}` : ""}`,
    at: Date.now(),
  });
  saveWorkspace(opts.projectId);
  broadcast(opts.projectId, { type: "mode", chatId: opts.chatId, mode });
  broadcast(opts.projectId, { type: "tab", tab });
  return { ok: true, mode, previous };
}

const TEXT_ROLES = new Set(["assistant", "ask", "debug", "plan"]);

/** Close open answer bubbles so later text lands after tools (bottom of the turn). */
function sealStreamingAnswers(tab: ChatTab): void {
  for (const m of tab.messages) {
    if (m.streaming && TEXT_ROLES.has(m.role)) {
      m.streaming = false;
    }
  }
}

function upsertStreamingBubble(
  tab: ChatTab,
  role: string,
  chunk: string,
  mode: "append" | "replace" = "append",
): ChatMsg {
  // Starting assistant-family text closes an open thinking bubble.
  if (role !== "thinking") {
    for (let i = tab.messages.length - 1; i >= 0; i--) {
      const m = tab.messages[i]!;
      if (m.role === "thinking" && m.streaming) {
        m.streaming = false;
        break;
      }
    }
  }
  // Only continue a streaming answer if it is still the newest message.
  // Otherwise (tools ran after it) open a fresh bubble at the bottom.
  let bubble: ChatMsg | undefined;
  const last = tab.messages[tab.messages.length - 1];
  if (last && last.role === role && last.streaming) {
    bubble = last;
  } else {
    // Stale mid-list streaming answer — seal it.
    for (const m of tab.messages) {
      if (m.role === role && m.streaming) m.streaming = false;
    }
  }
  if (!bubble) {
    bubble = {
      id: randomBytes(6).toString("hex"),
      role,
      text: "",
      streaming: true,
      at: Date.now(),
      ...(role === "plan" ? { planState: "open" as const } : {}),
    };
    tab.messages.push(bubble);
  }
  bubble.text = mode === "replace" ? chunk : `${bubble.text || ""}${chunk}`;
  bubble.at = Date.now();
  return bubble;
}

/** Ensure the completed answer sits after tools/todos for this turn. */
function placeFinalAnswerAtBottom(
  tab: ChatTab,
  role: string,
  finalText: string,
): void {
  const text = finalText.trim();
  if (!text) return;
  let lastUser = -1;
  for (let i = tab.messages.length - 1; i >= 0; i--) {
    if (tab.messages[i]!.role === "user") {
      lastUser = i;
      break;
    }
  }
  const turnStart = lastUser + 1;
  let lastActivity = -1;
  let lastAnswer = -1;
  for (let i = turnStart; i < tab.messages.length; i++) {
    const m = tab.messages[i]!;
    if (
      m.role === "tool" ||
      m.role === "todo" ||
      m.role === "task" ||
      m.role === "file" ||
      m.role === "thinking"
    ) {
      lastActivity = i;
    }
    if (TEXT_ROLES.has(m.role)) lastAnswer = i;
  }
  // Answer already last (after activity) — update in place.
  if (lastAnswer >= 0 && lastAnswer > lastActivity) {
    const m = tab.messages[lastAnswer]!;
    m.text = text;
    m.streaming = false;
    m.at = Date.now();
    return;
  }
  // Activity after the answer (or no answer yet) — append a bottom bubble.
  tab.messages.push({
    id: randomBytes(6).toString("hex"),
    role,
    text,
    streaming: false,
    at: Date.now(),
    ...(role === "plan" ? { planState: "open" as const } : {}),
  });
}

function upsertTodoBubble(
  tab: ChatTab,
  todos: ChatTodoItem[],
  callId?: string,
): ChatMsg {
  const lastTodo = [...tab.messages].reverse().find((m) => m.role === "todo");
  let bubble =
    (callId
      ? tab.messages.find((m) => m.role === "todo" && m.tool?.callId === callId)
      : undefined) || lastTodo;
  if (!bubble) {
    bubble = {
      id: randomBytes(6).toString("hex"),
      role: "todo",
      text: summarizeTodos(todos),
      at: Date.now(),
      todos,
      tool: callId
        ? { name: "updateTodos", status: "completed", callId, detail: summarizeTodos(todos) }
        : undefined,
    };
    tab.messages.push(bubble);
  } else {
    bubble.todos = todos;
    bubble.text = summarizeTodos(todos);
    bubble.at = Date.now();
    if (callId) {
      bubble.tool = {
        name: "updateTodos",
        status: "completed",
        callId,
        detail: summarizeTodos(todos),
      };
    }
  }
  return bubble;
}

function upsertPlanBubble(tab: ChatTab, plan: string, callId?: string): ChatMsg {
  let bubble =
    (callId
      ? tab.messages.find((m) => m.role === "plan" && m.tool?.callId === callId)
      : undefined) ||
    [...tab.messages].reverse().find((m) => m.role === "plan" && m.planState === "open");
  if (!bubble) {
    bubble = {
      id: randomBytes(6).toString("hex"),
      role: "plan",
      text: plan,
      at: Date.now(),
      planState: "open",
      tool: callId ? { name: "createPlan", status: "completed", callId } : undefined,
    };
    tab.messages.push(bubble);
  } else {
    bubble.text = plan;
    bubble.planState = bubble.planState || "open";
    bubble.at = Date.now();
  }
  return bubble;
}

function upsertTaskBubble(
  tab: ChatTab,
  opts: { status: string; detail: string; name?: string; callId?: string },
): ChatMsg {
  let bubble = opts.callId
    ? tab.messages.find((m) => m.role === "task" && m.tool?.callId === opts.callId)
    : undefined;
  if (!bubble) {
    bubble = {
      id: randomBytes(6).toString("hex"),
      role: "task",
      text: opts.detail,
      at: Date.now(),
      task: { status: opts.status, name: opts.name || opts.detail },
      tool: {
        name: "task",
        status: opts.status,
        detail: opts.detail,
        callId: opts.callId,
      },
    };
    tab.messages.push(bubble);
  } else {
    bubble.text = opts.detail;
    bubble.task = { status: opts.status, name: opts.name || opts.detail };
    if (bubble.tool) {
      bubble.tool.status = opts.status;
      bubble.tool.detail = opts.detail;
    }
    bubble.at = Date.now();
  }
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
    broadcast(projectId, workspacePayload(projectId, ws));
    return;
  }

  if (type === "new") {
    const tab = createChat(projectId, {
      title: String(msg.title || "New chat"),
      cwd: String(msg.cwd || ""),
    });
    send({ type: "tab", tab });
    return;
  }

  if (type === "select") {
    ws.activeId = String(msg.chatId || "");
    saveWorkspace(projectId);
    broadcast(projectId, workspacePayload(projectId, ws));
    return;
  }

  if (type === "delete") {
    const chatId = String(msg.chatId || "");
    const result = deleteChat(projectId, chatId);
    send({
      type: "deleted",
      chatId,
      ok: result.ok,
      deleted: result.deleted,
      activeId: result.activeId,
    });
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

  if (type === "set_mode") {
    const chatId = String(msg.chatId || ws.activeId || "");
    const mode = normalizeChatMode(String(msg.mode || "agent"));
    const tab = ws.tabs.find((t) => t.id === chatId);
    if (!tab) {
      send({ type: "error", error: "chat not found" });
      return;
    }
    tab.mode = mode;
    tab.updatedAt = Date.now();
    saveWorkspace(projectId);
    const payload = { type: "mode", chatId, mode };
    send(payload);
    broadcast(projectId, payload);
    return;
  }

  if (type === "plan_action") {
    const chatId = String(msg.chatId || ws.activeId || "");
    const messageId = String(msg.messageId || "");
    const action = String(msg.action || "");
    const tab = ws.tabs.find((t) => t.id === chatId);
    if (!tab) {
      send({ type: "error", error: "chat not found" });
      return;
    }
    const planMsg = tab.messages.find((m) => m.id === messageId && m.role === "plan");
    if (!planMsg) {
      send({ type: "error", error: "plan not found" });
      return;
    }
    if (action === "cancel") {
      planMsg.planState = "cancelled";
      tab.updatedAt = Date.now();
      saveWorkspace(projectId);
      broadcast(projectId, { type: "tab", tab });
      send({ type: "plan-ack", chatId, messageId, action: "cancel" });
      return;
    }
    if (action === "build") {
      planMsg.planState = "building";
      tab.mode = "agent";
      tab.updatedAt = Date.now();
      saveWorkspace(projectId);
      broadcast(projectId, { type: "mode", chatId, mode: "agent" });
      broadcast(projectId, { type: "tab", tab });
      send({ type: "plan-ack", chatId, messageId, action: "build" });
      const implement =
        "Implement the plan below. Follow it closely; do not ask to re-plan unless blocked.\n\n" +
        String(planMsg.text || "");
      void startRun(projectId, {
        chatId,
        prompt: implement,
        model: String(msg.model || tab.model || defaultModel()),
        mode: "agent",
        cwd: tab.cwd,
      });
      return;
    }
    send({ type: "error", error: "unknown plan action" });
    return;
  }

  if (type === "sudo") {
    const password = String(msg.password || "");
    if (!password) {
      send({ type: "sudo-ack", ok: false, error: "password required" });
      return;
    }
    const persistent = Boolean(msg.persistent);
    const status = persistent
      ? setPersistentSudo(password)
      : setSudo(password, Number(msg.ttlSec) || undefined);
    let fedSession = false;
    const sessionId = msg.sessionId ? String(msg.sessionId) : "";
    if (sessionId && password) {
      try {
        const { writeInput } = await import("./pty");
        // Interactive sudo on a PTY: feed password + newline once vaulted.
        writeInput(sessionId, `${password}\n`);
        fedSession = true;
      } catch {
        /* session may not exist (askpass-only flow) */
      }
    }
    send({
      type: "sudo-ack",
      ok: true,
      ...status,
      fedSession,
      persistent,
      chatId: msg.chatId,
      sessionId: msg.sessionId,
      callId: msg.callId,
    });
    broadcast(projectId, {
      type: "sudo-ack",
      ok: true,
      ...status,
      fedSession,
      persistent,
      chatId: msg.chatId,
    });
    return;
  }

  if (type === "sudo_allow") {
    const status = allowSudoUse(msg.id ? String(msg.id) : undefined);
    send({ type: "sudo-ack", ok: Boolean(status.ok !== false), ...status });
    broadcast(projectId, {
      type: "sudo-ack",
      ok: Boolean(status.ok !== false),
      ...status,
      allowed: true,
    });
    return;
  }

  if (type === "sudo_deny") {
    const status = denySudoUse(msg.id ? String(msg.id) : undefined);
    send({ type: "sudo-ack", ok: true, ...status, denied: true });
    broadcast(projectId, { type: "sudo-ack", ok: true, ...status, denied: true });
    return;
  }

  if (type === "sudo_clear") {
    clearSudo();
    send({ type: "sudo-ack", ok: true, cleared: true, ttlSec: 0, cached: false });
    return;
  }

  if (type === "sudo_clear_persistent") {
    clearPersistentSudo();
    clearSudo();
    send({
      type: "sudo-ack",
      ok: true,
      cleared: true,
      persistentCleared: true,
      ttlSec: 0,
      cached: false,
    });
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
    let storedId = ids[key] || tab.agentId || null;

    // After homebased restart / crashed wait(), SDK sqlite may still mark a run
    // active while Home Base's in-memory lock is free. Clear orphans before send.
    if (storedId) {
      const n = await clearStuckAgentRuns(storedId, cwd);
      if (n > 0) {
        appendTrace(
          "info",
          `cleared ${n} stuck SDK run(s) for ${storedId} before send`,
          "cursor",
        );
      }
    }

    const makeAgent = (agentId: string | null) =>
      createAgentHandle({
        projectId,
        chatId: opts.chatId,
        cwd,
        model: opts.model,
        mode: opts.mode,
        agentId,
      });

    let { agent } = await makeAgent(storedId);
    let agentId =
      (agent as { agentId?: string }).agentId ||
      (agent as { agent_id?: string }).agent_id ||
      storedId ||
      undefined;
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
    const textRole = assistantRoleForMode(opts.mode);
    const sendOpts = {
      mode: opts.mode === "plan" ? "plan" : "agent",
      onDelta: async ({ update }: { update: Record<string, unknown> }) => {
        if (ac.signal.aborted) return;
        const mapped = mapDeltaUpdate(update);
        if (!mapped) return;
        mapped.chatId = opts.chatId;

        if (mapped.type === "text-delta" || mapped.type === "text-snapshot") {
          const how = mapped.type === "text-snapshot" ? "replace" : "append";
          upsertStreamingBubble(tab, textRole, String(mapped.text || ""), how);
          mapped.role = textRole;
          scheduleSaveWorkspace(projectId);
          broadcast(projectId, mapped);
          return;
        }
        if (mapped.type === "thinking-delta" || mapped.type === "thinking-snapshot") {
          const how = mapped.type === "thinking-snapshot" ? "replace" : "append";
          upsertStreamingBubble(tab, "thinking", String(mapped.text || ""), how);
          scheduleSaveWorkspace(projectId);
          broadcast(projectId, mapped);
          return;
        }
        if (mapped.type === "thinking-completed") {
          const thinking = tab.messages.find((m) => m.role === "thinking" && m.streaming);
          if (thinking) {
            thinking.streaming = false;
            if (typeof mapped.ms === "number") thinking.durationMs = mapped.ms as number;
          }
          scheduleSaveWorkspace(projectId);
          broadcast(projectId, mapped);
          return;
        }
        if (mapped.type === "todo-delta") {
          sealStreamingAnswers(tab);
          const todos = Array.isArray(mapped.todos)
            ? (mapped.todos as ChatTodoItem[])
            : [];
          if (todos.length) {
            upsertTodoBubble(
              tab,
              todos,
              mapped.callId ? String(mapped.callId) : undefined,
            );
          }
          scheduleSaveWorkspace(projectId);
          broadcast(projectId, mapped);
          return;
        }
        if (mapped.type === "plan-delta") {
          // Structured plan card is the answer — still seal freeform text above tools.
          sealStreamingAnswers(tab);
          const plan = String(mapped.plan || "");
          if (plan.trim()) {
            upsertPlanBubble(
              tab,
              plan,
              mapped.callId ? String(mapped.callId) : undefined,
            );
          }
          scheduleSaveWorkspace(projectId);
          broadcast(projectId, mapped);
          return;
        }
        if (mapped.type === "task-delta") {
          sealStreamingAnswers(tab);
          upsertTaskBubble(tab, {
            status: String(mapped.status || "running"),
            detail: String(mapped.detail || mapped.taskName || "Task"),
            name: mapped.taskName ? String(mapped.taskName) : undefined,
            callId: mapped.callId ? String(mapped.callId) : undefined,
          });
          scheduleSaveWorkspace(projectId);
          broadcast(projectId, mapped);
          return;
        }
        if (mapped.type === "tool-delta") {
          sealStreamingAnswers(tab);
          const callId = mapped.callId ? String(mapped.callId) : "";
          const name = String(mapped.name || "tool");
          const status = String(mapped.status || "running");
          const detail =
            mapped.detail != null ? String(mapped.detail) : undefined;
          const path =
            mapped.path != null ? String(mapped.path) : undefined;
          const command =
            mapped.command != null ? String(mapped.command) : undefined;
          const editTool = Boolean(mapped.editTool);
          const shellTool = Boolean(mapped.shellTool);

          // Snapshot file before AI edit (best-effort).
          if (
            editTool &&
            path &&
            callId &&
            (status === "running" || status === "pending") &&
            !pendingFileBefore.has(callId)
          ) {
            try {
              const project = loadProjects().get(projectId);
              if (project) {
                const abs = path.startsWith("/")
                  ? path
                  : `${(opts.cwd || project.path).replace(/\/$/, "")}/${path}`;
                const data = readFile(project, abs);
                pendingFileBefore.set(callId, data.content);
              }
            } catch {
              pendingFileBefore.set(callId, "");
            }
          }

          let before =
            callId && pendingFileBefore.has(callId)
              ? pendingFileBefore.get(callId)
              : undefined;
          let after: string | undefined;
          if (editTool && (status === "completed" || status === "error")) {
            const oldStr =
              mapped.oldString != null ? String(mapped.oldString) : "";
            const newStr =
              mapped.newString != null ? String(mapped.newString) : "";
            const contents =
              mapped.contents != null ? String(mapped.contents) : "";
            if (contents) {
              after = contents;
            } else if (before != null && oldStr) {
              const idx = before.indexOf(oldStr);
              if (idx >= 0) {
                after =
                  before.slice(0, idx) + newStr + before.slice(idx + oldStr.length);
              }
            }
            if (after == null && path) {
              try {
                const project = loadProjects().get(projectId);
                if (project) {
                  const abs = path.startsWith("/")
                    ? path
                    : `${(opts.cwd || project.path).replace(/\/$/, "")}/${path}`;
                  after = readFile(project, abs).content;
                }
              } catch {
                /* ignore */
              }
            }
            if (callId) pendingFileBefore.delete(callId);
          }

          let output: string | undefined;
          if (shellTool && callId) {
            output = shellOutputBuf.get(callId);
            if (status === "completed" || status === "error") {
              shellOutputBuf.delete(callId);
            }
          }

          let toolMsg = callId
            ? tab.messages.find((m) => m.role === "tool" && m.tool?.callId === callId)
            : undefined;
          const toolFields = {
            name,
            status,
            detail: detail ?? toolMsg?.tool?.detail,
            callId: callId || toolMsg?.tool?.callId,
            path: path || toolMsg?.tool?.path,
            command: command || toolMsg?.tool?.command,
            output: output ?? toolMsg?.tool?.output,
            before: before ?? toolMsg?.tool?.before,
            after: after ?? toolMsg?.tool?.after,
          };
          if (!toolMsg) {
            toolMsg = {
              id: randomBytes(6).toString("hex"),
              role: "tool",
              text: "",
              at: Date.now(),
              tool: toolFields,
            };
            tab.messages.push(toolMsg);
          } else {
            toolMsg.tool = toolFields;
            toolMsg.at = Date.now();
          }

          // Dedicated file bubble for completed AI edits (click → diff editor).
          if (
            editTool &&
            path &&
            status === "completed" &&
            (before != null || after != null)
          ) {
            tab.messages.push({
              id: randomBytes(6).toString("hex"),
              role: "file",
              text: "",
              at: Date.now(),
              file: {
                path,
                action: name,
                before,
                after,
              },
            });
            mapped.file = { path, action: name, before, after };
          }

          mapped.path = toolFields.path;
          mapped.command = toolFields.command;
          mapped.output = toolFields.output;
          mapped.before = toolFields.before;
          mapped.after = toolFields.after;
          scheduleSaveWorkspace(projectId);
          broadcast(projectId, mapped);
          return;
        }
        if (mapped.type === "shell-delta") {
          const callId = mapped.callId ? String(mapped.callId) : "";
          const chunk = String(mapped.text || "");
          if (callId && chunk) {
            const prev = shellOutputBuf.get(callId) || "";
            const next = (prev + chunk).slice(-80_000);
            shellOutputBuf.set(callId, next);
            const toolMsg = tab.messages.find(
              (m) => m.role === "tool" && m.tool?.callId === callId,
            );
            if (toolMsg?.tool) {
              toolMsg.tool.output = next;
              mapped.output = next;
            }
          }
          broadcast(projectId, mapped);
          return;
        }
        broadcast(projectId, mapped);
      },
    };

    let run: AgentRun;
    try {
      run = await agent.send(sdkMessage, sendOpts);
    } catch (sendErr) {
      if (!isAgentBusyError(sendErr) || !agentId) throw sendErr;
      appendTrace(
        "warn",
        `agent busy on send (${agentId}); clearing stuck run and retrying`,
        "cursor",
      );
      broadcast(projectId, {
        type: "status-delta",
        chatId: opts.chatId,
        status: "clearing stuck run…",
      });
      await clearStuckAgentRuns(agentId, cwd);
      try {
        run = await agent.send(sdkMessage, sendOpts);
      } catch (retryErr) {
        if (!isAgentBusyError(retryErr)) throw retryErr;
        // Last resort: drop the stuck agent id and start a fresh conversation thread.
        appendTrace(
          "warn",
          `agent still busy after cancel (${agentId}); creating new agent`,
          "cursor",
        );
        delete ids[key];
        tab.agentId = null;
        saveAgentIds(ids);
        ;({ agent } = await makeAgent(null));
        agentId =
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
        run = await agent.send(sdkMessage, sendOpts);
      }
    }

    liveRuns.set(key, run);

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
      if (agentId) {
        try {
          await clearStuckAgentRuns(agentId, cwd);
        } catch {
          /* ignore */
        }
      }
    }
    const result: { status?: string; result?: string } =
      raced.kind === "done"
        ? raced.r
        : await waitPromise.catch(() => ({ status: "cancelled" as const }));

    for (const m of tab.messages) {
      if (m.streaming) m.streaming = false;
    }
    // Prefer final assistant text from the run when present — always at bottom
    // of the turn (after tools), not stuck above the activity trail.
    const finalText =
      typeof result.result === "string" ? result.result.trim() : "";
    if (finalText) {
      placeFinalAnswerAtBottom(tab, assistantRoleForMode(opts.mode), finalText);
    }
    // Ensure no tool/task bubble is left "running" after a clean finish.
    finalizeInterruptedTools(tab, "cancelled");

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
    const busy = isAgentBusyError(e);
    finalizeInterruptedTools(tab, "error");
    appendTrace("error", `cursor run ${key}: ${err}`, "cursor");
    broadcast(projectId, {
      type: "error",
      error: busy
        ? "Agent had a stuck run — cleared locks; press Stop if it persists, then send again."
        : err,
      chatId: opts.chatId,
      recoverable: true,
      busy,
    });
    // Auto-clear SDK orphans after locking-protocol / busy failures so the next
    // send does not immediately hit the same lock.
    if (busy) {
      const agentId = tab.agentId || loadAgentIds()[key];
      if (agentId) {
        try {
          await clearStuckAgentRuns(agentId, cwd);
        } catch {
          /* ignore */
        }
      }
    }
  } finally {
    liveRuns.delete(key);
    running.delete(key);
    tab.running = false;
    tab.updatedAt = Date.now();
    finalizeInterruptedTools(tab, "cancelled");
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
  invalidate = false,
): Promise<boolean> {
  const key = sessionKey(projectId, chatId);
  const ac = running.get(key);
  const live = liveRuns.get(key);
  let ok = false;
  if (ac) {
    ac.abort();
    ok = true;
  }
  if (live?.cancel) {
    try {
      await live.cancel();
      ok = true;
    } catch {
      /* ignore */
    }
  }
  const ws = loadWorkspace(projectId);
  const tab = ws.tabs.find((t) => t.id === chatId);
  const mapped = loadAgentIds()[key] || loadAgentIds()[`${projectId}:${chatId}`];
  const agentId = tab?.agentId || mapped;
  const cwd = resolveChatCwd(projectId, tab?.cwd);
  if (agentId && !invalidate) {
    const n = await clearStuckAgentRuns(agentId, cwd);
    if (n > 0) ok = true;
  }
  if (invalidate) {
    const removedId = unmapAgentId(projectId, chatId) || agentId;
    if (tab) {
      tab.agentId = null;
      tab.running = false;
      saveWorkspace(projectId);
    }
    if (removedId) void disposeAgentBackground(String(removedId), cwd);
    ok = true;
  }
  return ok;
}
