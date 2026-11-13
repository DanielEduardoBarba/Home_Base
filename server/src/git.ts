/**
 * Safe, allow-listed Git for registered projects.
 * Always runs `git` with an argv array (never a shell string) inside the project path.
 */
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { RUNTIME_DIR, type Project } from "./config";
import { projectHasActiveCursorJob } from "./cursor_jobs";
import { pushNotification } from "./notifications";
import { appendTrace } from "./trace";

export type GitSurface = "gui" | "mcp";

export type GitResult = {
  ok: boolean;
  error?: string;
  stdout?: string;
  stderr?: string;
  code?: number | null;
  data?: Record<string, unknown>;
};

const WRITE_OPS = new Set([
  "fetch",
  "pull",
  "checkout",
  "create_branch",
  "merge",
  "stage",
  "commit",
  "push",
  "stash_push",
  "stash_pop",
]);

/** Patterns / tokens that must never appear in argv (non-destructive allow-list). */
const BLOCKED_ARG_RE =
  /^(--force|--force-with-lease|-f|--hard|--soft|--mixed|--delete|-d|-D|--abort)$/i;

const BLOCKED_SUBCOMMANDS = new Set([
  "reset",
  "clean",
  "rebase",
  "filter-branch",
  "filter-repo",
  "gc",
  "prune",
  "reflog",
  "cherry-pick",
  "revert",
  "am",
  "bisect",
  "worktree",
  "submodule",
  "remote",
  "tag",
  "config",
  "update-ref",
  "replace",
]);

function plainError(msg: string): GitResult {
  return { ok: false, error: msg };
}

function projectRoot(project: Project): string {
  return resolve(project.path);
}

export function confinePath(project: Project, relOrAbs: string): string {
  const root = projectRoot(project);
  const raw = String(relOrAbs || "").trim();
  if (!raw || raw.includes("\0")) throw new Error("Invalid path");
  const target = raw.startsWith("/")
    ? resolve(raw)
    : resolve(join(root, raw));
  const rel = relative(root, target);
  if (rel.startsWith("..") || (rel !== "" && resolve(join(root, rel)) !== target)) {
    if (target !== root && !target.startsWith(root + "/")) {
      throw new Error("Path escapes project directory");
    }
  }
  if (target !== root && !target.startsWith(root + "/")) {
    throw new Error("Path escapes project directory");
  }
  return target;
}

export function validateBranchName(name: string): string | null {
  const t = String(name || "").trim();
  if (!t) return "branch name required";
  if (t === "HEAD" || t === "@") return "invalid branch name";
  if (t.startsWith("-")) return "branch name cannot start with a dash";
  if (t.includes("..") || t.includes("~") || t.includes("^") || t.includes(":")) {
    return "branch name contains invalid characters";
  }
  if (/\s/.test(t)) return "branch name cannot contain whitespace";
  const check = spawnSync("git", ["check-ref-format", "--branch", t], {
    encoding: "utf8",
  });
  if (check.status !== 0) {
    return `invalid branch name (git check-ref-format rejected "${t}")`;
  }
  return null;
}

/** Exported for unit tests — refuse dangerous argv shapes before spawn. */
export function assertSafeGitArgv(args: string[]): string | null {
  if (!args.length) return "empty git argv";
  for (const a of args) {
    if (typeof a !== "string" || a.includes("\0")) return "invalid git argument";
    if (a.includes(";") || a.includes("|") || a.includes("&") || a.includes("`")) {
      return "shell metacharacters are not allowed in git arguments";
    }
    if (BLOCKED_ARG_RE.test(a)) {
      return `blocked git flag: ${a}`;
    }
  }
  const sub = args[0]!;
  if (BLOCKED_SUBCOMMANDS.has(sub)) {
    return `git ${sub} is not allowed (non-destructive allow-list only)`;
  }
  // push: never delete remote refs (:ref or --delete)
  if (sub === "push") {
    if (args.some((a) => a === "--delete" || a === "-d")) {
      return "git push --delete is not allowed";
    }
    if (args.some((a) => a.includes(":") && !a.startsWith("refs/"))) {
      // allow remote name only; reject src:dst delete forms like :branch
      for (const a of args.slice(1)) {
        if (a.startsWith(":") || /:\S+$/.test(a) && a.includes(":")) {
          if (a.startsWith(":") || /^[^/]+:/.test(a)) {
            return "git push refspec delete / force forms are not allowed";
          }
        }
      }
    }
  }
  if (sub === "branch") {
    if (args.some((a) => a === "-d" || a === "-D" || a === "--delete")) {
      return "deleting branches is not allowed";
    }
  }
  if (sub === "checkout" || sub === "switch" || sub === "restore") {
    // Refuse discarding working tree: checkout -- ., restore ., etc.
    const dashDash = args.indexOf("--");
    if (dashDash >= 0 && args.length > dashDash + 1) {
      return "checkout/restore of paths (discarding changes) is not allowed";
    }
    if (args.includes(".") || args.includes("./")) {
      return "checkout/restore of paths (discarding changes) is not allowed";
    }
  }
  if (sub === "stash") {
    const action = args[1] || "";
    if (["drop", "clear", "remove"].includes(action)) {
      return `git stash ${action} is not allowed`;
    }
  }
  if (sub === "merge" && args.includes("--abort")) {
    // Only our merge helper may pass --abort after we started a merge.
    return null;
  }
  if (sub === "clean" || sub === "rebase") {
    return `git ${sub} is not allowed`;
  }
  return null;
}

/**
 * Env for every git spawn. homebased often runs as root while project trees are
 * seat-owned (e.g. /home/daniel/APP_PROJECTS/...); without safe.directory git
 * reports "dubious ownership" and callers see a false "Not a git repository".
 * Exported for unit tests.
 */
export function gitSpawnEnv(
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...base,
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
  };
  const existing = Number(env.GIT_CONFIG_COUNT || "0");
  let hasSafe = false;
  for (let i = 0; i < existing; i++) {
    if (env[`GIT_CONFIG_KEY_${i}`] === "safe.directory") {
      hasSafe = true;
      break;
    }
  }
  if (!hasSafe) {
    const n = Number.isFinite(existing) && existing > 0 ? existing : 0;
    env.GIT_CONFIG_COUNT = String(n + 1);
    env[`GIT_CONFIG_KEY_${n}`] = "safe.directory";
    env[`GIT_CONFIG_VALUE_${n}`] = "*";
  }
  return env;
}

function runGitRaw(
  cwd: string,
  args: string[],
  opts: { timeoutMs?: number } = {},
): { code: number | null; stdout: string; stderr: string } {
  const bad = assertSafeGitArgv(args);
  if (bad) {
    return { code: 1, stdout: "", stderr: bad };
  }
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: opts.timeoutMs ?? 120_000,
    maxBuffer: 4 * 1024 * 1024,
    env: gitSpawnEnv(),
  });
  return {
    code: r.status,
    stdout: (r.stdout || "").toString(),
    stderr: (r.stderr || "").toString() || (r.error ? String(r.error.message) : ""),
  };
}

/** Runtime log path (never inside the project git tree). */
export function projectActivityLogPath(projectId: string): string {
  return join(RUNTIME_DIR, "project-logs", `${projectId}.log`);
}

export function appendProjectLog(project: Project, line: string): void {
  const logPath = projectActivityLogPath(project.id);
  try {
    mkdirSync(join(RUNTIME_DIR, "project-logs"), { recursive: true });
    appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`, "utf8");
  } catch {
    /* ignore */
  }
  appendTrace("info", `${project.id}: ${line}`, "git");
}

function isGitRepo(cwd: string): boolean {
  const r = runGitRaw(cwd, ["rev-parse", "--is-inside-work-tree"]);
  return r.code === 0 && r.stdout.trim() === "true";
}

/** Prefer a clear refusal when rev-parse fails for a non-repo vs ownership. */
function notGitRepoError(cwd: string): GitResult {
  const r = runGitRaw(cwd, ["rev-parse", "--is-inside-work-tree"]);
  const err = `${r.stderr || ""} ${r.stdout || ""}`;
  if (/dubious ownership/i.test(err)) {
    return plainError(
      "Not a git repository (dubious ownership — Home Base could not mark safe.directory)",
    );
  }
  return plainError("Not a git repository");
}

export function isWorkingTreeDirty(cwd: string): boolean {
  const r = runGitRaw(cwd, ["status", "--porcelain"]);
  return r.code === 0 && r.stdout.trim().length > 0;
}

function refuseIfDirty(cwd: string): GitResult | null {
  if (!isWorkingTreeDirty(cwd)) return null;
  return plainError(
    "Working tree has uncommitted changes. Commit or stash them before checkout, merge, or pull.",
  );
}

function refuseIfCursorJob(projectId: string): GitResult | null {
  const active = projectHasActiveCursorJob(projectId);
  if (!active) return null;
  return plainError(
    `A Cursor job is ${active.status} for this project (id ${active.id}). ` +
      `Finish or wait for it before git write actions.`,
  );
}

function refuseMcpWrite(
  surface: GitSurface,
  mcpWriteAllowed: boolean,
): GitResult | null {
  if (surface !== "mcp") return null;
  if (mcpWriteAllowed) return null;
  return plainError(
    "MCP git write actions are disabled in Settings (Allow MCP git write actions).",
  );
}

function finishWrite(
  project: Project,
  op: string,
  result: GitResult,
  detail = "",
): GitResult {
  const summary = result.ok
    ? `git ${op} ok${detail ? `: ${detail}` : ""}`
    : `git ${op} failed: ${result.error || "error"}`;
  appendProjectLog(project, summary);
  if (WRITE_OPS.has(op) || op === "fetch") {
    pushNotification(
      result.ok ? `Git ${op}` : `Git ${op} failed`,
      `${project.name || project.id}: ${result.ok ? detail || "done" : result.error || "error"}`,
      {
        level: result.ok ? "info" : "warn",
        category: "git",
        meta: { projectId: project.id, op, ok: result.ok },
      },
    );
  }
  return result;
}

function parseAheadBehind(cwd: string): { ahead: number; behind: number } {
  const r = runGitRaw(cwd, ["status", "-sb"]);
  if (r.code !== 0) return { ahead: 0, behind: 0 };
  const line = r.stdout.split("\n")[0] || "";
  const ahead = /ahead (\d+)/.exec(line);
  const behind = /behind (\d+)/.exec(line);
  return {
    ahead: ahead ? Number(ahead[1]) : 0,
    behind: behind ? Number(behind[1]) : 0,
  };
}

function currentBranchName(cwd: string): string {
  const r = runGitRaw(cwd, ["branch", "--show-current"]);
  if (r.code === 0 && r.stdout.trim()) return r.stdout.trim();
  const d = runGitRaw(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return d.stdout.trim() || "HEAD";
}

function listBranches(cwd: string): {
  local: string[];
  remote: string[];
  current: string;
} {
  const localR = runGitRaw(cwd, ["branch", "--format=%(refname:short)"]);
  const remoteR = runGitRaw(cwd, [
    "branch",
    "-r",
    "--format=%(refname:short)",
  ]);
  const local = localR.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  const remote = remoteR.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s && !s.endsWith("/HEAD"));
  return { local, remote, current: currentBranchName(cwd) };
}

function parseStatusFiles(cwd: string): {
  path: string;
  index: string;
  worktree: string;
  status: string;
}[] {
  const r = runGitRaw(cwd, ["status", "--porcelain=v1", "-u"]);
  if (r.code !== 0) return [];
  const out: {
    path: string;
    index: string;
    worktree: string;
    status: string;
  }[] = [];
  for (const line of r.stdout.split("\n")) {
    if (!line) continue;
    const index = line[0] || " ";
    const worktree = line[1] || " ";
    let path = line.slice(3);
    if (path.includes(" -> ")) path = path.split(" -> ").pop() || path;
    out.push({
      path,
      index,
      worktree,
      status: `${index}${worktree}`.trim() || "??",
    });
  }
  return out;
}

function recentLog(cwd: string, limit = 8): {
  hash: string;
  short: string;
  subject: string;
  author: string;
  date: string;
}[] {
  const n = Math.min(Math.max(1, limit), 50);
  const r = runGitRaw(cwd, [
    "log",
    `-n${n}`,
    "--format=%H%x09%h%x09%s%x09%an%x09%cs",
  ]);
  if (r.code !== 0) return [];
  return r.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [hash, short, subject, author, date] = line.split("\t");
      return {
        hash: hash || "",
        short: short || "",
        subject: subject || "",
        author: author || "",
        date: date || "",
      };
    });
}

export type GitStatusSnapshot = {
  branch: string;
  ahead: number;
  behind: number;
  dirty: boolean;
  files: ReturnType<typeof parseStatusFiles>;
  commits: ReturnType<typeof recentLog>;
  remotes: string[];
  /** Origin fetch URL when configured (never includes credentials we strip). */
  originUrl: string | null;
};

export function gitStatusSnapshot(project: Project): GitResult {
  const cwd = projectRoot(project);
  if (!existsSync(cwd)) return plainError("Project path does not exist");
  if (!isGitRepo(cwd)) return notGitRepoError(cwd);
  const ab = parseAheadBehind(cwd);
  const remotesR = runGitRaw(cwd, ["remote"]);
  const originR = spawnSync("git", ["remote", "get-url", "origin"], {
    cwd,
    encoding: "utf8",
    env: gitSpawnEnv(),
  });
  let originUrl: string | null = null;
  if (originR.status === 0) {
    originUrl = (originR.stdout || "").toString().trim() || null;
    // Strip embedded credentials if any (never display tokens).
    if (originUrl) {
      originUrl = originUrl.replace(
        /^(https?:\/\/)[^/@]+@/i,
        "$1",
      );
    }
  }
  const data: GitStatusSnapshot = {
    branch: currentBranchName(cwd),
    ahead: ab.ahead,
    behind: ab.behind,
    dirty: isWorkingTreeDirty(cwd),
    files: parseStatusFiles(cwd),
    commits: recentLog(cwd, 8),
    remotes: remotesR.stdout
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean),
    originUrl,
  };
  appendProjectLog(project, `git status (branch ${data.branch})`);
  return { ok: true, data: data as unknown as Record<string, unknown> };
}

export type GitAction =
  | { action: "status" }
  | { action: "log"; limit?: number }
  | { action: "diff"; staged?: boolean; path?: string }
  | { action: "branches" }
  | { action: "remotes" }
  | { action: "fetch" }
  | { action: "pull" }
  | { action: "checkout"; branch: string }
  | { action: "create_branch"; name: string; base?: string; checkout?: boolean }
  | {
      action: "merge";
      branch: string;
      noFf?: boolean;
      abortOnConflict?: boolean;
    }
  | { action: "stage"; paths?: string[] }
  | { action: "commit"; message: string; stageAll?: boolean }
  | { action: "push" }
  | {
      action: "stash";
      mode: "push" | "list" | "pop";
      message?: string;
    };

export function runGitAction(
  project: Project,
  action: GitAction,
  opts: { surface?: GitSurface; mcpWriteAllowed?: boolean } = {},
): GitResult {
  const surface: GitSurface = opts.surface || "gui";
  const cwd = projectRoot(project);
  if (!existsSync(cwd)) return plainError("Project path does not exist");
  if (!isGitRepo(cwd)) return notGitRepoError(cwd);

  const opName =
    action.action === "stash" ? `stash_${action.mode}` : action.action;
  const isWrite =
    WRITE_OPS.has(opName) ||
    action.action === "fetch" ||
    (action.action === "stash" && action.mode !== "list");

  if (isWrite) {
    const mcpBlock = refuseMcpWrite(surface, opts.mcpWriteAllowed === true);
    if (mcpBlock) return mcpBlock;
    const jobBlock = refuseIfCursorJob(project.id);
    if (jobBlock) return jobBlock;
  }

  switch (action.action) {
    case "status":
      return gitStatusSnapshot(project);

    case "log": {
      const commits = recentLog(cwd, action.limit ?? 15);
      appendProjectLog(project, `git log (${commits.length})`);
      return { ok: true, data: { commits } };
    }

    case "diff": {
      const args = ["diff"];
      if (action.staged) args.push("--cached");
      if (action.path) {
        try {
          const abs = confinePath(project, action.path);
          const rel = relative(cwd, abs) || ".";
          args.push("--", rel);
        } catch (e) {
          return plainError(e instanceof Error ? e.message : String(e));
        }
      }
      const r = runGitRaw(cwd, args);
      appendProjectLog(project, "git diff");
      return {
        ok: r.code === 0,
        stdout: r.stdout,
        stderr: r.stderr,
        code: r.code,
        error: r.code === 0 ? undefined : r.stderr || "diff failed",
        data: { diff: r.stdout },
      };
    }

    case "branches": {
      const b = listBranches(cwd);
      appendProjectLog(project, "git branches");
      return { ok: true, data: b as unknown as Record<string, unknown> };
    }

    case "remotes": {
      // `remote` subcommand is blocked for mutating forms; allow read-only listing via direct spawn.
      const detail = spawnSync("git", ["remote", "-v"], {
        cwd,
        encoding: "utf8",
        env: gitSpawnEnv(),
      });
      const names = new Set<string>();
      for (const line of (detail.stdout || "").toString().split("\n")) {
        const n = line.trim().split(/\s+/)[0];
        if (n) names.add(n);
      }
      appendProjectLog(project, "git remotes");
      return {
        ok: detail.status === 0,
        data: {
          remotes: [...names],
          detail: (detail.stdout || "").toString(),
        },
        error:
          detail.status === 0
            ? undefined
            : (detail.stderr || "remotes failed").toString(),
      };
    }

    case "fetch": {
      const r = runGitRaw(cwd, ["fetch", "--all"], {
        timeoutMs: 180_000,
      });
      return finishWrite(project, "fetch", {
        ok: r.code === 0,
        stdout: r.stdout,
        stderr: r.stderr,
        code: r.code,
        error: r.code === 0 ? undefined : plainGitErr(r),
      });
    }

    case "pull": {
      const dirty = refuseIfDirty(cwd);
      if (dirty) return dirty;
      // Prefer fast-forward; allow merge (no rebase).
      const r = runGitRaw(cwd, ["pull", "--no-rebase", "--ff"], {
        timeoutMs: 180_000,
      });
      return finishWrite(
        project,
        "pull",
        {
          ok: r.code === 0,
          stdout: r.stdout,
          stderr: r.stderr,
          code: r.code,
          error: r.code === 0 ? undefined : plainGitErr(r),
        },
        currentBranchName(cwd),
      );
    }

    case "checkout": {
      const err = validateBranchName(action.branch);
      if (err) return plainError(err);
      const dirty = refuseIfDirty(cwd);
      if (dirty) return dirty;
      const branches = listBranches(cwd);
      const name = action.branch.trim();
      const localHit = branches.local.includes(name);
      const remoteHit = branches.remote.find(
        (r) => r === name || r.endsWith("/" + name),
      );
      if (!localHit && !remoteHit) {
        return plainError(
          `Branch "${name}" not found locally or on remotes. Create it first.`,
        );
      }
      const args = localHit
        ? ["switch", name]
        : ["switch", "--track", remoteHit!];
      // `switch` is not in blocked list
      const r = runGitRaw(cwd, args);
      return finishWrite(
        project,
        "checkout",
        {
          ok: r.code === 0,
          stdout: r.stdout,
          stderr: r.stderr,
          code: r.code,
          error: r.code === 0 ? undefined : plainGitErr(r),
          data: { branch: currentBranchName(cwd) },
        },
        name,
      );
    }

    case "create_branch": {
      const err = validateBranchName(action.name);
      if (err) return plainError(err);
      if (action.base) {
        const baseErr = validateBranchName(action.base);
        if (baseErr) return plainError(baseErr);
      }
      const name = action.name.trim();
      const base = action.base?.trim();
      const args = base
        ? ["branch", name, base]
        : ["branch", name];
      const r = runGitRaw(cwd, args);
      if (r.code !== 0) {
        return finishWrite(project, "create_branch", {
          ok: false,
          error: plainGitErr(r),
          stderr: r.stderr,
          code: r.code,
        });
      }
      if (action.checkout !== false) {
        const dirty = refuseIfDirty(cwd);
        if (dirty) {
          return finishWrite(
            project,
            "create_branch",
            {
              ok: true,
              data: { branch: name, checkedOut: false },
              error: undefined,
            },
            `${name} created (not checked out: ${dirty.error})`,
          );
        }
        const sw = runGitRaw(cwd, ["switch", name]);
        if (sw.code !== 0) {
          return finishWrite(project, "create_branch", {
            ok: false,
            error: `Branch created but switch failed: ${plainGitErr(sw)}`,
            data: { branch: name, checkedOut: false },
          });
        }
      }
      return finishWrite(
        project,
        "create_branch",
        {
          ok: true,
          data: {
            branch: name,
            checkedOut: action.checkout !== false,
            current: currentBranchName(cwd),
          },
        },
        name,
      );
    }

    case "merge": {
      const err = validateBranchName(action.branch);
      if (err) return plainError(err);
      const dirty = refuseIfDirty(cwd);
      if (dirty) return dirty;
      const target = currentBranchName(cwd);
      const source = action.branch.trim();
      const args = ["merge"];
      if (action.noFf) args.push("--no-ff");
      args.push(source);
      const r = runGitRaw(cwd, args);
      if (r.code !== 0) {
        const conflict =
          /CONFLICT/i.test(r.stdout + r.stderr) ||
          existsSync(join(cwd, ".git", "MERGE_HEAD"));
        if (conflict && action.abortOnConflict !== false) {
          // Allow merge --abort only for a merge we started.
          const abort = spawnSync("git", ["merge", "--abort"], {
            cwd,
            encoding: "utf8",
            env: gitSpawnEnv(),
          });
          return finishWrite(project, "merge", {
            ok: false,
            error:
              `Merge of ${source} into ${target} hit conflicts and was aborted` +
              (abort.status === 0 ? "" : " (abort also failed — resolve manually)"),
            stdout: r.stdout,
            stderr: r.stderr,
            code: r.code,
          });
        }
        return finishWrite(project, "merge", {
          ok: false,
          error: plainGitErr(r),
          stdout: r.stdout,
          stderr: r.stderr,
          code: r.code,
        });
      }
      return finishWrite(
        project,
        "merge",
        { ok: true, data: { source, target }, stdout: r.stdout },
        `${source} → ${target}`,
      );
    }

    case "stage": {
      const paths = action.paths?.length ? action.paths : ["."];
      const confined: string[] = [];
      try {
        for (const p of paths) {
          if (p === "." || p === "./") {
            confined.push(".");
            continue;
          }
          const abs = confinePath(project, p);
          confined.push(relative(cwd, abs) || ".");
        }
      } catch (e) {
        return plainError(e instanceof Error ? e.message : String(e));
      }
      const r = runGitRaw(cwd, ["add", "-A", "--", ...confined]);
      return finishWrite(project, "stage", {
        ok: r.code === 0,
        error: r.code === 0 ? undefined : plainGitErr(r),
        stdout: r.stdout,
        stderr: r.stderr,
        code: r.code,
      });
    }

    case "commit": {
      const msg = String(action.message || "").trim();
      if (!msg) return plainError("Commit message required");
      if (action.stageAll !== false) {
        const add = runGitRaw(cwd, ["add", "-A"]);
        if (add.code !== 0) {
          return finishWrite(project, "commit", {
            ok: false,
            error: plainGitErr(add),
          });
        }
      }
      const r = runGitRaw(cwd, ["commit", "-m", msg]);
      const ok =
        r.code === 0 || /nothing to commit/i.test(r.stdout + r.stderr);
      return finishWrite(
        project,
        "commit",
        {
          ok: r.code === 0,
          error:
            r.code === 0
              ? undefined
              : /nothing to commit/i.test(r.stdout + r.stderr)
                ? "Nothing to commit"
                : plainGitErr(r),
          stdout: r.stdout,
          stderr: r.stderr,
          code: r.code,
          data: { nothingToCommit: ok && r.code !== 0 },
        },
        msg.slice(0, 72),
      );
    }

    case "push": {
      const branch = currentBranchName(cwd);
      const r = runGitRaw(cwd, ["push", "-u", "origin", "HEAD"], {
        timeoutMs: 180_000,
      });
      return finishWrite(
        project,
        "push",
        {
          ok: r.code === 0,
          error: r.code === 0 ? undefined : plainGitErr(r),
          stdout: r.stdout,
          stderr: r.stderr,
          code: r.code,
        },
        branch,
      );
    }

    case "stash": {
      if (action.mode === "list") {
        const r = runGitRaw(cwd, ["stash", "list"]);
        appendProjectLog(project, "git stash list");
        return {
          ok: r.code === 0,
          data: {
            entries: r.stdout
              .split("\n")
              .map((s) => s.trim())
              .filter(Boolean),
          },
          error: r.code === 0 ? undefined : plainGitErr(r),
        };
      }
      if (action.mode === "push") {
        const args = ["stash", "push", "-u"];
        if (action.message?.trim()) {
          args.push("-m", action.message.trim());
        }
        const r = runGitRaw(cwd, args);
        return finishWrite(project, "stash_push", {
          ok: r.code === 0,
          error: r.code === 0 ? undefined : plainGitErr(r),
          stdout: r.stdout,
          stderr: r.stderr,
        });
      }
      // pop
      const r = runGitRaw(cwd, ["stash", "pop"]);
      return finishWrite(project, "stash_pop", {
        ok: r.code === 0,
        error: r.code === 0 ? undefined : plainGitErr(r),
        stdout: r.stdout,
        stderr: r.stderr,
      });
    }

    default:
      return plainError("Unknown git action");
  }
}

function plainGitErr(r: { stderr: string; stdout: string }): string {
  const t = (r.stderr || r.stdout || "git command failed").trim();
  // Prefer a short, plain-language first line
  const first = t.split("\n").find((l) => l.trim()) || "git command failed";
  return first.replace(/^error:\s*/i, "").slice(0, 400);
}

/** Unit-test helper: run allow-list check on a raw argv without a project. */
export function isArgvAllowed(args: string[]): boolean {
  return assertSafeGitArgv(args) === null;
}
