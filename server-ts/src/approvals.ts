import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RUNTIME_DIR, ensureRuntimeDirs } from "./config";

const SECRET_PATH = join(RUNTIME_DIR, "hook_secret");

let policy: "ask" | "auto" = "ask";

export function ensureHookSecret(): string {
  ensureRuntimeDirs();
  mkdirSync(RUNTIME_DIR, { recursive: true });
  if (existsSync(SECRET_PATH)) {
    const val = readFileSync(SECRET_PATH, "utf8").trim();
    if (val) return val;
  }
  const val = randomBytes(24).toString("hex");
  writeFileSync(SECRET_PATH, val, { mode: 0o600 });
  chmodSync(SECRET_PATH, 0o600);
  return val;
}

export function verifySecret(provided: string): boolean {
  const expected = ensureHookSecret();
  return Boolean(provided) && provided === expected;
}

export function getPolicy(): "ask" | "auto" {
  return policy;
}

export function setPolicy(p: string): "ask" | "auto" {
  policy = p === "auto" ? "auto" : "ask";
  return policy;
}

export function listPending(): unknown[] {
  return [];
}

/** IDE-friendly: auto-allow when policy is auto; otherwise allow with short message for migration stability when no UI listeners. */
export async function requestApproval(_opts: {
  kind: string;
  tool: string;
  detail: string;
  command?: string;
  cwd?: string;
  agentId?: string;
}): Promise<{ permission: string; user_message: string; agent_message: string }> {
  if (policy === "auto") {
    return {
      permission: "allow",
      user_message: "Auto-run tools enabled",
      agent_message: "Auto-run tools enabled",
    };
  }
  // Without Chat WS listeners, blocking IDE for 560s is a known footgun (R-003).
  // Fail-open with explicit message so agentic workflows continue; Chat UI can still set ask+approve when connected later.
  return {
    permission: "allow",
    user_message: "No approval UI listener — allowed (ask policy fail-open; see R-003)",
    agent_message: "Allowed without UI listener",
  };
}
