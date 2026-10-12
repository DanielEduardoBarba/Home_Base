/**
 * Friendly server display name — e.g. "Daniel's Home Base".
 * Defaults from the seat / OS username; user can override in onboarding or Settings.
 */
import {
  chmodSync,
  existsSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { RUNTIME_DIR, ensureRuntimeDirs } from "./config";
import { detectSeatUser } from "./shell_env";

const PATH = join(RUNTIME_DIR, "server_identity.json");

export type ServerIdentity = {
  displayName: string;
  updatedAt?: number;
};

function capitalize(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Best-effort human name from the OS seat user. */
export function guessOwnerName(): string {
  let raw = "";
  try {
    const seat = detectSeatUser();
    raw = seat.name || "";
  } catch {
    raw = "";
  }
  if (!raw || raw === "root") {
    raw =
      (process.env.SUDO_USER || "").trim() ||
      (process.env.USER || "").trim() ||
      (process.env.LOGNAME || "").trim() ||
      "Home";
  }
  if (raw === "root") raw = "Home";
  // DOMAIN\user or user@host
  raw = raw.split("\\").pop() || raw;
  raw = raw.split("@")[0] || raw;
  raw = raw.replace(/[._-]+/g, " ").trim() || "Home";
  // Title-case first token if single word; keep multi-word nicer
  const parts = raw.split(/\s+/).filter(Boolean);
  return parts.map(capitalize).join(" ") || "Home";
}

export function defaultDisplayName(owner = guessOwnerName()): string {
  const n = (owner || "Home").trim() || "Home";
  if (/^(home|user|nobody)$/i.test(n)) return "Home Base";
  return `${n}'s Home Base`;
}

export function loadIdentity(): ServerIdentity {
  if (!existsSync(PATH)) {
    return { displayName: defaultDisplayName() };
  }
  try {
    const raw = JSON.parse(readFileSync(PATH, "utf8")) as Partial<ServerIdentity>;
    const name = String(raw.displayName || "").trim();
    if (!name) return { displayName: defaultDisplayName() };
    return {
      displayName: name.slice(0, 64),
      updatedAt: Number(raw.updatedAt) || undefined,
    };
  } catch {
    return { displayName: defaultDisplayName() };
  }
}

export function saveIdentity(displayName: string): ServerIdentity {
  const cleaned = String(displayName || "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 64);
  if (!cleaned) throw new Error("Name required");
  ensureRuntimeDirs();
  const next: ServerIdentity = {
    displayName: cleaned,
    updatedAt: Date.now(),
  };
  writeFileSync(PATH, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  try {
    chmodSync(PATH, 0o600);
  } catch {
    /* ignore */
  }
  return next;
}

export function identityPublic(): {
  displayName: string;
  suggestedName: string;
  ownerGuess: string;
  customized: boolean;
} {
  const ownerGuess = guessOwnerName();
  const suggestedName = defaultDisplayName(ownerGuess);
  const customized = existsSync(PATH);
  const { displayName } = loadIdentity();
  return { displayName, suggestedName, ownerGuess, customized };
}

export function clearIdentity(): void {
  try {
    if (existsSync(PATH)) unlinkSync(PATH);
  } catch {
    /* ignore */
  }
}
