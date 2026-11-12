/**
 * Human GUI + MCP bot workspace creation (folder on disk + projects.json registration).
 */
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import {
  loadProjects,
  slugId,
  upsertProjectFromInput,
  type Project,
} from "./config";
import { mcpWorkspaceCreateAllowed } from "./mcp_server";
import { detectSeatUser } from "./shell_env";

export const WORKSPACE_NAME_MAX = 64;
const WORKSPACE_NAME_RE = /^[A-Za-z0-9._-]+$/;

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

function chownSeatUser(path: string): void {
  const seat = detectSeatUser();
  if (process.getuid?.() === 0 && seat.uid > 0) {
    try {
      Bun.spawnSync(["chown", `${seat.uid}:${seat.gid}`, path]);
    } catch {
      /* ignore */
    }
  }
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

export function createMcpWorkspace(name: string): CreateMcpWorkspaceResult {
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
  if (existsSync(target)) {
    return { ok: false, error: "workspace folder already exists" };
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
    mkdirWorkspace(target);
    created = true;
    assertRealpathInside(rootReal, target);
    const project = upsertProjectFromInput({
      path: target,
      name: trimmed,
      id: projectIdForName(trimmed),
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
