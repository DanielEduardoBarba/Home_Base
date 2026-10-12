/**
 * First-run / replay onboarding progress (client wizard).
 */
import {
  chmodSync,
  existsSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { AUTH_PATH, RUNTIME_DIR, ensureRuntimeDirs } from "./config";

const PATH = join(RUNTIME_DIR, "onboarding.json");

export type OnboardingState = {
  complete: boolean;
  skippedRemote?: boolean;
  remoteMode?: "wireguard" | "cloudflare" | null;
  updatedAt?: number;
};

function empty(): OnboardingState {
  return { complete: false, remoteMode: null };
}

function passwordAlreadySet(): boolean {
  if (!existsSync(AUTH_PATH)) return false;
  try {
    const raw = JSON.parse(readFileSync(AUTH_PATH, "utf8")) as {
      passwordHash?: string;
    };
    return Boolean(raw.passwordHash);
  } catch {
    return false;
  }
}

export function loadOnboarding(): OnboardingState {
  // Existing installs (password set, no onboarding file) skip the wizard.
  if (!existsSync(PATH)) {
    if (passwordAlreadySet()) return { complete: true, remoteMode: null };
    return empty();
  }
  try {
    const raw = JSON.parse(readFileSync(PATH, "utf8")) as Partial<OnboardingState>;
    return {
      complete: !!raw.complete,
      skippedRemote: !!raw.skippedRemote,
      remoteMode:
        raw.remoteMode === "wireguard" || raw.remoteMode === "cloudflare"
          ? raw.remoteMode
          : null,
      updatedAt: Number(raw.updatedAt) || undefined,
    };
  } catch {
    return empty();
  }
}

export function saveOnboarding(
  patch: Partial<OnboardingState>,
): OnboardingState {
  ensureRuntimeDirs();
  const next: OnboardingState = {
    ...loadOnboarding(),
    ...patch,
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

export function clearOnboarding(): void {
  try {
    if (existsSync(PATH)) unlinkSync(PATH);
  } catch {
    /* ignore */
  }
}

export function resetOnboardingForReplay(): OnboardingState {
  return saveOnboarding({
    complete: false,
    skippedRemote: false,
    remoteMode: null,
  });
}
