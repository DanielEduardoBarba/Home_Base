/**
 * Remote presence: who is remoted in (web GUI human vs MCP AI).
 * Drives the seat-user desktop presence window + MCP expression/chat.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RUNTIME_DIR, ensureRuntimeDirs } from "./config";
import { desktopNotify } from "./desktop_notify";
import { pushNotification } from "./notifications";
import { appendTrace } from "./trace";

const UI_TOKEN_PATH = join(RUNTIME_DIR, "presence_ui_token");
const HUMAN_TTL_MS = 45_000;
const AI_TTL_MS = 120_000;
const CHAT_CAP = 80;

export type PresenceKind = "human" | "ai";
export type PresenceMood =
  | "idle"
  | "thinking"
  | "happy"
  | "alert"
  | "working"
  | "listening";

export type PresenceActor = {
  id: string;
  kind: PresenceKind;
  name: string;
  label: string;
  mood: PresenceMood;
  bubble: string;
  peerIp?: string;
  lastSeen: number;
};

export type PresenceChatMsg = {
  id: string;
  from: "operator" | "ai" | "system";
  actorId?: string;
  actorName?: string;
  text: string;
  at: number;
};

type PresenceState = {
  actors: Map<string, PresenceActor>;
  chat: PresenceChatMsg[];
  windowWanted: boolean;
};

const state: PresenceState = {
  actors: new Map(),
  chat: [],
  windowWanted: false,
};

let pruneTimer: ReturnType<typeof setInterval> | null = null;
let onChange: (() => void) | null = null;

export function setPresenceChangeHandler(fn: (() => void) | null): void {
  onChange = fn;
}

function emitChange(): void {
  try {
    onChange?.();
  } catch {
    /* ignore */
  }
}

function ensurePrune(): void {
  if (pruneTimer) return;
  pruneTimer = setInterval(() => {
    pruneExpired();
  }, 5_000);
  if (typeof pruneTimer === "object" && "unref" in pruneTimer) {
    pruneTimer.unref();
  }
}

export function presenceUiToken(): string {
  ensureRuntimeDirs();
  if (existsSync(UI_TOKEN_PATH)) {
    try {
      const t = readFileSync(UI_TOKEN_PATH, "utf8").trim();
      if (t.length >= 24) return t;
    } catch {
      /* recreate */
    }
  }
  const t = randomBytes(24).toString("base64url");
  writeFileSync(UI_TOKEN_PATH, t + "\n", { mode: 0o600 });
  try {
    chmodSync(UI_TOKEN_PATH, 0o600);
  } catch {
    /* ignore */
  }
  return t;
}

export function verifyPresenceUiToken(token: string | undefined | null): boolean {
  if (!token) return false;
  return token === presenceUiToken();
}

function pruneExpired(): void {
  const now = Date.now();
  let changed = false;
  for (const [id, a] of state.actors) {
    const ttl = a.kind === "human" ? HUMAN_TTL_MS : AI_TTL_MS;
    if (now - a.lastSeen > ttl) {
      state.actors.delete(id);
      changed = true;
      appendTrace("info", `presence expired ${a.kind}:${a.name}`, "presence");
    }
  }
  const wanted = state.actors.size > 0;
  if (wanted !== state.windowWanted) {
    state.windowWanted = wanted;
    changed = true;
  }
  if (changed) emitChange();
}

function touchWindow(): void {
  ensurePrune();
  const wanted = state.actors.size > 0;
  if (wanted !== state.windowWanted) {
    state.windowWanted = wanted;
  }
  emitChange();
}

export function upsertPresence(opts: {
  id: string;
  kind: PresenceKind;
  name?: string;
  label?: string;
  peerIp?: string;
  mood?: PresenceMood;
  bubble?: string;
  announce?: boolean;
}): PresenceActor {
  const now = Date.now();
  const prev = state.actors.get(opts.id);
  const isNew = !prev;
  const actor: PresenceActor = {
    id: opts.id,
    kind: opts.kind,
    name:
      (opts.name || prev?.name || (opts.kind === "ai" ? "Grok" : "Remote user")).slice(
        0,
        48,
      ),
    label: (opts.label || prev?.label || (opts.kind === "ai" ? "MCP AI" : "Web GUI")).slice(
      0,
      64,
    ),
    mood: opts.mood || prev?.mood || "idle",
    bubble: opts.bubble != null ? String(opts.bubble).slice(0, 160) : prev?.bubble || "",
    peerIp: opts.peerIp || prev?.peerIp,
    lastSeen: now,
  };
  state.actors.set(opts.id, actor);
  touchWindow();
  if (isNew && opts.announce !== false) {
    const title =
      opts.kind === "ai" ? "AI remoted in (MCP)" : "Someone remoted in (Web)";
    const body = `${actor.name} · ${actor.label}${actor.peerIp ? ` · ${actor.peerIp}` : ""}`;
    pushNotification(title, body, {
      level: "warn",
      category: "security",
      meta: { kind: opts.kind, id: opts.id, peerIp: actor.peerIp },
    });
    desktopNotify(title, body, {
      urgency: "critical",
      dedupeKey: `presence-in:${opts.id}`,
      dedupeMs: 20_000,
    });
    appendTrace("warn", `presence join ${opts.kind}:${actor.name}`, "presence");
  }
  return actor;
}

export function expressPresence(
  id: string,
  patch: { mood?: PresenceMood; bubble?: string; name?: string },
): PresenceActor | null {
  const a = state.actors.get(id);
  if (!a) return null;
  if (patch.mood) a.mood = patch.mood;
  if (patch.bubble != null) a.bubble = String(patch.bubble).slice(0, 160);
  if (patch.name) a.name = String(patch.name).slice(0, 48);
  a.lastSeen = Date.now();
  state.actors.set(id, a);
  emitChange();
  return a;
}

export function dropPresence(id: string): boolean {
  const a = state.actors.get(id);
  if (!a) return false;
  state.actors.delete(id);
  touchWindow();
  appendTrace("info", `presence leave ${a.kind}:${a.name}`, "presence");
  return true;
}

export function listPresence(): PresenceActor[] {
  pruneExpired();
  return [...state.actors.values()].sort((a, b) => b.lastSeen - a.lastSeen);
}

export function presenceWindowWanted(): boolean {
  pruneExpired();
  return state.actors.size > 0;
}

export function pushPresenceChat(msg: {
  from: PresenceChatMsg["from"];
  text: string;
  actorId?: string;
  actorName?: string;
}): PresenceChatMsg {
  const row: PresenceChatMsg = {
    id: randomBytes(6).toString("hex"),
    from: msg.from,
    text: String(msg.text || "").trim().slice(0, 500),
    actorId: msg.actorId,
    actorName: msg.actorName,
    at: Date.now(),
  };
  if (!row.text) return row;
  state.chat.push(row);
  while (state.chat.length > CHAT_CAP) state.chat.shift();
  emitChange();
  if (msg.from === "ai") {
    desktopNotify(
      msg.actorName || "AI",
      row.text.slice(0, 120),
      { urgency: "normal", dedupeKey: `chat:${row.id}`, dedupeMs: 0 },
    );
  }
  return row;
}

export function listPresenceChat(since = 0): PresenceChatMsg[] {
  return state.chat.filter((m) => m.at > since);
}

export function presencePublic(): {
  actors: PresenceActor[];
  chat: PresenceChatMsg[];
  windowWanted: boolean;
  guidance: string;
} {
  return {
    actors: listPresence(),
    chat: listPresenceChat(),
    windowWanted: presenceWindowWanted(),
    guidance:
      "When remoted in via MCP, call homebase_presence_express to show mood/bubble on the operator desktop, " +
      "and homebase_presence_chat_send / _read to talk with the human at the laptop. " +
      "The presence window appears automatically — you cannot hide it. Vision Arm stays human-only.",
  };
}

const MOODS: PresenceMood[] = [
  "idle",
  "thinking",
  "happy",
  "alert",
  "working",
  "listening",
];

export function parseMood(raw: unknown): PresenceMood | undefined {
  const s = String(raw || "").toLowerCase();
  return MOODS.includes(s as PresenceMood) ? (s as PresenceMood) : undefined;
}
