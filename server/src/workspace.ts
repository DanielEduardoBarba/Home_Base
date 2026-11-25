/**
 * Human GUI + MCP bot workspace creation (folder on disk + projects.json registration).
 */
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import {
  BUNDLE_ROOT,
  healEmptyAppProject,
  loadProjects,
  looksLikeUnityWorkspace,
  mcpWorkspaceUpsertFields,
  slugId,
  upsertProjectFromInput,
  type Project,
} from "./config";
import { mcpWorkspaceCreateAllowed } from "./mcp_server";
import { detectSeatUser } from "./shell_env";
import {
  chownUnityWorkspaceToSeat,
  ensureUnityMcpPackageInManifest,
  scaffoldUnityProject,
} from "./unity";

export const WORKSPACE_NAME_MAX = 64;
const WORKSPACE_NAME_RE = /^[A-Za-z0-9._-]+$/;
/** Marker written on MCP create/clone (informational; reconcile does not require it). */
export const MCP_WORKSPACE_MARKER = ".homebase-mcp-workspace";
/** Written on intentional unregister so boot reconcile will not resurrect the folder. */
export const MCP_WORKSPACE_TOMBSTONE = ".homebase-mcp-removed";

const BLOCKED_PARENT_PREFIXES = [
  "/bin",
  "/boot",
  "/dev",
  "/etc",
  "/lib",
  "/lib64",
  "/proc",
  "/run",
  "/sbin",
  "/sys",
  "/usr",
  "/var",
  "/root",
] as const;

export function validateWorkspaceName(name: string): string | null {
  const t = String(name || "").trim();
  if (!t) return "workspace name required";
  if (t.startsWith(".")) return "workspace name cannot start with a dot";
  if (t.length > WORKSPACE_NAME_MAX) {
    return `workspace name too long (max ${WORKSPACE_NAME_MAX})`;
  }
  if (!WORKSPACE_NAME_RE.test(t)) {
    return "workspace name may only contain letters, digits, dot, underscore, and hyphen";
  }
  if (t.includes("/") || t.includes("\\")) {
    return "workspace name must not contain path separators";
  }
  return null;
}

export function mcpWorkspacesRoot(): string {
  const override = (process.env.HOMEBASE_MCP_WORKSPACES_ROOT || "").trim();
  if (override) return resolve(override);
  return join(detectSeatUser().home, "MCP_WORKSPACES");
}

/** Chown a path to the seat user when homebased is root (HB-CLONE-01 / HB-OWN). */
export function chownSeatUser(path: string): void {
  const seat = detectSeatUser();
  if (process.getuid?.() === 0 && seat.uid > 0) {
    try {
      Bun.spawnSync(["chown", `${seat.uid}:${seat.gid}`, path]);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Ensure a directory exists and is seat-owned before seat-user git/gh writes into it.
 * homebased runs as uid 0; mkdir alone leaves a root-owned folder that setpriv git cannot fill.
 */
export function ensureSeatOwnedDir(path: string): void {
  if (!existsSync(path)) {
    mkdirSync(path, { mode: 0o755 });
  }
  chownSeatUser(path);
}

export function ensureMcpWorkspacesRoot(): string {
  const root = mcpWorkspacesRoot();
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodPrivateDir(root);
  chownSeatUser(root);
  return root;
}

function chmodPrivateDir(path: string): void {
  try {
    chmodSync(path, 0o700);
  } catch {
    /* ignore */
  }
}

function parentIsBlocked(abs: string): boolean {
  const norm = resolve(abs);
  if (norm === "/") return true;
  for (const p of BLOCKED_PARENT_PREFIXES) {
    if (norm === p || norm.startsWith(`${p}/`)) return true;
  }
  return false;
}

function lexicalInside(root: string, target: string): boolean {
  const r = resolve(root);
  const t = resolve(target);
  return t === r || t.startsWith(`${r}/`);
}

function assertRealpathInside(root: string, target: string): void {
  const realRoot = realpathSync(root);
  const realTarget = realpathSync(target);
  if (realTarget !== realRoot && !realTarget.startsWith(`${realRoot}/`)) {
    throw new Error("path escapes allowed workspace root");
  }
}

/** Reject symlink hops that resolve outside root (existing paths). */
export function rejectSymlinkEscape(root: string, target: string): void {
  const realRoot = realpathSync(root);
  let cur = resolve(target);
  const seen = new Set<string>();
  while (!seen.has(cur)) {
    seen.add(cur);
    if (!existsSync(cur)) {
      const parent = resolve(cur, "..");
      if (parent === cur) break;
      cur = parent;
      continue;
    }
    const st = lstatSync(cur);
    if (st.isSymbolicLink()) {
      const linked = realpathSync(cur);
      if (linked !== realRoot && !linked.startsWith(`${realRoot}/`)) {
        throw new Error("symlink escapes allowed workspace root");
      }
    }
    const parent = resolve(cur, "..");
    if (parent === cur) break;
    cur = parent;
  }
}

function projectIdForName(folderName: string): string {
  return slugId(basename(folderName));
}

function assertNotDuplicate(targetPath: string, folderName: string): void {
  const id = projectIdForName(folderName);
  if (loadProjects().has(id)) {
    throw new Error("a project with this id is already registered");
  }
  const want = resolve(targetPath);
  for (const p of loadProjects().values()) {
    if (resolve(p.path) === want) {
      throw new Error("this path is already registered as a project");
    }
  }
}

function mkdirWorkspace(target: string): void {
  mkdirSync(target, { mode: 0o755 });
  chownSeatUser(target);
}

export type CreateHumanWorkspaceInput = {
  parentPath: string;
  folderName: string;
  displayName?: string;
};

export function createHumanWorkspace(input: CreateHumanWorkspaceInput): Project {
  const nameErr = validateWorkspaceName(input.folderName);
  if (nameErr) throw new Error(nameErr);

  const parentInput = resolve(String(input.parentPath || "").trim());
  if (!parentInput.startsWith("/")) {
    throw new Error("parent path must be absolute");
  }
  if (parentInput.includes("\0")) throw new Error("invalid parent path");
  if (parentIsBlocked(parentInput)) {
    throw new Error("cannot create workspace under a system directory");
  }

  let parentReal: string;
  try {
    parentReal = realpathSync(parentInput);
  } catch {
    throw new Error("parent folder does not exist");
  }
  if (parentIsBlocked(parentReal)) {
    throw new Error("cannot create workspace under a system directory");
  }
  const pst = statSync(parentReal);
  if (!pst.isDirectory()) throw new Error("parent path is not a directory");

  const target = join(parentReal, input.folderName.trim());
  if (!lexicalInside(parentReal, target)) {
    throw new Error("invalid workspace path");
  }
  if (existsSync(target)) {
    throw new Error("a folder or file with that name already exists");
  }

  assertNotDuplicate(target, input.folderName.trim());

  let created = false;
  try {
    mkdirWorkspace(target);
    created = true;
    assertRealpathInside(parentReal, target);
    const label =
      String(input.displayName || "").trim() || input.folderName.trim();
    return upsertProjectFromInput({
      path: target,
      name: label,
      id: projectIdForName(input.folderName.trim()),
    });
  } catch (e) {
    if (created) {
      try {
        rmSync(target, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    throw e instanceof Error ? e : new Error(String(e));
  }
}

export type CreateMcpWorkspaceResult =
  | { ok: true; project: Project }
  | { ok: false; error: string };

function unlinkQuiet(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    /* ignore */
  }
}

/** True when abs path is inside the seat MCP_WORKSPACES root. */
export function isUnderMcpWorkspaces(absPath: string): boolean {
  try {
    const root = realpathSync(mcpWorkspacesRoot());
    const target = resolve(absPath);
    let real = target;
    try {
      real = realpathSync(target);
    } catch {
      /* path may not exist yet */
    }
    return real === root || real.startsWith(`${root}/`);
  } catch {
    return false;
  }
}

/** Mark a folder as an MCP workspace and clear any delete tombstone. */
export function markMcpWorkspace(target: string): void {
  const abs = resolve(target);
  unlinkQuiet(join(abs, MCP_WORKSPACE_TOMBSTONE));
  const marker = join(abs, MCP_WORKSPACE_MARKER);
  if (existsSync(marker)) return;
  writeFileSync(marker, `${new Date().toISOString()}\n`, { mode: 0o644 });
  chownSeatUser(marker);
}

/** Record intentional unregister so reconcile will not re-add this folder. */
export function tombstoneMcpWorkspace(target: string): void {
  const abs = resolve(target);
  if (!existsSync(abs)) return;
  unlinkQuiet(join(abs, MCP_WORKSPACE_MARKER));
  const stone = join(abs, MCP_WORKSPACE_TOMBSTONE);
  writeFileSync(stone, `${new Date().toISOString()}\n`, { mode: 0o644 });
  chownSeatUser(stone);
}

/**
 * Refresh Unity helper scripts + preset actions for an existing project.
 * Preserves path/id/name/ports; replaces actions from the unity preset and
 * re-copies scripts/unity/* (game Assets/Packages untouched).
 */
export function refreshUnityWorkspace(projectId: string): {
  ok: boolean;
  error?: string;
  project?: Project;
  scriptsInstalled?: string[];
} {
  const want = String(projectId || "").trim();
  if (!want) return { ok: false, error: "projectId required" };
  const existing = loadProjects().get(want);
  if (!existing) return { ok: false, error: "project not found" };
  if (
    !looksLikeUnityWorkspace(existing.path) &&
    !(existing.ports || []).some((p) => p.id === "webgl" || p.id === "mcp-bridge")
  ) {
    return {
      ok: false,
      error: "project is not a Unity workspace (no ProjectVersion.txt / unity ports)",
    };
  }

  installUnityWorkspaceScripts(existing.path);
  const installed: string[] = [];
  const destDir = join(existing.path, "scripts", "unity");
  for (const name of [
    "start-editor-bridge.sh",
    "stop-editor-bridge.sh",
    "build-webgl.sh",
    "serve-webgl.sh",
    "serve-webgl.mjs",
    "webgl-bind.mjs",
    "live-webgl.sh",
  ]) {
    if (existsSync(join(destDir, name))) installed.push(name);
  }

  // Re-apply unity preset actions while keeping this workspace's allocated ports.
  const ports =
    (existing.ports || []).length > 0 ? existing.ports : undefined;
  const project = upsertProjectFromInput({
    path: existing.path,
    preset: "unity",
    id: existing.id,
    name: existing.name,
    ports,
  });

  return { ok: true, project, scriptsInstalled: installed };
}

/** Copy Home Base Unity helper scripts into a workspace (project-relative actions). */
export function installUnityWorkspaceScripts(projectPath: string): void {
  const abs = resolve(projectPath);
  const destDir = join(abs, "scripts", "unity");
  mkdirSync(destDir, { recursive: true });
  const srcDir = join(BUNDLE_ROOT, "scripts", "unity");
  for (const name of [
    "start-editor-bridge.sh",
    "stop-editor-bridge.sh",
    "build-webgl.sh",
    "serve-webgl.sh",
    "serve-webgl.mjs",
    "webgl-bind.mjs",
    "live-webgl.sh",
  ]) {
    const src = join(srcDir, name);
    const dest = join(destDir, name);
    if (!existsSync(src)) continue;
    copyFileSync(src, dest);
    try {
      chmodSync(dest, 0o755);
    } catch {
      /* ignore */
    }
  }
  // Friendly README so humans know the bridge path (rewritten on refresh).
  const readme = join(abs, "README.homebase-unity.md");
  try {
    writeFileSync(
      readme,
      [
        "# Unity workspace (Home Base)",
        "",
        "Actions (from the project card):",
        "- `scripts/unity/start-editor-bridge.sh` — headless Editor + Coplay MCP bridge",
        "- `scripts/unity/stop-editor-bridge.sh` — stop this project's bridge Editor",
        "- `scripts/unity/build-webgl.sh` — batchmode WebGL → `Builds/WebGL.next` then atomic swap into `Builds/WebGL`",
        "- `scripts/unity/live-webgl.sh` — build if missing, watch Assets → rebuild → serve (`UNITY_WEBGL_PORT`)",
        "- `scripts/unity/serve-webgl.sh` — static serve / Build-in-progress placeholder (survives atomic swaps; never 0.0.0.0 by default)",
        "",
        "Default action **Unity.Dev** starts bridge + WebGL preview together.",
        "Bridge vs live rebuild: one Editor per project. Live WebGL stops this",
        "project's Coplay bridge before each batchmode build, then restarts it.",
        "Failed builds leave the last good `Builds/WebGL` serving.",
        "",
        "Refresh scripts/actions (no game code): `homebase_unity_refresh_scripts`",
        "or `homebase_project_upsert` with `refreshUnityScripts: true`.",
        "",
      ].join("\n"),
      { mode: 0o644 },
    );
  } catch {
    /* ignore */
  }
  // HB-U-03: scripts/README written by root must become seat-owned.
  chownSeatUser(destDir);
  chownSeatUser(readme);
  try {
    chownUnityWorkspaceToSeat(abs);
  } catch {
    /* best-effort */
  }
}

function registerMcpFolder(
  rootReal: string,
  folderName: string,
  opts: { preset?: string } = {},
): Project {
  const target = join(rootReal, folderName);
  assertRealpathInside(rootReal, target);
  rejectSymlinkEscape(rootReal, target);
  const st = statSync(target);
  if (!st.isDirectory()) throw new Error("workspace path is not a directory");
  markMcpWorkspace(target);
  // Unity projects get unity preset; app checkouts get example; bare stay empty.
  return upsertProjectFromInput(
    mcpWorkspaceUpsertFields({
      path: target,
      name: folderName,
      id: projectIdForName(folderName),
      preset: opts.preset,
    }),
  );
}

/**
 * Re-register directories under ~/MCP_WORKSPACES missing from projects.json
 * (e.g. after an old --deploy overwrite). Skips tombstoned folders so
 * intentional project deletes stay deleted.
 */
export function reconcileMcpWorkspaces(): {
  registered: Project[];
  skipped: string[];
} {
  const registered: Project[] = [];
  const skipped: string[] = [];
  let rootReal: string;
  try {
    rootReal = realpathSync(ensureMcpWorkspacesRoot());
  } catch {
    return { registered, skipped };
  }

  let names: string[];
  try {
    names = readdirSync(rootReal);
  } catch {
    return { registered, skipped };
  }

  const projects = loadProjects();
  const registeredPaths = new Set(
    [...projects.values()].map((p) => resolve(p.path)),
  );

  for (const name of names) {
    const nameErr = validateWorkspaceName(name);
    if (nameErr) {
      skipped.push(name);
      continue;
    }
    const target = join(rootReal, name);
    try {
      const st = lstatSync(target);
      if (st.isSymbolicLink()) {
        rejectSymlinkEscape(rootReal, target);
      }
      if (!statSync(target).isDirectory()) {
        skipped.push(name);
        continue;
      }
      if (existsSync(join(target, MCP_WORKSPACE_TOMBSTONE))) {
        skipped.push(name);
        continue;
      }
      const abs = resolve(realpathSync(target));
      if (registeredPaths.has(abs) || projects.has(projectIdForName(name))) {
        // Already registered — heal bare app projects missing Run/Ship.
        const existing =
          projects.get(projectIdForName(name)) ||
          [...projects.values()].find((p) => resolve(p.path) === abs);
        if (existing) {
          const healed = healEmptyAppProject(existing);
          if (healed) registered.push(healed);
        }
        continue;
      }
      const project = registerMcpFolder(rootReal, name);
      registered.push(project);
      registeredPaths.add(resolve(project.path));
    } catch {
      skipped.push(name);
    }
  }
  return { registered, skipped };
}

export function createMcpWorkspace(
  name: string,
  opts: { preset?: string } = {},
): CreateMcpWorkspaceResult {
  if (!mcpWorkspaceCreateAllowed()) {
    return {
      ok: false,
      error: "MCP workspace creation is disabled in Settings",
    };
  }

  const trimmed = String(name || "").trim();
  const nameErr = validateWorkspaceName(trimmed);
  if (nameErr) return { ok: false, error: nameErr };

  if (trimmed.startsWith("/") || trimmed.includes("..")) {
    return { ok: false, error: "workspace name must be a single folder name, not a path" };
  }

  const preset = String(opts.preset || "").trim() || undefined;
  const wantUnity = preset === "unity";

  const root = ensureMcpWorkspacesRoot();
  let rootReal: string;
  try {
    rootReal = realpathSync(root);
  } catch {
    return { ok: false, error: "MCP workspaces root is not available" };
  }

  try {
    rejectSymlinkEscape(rootReal, rootReal);
  } catch {
    return { ok: false, error: "MCP workspaces root is not safe" };
  }

  const target = join(rootReal, trimmed);
  if (!lexicalInside(rootReal, target)) {
    return { ok: false, error: "invalid workspace path" };
  }

  // Folder already on disk (often after deploy wiped projects.json): re-register.
  if (existsSync(target)) {
    try {
      const abs = resolve(realpathSync(target));
      for (const p of loadProjects().values()) {
        if (resolve(p.path) === abs) {
          if (wantUnity) {
            installUnityWorkspaceScripts(abs);
            ensureUnityMcpPackageInManifest(abs);
          }
          return { ok: true, project: p };
        }
      }
      if (loadProjects().has(projectIdForName(trimmed))) {
        return { ok: false, error: "a project with this id is already registered" };
      }
      if (wantUnity) {
        const scaffold = scaffoldUnityProject(abs);
        if (!scaffold.ok) {
          return { ok: false, error: scaffold.error || "Unity scaffold failed" };
        }
        installUnityWorkspaceScripts(abs);
      }
      const project = registerMcpFolder(rootReal, trimmed, {
        preset: wantUnity ? "unity" : undefined,
      });
      return { ok: true, project };
    } catch (e) {
      return {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }

  try {
    assertNotDuplicate(target, trimmed);
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }

  let created = false;
  try {
    if (wantUnity) {
      // Unity -createProject makes the folder; do not mkdir first.
      const scaffold = scaffoldUnityProject(target);
      if (!scaffold.ok) {
        return {
          ok: false,
          error: scaffold.error || "Unity createProject failed",
        };
      }
      created = scaffold.created || existsSync(target);
      installUnityWorkspaceScripts(target);
    } else {
      mkdirWorkspace(target);
      created = true;
    }
    const project = registerMcpFolder(rootReal, trimmed, {
      preset: wantUnity ? "unity" : undefined,
    });
    return { ok: true, project };
  } catch (e) {
    if (created) {
      try {
        rmSync(target, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
