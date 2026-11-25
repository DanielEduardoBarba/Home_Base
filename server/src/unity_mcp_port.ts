/**
 * Persist the project's Coplay MCPForUnity bridge port so the Editor listens
 * where Home Base expects (PortManager + EditorPrefs key).
 *
 * PortManager reads ~/.unity-mcp/unity-mcp-port-{sha1(Assets)[0:8]}.json
 * (and legacy unity-mcp-port.json). Application.dataPath === <project>/Assets.
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const UNITY_MCP_EDITOR_PREFS_KEY = "MCPForUnity.UnitySocketPort";

export type UnityMcpPortConfig = {
  unity_port: number;
  created_date: string;
  project_path: string;
};

/**
 * Seat home without importing unity_paths/shell_env (those pull sudo → config
 * and would TDZ RUNTIME_DIR when config imports this module).
 */
function seatHomeLite(): string {
  const sudo = (process.env.SUDO_USER || "").trim();
  if (sudo && sudo !== "root") {
    const h = `/home/${sudo}`;
    if (existsSync(h)) return h;
  }
  try {
    for (const name of readdirSync("/home")) {
      const h = join("/home", name);
      if (existsSync(join(h, "Unity/Hub/Editor")) || existsSync(join(h, ".unity-mcp"))) {
        return h;
      }
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
  return envHome || "/home/daniel";
}

/** SHA1 hex prefix matching PortManager.ComputeProjectHash. */
export function unityMcpProjectHash(assetsPath: string): string {
  return createHash("sha1")
    .update(String(assetsPath || ""), "utf8")
    .digest("hex")
    .slice(0, 8);
}

export function unityMcpRegistryDir(seatHome?: string): string {
  const override = (process.env.UNITY_MCP_STATUS_DIR || "").trim();
  if (override) return resolve(override);
  return join(seatHome || seatHomeLite(), ".unity-mcp");
}

/**
 * Write PortManager JSON (+ project-local hint) for the allocated bridge port.
 * Also best-effort patches Linux Unity EditorPrefs for MCPForUnity.UnitySocketPort.
 */
export function writeUnityMcpBridgePort(
  projectPath: string,
  port: number,
): { ok: boolean; files: string[]; error?: string } {
  const n = Number(port);
  if (!Number.isFinite(n) || n <= 0) {
    return { ok: false, files: [], error: "invalid bridge port" };
  }
  const abs = resolve(String(projectPath || "").trim());
  if (!abs) return { ok: false, files: [], error: "path required" };
  const assetsPath = join(abs, "Assets");
  const dir = unityMcpRegistryDir();
  try {
    mkdirSync(dir, { recursive: true });
  } catch (e) {
    return {
      ok: false,
      files: [],
      error: e instanceof Error ? e.message : String(e),
    };
  }
  const body: UnityMcpPortConfig = {
    unity_port: Math.floor(n),
    created_date: new Date().toISOString(),
    project_path: assetsPath,
  };
  const json = `${JSON.stringify(body, null, 2)}\n`;
  const hash = unityMcpProjectHash(assetsPath);
  const hashed = join(dir, `unity-mcp-port-${hash}.json`);
  const legacy = join(dir, "unity-mcp-port.json");
  const files: string[] = [];
  try {
    writeFileSync(hashed, json, { mode: 0o644 });
    files.push(hashed);
    writeFileSync(legacy, json, { mode: 0o644 });
    files.push(legacy);
  } catch (e) {
    return {
      ok: false,
      files,
      error: e instanceof Error ? e.message : String(e),
    };
  }

  // Project-local copy for operators / scripts (not read by Coplay; documentation).
  try {
    const ps = join(abs, "ProjectSettings");
    mkdirSync(ps, { recursive: true });
    const local = join(ps, "HomeBaseMcpBridge.json");
    writeFileSync(
      local,
      `${JSON.stringify(
        {
          unity_port: body.unity_port,
          editorPrefsKey: UNITY_MCP_EDITOR_PREFS_KEY,
          note: "Written by Home Base; Coplay PortManager uses ~/.unity-mcp/",
        },
        null,
        2,
      )}\n`,
    );
    files.push(local);
  } catch {
    /* optional */
  }

  try {
    writeUnityEditorPrefsPortHint(Math.floor(n));
  } catch {
    /* optional — PortManager JSON is enough for GetPortWithFallback */
  }

  return { ok: true, files };
}

/**
 * Best-effort: set MCPForUnity.UnitySocketPort in Unity's Linux prefs plist-ish file.
 * Safe no-op when the prefs file is missing or unreadable.
 */
export function writeUnityEditorPrefsPortHint(port: number): boolean {
  const home = seatHomeLite();
  const candidates = [
    join(home, ".config/unity3d/prefs"),
    join(home, ".local/share/unity3d/prefs"),
  ];
  const key = UNITY_MCP_EDITOR_PREFS_KEY;
  for (const prefs of candidates) {
    if (!existsSync(prefs)) continue;
    try {
      let text = readFileSync(prefs, "utf8");
      const re = new RegExp(
        `(<pref\\s+name="${key.replace(/\./g, "\\.")}"\\s+type="int">)\\s*-?\\d+`,
        "i",
      );
      if (re.test(text)) {
        text = text.replace(re, `$1${port}`);
      } else if (/<\/unity_prefs>/i.test(text)) {
        text = text.replace(
          /<\/unity_prefs>/i,
          `  <pref name="${key}" type="int">${port}</pref>\n</unity_prefs>`,
        );
      } else {
        continue;
      }
      writeFileSync(prefs, text);
      return true;
    } catch {
      /* try next */
    }
  }
  return false;
}
