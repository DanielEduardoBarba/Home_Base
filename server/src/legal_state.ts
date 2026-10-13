/**
 * Install-level Terms of Use + Privacy Policy acceptance.
 * Required before bootstrap / continued use when doc version changes.
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
import { HttpError } from "./auth";

/** Bump when Terms or Privacy text changes in a material way. */
export const LEGAL_DOC_VERSION = "1";

const PATH = join(RUNTIME_DIR, "legal.json");

export type LegalState = {
  acceptedVersion: string | null;
  acceptedAt: number | null;
};

export type LegalPublic = {
  version: string;
  accepted: boolean;
  acceptedVersion: string | null;
  acceptedAt: number | null;
};

function empty(): LegalState {
  return { acceptedVersion: null, acceptedAt: null };
}

function load(): LegalState {
  if (!existsSync(PATH)) return empty();
  try {
    const raw = JSON.parse(readFileSync(PATH, "utf8")) as Partial<LegalState>;
    const ver =
      typeof raw.acceptedVersion === "string" && raw.acceptedVersion.trim()
        ? raw.acceptedVersion.trim()
        : null;
    const at = Number(raw.acceptedAt);
    return {
      acceptedVersion: ver,
      acceptedAt: Number.isFinite(at) && at > 0 ? at : null,
    };
  } catch {
    return empty();
  }
}

function save(state: LegalState): LegalState {
  ensureRuntimeDirs();
  writeFileSync(PATH, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  try {
    chmodSync(PATH, 0o600);
  } catch {
    /* ignore */
  }
  return state;
}

export function isLegalAccepted(version = LEGAL_DOC_VERSION): boolean {
  const s = load();
  return !!s.acceptedVersion && s.acceptedVersion === version;
}

export function legalPublic(): LegalPublic {
  const s = load();
  const accepted = isLegalAccepted();
  return {
    version: LEGAL_DOC_VERSION,
    accepted,
    acceptedVersion: s.acceptedVersion,
    acceptedAt: s.acceptedAt,
  };
}

export function acceptLegal(version: string): LegalPublic {
  const v = (version || "").trim();
  if (v !== LEGAL_DOC_VERSION) {
    throw new HttpError(
      400,
      `Stale legal documents (expected version ${LEGAL_DOC_VERSION}) — refresh and accept again`,
    );
  }
  save({
    acceptedVersion: LEGAL_DOC_VERSION,
    acceptedAt: Date.now(),
  });
  return legalPublic();
}

export function requireLegalAccepted(): void {
  if (!isLegalAccepted()) {
    throw new HttpError(
      403,
      "Accept the Terms of Use and Privacy Policy before continuing",
    );
  }
}

export function clearLegal(): void {
  try {
    if (existsSync(PATH)) unlinkSync(PATH);
  } catch {
    /* ignore */
  }
}
