/**
 * Remote presence: who is remoted in (web GUI human vs MCP AI).
 * Drives the seat-user desktop presence window + MCP expression/chat.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RUNTIME_DIR, ensureRuntimeDirs } from "./config";
import { desktopClose, desktopNotify } from "./desktop_notify";
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

/** Grok-style blob silhouette the desktop Presence window renders. */
export type PresenceForm =
  | "pill"
  | "cloud"
  | "drop"
  | "circle"
  | "hex"
  | "diamond"
  | "soft"
  | "cluster";

export type PresenceActor = {
  id: string;
  kind: PresenceKind;
  name: string;
  label: string;
  mood: PresenceMood;
  bubble: string;
  /** Cartoon form (AI-controllable). */
  form: PresenceForm;
  /** CSS/hex color for the blob. */
  color: string;
  /** 0..1 animation intensity / expressiveness. */
  energy: number;
  peerIp?: string;
  lastSeen: number;
};

const FORMS: PresenceForm[] = [
  "pill",
  "cloud",
  "drop",
  "circle",
  "hex",
  "diamond",
  "soft",
  "cluster",
];

const AI_PALETTE = [
  "#ff4d8d",
  "#7c5cff",
  "#3ecf8e",
  "#ff8a3d",
  "#4da3ff",
  "#f0b429",
  "#2dd4bf",
  "#f472b6",
  "#a78bfa",
  "#ffffff",
];

export function parseForm(raw: unknown): PresenceForm | undefined {
  const s = String(raw || "").toLowerCase().trim();
  return FORMS.includes(s as PresenceForm) ? (s as PresenceForm) : undefined;
}

export function parseEnergy(raw: unknown): number | undefined {
  if (raw == null || raw === "") return undefined;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return undefined;
  return Math.max(0, Math.min(1, n));
}

export function parseColor(raw: unknown): string | undefined {
  const s = String(raw || "").trim();
  if (!s) return undefined;
  if (/^#[0-9a-fA-F]{3,8}$/.test(s)) return s;
  if (/^[a-zA-Z]{3,20}$/.test(s)) return s;
  return undefined;
}

function hashHue(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h;
}

export function defaultFormFor(id: string, kind: PresenceKind): PresenceForm {
  if (kind === "human") return "circle";
  return FORMS[hashHue(id) % FORMS.length]!;
}

export function defaultColorFor(id: string, kind: PresenceKind): string {
  if (kind === "human") return "#4da3ff";
  return AI_PALETTE[hashHue(id) % AI_PALETTE.length]!;
}

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
      desktopClose(`presence:${id}`);
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
  form?: PresenceForm;
  color?: string;
  energy?: number;
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
    form: opts.form || prev?.form || defaultFormFor(opts.id, opts.kind),
    color: opts.color || prev?.color || defaultColorFor(opts.id, opts.kind),
    energy:
      opts.energy != null
        ? opts.energy
        : prev?.energy != null
          ? prev.energy
          : opts.kind === "ai"
            ? 0.45
            : 0.2,
    peerIp: opts.peerIp || prev?.peerIp,
    lastSeen: now,
  };
  state.actors.set(opts.id, actor);
  touchWindow();
  if (isNew && opts.announce !== false) {
    const localIp =
      !actor.peerIp ||
      actor.peerIp === "127.0.0.1" ||
      actor.peerIp === "::1" ||
      actor.peerIp === "localhost";
    const title =
      opts.kind === "ai" ? "AI connected" : "Someone signed in";
    const body = `${actor.name}${actor.peerIp && !localIp ? ` · ${actor.peerIp}` : ""}`;
    // Inbox history still records joins; desktop tray stays quiet for local browser.
    pushNotification(title, body, {
      level: opts.kind === "ai" ? "info" : "warn",
      category: "security",
      meta: { kind: opts.kind, id: opts.id, peerIp: actor.peerIp },
    });
    if (!(opts.kind === "human" && localIp)) {
      desktopNotify(title, body, {
        urgency: "low",
        replaceKey: `presence:${opts.id}`,
        dedupeKey: `presence-in:${opts.id}`,
        dedupeMs: 120_000,
        expireMs: 4_000,
      });
    }
    appendTrace("info", `presence join ${opts.kind}:${actor.name}`, "presence");
  }
  return actor;
}

export function expressPresence(
  id: string,
  patch: {
    mood?: PresenceMood;
    bubble?: string;
    name?: string;
    form?: PresenceForm;
    color?: string;
    energy?: number;
  },
): PresenceActor | null {
  const a = state.actors.get(id);
  if (!a) return null;
  if (patch.mood) a.mood = patch.mood;
  if (patch.bubble != null) a.bubble = String(patch.bubble).slice(0, 160);
  if (patch.name) a.name = String(patch.name).slice(0, 48);
  if (patch.form) a.form = patch.form;
  if (patch.color) a.color = patch.color;
  if (patch.energy != null) a.energy = patch.energy;
  a.lastSeen = Date.now();
  state.actors.set(id, a);
  emitChange();
  return a;
}

export function dropPresence(id: string): boolean {
  const a = state.actors.get(id);
  if (!a) return false;
  state.actors.delete(id);
  desktopClose(`presence:${id}`);
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
  // Chat lives in the Presence window — no desktop toast per message.
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
