import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { RUNTIME_DIR, ensureRuntimeDirs, bindPort } from "./config";

const PASS_PATH = join(RUNTIME_DIR, "sudo_askpass.pass");
const META_PATH = join(RUNTIME_DIR, "sudo_askpass.meta");
const PENDING_PATH = join(RUNTIME_DIR, "sudo_askpass.pending");
const ASKPASS_PATH = join(RUNTIME_DIR, "sudo-askpass");
const KEY_PATH = join(RUNTIME_DIR, "sudo_vault.key");
const PERSIST_PATH = join(RUNTIME_DIR, "sudo_vault.enc");
const DEFAULT_TTL = 600;

type Meta = { expiresAt: number; sessionOnly?: boolean };

export type SudoPending = {
  id: string;
  at: number;
  command: string;
  prompt: string;
  chatId?: string;
  sessionId?: string;
  callId?: string;
  /** Waiting for explicit Allow before decrypting vault into askpass. */
  needsAllow?: boolean;
};

let pending: SudoPending | null = null;
/** Outcome for askpass pollers: allow → password ready; deny → refused. */
const releaseState = new Map<string, "allow" | "deny">();

function loadMeta(): Meta | null {
  if (!existsSync(META_PATH)) return null;
  try {
    const raw = readFileSync(META_PATH, "utf8").trim();
    if (/^\d+(\.\d+)?$/.test(raw)) return { expiresAt: Number(raw) };
    return JSON.parse(raw) as Meta;
  } catch {
    return null;
  }
}

function vaultKey(): Buffer {
  ensureRuntimeDirs();
  mkdirSync(RUNTIME_DIR, { recursive: true });
  if (existsSync(KEY_PATH)) {
    const raw = readFileSync(KEY_PATH);
    if (raw.length >= 32) return raw.subarray(0, 32);
  }
  const key = randomBytes(32);
  writeFileSync(KEY_PATH, key, { mode: 0o600 });
  chmodSync(KEY_PATH, 0o600);
  return key;
}

function encryptSecret(plain: string): string {
  const key = vaultKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({
    v: 1,
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ct: ct.toString("base64"),
  });
}

function decryptSecret(blob: string): string | null {
  try {
    const o = JSON.parse(blob) as {
      v?: number;
      iv?: string;
      tag?: string;
      ct?: string;
    };
    if (o.v !== 1 || !o.iv || !o.tag || !o.ct) return null;
    const key = vaultKey();
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(o.iv, "base64"),
    );
    decipher.setAuthTag(Buffer.from(o.tag, "base64"));
    const pt = Buffer.concat([
      decipher.update(Buffer.from(o.ct, "base64")),
      decipher.final(),
    ]);
    return pt.toString("utf8");
  } catch {
    return null;
  }
}

function purgeIfExpired(): void {
  const meta = loadMeta();
  if (!meta) return;
  if (Date.now() / 1000 >= meta.expiresAt) {
    try {
      if (existsSync(PASS_PATH)) unlinkSync(PASS_PATH);
      if (existsSync(META_PATH)) unlinkSync(META_PATH);
    } catch {
      /* ignore */
    }
  }
}

function readPendingFile(): SudoPending | null {
  if (!existsSync(PENDING_PATH)) return null;
  try {
    return JSON.parse(readFileSync(PENDING_PATH, "utf8")) as SudoPending;
  } catch {
    return null;
  }
}

function writeSessionCipher(password: string, ttlSec: number): void {
  const blob = encryptSecret(password);
  writeFileSync(PASS_PATH, blob, { mode: 0o600 });
  chmodSync(PASS_PATH, 0o600);
  const expiresAt = Date.now() / 1000 + Math.max(30, ttlSec);
  writeFileSync(
    META_PATH,
    JSON.stringify({ expiresAt, sessionOnly: true }),
    { mode: 0o600 },
  );
  chmodSync(META_PATH, 0o600);
}

function readSessionPassword(): string | null {
  purgeIfExpired();
  if (!existsSync(PASS_PATH) || !existsSync(META_PATH)) return null;
  try {
    const blob = readFileSync(PASS_PATH, "utf8");
    // Legacy plaintext fallback (pre-encrypt installs)
    if (!blob.trim().startsWith("{")) {
      return blob;
    }
    return decryptSecret(blob);
  } catch {
    return null;
  }
}

/** Install / refresh the SUDO_ASKPASS helper (safe to call often). */
export function ensureAskpass(): string {
  ensureRuntimeDirs();
  mkdirSync(RUNTIME_DIR, { recursive: true });
  const port = String(bindPort() || process.env.HOMEBASE_PORT || "8888");
  const secretPath = join(RUNTIME_DIR, "hook_secret");
  // Askpass never prints the password itself from disk plaintext —
  // it asks Home Base to authorize + decrypt via internal API.
  const script = `#!/bin/sh
# Home Base SUDO_ASKPASS — written by homebased; do not edit.
set -eu
PENDING_FILE=${JSON.stringify(PENDING_PATH)}
SECRET_FILE=${JSON.stringify(secretPath)}
PORT=${JSON.stringify(port)}
PROMPT=\${1:-"[sudo] password required"}
if [ -n "\${HOMEBASE_SUDO_FOR:-}" ]; then
  CMD="\$HOMEBASE_SUDO_FOR"
elif [ -n "\${SUDO_COMMAND:-}" ]; then
  CMD="\$SUDO_COMMAND"
else
  CMD="\$PROMPT"
fi
ID=\$(date +%s%N 2>/dev/null || date +%s)
python3 - "\$PENDING_FILE" "\$ID" "\$CMD" "\$PROMPT" <<'PY' 2>/dev/null || true
import json,sys,time
path,i,cmd,prompt=sys.argv[1:5]
open(path,"w").write(json.dumps({"id":i,"at":time.time(),"command":cmd[:400],"prompt":prompt[:200],"needsAllow":True}))
PY
echo "[sudo] password for: \$CMD" >&2
SECRET=\$(cat "\$SECRET_FILE" 2>/dev/null || true)
python3 - "\$SECRET" "\$PORT" "\$CMD" "\$PROMPT" "\$ID" <<'PY'
import json,sys,urllib.request,time
secret,port,cmd,prompt,rid=sys.argv[1:6]
body=json.dumps({"secret":secret,"command":cmd,"prompt":prompt,"id":rid}).encode()
url=f"http://127.0.0.1:{port}/api/internal/sudo-prompt"
# Notify Chat
try:
  urllib.request.urlopen(urllib.request.Request(url,data=body,headers={"Content-Type":"application/json"},method="POST"),timeout=2).read()
except Exception:
  pass
# Wait for authorized password (Chat Allow / typed password)
release=f"http://127.0.0.1:{port}/api/internal/sudo-release"
for _ in range(240):
  try:
    req=urllib.request.Request(release,data=json.dumps({"secret":secret,"id":rid}).encode(),headers={"Content-Type":"application/json"},method="POST")
    with urllib.request.urlopen(req,timeout=2) as resp:
      data=json.loads(resp.read().decode() or "{}")
    if data.get("password"):
      sys.stdout.write(str(data["password"]))
      raise SystemExit(0)
    if data.get("denied"):
      print("homebase: sudo denied in Chat", file=sys.stderr)
      raise SystemExit(1)
  except SystemExit:
    raise
  except Exception:
    pass
  time.sleep(0.5)
print("homebase: sudo password not provided in time (use Chat sudo card)", file=sys.stderr)
raise SystemExit(1)
PY
`;
  writeFileSync(ASKPASS_PATH, script, { mode: 0o700 });
  try {
    chmodSync(ASKPASS_PATH, 0o700);
  } catch {
    /* ignore */
  }
  return ASKPASS_PATH;
}

export function askpassPath(): string {
  ensureAskpass();
  return ASKPASS_PATH;
}

export function sudoAskpassEnv(): Record<string, string> {
  const path = askpassPath();
  return {
    SUDO_ASKPASS: path,
    SUDO_ASKPASS_REQUIRE: "1",
  };
}

export function hasPersistentVault(): boolean {
  return existsSync(PERSIST_PATH);
}

export function sudoStatus(): Record<string, unknown> {
  purgeIfExpired();
  ensureAskpass();
  const meta = loadMeta();
  const session = Boolean(meta && readSessionPassword());
  const expiresAt = meta?.expiresAt || 0;
  const ttlSec = session
    ? Math.max(0, Math.floor(expiresAt - Date.now() / 1000))
    : 0;
  const filePending = readPendingFile();
  const waiting = Boolean(pending || filePending);
  return {
    cached: session || hasPersistentVault(),
    sessionCached: session,
    persistent: hasPersistentVault(),
    expiresAt: session ? expiresAt : null,
    ttlSec,
    askpassWaiting: waiting,
    pending: pending || filePending,
  };
}

export function getSudoPending(): SudoPending | null {
  return pending || readPendingFile();
}

export async function requestSudoPrompt(opts: {
  command?: string;
  prompt?: string;
  id?: string;
  chatId?: string;
  sessionId?: string;
  callId?: string;
}): Promise<SudoPending> {
  ensureAskpass();
  const req: SudoPending = {
    id: String(opts.id || randomBytes(6).toString("hex")),
    at: Date.now() / 1000,
    command: String(opts.command || opts.prompt || "elevated command").slice(0, 400),
    prompt: String(opts.prompt || "[sudo] password required").slice(0, 200),
    chatId: opts.chatId,
    sessionId: opts.sessionId,
    callId: opts.callId,
    needsAllow: true,
  };
  pending = req;
  try {
    writeFileSync(PENDING_PATH, JSON.stringify(req) + "\n", { mode: 0o600 });
    chmodSync(PENDING_PATH, 0o600);
  } catch {
    /* ignore */
  }
  try {
    const { broadcastAllCursor } = await import("./cursor");
    broadcastAllCursor({
      type: "sudo-request",
      id: req.id,
      command: req.command,
      prompt: req.prompt,
      chatId: req.chatId,
      sessionId: req.sessionId,
      callId: req.callId,
      at: req.at,
      needsAllow: true,
      hasPersistent: hasPersistentVault(),
      hasSession: Boolean(readSessionPassword()),
    });
  } catch {
    /* ignore */
  }
  return req;
}

/** Session vault (encrypted, TTL). Used after user types a password this session. */
export function setSudo(
  password: string,
  ttlSec = DEFAULT_TTL,
): Record<string, unknown> {
  ensureRuntimeDirs();
  mkdirSync(RUNTIME_DIR, { recursive: true });
  ensureAskpass();
  writeSessionCipher(password, ttlSec);
  // Typed password counts as explicit permission for the current pending prompt.
  const rid = pending?.id || readPendingFile()?.id || "";
  if (rid) {
    markRelease(rid, "allow");
    if (pending) pending.needsAllow = false;
  }
  return sudoStatus();
}

/** Long-lived encrypted vault — never auto-used without Allow. */
export function setPersistentSudo(password: string): Record<string, unknown> {
  ensureRuntimeDirs();
  mkdirSync(RUNTIME_DIR, { recursive: true });
  const blob = encryptSecret(password);
  writeFileSync(PERSIST_PATH, blob + "\n", { mode: 0o600 });
  chmodSync(PERSIST_PATH, 0o600);
  // Also warm short session cache for convenience after explicit set.
  writeSessionCipher(password, DEFAULT_TTL);
  const rid = pending?.id || readPendingFile()?.id || "";
  if (rid) {
    markRelease(rid, "allow");
    if (pending) pending.needsAllow = false;
  }
  return sudoStatus();
}

export function clearPersistentSudo(): { ok: boolean } {
  try {
    if (existsSync(PERSIST_PATH)) unlinkSync(PERSIST_PATH);
  } catch {
    /* ignore */
  }
  return { ok: true };
}

export function clearSudo(): { ok: boolean } {
  pending = null;
  releaseState.clear();
  for (const p of [PASS_PATH, META_PATH, PENDING_PATH]) {
    try {
      if (existsSync(p)) unlinkSync(p);
    } catch {
      /* ignore */
    }
  }
  ensureAskpass();
  return { ok: true };
}

function markRelease(id: string, outcome: "allow" | "deny"): void {
  if (id) releaseState.set(id, outcome);
  // Single pending fallback
  const req = pending || readPendingFile();
  if (req?.id) releaseState.set(req.id, outcome);
}

/**
 * User tapped Allow — decrypt vault (session or persistent) for this pending id.
 * Password is never released without this (or an explicit typed setSudo).
 */
export function allowSudoUse(id?: string): Record<string, unknown> {
  const req = pending || readPendingFile();
  const rid = id || req?.id || "";
  let password = readSessionPassword();
  if (!password && existsSync(PERSIST_PATH)) {
    password = decryptSecret(readFileSync(PERSIST_PATH, "utf8"));
  }
  if (!password) {
    return {
      ok: false,
      error: "No saved password — enter one or use Set sudo password",
      ...sudoStatus(),
    };
  }
  writeSessionCipher(password, DEFAULT_TTL);
  markRelease(rid, "allow");
  if (req) req.needsAllow = false;
  pending = req ? { ...req, needsAllow: false } : null;
  return { ok: true, ...sudoStatus() };
}

export function denySudoUse(id?: string): Record<string, unknown> {
  const rid = id || pending?.id || readPendingFile()?.id || "";
  markRelease(rid, "deny");
  pending = null;
  try {
    if (existsSync(PENDING_PATH)) unlinkSync(PENDING_PATH);
  } catch {
    /* ignore */
  }
  return { ok: true, denied: true, ...sudoStatus() };
}

/**
 * Internal: askpass polls this after Chat has been notified.
 * Returns password only after Allow or typed setSudo for this id.
 */
export function releaseSudoPassword(opts: {
  id?: string;
}): { password?: string; denied?: boolean; waiting?: boolean } {
  const rid = String(opts.id || pending?.id || readPendingFile()?.id || "");
  const state = rid ? releaseState.get(rid) : undefined;
  if (state === "deny") {
    releaseState.delete(rid);
    return { denied: true };
  }
  if (state === "allow") {
    const password = readSessionPassword();
    if (password) {
      releaseState.delete(rid);
      pending = null;
      try {
        if (existsSync(PENDING_PATH)) unlinkSync(PENDING_PATH);
      } catch {
        /* ignore */
      }
      return { password };
    }
    return { waiting: true };
  }
  // Typed password via setSudo while pending — treat as allow for this id.
  if (rid && readSessionPassword() && pending?.id === rid && pending.needsAllow === false) {
    const password = readSessionPassword();
    if (password) return { password };
  }
  return { waiting: true };
}

/**
 * Integrity fingerprint for tamper detection.
 * Includes key + askpass helper only — not the user-writable password blob
 * (saving a password must not look like an attack).
 */
export function sudoVaultFingerprint(): string {
  const parts: string[] = [];
  for (const p of [KEY_PATH, ASKPASS_PATH]) {
    if (!existsSync(p)) {
      parts.push(`${p}:missing`);
      continue;
    }
    try {
      const h = createHash("sha256").update(readFileSync(p)).digest("hex").slice(0, 16);
      parts.push(`${p}:${h}`);
    } catch {
      parts.push(`${p}:err`);
    }
  }
  return createHash("sha256").update(parts.join("|")).digest("hex");
}

export function verifySecretEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  try {
    return timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}
