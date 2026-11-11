/**
 * Home Base usage: local chat/tool/thinking aggregates + optional Cursor account/billing.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { RUNTIME_DIR, ensureRuntimeDirs, loadProjects } from "./config";
import {
  cursorApiKeyConfigured,
  loadCursorApiKey,
} from "./secrets_vault";
import { listActivity } from "./activity_audit";
import { listMcpTokens } from "./mcp_server";

const USAGE_DIR = () => join(RUNTIME_DIR, "usage");
const LEDGER_PATH = () => join(USAGE_DIR(), "ledger.jsonl");
const CACHE_PATH = () => join(USAGE_DIR(), "cursor_cache.json");

export type LedgerRow = {
  at: number;
  projectId: string;
  chatId: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
  thinkingMs?: number;
  source?: string;
};

export type DayBucket = {
  day: string;
  userMessages: number;
  assistantMessages: number;
  thinkingMs: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
};

export type HomebaseUsage = {
  chats: number;
  projectsWithChats: number;
  userMessages: number;
  assistantMessages: number;
  thinkingMessages: number;
  thinkingMs: number;
  toolCalls: number;
  toolErrors: number;
  fileEdits: number;
  imagesAttached: number;
  models: { id: string; chats: number }[];
  modes: { id: string; chats: number }[];
  byDay: DayBucket[];
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
    events: number;
    /** True when totals come only from post-ledger SDK captures (not full history). */
    ledgerOnly: boolean;
  };
  oldestAt: number | null;
  newestAt: number | null;
};

export type CursorAccount = {
  ok: boolean;
  configured: boolean;
  keyHint: string | null;
  me: {
    apiKeyName?: string;
    createdAt?: string;
    userId?: number;
    userEmail?: string;
    userFirstName?: string;
    userLastName?: string;
  } | null;
  meError?: string;
  /** Present when the key has Admin/Team API access. */
  billing: {
    available: boolean;
    error?: string;
    spendCents?: number;
    overallSpendCents?: number;
    members?: Array<{
      email?: string;
      name?: string;
      spendCents?: number;
      overallSpendCents?: number;
    }>;
    events?: {
      count: number;
      chargedCents: number;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
      byModel: { model: string; count: number; chargedCents: number }[];
      tokenBasedCount?: number;
      requestBasedCount?: number;
      byKind?: { kind: string; count: number }[];
    };
    range?: { startMs: number; endMs: number };
    subscriptionCycleStartMs?: number;
    totalMembers?: number;
  } | null;
  dashboardUrl: string;
  note: string;
};

/** Plan family: The X Subscription (new) vs legacy Cursor vs oldest request-based. */
export type PlanFamily =
  | "x_subscription"
  | "legacy_cursor"
  | "request_based"
  | "unknown";

export type PlanTier =
  | "free"
  | "plus"
  | "premium"
  | "super"
  | "ultra"
  | "hobby"
  | "start"
  | "pro"
  | "pro_plus"
  | "teams"
  | "teams_standard"
  | "teams_premium"
  | "enterprise"
  | "unknown";

export type PlanInfo = {
  family: PlanFamily;
  familyLabel: string;
  tier: PlanTier | null;
  tierLabel: string | null;
  /** How we know: auto = inferred; manual = user set in Settings. */
  source: "auto" | "manual";
  confidence: "high" | "medium" | "low";
  billingModel: "usage_based" | "request_based" | "mixed" | "unknown";
  cycleStartMs?: number;
  dashboardUrl: string;
  manageUrl: string;
  note: string;
  signals: string[];
};

export type ModelPoolId = "cursor_models" | "other_models" | "unknown";

export type ModelPoolRow = {
  id: string;
  pool: ModelPoolId;
  chats: number;
  events: number;
  chargedCents: number;
};

export type AiSources = {
  homebaseChat: {
    chats: number;
    models: number;
    tokensCaptured: number;
  };
  mcp: {
    tokenCount: number;
    tokens: Array<{ id: string; label: string; prefix: string; createdAt: number }>;
    toolCalls7d: number;
    actors7d: { label: string; calls: number }[];
  };
};

export type AiUsageBundle = {
  plan: PlanInfo;
  pools: {
    cursorModels: ModelPoolRow[];
    otherModels: ModelPoolRow[];
    unknown: ModelPoolRow[];
  };
  sources: AiSources;
  availableTiers: Array<{ family: PlanFamily; tier: PlanTier; label: string }>;
};

const PLAN_OVERRIDE_PATH = () => join(USAGE_DIR(), "plan_override.json");

export type PlanOverride = {
  family: PlanFamily | "auto";
  tier: PlanTier | null;
  updatedAt: number;
};

const FAMILY_LABELS: Record<PlanFamily, string> = {
  x_subscription: "The X Subscription",
  legacy_cursor: "Legacy Cursor plan",
  request_based: "Request-based (oldest legacy)",
  unknown: "Unknown plan",
};

const TIER_LABELS: Record<PlanTier, string> = {
  free: "Free",
  plus: "Plus",
  premium: "Premium",
  super: "Super",
  ultra: "Ultra",
  hobby: "Hobby",
  start: "Start",
  pro: "Pro",
  pro_plus: "Pro+",
  teams: "Teams",
  teams_standard: "Teams Standard",
  teams_premium: "Teams Premium",
  enterprise: "Enterprise",
  unknown: "Unknown",
};

export const AVAILABLE_PLAN_TIERS: AiUsageBundle["availableTiers"] = [
  { family: "x_subscription", tier: "free", label: "X · Free" },
  { family: "x_subscription", tier: "plus", label: "X · Plus" },
  { family: "x_subscription", tier: "premium", label: "X · Premium" },
  { family: "x_subscription", tier: "super", label: "X · Super" },
  { family: "x_subscription", tier: "ultra", label: "X · Ultra" },
  { family: "x_subscription", tier: "teams", label: "X · Teams" },
  { family: "legacy_cursor", tier: "hobby", label: "Legacy · Hobby" },
  { family: "legacy_cursor", tier: "start", label: "Legacy · Start" },
  { family: "legacy_cursor", tier: "pro", label: "Legacy · Pro" },
  { family: "legacy_cursor", tier: "pro_plus", label: "Legacy · Pro+" },
  { family: "legacy_cursor", tier: "ultra", label: "Legacy · Ultra" },
  { family: "legacy_cursor", tier: "teams_standard", label: "Legacy · Teams Standard" },
  { family: "legacy_cursor", tier: "teams_premium", label: "Legacy · Teams Premium" },
  { family: "request_based", tier: "pro", label: "Request-based · Pro-era" },
  { family: "request_based", tier: "unknown", label: "Request-based · Unknown tier" },
];

export function readPlanOverride(): PlanOverride | null {
  try {
    if (!existsSync(PLAN_OVERRIDE_PATH())) return null;
    const raw = JSON.parse(readFileSync(PLAN_OVERRIDE_PATH(), "utf8")) as PlanOverride;
    if (!raw || typeof raw !== "object") return null;
    return raw;
  } catch {
    return null;
  }
}

export function writePlanOverride(input: {
  family: PlanFamily | "auto";
  tier?: PlanTier | null;
}): PlanOverride {
  ensureUsageDir();
  const next: PlanOverride = {
    family: input.family,
    tier: input.family === "auto" ? null : input.tier ?? null,
    updatedAt: Date.now(),
  };
  writeFileSync(PLAN_OVERRIDE_PATH(), `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

/** Classify model id into Cursor Models pool vs Other Models (third-party). */
export function classifyModelPool(modelId: string): ModelPoolId {
  const m = String(modelId || "").trim().toLowerCase();
  if (!m || m === "unknown" || m === "auto") return "unknown";
  if (
    m.includes("grok") ||
    m.includes("composer") ||
    m.startsWith("cursor") ||
    m.includes("cheetah")
  ) {
    return "cursor_models";
  }
  if (
    m.includes("claude") ||
    m.includes("sonnet") ||
    m.includes("opus") ||
    m.includes("haiku") ||
    m.includes("gpt") ||
    m.includes("o1") ||
    m.includes("o3") ||
    m.includes("o4") ||
    m.includes("gemini") ||
    m.includes("flash") ||
    m.includes("deepseek") ||
    m.includes("mistral") ||
    m.includes("llama") ||
    m.includes("qwen") ||
    m.includes("anthropic") ||
    m.includes("openai")
  ) {
    return "other_models";
  }
  return "unknown";
}

function ensureUsageDir(): void {
  ensureRuntimeDirs();
  try {
    mkdirSync(USAGE_DIR(), { recursive: true });
  } catch {
    /* ignore */
  }
}

function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function bumpDay(
  map: Map<string, DayBucket>,
  day: string,
  patch: Partial<DayBucket>,
): void {
  const cur = map.get(day) || {
    day,
    userMessages: 0,
    assistantMessages: 0,
    thinkingMs: 0,
    toolCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
  };
  for (const [k, v] of Object.entries(patch)) {
    if (k === "day") continue;
    (cur as Record<string, number>)[k] =
      ((cur as Record<string, number>)[k] || 0) + (v as number);
  }
  map.set(day, cur);
}

/** Best-effort capture from SDK stream updates (usage / token-delta / thinking). */
export function recordUsageFromUpdate(
  update: Record<string, unknown>,
  ctx: { projectId: string; chatId: string; model?: string },
): void {
  const type = String(update.type || update.event || "").toLowerCase();
  const row: LedgerRow = {
    at: Date.now(),
    projectId: ctx.projectId,
    chatId: ctx.chatId,
    model: ctx.model,
    source: type || "sdk",
  };
  let keep = false;

  if (type.includes("usage") || type === "token-delta" || type === "token_delta") {
    const u =
      (update.usage as Record<string, unknown> | undefined) ||
      (update.tokenUsage as Record<string, unknown> | undefined) ||
      update;
    const input = num(u.inputTokens ?? u.input_tokens ?? update.inputTokens);
    const output = num(u.outputTokens ?? u.output_tokens ?? update.outputTokens);
    const cacheRead = num(
      u.cacheReadTokens ?? u.cache_read_tokens ?? update.cacheReadTokens,
    );
    const cacheWrite = num(
      u.cacheWriteTokens ?? u.cache_write_tokens ?? update.cacheWriteTokens,
    );
    const total = num(u.totalTokens ?? u.total_tokens) || input + output + cacheRead + cacheWrite;
    if (input || output || cacheRead || cacheWrite || total) {
      row.inputTokens = input;
      row.outputTokens = output;
      row.cacheReadTokens = cacheRead;
      row.cacheWriteTokens = cacheWrite;
      row.totalTokens = total;
      keep = true;
    }
  }

  if (type.includes("thinking") && type.includes("complet")) {
    const ms = num(
      update.thinkingDurationMs ??
        update.thinking_duration_ms ??
        update.ms ??
        update.durationMs,
    );
    if (ms > 0) {
      row.thinkingMs = ms;
      keep = true;
    }
  }

  if (!keep) return;
  ensureUsageDir();
  try {
    appendFileSync(LEDGER_PATH(), `${JSON.stringify(row)}\n`, "utf8");
  } catch {
    /* ignore */
  }
}

function readLedger(limit = 50_000): LedgerRow[] {
  const path = LEDGER_PATH();
  if (!existsSync(path)) return [];
  try {
    const lines = readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
    const slice = lines.length > limit ? lines.slice(-limit) : lines;
    const out: LedgerRow[] = [];
    for (const line of slice) {
      try {
        out.push(JSON.parse(line) as LedgerRow);
      } catch {
        /* ignore */
      }
    }
    return out;
  } catch {
    return [];
  }
}

type ChatMsgLite = {
  role?: string;
  at?: number;
  durationMs?: number;
  images?: unknown[];
  tool?: { status?: string };
  file?: unknown;
};

type ChatTabLite = {
  id?: string;
  model?: string;
  mode?: string;
  updatedAt?: number;
  messages?: ChatMsgLite[];
};

/** Aggregate Home Base chat history + SDK usage ledger. */
export function collectHomebaseUsage(): HomebaseUsage {
  ensureUsageDir();
  const chatsDir = join(RUNTIME_DIR, "chats");
  const modelCounts = new Map<string, number>();
  const modeCounts = new Map<string, number>();
  const byDay = new Map<string, DayBucket>();
  let chats = 0;
  let projectsWithChats = 0;
  let userMessages = 0;
  let assistantMessages = 0;
  let thinkingMessages = 0;
  let thinkingMs = 0;
  let toolCalls = 0;
  let toolErrors = 0;
  let fileEdits = 0;
  let imagesAttached = 0;
  let oldestAt: number | null = null;
  let newestAt: number | null = null;

  const touch = (ms?: number) => {
    if (!ms || !Number.isFinite(ms)) return;
    if (oldestAt == null || ms < oldestAt) oldestAt = ms;
    if (newestAt == null || ms > newestAt) newestAt = ms;
  };

  if (existsSync(chatsDir)) {
    for (const name of readdirSync(chatsDir)) {
      if (!name.endsWith(".json")) continue;
      let tabs: ChatTabLite[] = [];
      try {
        const raw = JSON.parse(readFileSync(join(chatsDir, name), "utf8")) as {
          tabs?: ChatTabLite[];
        };
        tabs = Array.isArray(raw.tabs) ? raw.tabs : [];
      } catch {
        continue;
      }
      if (!tabs.length) continue;
      projectsWithChats += 1;
      for (const tab of tabs) {
        chats += 1;
        const model = String(tab.model || "").trim() || "unknown";
        modelCounts.set(model, (modelCounts.get(model) || 0) + 1);
        const mode = String(tab.mode || "agent").trim() || "agent";
        modeCounts.set(mode, (modeCounts.get(mode) || 0) + 1);
        touch(tab.updatedAt);
        for (const m of tab.messages || []) {
          const at = num(m.at) || tab.updatedAt || 0;
          touch(at);
          const day = at ? dayKey(at) : dayKey(Date.now());
          const role = String(m.role || "");
          if (role === "user") {
            userMessages += 1;
            bumpDay(byDay, day, { userMessages: 1 });
            imagesAttached += Array.isArray(m.images) ? m.images.length : 0;
          } else if (
            role === "assistant" ||
            role === "ask" ||
            role === "plan" ||
            role === "debug"
          ) {
            assistantMessages += 1;
            bumpDay(byDay, day, { assistantMessages: 1 });
          } else if (role === "thinking") {
            thinkingMessages += 1;
            const ms = num(m.durationMs);
            thinkingMs += ms;
            if (ms) bumpDay(byDay, day, { thinkingMs: ms });
          } else if (role === "tool") {
            toolCalls += 1;
            bumpDay(byDay, day, { toolCalls: 1 });
            if (String(m.tool?.status || "") === "error") toolErrors += 1;
          } else if (role === "file" || m.file) {
            fileEdits += 1;
          }
        }
      }
    }
  }

  const ledger = readLedger();
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let total = 0;
  let events = 0;
  for (const row of ledger) {
    events += 1;
    input += num(row.inputTokens);
    output += num(row.outputTokens);
    cacheRead += num(row.cacheReadTokens);
    cacheWrite += num(row.cacheWriteTokens);
    total += num(row.totalTokens) ||
      num(row.inputTokens) +
        num(row.outputTokens) +
        num(row.cacheReadTokens) +
        num(row.cacheWriteTokens);
    if (row.thinkingMs) {
      // Prefer chat-derived thinking totals; ledger thinking is additive only if chats missed it.
    }
    if (row.at) {
      bumpDay(byDay, dayKey(row.at), {
        inputTokens: num(row.inputTokens),
        outputTokens: num(row.outputTokens),
      });
      touch(row.at);
    }
  }

  const days = [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
  const last30 = days.slice(-30);

  return {
    chats,
    projectsWithChats,
    userMessages,
    assistantMessages,
    thinkingMessages,
    thinkingMs,
    toolCalls,
    toolErrors,
    fileEdits,
    imagesAttached,
    models: [...modelCounts.entries()]
      .map(([id, n]) => ({ id, chats: n }))
      .sort((a, b) => b.chats - a.chats),
    modes: [...modeCounts.entries()]
      .map(([id, n]) => ({ id, chats: n }))
      .sort((a, b) => b.chats - a.chats),
    byDay: last30,
    tokens: {
      input,
      output,
      cacheRead,
      cacheWrite,
      total: total || input + output + cacheRead + cacheWrite,
      events,
      ledgerOnly: true,
    },
    oldestAt,
    newestAt,
  };
}

function basicAuth(apiKey: string): string {
  return `Basic ${Buffer.from(`${apiKey}:`, "utf8").toString("base64")}`;
}

async function cursorFetch(
  apiKey: string,
  path: string,
  init?: RequestInit,
): Promise<{ ok: boolean; status: number; json: unknown; error?: string }> {
  try {
    const res = await fetch(`https://api.cursor.com${path}`, {
      ...init,
      headers: {
        Authorization: basicAuth(apiKey),
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(init?.headers || {}),
      },
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { raw: text.slice(0, 400) };
    }
    if (!res.ok) {
      const msg =
        (json as { message?: string; error?: string } | null)?.message ||
        (json as { error?: string } | null)?.error ||
        `HTTP ${res.status}`;
      return { ok: false, status: res.status, json, error: String(msg) };
    }
    return { ok: true, status: res.status, json };
  } catch (e) {
    return {
      ok: false,
      status: 0,
      json: null,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

function keyHint(apiKey: string): string {
  const k = apiKey.trim();
  if (k.length < 10) return "••••";
  return `${k.slice(0, 4)}…${k.slice(-4)}`;
}

type CursorCache = {
  at: number;
  account: CursorAccount;
};

function readCursorCache(): CursorCache | null {
  try {
    if (!existsSync(CACHE_PATH())) return null;
    return JSON.parse(readFileSync(CACHE_PATH(), "utf8")) as CursorCache;
  } catch {
    return null;
  }
}

function writeCursorCache(account: CursorAccount): void {
  ensureUsageDir();
  try {
    writeFileSync(
      CACHE_PATH(),
      `${JSON.stringify({ at: Date.now(), account } satisfies CursorCache)}\n`,
      "utf8",
    );
  } catch {
    /* ignore */
  }
}

/** Fetch Cursor identity + best-effort team billing (Admin API when key allows). */
export async function fetchCursorAccount(opts?: {
  force?: boolean;
}): Promise<CursorAccount> {
  const configured = cursorApiKeyConfigured() || Boolean((process.env.CURSOR_API_KEY || "").trim());
  const apiKey = (loadCursorApiKey() || process.env.CURSOR_API_KEY || "").trim();
  const baseNote =
    "Personal Cursor API keys unlock Chat and account identity. Team spend/usage needs an Admin API key (Enterprise). Full invoices stay on cursor.com/dashboard.";

  if (!configured || !apiKey) {
    return {
      ok: false,
      configured: false,
      keyHint: null,
      me: null,
      billing: null,
      dashboardUrl: "https://cursor.com/dashboard",
      note: "Add a Cursor API key in Settings to link account info.",
    };
  }

  if (!opts?.force) {
    const cached = readCursorCache();
    if (cached && Date.now() - cached.at < 15 * 60_000) {
      return { ...cached.account, keyHint: keyHint(apiKey) };
    }
  }

  const meRes = await cursorFetch(apiKey, "/v1/me");
  const me = meRes.ok
    ? (meRes.json as CursorAccount["me"])
    : null;

  const endMs = Date.now();
  const startMs = endMs - 30 * 24 * 60 * 60 * 1000;

  let billing: CursorAccount["billing"] = {
    available: false,
    range: { startMs, endMs },
  };

  const spendRes = await cursorFetch(apiKey, "/teams/spend", {
    method: "POST",
    body: JSON.stringify({ page: 1, pageSize: 50 }),
  });

  if (spendRes.ok) {
    const data = spendRes.json as {
      teamMemberSpend?: Array<Record<string, unknown>>;
      totalSpendCents?: number;
      totalMembers?: number;
      subscriptionCycleStart?: number;
    };
    const members = (data.teamMemberSpend || []).map((m) => ({
      email: m.email ? String(m.email) : undefined,
      name: m.name ? String(m.name) : undefined,
      spendCents: num(m.spendCents),
      overallSpendCents: num(m.overallSpendCents),
    }));
    const spendCents = members.reduce((s, m) => s + (m.spendCents || 0), 0);
    const overallSpendCents = members.reduce(
      (s, m) => s + (m.overallSpendCents || 0),
      num(data.totalSpendCents),
    );
    billing = {
      available: true,
      spendCents,
      overallSpendCents: overallSpendCents || spendCents,
      members: members.slice(0, 25),
      range: { startMs, endMs },
      subscriptionCycleStartMs: num(data.subscriptionCycleStart) || undefined,
      totalMembers: num(data.totalMembers) || members.length || undefined,
    };

    const eventsRes = await cursorFetch(apiKey, "/teams/filtered-usage-events", {
      method: "POST",
      body: JSON.stringify({
        startDate: startMs,
        endDate: endMs,
        page: 1,
        pageSize: 200,
      }),
    });
    if (eventsRes.ok) {
      const ev = eventsRes.json as {
        totalUsageEventsCount?: number;
        usageEvents?: Array<Record<string, unknown>>;
      };
      const usageEvents = Array.isArray(ev.usageEvents) ? ev.usageEvents : [];
      let chargedCents = 0;
      let inputTokens = 0;
      let outputTokens = 0;
      let cacheReadTokens = 0;
      let cacheWriteTokens = 0;
      let tokenBasedCount = 0;
      let requestBasedCount = 0;
      const byModel = new Map<string, { count: number; chargedCents: number }>();
      const byKind = new Map<string, number>();
      for (const e of usageEvents) {
        const cents = num(e.chargedCents);
        chargedCents += cents;
        const tu = (e.tokenUsage || {}) as Record<string, unknown>;
        inputTokens += num(tu.inputTokens);
        outputTokens += num(tu.outputTokens);
        cacheReadTokens += num(tu.cacheReadTokens);
        cacheWriteTokens += num(tu.cacheWriteTokens);
        const model = String(e.model || e.modelType || "unknown");
        const cur = byModel.get(model) || { count: 0, chargedCents: 0 };
        cur.count += 1;
        cur.chargedCents += cents;
        byModel.set(model, cur);
        if (e.isTokenBasedCall === true) tokenBasedCount += 1;
        else if (e.isTokenBasedCall === false) requestBasedCount += 1;
        const kind = String(e.kind || "").trim() || "unknown";
        byKind.set(kind, (byKind.get(kind) || 0) + 1);
      }
      billing.events = {
        count: num(ev.totalUsageEventsCount) || usageEvents.length,
        chargedCents,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens,
        tokenBasedCount,
        requestBasedCount,
        byKind: [...byKind.entries()]
          .map(([kind, count]) => ({ kind, count }))
          .sort((a, b) => b.count - a.count)
          .slice(0, 8),
        byModel: [...byModel.entries()]
          .map(([model, v]) => ({ model, ...v }))
          .sort((a, b) => b.chargedCents - a.chargedCents)
          .slice(0, 12),
      };
    }
  } else {
    billing = {
      available: false,
      error: spendRes.error || "Admin API not available for this key",
      range: { startMs, endMs },
    };
  }

  const account: CursorAccount = {
    ok: Boolean(meRes.ok),
    configured: true,
    keyHint: keyHint(apiKey),
    me,
    meError: meRes.ok ? undefined : meRes.error,
    billing,
    dashboardUrl: "https://cursor.com/dashboard",
    note: billing.available
      ? "Billing figures from Cursor Admin API (team key). Local Home Base stats are below."
      : baseNote,
  };
  writeCursorCache(account);
  return account;
}

function collectMcpSources(): AiSources["mcp"] {
  let tokens: AiSources["mcp"]["tokens"] = [];
  try {
    tokens = listMcpTokens().map((t) => ({
      id: t.id,
      label: t.label,
      prefix: t.prefix,
      createdAt: t.createdAt,
    }));
  } catch {
    tokens = [];
  }

  let toolCalls7d = 0;
  const actorMap = new Map<string, number>();
  const since = Date.now() - 7 * 24 * 60 * 60 * 1000;
  try {
    for (let i = 0; i < 8; i++) {
      const day = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
      const page = listActivity({ day, source: "mcp", limit: 5000 });
      for (const ev of page.events) {
        if (ev.at < since) continue;
        if (ev.kind !== "tool") continue;
        toolCalls7d += 1;
        const label = String(ev.actor || "MCP").trim() || "MCP";
        actorMap.set(label, (actorMap.get(label) || 0) + 1);
      }
    }
  } catch {
    /* ignore */
  }

  return {
    tokenCount: tokens.length,
    tokens,
    toolCalls7d,
    actors7d: [...actorMap.entries()]
      .map(([label, calls]) => ({ label, calls }))
      .sort((a, b) => b.calls - a.calls)
      .slice(0, 12),
  };
}

function buildModelPools(
  homebase: HomebaseUsage,
  cursor: CursorAccount,
): AiUsageBundle["pools"] {
  const map = new Map<string, ModelPoolRow>();
  const bump = (
    id: string,
    patch: { chats?: number; events?: number; chargedCents?: number },
  ) => {
    const key = String(id || "unknown").trim() || "unknown";
    const cur = map.get(key) || {
      id: key,
      pool: classifyModelPool(key),
      chats: 0,
      events: 0,
      chargedCents: 0,
    };
    cur.chats += patch.chats || 0;
    cur.events += patch.events || 0;
    cur.chargedCents += patch.chargedCents || 0;
    cur.pool = classifyModelPool(key);
    map.set(key, cur);
  };
  for (const m of homebase.models) bump(m.id, { chats: m.chats });
  for (const m of cursor.billing?.events?.byModel || []) {
    bump(m.model, { events: m.count, chargedCents: m.chargedCents });
  }
  const rows = [...map.values()].sort(
    (a, b) => b.chats + b.events - (a.chats + a.events),
  );
  return {
    cursorModels: rows.filter((r) => r.pool === "cursor_models"),
    otherModels: rows.filter((r) => r.pool === "other_models"),
    unknown: rows.filter((r) => r.pool === "unknown"),
  };
}

function inferPlan(homebase: HomebaseUsage, cursor: CursorAccount): PlanInfo {
  const override = readPlanOverride();
  const signals: string[] = [];
  const tokenBased = cursor.billing?.events?.tokenBasedCount || 0;
  const requestBased = cursor.billing?.events?.requestBasedCount || 0;
  const totalSignal = tokenBased + requestBased;

  let billingModel: PlanInfo["billingModel"] = "unknown";
  if (totalSignal > 0) {
    if (tokenBased > 0 && requestBased > 0 && Math.min(tokenBased, requestBased) / totalSignal > 0.15) {
      billingModel = "mixed";
      signals.push(`Events mix token (${tokenBased}) + request (${requestBased}) billing`);
    } else if (tokenBased >= requestBased) {
      billingModel = "usage_based";
      signals.push(`Admin usage events look usage-based (${tokenBased}/${totalSignal})`);
    } else {
      billingModel = "request_based";
      signals.push(`Admin usage events look request-based (${requestBased}/${totalSignal})`);
    }
  } else if (cursor.billing?.available) {
    signals.push("Team Admin API reachable, but no recent usage events to classify billing");
  } else if (cursor.configured) {
    signals.push("Personal API key — plan tier is not exposed; set it below or open the dashboard");
  } else {
    signals.push("No Cursor API key — local Home Base + MCP activity only");
  }

  const pools = buildModelPools(homebase, cursor);
  if (pools.cursorModels.length) {
    signals.push(
      `Cursor Models seen: ${pools.cursorModels
        .slice(0, 3)
        .map((m) => m.id)
        .join(", ")}`,
    );
  }
  if (pools.otherModels.length) {
    signals.push(
      `Other Models seen: ${pools.otherModels
        .slice(0, 3)
        .map((m) => m.id)
        .join(", ")}`,
    );
  }

  let family: PlanFamily = "unknown";
  let confidence: PlanInfo["confidence"] = "low";
  let tier: PlanTier | null = null;

  if (billingModel === "request_based") {
    family = "request_based";
    confidence = totalSignal >= 5 ? "high" : "medium";
  } else if (billingModel === "usage_based" || billingModel === "mixed") {
    // Usage-based spans both The X Subscription and newer legacy Pro/Pro+/Ultra.
    // Prefer Other Models pool activity as a soft legacy signal (X does not include that pool).
    if (pools.otherModels.some((m) => m.events > 0 || m.chats > 0) && pools.cursorModels.length) {
      family = "legacy_cursor";
      confidence = "medium";
      signals.push("Both Cursor + Other model pools in use → likely legacy Cursor plan");
    } else if (pools.cursorModels.length && !pools.otherModels.length) {
      family = "x_subscription";
      confidence = "low";
      signals.push("Mostly Cursor Models → could be The X Subscription (confirm in Settings)");
    } else {
      family = "legacy_cursor";
      confidence = "low";
      signals.push("Usage-based billing detected; family ambiguous without dashboard");
    }
  }

  if (cursor.billing?.totalMembers && cursor.billing.totalMembers > 1) {
    tier = family === "x_subscription" ? "teams" : "teams_standard";
    signals.push(`Team has ${cursor.billing.totalMembers} members`);
    if (confidence === "low") confidence = "medium";
  }

  if (override && override.family !== "auto") {
    family = override.family;
    tier = override.tier;
    confidence = "high";
    signals.unshift("Plan set manually in Home Base Settings");
  } else if (override?.tier) {
    tier = override.tier;
    signals.unshift("Tier set manually in Home Base Settings");
    confidence = confidence === "low" ? "medium" : confidence;
  }

  const dashboardUrl =
    family === "x_subscription"
      ? "https://grok.com/dashboard"
      : "https://cursor.com/dashboard";
  const manageUrl =
    family === "x_subscription"
      ? "https://grok.com/dashboard/billing"
      : family === "legacy_cursor"
        ? "https://cursor.com/dashboard/spending"
        : "https://cursor.com/dashboard/billing";

  let note =
    "Cursor does not expose personal plan tier on the Chat API key. We infer billing family from Admin usage events when available; set your plan below for an exact badge.";
  if (override && override.family !== "auto") {
    note = "Showing the plan you set in Home Base. Clear to auto-detect again.";
  } else if (family === "x_subscription") {
    note =
      "The X Subscription uses one weekly Cursor-models pool (shared with Grok). Manage billing on grok.com.";
  } else if (family === "legacy_cursor") {
    note =
      "Legacy Cursor plans use monthly Cursor Models + Other Models pools. Spending lives on cursor.com/dashboard.";
  } else if (family === "request_based") {
    note =
      "Oldest request-based pricing. Migrates to usage-based at renewal — see Cursor docs.";
  }

  return {
    family,
    familyLabel: FAMILY_LABELS[family],
    tier,
    tierLabel: tier ? TIER_LABELS[tier] : null,
    source: override && override.family !== "auto" ? "manual" : "auto",
    confidence,
    billingModel,
    cycleStartMs: cursor.billing?.subscriptionCycleStartMs,
    dashboardUrl,
    manageUrl,
    note,
    signals: signals.slice(0, 8),
  };
}

function buildAiBundle(homebase: HomebaseUsage, cursor: CursorAccount): AiUsageBundle {
  return {
    plan: inferPlan(homebase, cursor),
    pools: buildModelPools(homebase, cursor),
    sources: {
      homebaseChat: {
        chats: homebase.chats,
        models: homebase.models.length,
        tokensCaptured: homebase.tokens.total,
      },
      mcp: collectMcpSources(),
    },
    availableTiers: AVAILABLE_PLAN_TIERS,
  };
}

export async function usageOverview(opts?: { force?: boolean }): Promise<{
  homebase: HomebaseUsage;
  cursor: CursorAccount;
  ai: AiUsageBundle;
  projects: number;
  generatedAt: number;
}> {
  const [homebase, cursor] = await Promise.all([
    Promise.resolve(collectHomebaseUsage()),
    fetchCursorAccount(opts),
  ]);
  return {
    homebase,
    cursor,
    ai: buildAiBundle(homebase, cursor),
    projects: loadProjects().size,
    generatedAt: Date.now(),
  };
}
