/**
 * Unity Hub / Editor / license / MCP bridge status (read-only).
 * Never activates, returns, or prints serials/emails.
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { detectSeatUser, wrapArgvForSeat } from "./shell_env";
import { repairProjectOwnership } from "./project_owner";
import {
  DEFAULT_EDITOR_VERSION,
  hubInfoVersion,
  resolveEditorBinary as resolveEditorBinaryFromDisk,
  resolveSeatHome,
  resolveUnityCliPath,
  resolveUnityHubPath,
  scanEditorsOnDisk,
} from "./unity_paths";

const DEFAULT_BRIDGE_PORT = 6400;
const MCP_PKG = "com.coplaydev.unity-mcp";

export type UnityCmdResult = {
  code: number | null;
  stdout: string;
  stderr: string;
};

export type UnityCmdRunner = (
  cmd: string,
  args: string[],
  opts?: { timeoutMs?: number },
) => UnityCmdResult;

function seatPathEnv(): NodeJS.ProcessEnv {
  const home = resolveSeatHome();
  const localBin = join(home, ".local/bin");
  const path = [localBin, process.env.PATH || "/usr/bin:/bin"]
    .filter(Boolean)
    .join(":");
  return {
    ...process.env,
    HOME: home,
    USER: process.env.SUDO_USER || process.env.USER || "",
    PATH: path,
    DISPLAY: process.env.DISPLAY || process.env.HOMEBASE_DISPLAY || "",
  };
}

function defaultRunner(
  cmd: string,
  args: string[],
  opts: { timeoutMs?: number } = {},
): UnityCmdResult {
  // HB-U-03: when homebased is root, drop to the seat user so Unity does not
  // create root-owned ProjectSettings / Library / Temp trees.
  const argv = wrapArgvForSeat([cmd, ...args]);
  const r = spawnSync(argv[0]!, argv.slice(1), {
    encoding: "utf8",
    timeout: opts.timeoutMs ?? 15_000,
    env: seatPathEnv(),
  });
  return {
    code: r.status,
    stdout: r.stdout || "",
    stderr: r.stderr || "",
  };
}

/** Chown a Unity workspace (and cache dirs we touch) to the seat user. */
export function chownUnityWorkspaceToSeat(projectPath: string): {
  repaired: number;
  owner: { uid: number; gid: number; name: string };
} {
  const seat = detectSeatUser();
  const r = repairProjectOwnership(projectPath, { owner: seat, log: false });
  // Also ensure seat owns create/build log cache under ~/.cache/homebase-unity
  const cache = join(seat.home, ".cache/homebase-unity");
  if (existsSync(cache) && process.getuid?.() === 0 && seat.uid > 0) {
    try {
      spawnSync("chown", ["-R", `${seat.uid}:${seat.gid}`, cache], {
        encoding: "utf8",
        timeout: 30_000,
      });
    } catch {
      /* ignore */
    }
  }
  return {
    repaired: r.repaired,
    owner: { uid: seat.uid, gid: seat.gid, name: seat.name },
  };
}

let runner: UnityCmdRunner = defaultRunner;

/** Test-only: stub unity/hub probes. Pass null to restore. */
export function _setUnityRunnerForTests(next: UnityCmdRunner | null): void {
  runner = next || defaultRunner;
}

function seatHome(): string {
  return resolveSeatHome();
}

function which(bin: string): string | null {
  if (bin === "unity") {
    const known = resolveUnityCliPath();
    if (known) return known;
  }
  if (bin === "unityhub") {
    const known = resolveUnityHubPath();
    if (known) return known;
  }
  const r = runner("bash", ["-lc", `command -v ${bin} || true`], {
    timeoutMs: 5_000,
  });
  const line = (r.stdout || "").trim().split("\n")[0]?.trim();
  return line || null;
}

function readJsonFile(path: string): unknown | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function redactEmail(s: string): string {
  return s.replace(
    /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,
    "[redacted-email]",
  );
}

function redactSerialish(s: string): string {
  // Long alphanumeric runs that look like serials / tokens
  return s.replace(/\b[A-Z0-9]{4}(-[A-Z0-9]{4}){3,}\b/gi, "[redacted]");
}

export function redactUnityText(s: string): string {
  return redactSerialish(redactEmail(String(s || "")));
}

function tcpListening(
  port: number,
  host = "127.0.0.1",
  timeoutMs = 400,
): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = createConnection({ host, port });
    const done = (ok: boolean) => {
      try {
        sock.destroy();
      } catch {
        /* ignore */
      }
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => done(true));
    sock.once("timeout", () => done(false));
    sock.once("error", () => done(false));
  });
}

export function hubStatus(): {
  present: boolean;
  path: string | null;
  version: string | null;
  headlessOk: boolean;
  note: string | null;
} {
  const path = which("unityhub") || resolveUnityHubPath();
  const version = hubInfoVersion();
  // Hub CLI needs a display; we do not attempt a live headless call here.
  return {
    present: Boolean(path),
    path,
    version,
    headlessOk: false,
    note: path
      ? "Hub GUI is human-facing; prefer `unity` CLI for automation (headless Hub hangs without a working DISPLAY)."
      : "Unity Hub not found on PATH",
  };
}

export function resolveEditorBinary(
  version = DEFAULT_EDITOR_VERSION,
): string | null {
  return resolveEditorBinaryFromDisk(version);
}

export function editorsStatus(): {
  cliPresent: boolean;
  cliVersion: string | null;
  editors: {
    version: string;
    path: string | null;
    modules: {
      id: string;
      installed: boolean;
      onDisk?: boolean;
    }[];
  }[];
  webglReady: boolean;
  source: "cli+disk" | "disk" | "cli" | "none";
} {
  const unityBin = which("unity") || resolveUnityCliPath();
  let cliVersion: string | null = null;
  if (unityBin) {
    const v = runner(unityBin, ["--version"], { timeoutMs: 5_000 });
    cliVersion = (rTrim(v.stdout || v.stderr || "")).split("\n")[0] || null;
  }

  type Ed = {
    version: string;
    path: string | null;
    modules: { id: string; installed: boolean; onDisk?: boolean }[];
  };
  const byVersion = new Map<string, Ed>();

  const upsert = (ed: Ed) => {
    const prev = byVersion.get(ed.version);
    if (!prev) {
      byVersion.set(ed.version, ed);
      return;
    }
    // Prefer a path that exists on disk
    const path =
      (ed.path && existsSync(ed.path) ? ed.path : null) ||
      (prev.path && existsSync(prev.path) ? prev.path : null) ||
      ed.path ||
      prev.path;
    const modules = ed.modules.map((m) => {
      const old = prev.modules.find((x) => x.id === m.id);
      return {
        id: m.id,
        installed: Boolean(m.installed || old?.installed),
        onDisk: Boolean(m.onDisk || old?.onDisk),
      };
    });
    byVersion.set(ed.version, { version: ed.version, path, modules });
  };

  let cliParsed = false;
  if (unityBin) {
    const r = runner(unityBin, ["editors", "-i", "--json"], {
      timeoutMs: 12_000,
    });
    try {
      const parsed = JSON.parse(r.stdout || "{}") as {
        data?: {
          items?: {
            version?: string;
            location?: string;
            moduleNames?: string[];
          }[];
        };
      };
      for (const item of parsed.data?.items || []) {
        const version = String(item.version || "");
        if (!version) continue;
        const path =
          (item.location && existsSync(item.location)
            ? item.location
            : null) || resolveEditorBinary(version);
        const names = new Set(
          (item.moduleNames || []).map((m) => m.toLowerCase()),
        );
        const editorRoot = path
          ? path.replace(/\/Editor\/Unity$/, "")
          : join(seatHome(), "Unity/Hub/Editor", version);
        const webglDisk = existsSync(
          join(editorRoot, "Editor/Data/PlaybackEngines/WebGLSupport"),
        );
        const linuxDisk = existsSync(
          join(editorRoot, "Editor/Data/PlaybackEngines/LinuxStandaloneSupport"),
        );
        const iosDisk = existsSync(
          join(editorRoot, "Editor/Data/PlaybackEngines/iOSSupport"),
        );
        upsert({
          version,
          path: path || null,
          modules: [
            {
              id: "webgl",
              installed: names.has("web") || names.has("webgl") || webglDisk,
              onDisk: webglDisk,
            },
            {
              id: "linux-il2cpp",
              installed: names.has("linux-il2cpp") || linuxDisk,
              onDisk: linuxDisk,
            },
            {
              id: "ios",
              installed:
                names.has("ios") ||
                names.has("iphone") ||
                names.has("iossupport") ||
                iosDisk,
              onDisk: iosDisk,
            },
          ],
        });
        cliParsed = true;
      }
    } catch {
      /* fall through — disk scan always runs */
    }
  }

  // Always merge filesystem scan (systemd HOME/PATH often hide CLI results).
  const disk = scanEditorsOnDisk();
  for (const e of disk) {
    upsert({
      version: e.version,
      path: e.unityPath,
      modules: [
        { id: "webgl", installed: e.webglOnDisk, onDisk: e.webglOnDisk },
        {
          id: "linux-il2cpp",
          installed: e.linuxOnDisk,
          onDisk: e.linuxOnDisk,
        },
        { id: "ios", installed: e.iosOnDisk, onDisk: e.iosOnDisk },
      ],
    });
  }

  const editors = [...byVersion.values()].sort((a, b) =>
    a.version.localeCompare(b.version),
  );
  const webglReady = editors.some((e) =>
    e.modules.some((m) => m.id === "webgl" && m.installed),
  );
  const source =
    cliParsed && disk.length
      ? "cli+disk"
      : disk.length
        ? "disk"
        : cliParsed
          ? "cli"
          : "none";

  return {
    cliPresent: Boolean(unityBin),
    cliVersion,
    editors,
    webglReady,
    source,
  };
}

function rTrim(s: string): string {
  return String(s || "").trim();
}

export function licenseStatus(): {
  ok: boolean;
  products: { product: string; type: string }[];
  entitlementPresent: boolean;
  legacyUlfPresent: boolean;
  note: string | null;
} {
  const home = seatHome();
  const entitlementPresent = existsSync(
    join(home, ".config/unity3d/Unity/licenses/UnityEntitlementLicense.xml"),
  );
  const legacyUlfPresent = existsSync(
    join(home, ".local/share/unity3d/Unity/Unity_lic.ulf"),
  );

  const unityBin = which("unity");
  const products: { product: string; type: string }[] = [];
  if (unityBin) {
    const r = runner(unityBin, ["license", "--json"], { timeoutMs: 12_000 });
    try {
      const parsed = JSON.parse(r.stdout || "{}") as {
        success?: boolean;
        data?: { items?: { product?: string; type?: string }[] };
      };
      for (const item of parsed.data?.items || []) {
        const product = redactUnityText(String(item.product || "Unknown"));
        const type = redactUnityText(String(item.type || ""));
        // Never surface organization / serial fields
        products.push({ product, type });
      }
      return {
        ok: parsed.success !== false && products.length > 0,
        products,
        entitlementPresent,
        legacyUlfPresent,
        note: null,
      };
    } catch {
      /* ignore */
    }
  }

  return {
    ok: entitlementPresent || legacyUlfPresent,
    products: entitlementPresent
      ? [{ product: "Unity (entitlement on disk)", type: "Unknown" }]
      : [],
    entitlementPresent,
    legacyUlfPresent,
    note: unityBin
      ? "Could not parse `unity license --json`"
      : "unity CLI not found — license inferred from on-disk entitlement only",
  };
}

export async function bridgeStatus(
  port = DEFAULT_BRIDGE_PORT,
): Promise<{
  port: number;
  reachable: boolean;
  xvfbPresent: boolean;
  statusFiles: number;
  sampleProject: {
    path: string;
    exists: boolean;
    hasMcpPackage: boolean;
  };
}> {
  const home = seatHome();
  const samplePath = join(home, "MCP_WORKSPACES/unity-sample");
  let hasMcpPackage = false;
  const manifestPath = join(samplePath, "Packages/manifest.json");
  if (existsSync(manifestPath)) {
    try {
      const raw = JSON.parse(readFileSync(manifestPath, "utf8")) as {
        dependencies?: Record<string, string>;
      };
      hasMcpPackage = Boolean(raw.dependencies?.[MCP_PKG]);
    } catch {
      hasMcpPackage = false;
    }
  }
  const statusDir = join(home, ".unity-mcp");
  let statusFiles = 0;
  if (existsSync(statusDir)) {
    try {
      statusFiles = readdirSync(statusDir).filter((n) =>
        n.startsWith("unity-mcp-status-"),
      ).length;
    } catch {
      statusFiles = 0;
    }
  }
  const reachable = await tcpListening(port);
  return {
    port,
    reachable,
    xvfbPresent: Boolean(which("xvfb-run") || which("Xvfb")),
    statusFiles,
    sampleProject: {
      path: samplePath,
      exists:
        existsSync(samplePath) &&
        existsSync(join(samplePath, "ProjectSettings/ProjectVersion.txt")),
      hasMcpPackage,
    },
  };
}

export type UnitySetupCheck = {
  id: string;
  ok: boolean;
  label: string;
  detail: string | null;
};

export async function unityStatus(): Promise<{
  ok: boolean;
  hub: ReturnType<typeof hubStatus>;
  editors: ReturnType<typeof editorsStatus>;
  license: ReturnType<typeof licenseStatus>;
  bridge: Awaited<ReturnType<typeof bridgeStatus>>;
  checks: UnitySetupCheck[];
}> {
  const hub = hubStatus();
  const editors = editorsStatus();
  const license = licenseStatus();
  const bridge = await bridgeStatus();

  const checks: UnitySetupCheck[] = [
    {
      id: "hub",
      ok: hub.present,
      label: "Unity Hub installed",
      detail: hub.present
        ? `v${hub.version || "?"} · ${hub.path}`
        : hub.note,
    },
    {
      id: "cli",
      ok: editors.cliPresent,
      label: "Unity CLI (`unity`)",
      detail: editors.cliPresent
        ? editors.cliVersion
        : "Install Unity CLI for editors/modules/license probes",
    },
    {
      id: "editor",
      ok: editors.editors.length > 0,
      label: "Editor installed",
      detail: editors.editors.length
        ? editors.editors.map((e) => e.version).join(", ")
        : "No Editor under ~/Unity/Hub/Editor",
    },
    {
      id: "webgl",
      ok: editors.webglReady,
      label: "WebGL module",
      detail: editors.webglReady
        ? "WebGLSupport present"
        : "Install Web Build Support via Hub or `unity install-modules`",
    },
    {
      id: "license",
      ok: license.ok,
      label: "License (read-only)",
      detail: license.products.length
        ? license.products.map((p) => `${p.product} (${p.type})`).join(", ")
        : license.note,
    },
    {
      id: "bridge",
      ok: bridge.reachable,
      label: `MCP bridge :${bridge.port}`,
      detail: bridge.reachable
        ? "Listening on loopback"
        : "Not listening — run scripts/unity/start-editor-bridge.sh",
    },
    {
      id: "sample",
      ok: bridge.sampleProject.exists && bridge.sampleProject.hasMcpPackage,
      label: "Scratch project unity-sample",
      detail: bridge.sampleProject.exists
        ? bridge.sampleProject.hasMcpPackage
          ? bridge.sampleProject.path
          : "Project exists but MCP package missing from Packages/manifest.json"
        : "Missing — start-editor-bridge.sh will create it",
    },
  ];

  const required = checks.filter((c) =>
    ["editor", "license", "webgl"].includes(c.id),
  );
  const ok = required.every((c) => c.ok);

  return { ok, hub, editors, license, bridge, checks };
}

/** Ensure Packages/manifest.json includes the Coplay MCP package (no network). */
export function ensureUnityMcpPackageInManifest(
  projectPath: string,
  packageUrl = "https://github.com/CoplayDev/unity-mcp.git?path=/MCPForUnity#main",
): { ok: boolean; changed: boolean; error?: string } {
  const manifest = join(projectPath, "Packages/manifest.json");
  try {
    if (!existsSync(join(projectPath, "Packages"))) {
      return { ok: false, changed: false, error: "Packages/ missing" };
    }
    let data: { dependencies?: Record<string, string> } = {
      dependencies: {},
    };
    if (existsSync(manifest)) {
      data = JSON.parse(readFileSync(manifest, "utf8") || "{}") as typeof data;
    }
    data.dependencies = data.dependencies || {};
    const prev = data.dependencies[MCP_PKG];
    if (prev === packageUrl) {
      return { ok: true, changed: false };
    }
    data.dependencies[MCP_PKG] = packageUrl;
    mkdirSync(join(projectPath, "Packages"), { recursive: true });
    writeFileSync(manifest, `${JSON.stringify(data, null, 2)}\n`, {
      mode: 0o644,
    });
    return { ok: true, changed: true };
  } catch (e) {
    return {
      ok: false,
      changed: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export type CreateUnityProjectRunner = (
  unityBin: string,
  projectPath: string,
) => UnityCmdResult;

function defaultCreateProjectRunner(
  unityBin: string,
  projectPath: string,
): UnityCmdResult {
  // Ensure parent + cache exist and are seat-owned before createProject.
  const seat = detectSeatUser();
  const cacheDir = join(seat.home, ".cache/homebase-unity");
  try {
    mkdirSync(cacheDir, { recursive: true });
    mkdirSync(join(projectPath, ".."), { recursive: true });
  } catch {
    /* ignore */
  }
  if (process.getuid?.() === 0 && seat.uid > 0) {
    try {
      spawnSync("chown", [`${seat.uid}:${seat.gid}`, cacheDir], {
        encoding: "utf8",
      });
      spawnSync("chown", [`${seat.uid}:${seat.gid}`, join(projectPath, "..")], {
        encoding: "utf8",
      });
    } catch {
      /* ignore */
    }
  }
  return defaultRunner(
    unityBin,
    [
      "-batchmode",
      "-nographics",
      "-quit",
      "-createProject",
      projectPath,
      "-logFile",
      join(cacheDir, "create-mcp.log"),
    ],
    { timeoutMs: 600_000 },
  );
}

let createRunner: CreateUnityProjectRunner = defaultCreateProjectRunner;

export function _setUnityCreateRunnerForTests(
  next: CreateUnityProjectRunner | null,
): void {
  createRunner = next || defaultCreateProjectRunner;
}

/**
 * Create a Unity project via Editor -createProject and add the MCP package.
 * Does not start the Editor bridge or touch licenses.
 */
export function scaffoldUnityProject(projectPath: string): {
  ok: boolean;
  error?: string;
  created: boolean;
  mcpPackage: boolean;
} {
  const abs = projectPath;
  const versionTxt = join(abs, "ProjectSettings/ProjectVersion.txt");
  let created = false;
  if (!existsSync(versionTxt)) {
    const editors = editorsStatus();
    const bin =
      editors.editors[0]?.path ||
      resolveEditorBinary() ||
      null;
    if (!bin || !existsSync(bin)) {
      return {
        ok: false,
        created: false,
        mcpPackage: false,
        error: "Unity Editor binary not found",
      };
    }
    try {
      mkdirSync(join(seatHome(), ".cache/homebase-unity"), { recursive: true });
      mkdirSync(join(abs, ".."), { recursive: true });
    } catch {
      /* ignore */
    }
    if (existsSync(abs) && (!statSync(abs).isDirectory() || readdirSync(abs).length > 0)) {
      // createProject needs an empty/new path; if folder exists empty that's ok for Unity
      try {
        if (readdirSync(abs).length > 0 && !existsSync(versionTxt)) {
          return {
            ok: false,
            created: false,
            mcpPackage: false,
            error: "target folder is not empty and is not a Unity project",
          };
        }
      } catch {
        /* ignore */
      }
    }
    const r = createRunner(bin, abs);
    if (r.code !== 0 || !existsSync(versionTxt)) {
      return {
        ok: false,
        created: false,
        mcpPackage: false,
        error: redactUnityText(
          `createProject failed (exit ${r.code}): ${(r.stderr || r.stdout || "").slice(0, 400)}`,
        ),
      };
    }
    created = true;
  }
  const mcp = ensureUnityMcpPackageInManifest(abs);
  // Always heal ownership (HB-U-03) — even if create was stubbed/skipped.
  try {
    chownUnityWorkspaceToSeat(abs);
  } catch {
    /* best-effort */
  }
  return {
    ok: mcp.ok,
    created,
    mcpPackage: mcp.ok,
    error: mcp.error,
  };
}
