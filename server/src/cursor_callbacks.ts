/**
 * Encrypted pending job-webhook records under RUNTIME_DIR.
 * Auth is stored only as encryptSecret (AES-256-GCM) output — never plaintext.
 * File mode 0600. Deleted after delivery, final failure, expiry, or lost-callback.
 */
import {
  chmodSync,
  existsSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { RUNTIME_DIR, ensureRuntimeDirs } from "./config";
import { decryptSecret, encryptSecret } from "./secrets_vault";

export const PENDING_CALLBACKS_PATH = join(
  RUNTIME_DIR,
  "cursor_callbacks.pending.enc",
);
export const PENDING_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const INTERRUPTED_SUMMARY =
  "Home Base restarted while this job was running; the job did not finish";

export type PendingCallbackRecord = {
  jobId: string;
  projectId: string;
  callbackUrl: string;
  startedAt: number;
  hasAuth: boolean;
  /** encryptSecret blob only — never plaintext. */
  authEnc?: string;
};

type FileShape = { v: 1; records: PendingCallbackRecord[] };

function writePrivate(path: string, body: string): void {
  ensureRuntimeDirs();
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, body, { mode: 0o600 });
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

function loadFile(): PendingCallbackRecord[] {
  if (!existsSync(PENDING_CALLBACKS_PATH)) return [];
  try {
    const raw = readFileSync(PENDING_CALLBACKS_PATH, "utf8");
    const o = JSON.parse(raw) as FileShape;
    if (!o || o.v !== 1 || !Array.isArray(o.records)) return [];
    return o.records
      .filter((r) => r && typeof r.jobId === "string" && r.callbackUrl)
      .map((r) => ({
        jobId: String(r.jobId),
        projectId: String(r.projectId || ""),
        callbackUrl: String(r.callbackUrl),
        startedAt: Number(r.startedAt) || 0,
        hasAuth: Boolean(r.hasAuth),
        authEnc: typeof r.authEnc === "string" ? r.authEnc : undefined,
      }));
  } catch {
    return [];
  }
}

function saveFile(records: PendingCallbackRecord[]): void {
  if (!records.length) {
    clearAllPendingCallbacks();
    return;
  }
  writePrivate(
    PENDING_CALLBACKS_PATH,
    JSON.stringify({ v: 1, records } satisfies FileShape),
  );
}

export function loadPendingCallbacks(): PendingCallbackRecord[] {
  return loadFile();
}

export function persistPendingCallback(input: {
  jobId: string;
  projectId: string;
  callbackUrl: string;
  startedAt: number;
  auth?: string;
}): void {
  const auth = String(input.auth || "").trim();
  const rec: PendingCallbackRecord = {
    jobId: String(input.jobId),
    projectId: String(input.projectId || ""),
    callbackUrl: String(input.callbackUrl),
    startedAt: Number(input.startedAt) || Date.now(),
    hasAuth: Boolean(auth),
    authEnc: auth ? encryptSecret(auth) : undefined,
  };
  const rest = loadFile().filter((r) => r.jobId !== rec.jobId);
  rest.push(rec);
  saveFile(rest);
}

export function removePendingCallback(jobId: string): void {
  const id = String(jobId || "");
  if (!id) return;
  saveFile(loadFile().filter((r) => r.jobId !== id));
}

export function clearAllPendingCallbacks(): void {
  try {
    if (existsSync(PENDING_CALLBACKS_PATH)) unlinkSync(PENDING_CALLBACKS_PATH);
  } catch {
    /* ignore */
  }
  try {
    if (existsSync(`${PENDING_CALLBACKS_PATH}.tmp`)) {
      unlinkSync(`${PENDING_CALLBACKS_PATH}.tmp`);
    }
  } catch {
    /* ignore */
  }
}

/** Decrypt auth for a pending record. null = decrypt failed (hasAuth was set). */
export function decryptPendingAuth(
  rec: PendingCallbackRecord,
): { auth?: string; decryptFailed: boolean } {
  if (!rec.hasAuth) return { decryptFailed: false };
  if (!rec.authEnc) return { decryptFailed: true };
  const plain = decryptSecret(rec.authEnc);
  if (plain == null) return { decryptFailed: true };
  return { auth: plain, decryptFailed: false };
}

/** Test helper: write records as they would appear on disk (authEnc only). */
export function _writePendingRecordsForTests(
  records: PendingCallbackRecord[],
): void {
  saveFile(records);
}
