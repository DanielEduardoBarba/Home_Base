/**
 * Lightweight host integrity + attack signals → security notifications.
 * Never stores secrets; fingerprints vault/askpass files for tamper alerts.
 */
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { RUNTIME_DIR, ensureRuntimeDirs } from "./config";
import { pushNotification } from "./notifications";
import { sudoVaultFingerprint } from "./sudo";
import { lockoutStatus } from "./auth";

const STATE_PATH = join(RUNTIME_DIR, "security_monitor.json");
const CHECK_MS = 30_000;

type SecurityState = {
  vaultFp?: string;
  askpassMode?: number;
  askpassSize?: number;
  lastLockoutFail?: number;
  lastAuthBurstAt?: number;
  authBurstCount?: number;
};

let timer: ReturnType<typeof setInterval> | null = null;
let lastNotifyKey = "";
let lastNotifyAt = 0;

function loadState(): SecurityState {
  if (!existsSync(STATE_PATH)) return {};
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf8")) as SecurityState;
  } catch {
    return {};
  }
}

function saveState(s: SecurityState): void {
  ensureRuntimeDirs();
  try {
    writeFileSync(STATE_PATH, JSON.stringify(s) + "\n", { mode: 0o600 });
  } catch {
    /* ignore */
  }
}

function notifyOnce(
  key: string,
  title: string,
  body: string,
  level: "warn" | "error" = "warn",
): void {
  const now = Date.now();
  // Debounce identical alerts (5 min)
  if (key === lastNotifyKey && now - lastNotifyAt < 5 * 60_000) return;
  lastNotifyKey = key;
  lastNotifyAt = now;
  pushNotification(title, body, {
    level,
    category: "security",
    meta: { key, at: now },
  });
}

function askpassMeta(): { mode: number; size: number } | null {
  const path = join(RUNTIME_DIR, "sudo-askpass");
  if (!existsSync(path)) return null;
  try {
    const st = statSync(path);
    return { mode: st.mode & 0o777, size: st.size };
  } catch {
    return null;
  }
}

function checkVaultTamper(state: SecurityState): SecurityState {
  const fp = sudoVaultFingerprint();
  if (state.vaultFp && state.vaultFp !== fp) {
    notifyOnce(
      `vault-fp:${fp.slice(0, 12)}`,
      "Sudo vault changed",
      "Encrypted sudo key/vault or askpass helper was modified unexpectedly. Re-check Host security if you did not change it.",
      "error",
    );
  }
  return { ...state, vaultFp: fp };
}

function checkAskpass(state: SecurityState): SecurityState {
  // Read without rewriting (askpassPath() would refresh the helper every tick).
  const path = join(RUNTIME_DIR, "sudo-askpass");
  if (!existsSync(path)) {
    notifyOnce(
      "askpass-missing",
      "Askpass helper missing",
      "SUDO_ASKPASS helper is missing — elevated agent commands cannot prompt safely.",
      "error",
    );
    return state;
  }
  let meta: { mode: number; size: number };
  try {
    const st = statSync(path);
    meta = { mode: st.mode & 0o777, size: st.size };
  } catch {
    return state;
  }
  // Expect owner rwx only (0700). World/group readable is a red flag.
  if (meta.mode & 0o077) {
    notifyOnce(
      `askpass-mode:${meta.mode.toString(8)}`,
      "Askpass permissions unsafe",
      `sudo-askpass mode is 0o${meta.mode.toString(8)} (expected 0700). Possible tampering.`,
      "error",
    );
  }
  if (
    state.askpassSize != null &&
    state.askpassMode != null &&
    (state.askpassSize !== meta.size || state.askpassMode !== meta.mode)
  ) {
    notifyOnce(
      `askpass-meta:${meta.size}:${meta.mode}`,
      "Askpass helper altered",
      "The SUDO_ASKPASS script size or mode changed without a normal Home Base rewrite.",
      "warn",
    );
  }
  return { ...state, askpassMode: meta.mode, askpassSize: meta.size };
}

function checkAuthPressure(state: SecurityState): SecurityState {
  const lock = lockoutStatus();
  const failCount = Number(lock.failCount || 0);
  if (failCount >= 3 && failCount !== state.lastLockoutFail) {
    notifyOnce(
      `auth-fail:${failCount}`,
      "Repeated login failures",
      `${failCount} failed sign-in attempt${failCount === 1 ? "" : "s"} detected${
        lock.locked ? ` — lockout active (~${lock.retryAfter || 0}s).` : "."
      }`,
      failCount >= 5 ? "error" : "warn",
    );
  }
  return { ...state, lastLockoutFail: failCount };
}

/** Call when a request looks like probing / credential stuffing. */
export function noteSuspiciousRequest(opts: {
  ip?: string;
  path?: string;
  reason: string;
}): void {
  const ip = opts.ip || "unknown";
  const path = opts.path || "";
  notifyOnce(
    `probe:${ip}:${opts.reason}:${path.slice(0, 40)}`,
    "Suspicious request blocked",
    `${opts.reason}${path ? ` · ${path}` : ""} from ${ip}`,
    "warn",
  );
}

export function runSecurityCheck(): void {
  let state = loadState();
  state = checkVaultTamper(state);
  state = checkAskpass(state);
  state = checkAuthPressure(state);
  saveState(state);
}

export function startSecurityMonitor(): void {
  if (timer) return;
  // Baseline fingerprint on first run without alerting.
  const state = loadState();
  if (!state.vaultFp) {
    const fp = sudoVaultFingerprint();
    const meta = askpassMeta();
    saveState({
      vaultFp: fp,
      askpassMode: meta?.mode,
      askpassSize: meta?.size,
      lastLockoutFail: Number(lockoutStatus().failCount || 0),
    });
  }
  void runSecurityCheck();
  timer = setInterval(() => {
    try {
      runSecurityCheck();
    } catch {
      /* ignore */
    }
  }, CHECK_MS);
  if (typeof timer === "object" && timer && "unref" in timer) {
    try {
      (timer as NodeJS.Timeout).unref();
    } catch {
      /* ignore */
    }
  }
}

/** Hash helper for external integrity checks. */
export function hashFile(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return null;
  }
}
