/**
 * Soft / hard wipe of runtime user data.
 * Soft keeps auth, PIN, Cursor key, WG/CF, JWT secret, projects.
 * Hard clears user settings (localhost-gated at the route).
 */
import {
  existsSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  AUTH_PATH,
  CONFIG_DIR,
  JWT_SECRET_PATH,
  NOTIFICATIONS_PATH,
  PROJECTS_PATH,
  RUNTIME_DIR,
  ensureRuntimeDirs,
} from "./config";
import { clearLegal } from "./legal_state";
import { clearOnboarding } from "./onboarding_state";
import { clearCursorApiKey } from "./secrets_vault";

const KEEP_SOFT = new Set([
  "auth.json",
  "jwt_secret",
  "app_pin.json",
  "cursor_api_key.enc",
  "secrets_vault.key",
  "sudo_vault.key",
  "sudo_vault.enc",
  "sudo_vault.meta.json",
  "wireguard",
  "cloudflare_tunnel.json",
  "cloudflare_token.enc",
  "onboarding.json",
  "legal.json",
  "server_identity.json",
  "logs",
]);

function wipeDirContents(dir: string, keepNames?: Set<string>): number {
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const name of readdirSync(dir)) {
    if (keepNames?.has(name)) continue;
    try {
      rmSync(join(dir, name), { recursive: true, force: true });
      n += 1;
    } catch {
      /* ignore */
    }
  }
  return n;
}

export function softReset(): { ok: boolean; removed: number } {
  ensureRuntimeDirs();
  let removed = 0;
  // Chats
  removed += wipeDirContents(join(RUNTIME_DIR, "chats"));
  // Home Access widgets
  for (const name of ["home_access.json"]) {
    const p = join(RUNTIME_DIR, name);
    if (existsSync(p)) {
      try {
        unlinkSync(p);
        removed += 1;
      } catch {
        /* ignore */
      }
    }
  }
  // Notifications
  if (existsSync(NOTIFICATIONS_PATH)) {
    try {
      unlinkSync(NOTIFICATIONS_PATH);
      removed += 1;
    } catch {
      /* ignore */
    }
  }
  // Misc runtime (agents, security monitor, lockout stays? soft keeps auth — clear lockout)
  for (const name of [
    "agents.json",
    "security_monitor.json",
    "lockout.json",
  ]) {
    const p = join(RUNTIME_DIR, name);
    if (existsSync(p)) {
      try {
        unlinkSync(p);
        removed += 1;
      } catch {
        /* ignore */
      }
    }
  }
  return { ok: true, removed };
}

export function hardReset(): { ok: boolean; removed: number } {
  ensureRuntimeDirs();
  let removed = softReset().removed;
  // Wipe almost everything under runtime
  removed += wipeDirContents(RUNTIME_DIR, new Set(["logs"]));
  // Clear logs contents but keep dir
  removed += wipeDirContents(join(RUNTIME_DIR, "logs"));
  clearCursorApiKey();
  clearOnboarding();
  clearLegal();
  for (const p of [AUTH_PATH, JWT_SECRET_PATH]) {
    if (existsSync(p)) {
      try {
        unlinkSync(p);
        removed += 1;
      } catch {
        /* ignore */
      }
    }
  }
  // Empty projects registry
  try {
    writeFileSync(
      PROJECTS_PATH,
      '{\n  "projects": []\n}\n',
      { mode: 0o644 },
    );
    removed += 1;
  } catch {
    /* ignore */
  }
  // Cloudflare / leftover enc files already wiped via RUNTIME_DIR
  void KEEP_SOFT;
  void CONFIG_DIR;
  return { ok: true, removed };
}
