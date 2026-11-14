/**
 * HB-OWN-01: Run project-scoped processes as the checkout owner (not root),
 * and repair root-owned files left behind by older homebased spawns.
 */
import { existsSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  detectSeatUser,
  loginEnvForUser,
  passwdByUid,
  wrapArgvForUser,
  type SeatUser,
} from "./shell_env";
import { appendTrace } from "./trace";

const SAMPLE_LIMIT = 8;
const FIND_TIMEOUT_MS = 45_000;

export type OwnershipHealth = {
  ok: boolean;
  owner: { uid: number; gid: number; name: string; home: string };
  foreignCount: number;
  samples: string[];
};

export type OwnershipRepairResult = {
  ok: boolean;
  repaired: number;
  samples: string[];
  owner: { uid: number; gid: number; name: string; home: string };
  skipped?: string;
};

function statOwnerIds(path: string): { uid: number; gid: number } | null {
  try {
    const st = statSync(path);
    return { uid: st.uid, gid: st.gid };
  } catch {
    return null;
  }
}

/**
 * Owner of the project checkout: directory uid/gid, falling back to seat user.
 */
export function resolveProjectOwner(projectPath: string): SeatUser {
  const root = resolve(String(projectPath || "").trim() || ".");
  const ids = existsSync(root) ? statOwnerIds(root) : null;
  if (ids && ids.uid > 0) {
    return (
      passwdByUid(ids.uid) || {
        uid: ids.uid,
        gid: ids.gid || ids.uid,
        name: `uid${ids.uid}`,
        home: `/home/uid${ids.uid}`,
        shell: "/bin/bash",
      }
    );
  }
  return detectSeatUser();
}

export function wrapArgvForProject(
  argv: string[],
  projectPath: string,
): string[] {
  return wrapArgvForUser(resolveProjectOwner(projectPath), argv);
}

export function loginEnvForProject(projectPath: string): Record<string, string> {
  return loginEnvForUser(resolveProjectOwner(projectPath));
}

function relSample(root: string, abs: string): string {
  const rel = relative(root, abs);
  if (!rel || rel.startsWith("..")) return abs;
  return rel;
}

function findForeignPaths(
  root: string,
  ownerUid: number,
  opts: { onlyRoot?: boolean; max?: number; pruneHeavy?: boolean } = {},
): string[] {
  if (!existsSync(root) || ownerUid <= 0) return [];
  const max = opts.max ?? 5000;
  const args = ["find", root, "-xdev"];
  if (opts.pruneHeavy) {
    args.push(
      "(",
      "-path",
      "*/node_modules/*",
      "-o",
      "-path",
      "*/.next/*",
      "-o",
      "-path",
      "*/dist/*",
      "-o",
      "-path",
      "*/.runtime/*",
      ")",
      "-prune",
      "-o",
    );
  }
  if (opts.onlyRoot) {
    args.push("-uid", "0");
  } else {
    args.push("!", "-uid", String(ownerUid));
  }
  args.push("-print");
  const r = spawnSync(args[0]!, args.slice(1), {
    encoding: "utf8",
    timeout: FIND_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (r.status !== 0 && !r.stdout) return [];
  const lines = String(r.stdout || "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  return lines.slice(0, max);
}

export function projectOwnershipHealth(
  projectPath: string,
  opts: { maxSamples?: number } = {},
): OwnershipHealth {
  const root = resolve(String(projectPath || "").trim() || ".");
  const owner = resolveProjectOwner(root);
  const maxSamples = opts.maxSamples ?? SAMPLE_LIMIT;
  if (!existsSync(root)) {
    return {
      ok: true,
      owner: {
        uid: owner.uid,
        gid: owner.gid,
        name: owner.name,
        home: owner.home,
      },
      foreignCount: 0,
      samples: [],
    };
  }
  const foreign = findForeignPaths(root, owner.uid, {
    max: 10_000,
    pruneHeavy: true,
  });
  const samples = foreign.slice(0, maxSamples).map((p) => relSample(root, p));
  return {
    ok: foreign.length === 0,
    owner: {
      uid: owner.uid,
      gid: owner.gid,
      name: owner.name,
      home: owner.home,
    },
    foreignCount: foreign.length,
    samples,
  };
}

/**
 * Chown root-owned paths under the project back to the checkout owner.
 * No-op when not running as root or owner is root.
 */
export function repairProjectOwnership(
  projectPath: string,
  opts: { log?: boolean; owner?: SeatUser } = {},
): OwnershipRepairResult {
  const root = resolve(String(projectPath || "").trim() || ".");
  const owner = opts.owner && opts.owner.uid > 0 ? opts.owner : resolveProjectOwner(root);
  const ownerPub = {
    uid: owner.uid,
    gid: owner.gid,
    name: owner.name,
    home: owner.home,
  };
  if (!existsSync(root)) {
    return { ok: true, repaired: 0, samples: [], owner: ownerPub, skipped: "missing" };
  }
  if (typeof process.getuid === "function" && process.getuid() !== 0) {
    return { ok: true, repaired: 0, samples: [], owner: ownerPub, skipped: "not-root" };
  }
  if (owner.uid <= 0) {
    return { ok: true, repaired: 0, samples: [], owner: ownerPub, skipped: "owner-root" };
  }

  const rootOwned = findForeignPaths(root, owner.uid, {
    onlyRoot: true,
    max: 50_000,
  });
  if (!rootOwned.length) {
    return { ok: true, repaired: 0, samples: [], owner: ownerPub };
  }

  // Prefer find -exec so we never hit ARG_MAX on large trees.
  const ch = spawnSync(
    "find",
    [
      root,
      "-xdev",
      "-uid",
      "0",
      "-exec",
      "chown",
      "-h",
      `${owner.uid}:${owner.gid}`,
      "{}",
      "+",
    ],
    { encoding: "utf8", timeout: FIND_TIMEOUT_MS },
  );
  if (ch.status !== 0 && rootOwned.length <= 200) {
    spawnSync("chown", ["-h", `${owner.uid}:${owner.gid}`, ...rootOwned], {
      encoding: "utf8",
      timeout: FIND_TIMEOUT_MS,
    });
  }

  const samples = rootOwned.slice(0, SAMPLE_LIMIT).map((p) => relSample(root, p));
  if (opts.log !== false) {
    appendTrace(
      "warn",
      `ownership repair path=${root} owner=${owner.name}(${owner.uid}) repaired=${rootOwned.length} sample=${samples.join(",")}`,
      "ownership",
    );
  }
  return {
    ok: true,
    repaired: rootOwned.length,
    samples,
    owner: ownerPub,
  };
}

/** Repair root-owned paths (project load / before git). Cheap when clean. */
export function ensureProjectOwnership(projectPath: string): OwnershipRepairResult {
  // Prefer repairing .git first (the Permission denied surface), then the tree.
  const root = resolve(String(projectPath || "").trim() || ".");
  const owner = resolveProjectOwner(root);
  const gitDir = join(root, ".git");
  if (existsSync(gitDir)) {
    repairProjectOwnership(gitDir, { log: false, owner });
  }
  return repairProjectOwnership(root, { owner });
}

/** Repair every registered project once (setup / boot). */
export function repairAllRegisteredProjects(
  projects: Iterable<{ path: string; id?: string }>,
): { projects: number; repairedFiles: number } {
  let projectsTouched = 0;
  let repairedFiles = 0;
  for (const p of projects) {
    if (!p?.path) continue;
    const r = repairProjectOwnership(p.path);
    if (r.repaired > 0) {
      projectsTouched += 1;
      repairedFiles += r.repaired;
    }
  }
  return { projects: projectsTouched, repairedFiles };
}

/**
 * QA gate: after Cursor job / MCP git_commit, .git must not contain
 * non-owner files and the owner must be able to run `git commit` dry checks.
 */
export function ownershipQaAfterGitOp(projectPath: string): {
  ok: boolean;
  error?: string;
  health: OwnershipHealth;
  gitCommitProbe?: { ok: boolean; stderr: string };
} {
  const root = resolve(projectPath);
  // Prefer repairing first so QA reflects the post-fix world when we can.
  repairProjectOwnership(root);
  const health = projectOwnershipHealth(root);
  const gitDir = resolve(root, ".git");
  let gitForeign = 0;
  if (existsSync(gitDir)) {
    gitForeign = findForeignPaths(gitDir, health.owner.uid, { max: 1000 }).length;
  }
  if (gitForeign > 0 || !health.ok) {
    return {
      ok: false,
      error: `ownership QA failed: foreign=${health.foreignCount} underGit=${gitForeign} samples=${health.samples.join(",")}`,
      health,
    };
  }

  // Probe: owner can write the index (status is enough; never creates a commit).
  const argv = wrapArgvForProject(["git", "status", "--porcelain"], root);
  const env = loginEnvForProject(root);
  const probe = spawnSync(argv[0]!, argv.slice(1), {
    cwd: root,
    encoding: "utf8",
    timeout: 15_000,
    env,
  });
  const probeOk = probe.status === 0;
  if (!probeOk) {
    return {
      ok: false,
      error: `owner git status failed: ${(probe.stderr || probe.stdout || "").slice(0, 200)}`,
      health,
      gitCommitProbe: {
        ok: false,
        stderr: String(probe.stderr || probe.stdout || "").slice(0, 400),
      },
    };
  }
  return {
    ok: true,
    health,
    gitCommitProbe: { ok: true, stderr: "" },
  };
}
