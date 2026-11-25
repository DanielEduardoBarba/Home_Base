/**
 * Seat-aware Unity Hub / Editor path resolution.
 * homebased runs as root under systemd — never trust process.env.HOME alone.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { detectSeatUser } from "./shell_env";

export const DEFAULT_EDITOR_VERSION = "6000.6.4f1";

/** Resolve the interactive seat user's home (X11 owner / SUDO_USER / passwd). */
export function resolveSeatHome(): string {
  try {
    const seat = detectSeatUser();
    if (seat.home && seat.home !== "/root" && existsSync(seat.home)) {
      return seat.home;
    }
  } catch {
    /* fall through */
  }
  const sudo = (process.env.SUDO_USER || "").trim();
  if (sudo && sudo !== "root") {
    const h = `/home/${sudo}`;
    if (existsSync(h)) return h;
  }
  // Prefer a /home/* that actually has Unity editors (systemd HOME=/root).
  try {
    for (const name of readdirSync("/home")) {
      const h = join("/home", name);
      if (existsSync(join(h, "Unity/Hub/Editor"))) return h;
    }
  } catch {
    /* ignore */
  }
  const envHome = (process.env.HOME || "").trim();
  if (envHome && envHome !== "/root" && existsSync(envHome)) return envHome;
  try {
    const h = homedir();
    if (h && h !== "/root") return h;
  } catch {
    /* ignore */
  }
  return envHome || homedir() || "/home/daniel";
}

/** Candidate homes to scan (seat first, then env, then /home/* with Hub editors). */
export function candidateHomes(): string[] {
  const out: string[] = [];
  const add = (h: string | null | undefined) => {
    const abs = resolve(String(h || "").trim());
    if (!abs || abs === "/") return;
    if (!existsSync(abs)) return;
    if (!out.includes(abs)) out.push(abs);
  };
  add(resolveSeatHome());
  add(process.env.HOME);
  add(homedir());
  try {
    for (const name of readdirSync("/home")) {
      add(join("/home", name));
    }
  } catch {
    /* ignore */
  }
  return out;
}

function readTextMaybe(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function readJsonMaybe(path: string): unknown | null {
  try {
    const raw = readTextMaybe(path);
    if (raw == null) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Hub secondary install path (plain string file or JSON).
 * Missing file is fine — default remains ~/Unity/Hub/Editor.
 */
export function readSecondaryInstallPath(home: string): string | null {
  const candidates = [
    join(home, ".config/unityhub/secondaryInstallPath.json"),
    join(home, ".config/unityhub/secondaryInstallPath"),
  ];
  for (const p of candidates) {
    const raw = readTextMaybe(p);
    if (raw == null) continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (typeof parsed === "string" && parsed.trim()) {
        const abs = resolve(parsed.trim());
        if (existsSync(abs)) return abs;
      }
      if (parsed && typeof parsed === "object") {
        const o = parsed as { path?: string; secondaryInstallPath?: string };
        const v = o.path || o.secondaryInstallPath;
        if (typeof v === "string" && v.trim()) {
          const abs = resolve(v.trim());
          if (existsSync(abs)) return abs;
        }
      }
    } catch {
      // Plain path string (Hub sometimes writes without JSON quotes)
      const abs = resolve(trimmed.replace(/^"|"$/g, ""));
      if (existsSync(abs)) return abs;
    }
  }
  return null;
}

/** Roots that may contain <version>/Editor/Unity. */
export function hubEditorRoots(homes = candidateHomes()): string[] {
  const roots: string[] = [];
  const add = (r: string | null | undefined) => {
    if (!r) return;
    const abs = resolve(r);
    if (!existsSync(abs)) return;
    if (!roots.includes(abs)) roots.push(abs);
  };
  for (const home of homes) {
    add(join(home, "Unity/Hub/Editor"));
    add(readSecondaryInstallPath(home));
  }
  // Absolute fallbacks often used on this seat
  add("/home/daniel/Unity/Hub/Editor");
  return roots;
}

export type DiskEditor = {
  version: string;
  unityPath: string;
  editorRoot: string;
  webglOnDisk: boolean;
  linuxOnDisk: boolean;
};

function moduleDirPresent(editorRoot: string, name: string): boolean {
  return existsSync(join(editorRoot, "Editor/Data/PlaybackEngines", name));
}

/** Scan filesystem for installed Editors (no CLI). */
export function scanEditorsOnDisk(roots = hubEditorRoots()): DiskEditor[] {
  const found: DiskEditor[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    let names: string[];
    try {
      names = readdirSync(root);
    } catch {
      continue;
    }
    for (const name of names) {
      const unityPath = join(root, name, "Editor/Unity");
      if (!existsSync(unityPath)) continue;
      try {
        if (!statSync(unityPath).isFile()) continue;
      } catch {
        continue;
      }
      const editorRoot = join(root, name);
      const key = resolve(unityPath);
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({
        version: name,
        unityPath,
        editorRoot,
        webglOnDisk: moduleDirPresent(editorRoot, "WebGLSupport"),
        linuxOnDisk: moduleDirPresent(editorRoot, "LinuxStandaloneSupport"),
      });
    }
  }
  found.sort((a, b) => a.version.localeCompare(b.version));
  return found;
}

export function resolveEditorBinary(
  version = DEFAULT_EDITOR_VERSION,
): string | null {
  for (const e of scanEditorsOnDisk()) {
    if (e.version === version) return e.unityPath;
  }
  // Soft match any installed editor when exact version missing
  const any = scanEditorsOnDisk()[0];
  return any?.unityPath || null;
}

/** Resolve `unity` CLI even when systemd PATH omits ~/.local/bin. */
export function resolveUnityCliPath(homes = candidateHomes()): string | null {
  const bins: string[] = [];
  for (const home of homes) {
    bins.push(join(home, ".local/bin/unity"));
    const cliInstall = readJsonMaybe(
      join(home, ".config/unityhub/cli-install.json"),
    ) as { path?: string } | null;
    if (cliInstall?.path) bins.push(cliInstall.path);
  }
  bins.push("/usr/local/bin/unity", "/usr/bin/unity");
  for (const b of bins) {
    if (existsSync(b)) {
      try {
        if (statSync(b).isFile()) return b;
      } catch {
        /* ignore */
      }
    }
  }
  return null;
}

export function resolveUnityHubPath(): string | null {
  for (const p of ["/usr/bin/unityhub", "/usr/local/bin/unityhub"]) {
    if (existsSync(p)) return p;
  }
  for (const home of candidateHomes()) {
    if (existsSync(join(home, ".config/unityhub/hubInfo.json"))) {
      return "/usr/bin/unityhub";
    }
  }
  return null;
}

export function hubInfoVersion(homes = candidateHomes()): string | null {
  for (const home of homes) {
    const info = readJsonMaybe(join(home, ".config/unityhub/hubInfo.json")) as {
      version?: string;
    } | null;
    if (info && typeof info.version === "string") return info.version;
  }
  return null;
}

/** Lightweight flags for /api/system/status (no CLI spawn). */
export function unityPresenceFlags(): {
  hubPresent: boolean;
  editorPresent: boolean;
  editorPath: string | null;
  seatHome: string;
} {
  const seatHome = resolveSeatHome();
  const editors = scanEditorsOnDisk();
  const preferred =
    editors.find((e) => e.version === DEFAULT_EDITOR_VERSION) || editors[0];
  return {
    hubPresent: Boolean(resolveUnityHubPath()),
    editorPresent: editors.length > 0,
    editorPath: preferred?.unityPath || null,
    seatHome,
  };
}

export function basenameHome(home: string): string {
  return basename(home) || "user";
}
