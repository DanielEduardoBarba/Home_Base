/**
 * GitHub repo hookup for Home Base workspaces (gh + git argv, never shell strings).
 * Uses the laptop's existing `gh` auth — never stores tokens.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
  loadProjects,
  slugId,
  upsertProjectFromInput,
  type Project,
} from "./config";
import {
  mcpGitWriteAllowed,
  mcpGithubReposAllowed,
  mcpWorkspaceCreateAllowed,
} from "./mcp_server";
import {
  ensureMcpWorkspacesRoot,
  rejectSymlinkEscape,
  validateWorkspaceName,
} from "./workspace";
import { validateBranchName } from "./git";
import { gitEnvCheck, runOperatorCmd } from "./operator_git_env";
import { repairProjectOwnership } from "./project_owner";

export type CmdResult = {
  code: number | null;
  stdout: string;
  stderr: string;
};

export type CmdRunner = (
  cmd: string,
  args: string[],
  opts?: { cwd?: string; timeoutMs?: number },
) => CmdResult;

export type GithubSurface = "gui" | "mcp";

export type GithubResult = {
  ok: boolean;
  error?: string;
  data?: Record<string, unknown>;
};

const DEV_BRANCH = "development_grok";
const GH_SIGNIN_HINT = "gh auth login -h github.com";

const BLOCKED_ARG_RE =
  /^(--force|--force-with-lease|-f|--hard|--delete|-d|-D|--force-push)$/i;

function defaultRunner(
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number } = {},
): CmdResult {
  // git + gh go through the operator login-env runner (seat user / keyring).
  if (cmd === "git" || cmd === "gh") {
    const r = runOperatorCmd(cmd, args, {
      cwd: opts.cwd,
      timeoutMs: opts.timeoutMs,
    });
    return { code: r.code, stdout: r.stdout, stderr: r.stderr };
  }
  return {
    code: 1,
    stdout: "",
    stderr: `binary not allow-listed: ${cmd}`,
  };
}

let runner: CmdRunner = defaultRunner;

/** Test-only: stub gh/git. Pass null to restore. */
export function _setGithubRunnerForTests(next: CmdRunner | null): void {
  runner = next || defaultRunner;
}

function plainError(msg: string): GithubResult {
  return { ok: false, error: msg };
}

function assertSafeArgv(args: string[]): string | null {
  for (const a of args) {
    if (typeof a !== "string" || a.includes("\0")) return "invalid argument";
    if (/[;|&`$]/.test(a)) return "shell metacharacters are not allowed";
    if (BLOCKED_ARG_RE.test(a)) return `blocked flag: ${a}`;
  }
  return null;
}

function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number } = {},
): CmdResult {
  const bad = assertSafeArgv(args);
  if (bad) return { code: 1, stdout: "", stderr: bad };
  return runner(cmd, args, opts);
}

function refuseMcpGithub(surface: GithubSurface): GithubResult | null {
  if (surface !== "mcp") return null;
  if (!mcpGithubReposAllowed()) {
    return plainError(
      "MCP GitHub repo access is disabled in Settings (Allow MCP GitHub repo access)",
    );
  }
  return null;
}

function isGitRepo(cwd: string): boolean {
  const r = run("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd,
    timeoutMs: 10_000,
  });
  return r.code === 0 && r.stdout.trim() === "true";
}

function dirNonEmpty(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    return readdirSync(path).length > 0;
  } catch {
    return true;
  }
}

function projectIdForName(folderName: string): string {
  return slugId(folderName);
}

function assertNotDuplicate(targetPath: string, folderName: string): string | null {
  const id = projectIdForName(folderName);
  if (loadProjects().has(id)) {
    return "a project with this id is already registered";
  }
  const want = resolve(targetPath);
  for (const p of loadProjects().values()) {
    if (resolve(p.path) === want) {
      return "this path is already registered as a project";
    }
  }
  return null;
}

/** Parse owner/repo or common GitHub URL shapes. Never returns tokens. */
export function parseGithubRepoRef(input: string): {
  owner: string;
  repo: string;
  cloneUrl: string;
  nameHint: string;
} | null {
  const raw = String(input || "").trim();
  if (!raw || raw.includes("\0")) return null;
  let owner = "";
  let repo = "";

  const ssh = raw.match(/^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i);
  if (ssh) {
    owner = ssh[1]!;
    repo = ssh[2]!;
  } else {
    const https = raw.match(
      /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s]+)\/([^/\s#?]+?)(?:\.git)?\/?(?:#.*)?$/i,
    );
    if (https) {
      owner = https[1]!;
      repo = https[2]!;
    } else {
      const short = raw.match(/^([^/\s]+)\/([^/\s]+?)(?:\.git)?$/);
      if (short) {
        owner = short[1]!;
        repo = short[2]!;
      }
    }
  }

  owner = owner.trim();
  repo = repo.replace(/\.git$/i, "").trim();
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) {
    return null;
  }
  if (owner === "." || owner === ".." || repo === "." || repo === "..") {
    return null;
  }
  return {
    owner,
    repo,
    cloneUrl: `https://github.com/${owner}/${repo}.git`,
    nameHint: repo,
  };
}

export function githubAuthStatus(): GithubResult {
  const env = gitEnvCheck();
  const r = run("gh", ["auth", "status"], { timeoutMs: 15_000 });
  const text = `${r.stdout}\n${r.stderr}`;
  const userMatch =
    text.match(/Logged in to github\.com account (\S+)/i) ||
    text.match(/account (\S+)/i);
  const user = userMatch?.[1]?.replace(/[()]/g, "") || "";
  const loggedIn =
    r.code === 0 &&
    /Logged in to github\.com/i.test(text) &&
    !/token .* is invalid/i.test(text) &&
    !/Failed to log in/i.test(text);

  const envSummary = {
    useOperatorLoginEnv: env.useOperatorLoginEnv,
    seatUser: env.seat.name,
    seatHome: env.seat.home,
    gitPath: env.git.path,
    gitVersion: env.git.version,
    ghPath: env.gh.path,
    ghVersion: env.gh.version,
    wrappedForSeat: env.env.wrappedForSeat,
    envHint: env.hint,
  };

  if (loggedIn && user) {
    return {
      ok: true,
      data: {
        loggedIn: true,
        user,
        host: "github.com",
        hint: null,
        ...envSummary,
      },
    };
  }

  // Prefer a clear sign-in hint; never echo tokens from hosts.yml.
  // Env hints about setpriv/login-env stay in envHint — auth hint is always the sign-in command.
  return {
    ok: true,
    data: {
      loggedIn: false,
      user: null,
      host: "github.com",
      hint: `Sign in to GitHub on this laptop: ${GH_SIGNIN_HINT} (Settings → Git & GitHub)`,
      detail: /invalid|Failed to log in|not logged/i.test(text)
        ? "GitHub CLI is not signed in (or the saved login is invalid)."
        : r.code === 0
          ? "GitHub CLI did not report a signed-in user."
          : (r.stderr || r.stdout || "gh auth status failed").slice(0, 240),
      ...envSummary,
    },
  };
}

export type GithubRepoRow = {
  name: string;
  nameWithOwner: string;
  url: string;
  isPrivate: boolean;
  defaultBranch: string;
  description: string;
};

export function listGithubRepos(
  opts: {
    search?: string;
    limit?: number;
    surface?: GithubSurface;
  } = {},
): GithubResult {
  const surface = opts.surface || "gui";
  const gate = refuseMcpGithub(surface);
  if (gate) return gate;

  const auth = githubAuthStatus();
  if (!auth.data?.loggedIn) {
    return plainError(
      String(auth.data?.hint || `Sign in to GitHub: ${GH_SIGNIN_HINT}`),
    );
  }

  const limit = Math.min(100, Math.max(1, Number(opts.limit) || 30));
  const args = [
    "repo",
    "list",
    "--limit",
    String(limit),
    "--json",
    "name,nameWithOwner,url,isPrivate,defaultBranchRef,description",
  ];
  const search = String(opts.search || "").trim();
  // Filter client-side; avoid passing free-form into gh beyond list.

  const r = run("gh", args, { timeoutMs: 60_000 });
  if (r.code !== 0) {
    return plainError(
      (r.stderr || r.stdout || "gh repo list failed").slice(0, 400),
    );
  }
  let rows: unknown[] = [];
  try {
    rows = JSON.parse(r.stdout || "[]") as unknown[];
  } catch {
    return plainError("could not parse gh repo list JSON");
  }

  let repos: GithubRepoRow[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const o = row as Record<string, unknown>;
    const name = String(o.name || "");
    const nameWithOwner = String(o.nameWithOwner || "");
    const url = String(o.url || "");
    const isPrivate = Boolean(o.isPrivate);
    const dbr = o.defaultBranchRef as { name?: string } | string | null;
    const defaultBranch =
      typeof dbr === "string"
        ? dbr
        : dbr && typeof dbr === "object"
          ? String(dbr.name || "main")
          : "main";
    const description = String(o.description || "");
    if (!nameWithOwner) continue;
    repos.push({
      name,
      nameWithOwner,
      url,
      isPrivate,
      defaultBranch: defaultBranch || "main",
      description,
    });
  }

  if (search) {
    const q = search.toLowerCase();
    repos = repos.filter(
      (repo) =>
        repo.name.toLowerCase().includes(q) ||
        repo.nameWithOwner.toLowerCase().includes(q) ||
        repo.description.toLowerCase().includes(q),
    );
  }

  return {
    ok: true,
    data: {
      repos,
      user: auth.data.user,
      count: repos.length,
    },
  };
}

function ensureDevelopmentGrok(cwd: string): GithubResult {
  const cur = run("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd,
    timeoutMs: 10_000,
  });
  const branch = cur.stdout.trim();
  if (branch === DEV_BRANCH) {
    return { ok: true, data: { branch: DEV_BRANCH, created: false } };
  }

  const local = run("git", ["show-ref", "--verify", "--quiet", `refs/heads/${DEV_BRANCH}`], {
    cwd,
    timeoutMs: 10_000,
  });
  if (local.code === 0) {
    const sw = run("git", ["switch", DEV_BRANCH], { cwd, timeoutMs: 30_000 });
    if (sw.code !== 0) {
      return plainError(
        (sw.stderr || sw.stdout || `could not switch to ${DEV_BRANCH}`).slice(
          0,
          400,
        ),
      );
    }
    return { ok: true, data: { branch: DEV_BRANCH, created: false } };
  }

  const remote = run(
    "git",
    ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${DEV_BRANCH}`],
    { cwd, timeoutMs: 10_000 },
  );
  if (remote.code === 0) {
    const sw = run(
      "git",
      ["switch", "-c", DEV_BRANCH, "--track", `origin/${DEV_BRANCH}`],
      { cwd, timeoutMs: 30_000 },
    );
    if (sw.code !== 0) {
      return plainError(
        (sw.stderr || sw.stdout || `could not track origin/${DEV_BRANCH}`).slice(
          0,
          400,
        ),
      );
    }
    return { ok: true, data: { branch: DEV_BRANCH, created: false, tracked: true } };
  }

  const created = run("git", ["switch", "-c", DEV_BRANCH], {
    cwd,
    timeoutMs: 30_000,
  });
  if (created.code !== 0) {
    return plainError(
      (created.stderr || created.stdout || `could not create ${DEV_BRANCH}`).slice(
        0,
        400,
      ),
    );
  }
  return { ok: true, data: { branch: DEV_BRANCH, created: true } };
}

function originUrl(cwd: string): string | null {
  const r = run("git", ["remote", "get-url", "origin"], {
    cwd,
    timeoutMs: 10_000,
  });
  if (r.code !== 0) return null;
  const url = r.stdout.trim();
  return url || null;
}

function normalizeRemoteUrl(url: string): string {
  return url
    .trim()
    .replace(/\.git$/i, "")
    .replace(/^git@github\.com:/i, "https://github.com/")
    .replace(/^ssh:\/\/git@github\.com\//i, "https://github.com/")
    .replace(/\/+$/, "")
    .toLowerCase();
}

export function cloneGithubWorkspace(opts: {
  repo: string;
  workspaceName?: string;
  branch?: string;
  surface?: GithubSurface;
}): GithubResult {
  const surface = opts.surface || "gui";
  const gate = refuseMcpGithub(surface);
  if (gate) return gate;
  if (surface === "mcp" && !mcpWorkspaceCreateAllowed()) {
    return plainError("MCP workspace creation is disabled in Settings");
  }

  const parsed = parseGithubRepoRef(opts.repo);
  if (!parsed) {
    return plainError(
      "Invalid GitHub repo — use owner/repo or a github.com URL",
    );
  }

  const name =
    String(opts.workspaceName || "").trim() || parsed.nameHint;
  const nameErr = validateWorkspaceName(name);
  if (nameErr) return plainError(nameErr);

  const branch = String(opts.branch || "").trim();
  if (branch) {
    const bErr = validateBranchName(branch);
    if (bErr) return plainError(bErr);
  }

  const root = ensureMcpWorkspacesRoot();
  let rootReal: string;
  try {
    rootReal = realpathSync(root);
  } catch {
    return plainError("MCP workspaces root is not available");
  }
  try {
    rejectSymlinkEscape(rootReal, rootReal);
  } catch {
    return plainError("MCP workspaces root is not safe");
  }

  const target = join(rootReal, name);
  if (!target.startsWith(rootReal + "/") && target !== rootReal) {
    return plainError("invalid workspace path");
  }
  if (existsSync(target) && dirNonEmpty(target)) {
    return plainError(
      "workspace folder already exists and is not empty — choose another name",
    );
  }
  const dup = assertNotDuplicate(target, name);
  if (dup) return plainError(dup);

  const existedEmpty = existsSync(target) && !dirNonEmpty(target);
  let createdDir = false;
  if (!existsSync(target)) {
    try {
      mkdirSync(target, { mode: 0o755 });
      createdDir = true;
    } catch (e) {
      return plainError(e instanceof Error ? e.message : String(e));
    }
  }

  // Always clone into the target directory with "." so we control the path.
  const cloneArgs = branch
    ? ["clone", "--branch", branch, parsed.cloneUrl, "."]
    : ["clone", parsed.cloneUrl, "."];
  const clone = run("git", cloneArgs, { cwd: target, timeoutMs: 300_000 });

  if (clone.code !== 0) {
    if (createdDir || existedEmpty) {
      try {
        rmSync(target, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    return plainError(
      (clone.stderr || clone.stdout || "git clone failed").slice(0, 500),
    );
  }

  const grok = ensureDevelopmentGrok(target);
  if (!grok.ok) {
    // Keep the clone; surface the branch issue.
  }

  try {
    repairProjectOwnership(target);
  } catch {
    /* best-effort */
  }

  let project: Project;
  try {
    project = upsertProjectFromInput({
      path: target,
      name,
      id: projectIdForName(name),
    });
  } catch (e) {
    return plainError(e instanceof Error ? e.message : String(e));
  }

  const origin = originUrl(target);
  return {
    ok: true,
    data: {
      project,
      path: target,
      origin: origin,
      repo: `${parsed.owner}/${parsed.repo}`,
      branch: String(grok.data?.branch || DEV_BRANCH),
      developmentGrok: grok.data || null,
      openGitPanel: true,
      warning: grok.ok ? undefined : grok.error,
    },
  };
}

export function connectWorkspaceToGithub(opts: {
  projectId: string;
  repo: string;
  setUpstream?: boolean;
  surface?: GithubSurface;
}): GithubResult {
  const surface = opts.surface || "gui";
  const gate = refuseMcpGithub(surface);
  if (gate) return gate;

  const project = loadProjects().get(String(opts.projectId || "").trim());
  if (!project) return plainError("project not found");

  const parsed = parseGithubRepoRef(opts.repo);
  if (!parsed) {
    return plainError(
      "Invalid GitHub repo — use owner/repo or a github.com URL",
    );
  }

  const cwd = resolve(project.path);
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
    return plainError("project path does not exist");
  }

  const want = normalizeRemoteUrl(parsed.cloneUrl);
  const existing = isGitRepo(cwd) ? originUrl(cwd) : null;

  if (existing) {
    const have = normalizeRemoteUrl(existing);
    if (have !== want) {
      return plainError(
        `This workspace already has a different origin (${existing}). ` +
          `Home Base will not remove or replace remotes — connect a different folder or fix origin manually.`,
      );
    }
    // Same origin already — optionally set upstream.
  } else if (!isGitRepo(cwd)) {
    const init = run("git", ["init", "-b", "main"], { cwd, timeoutMs: 30_000 });
    if (init.code !== 0) {
      return plainError(
        (init.stderr || init.stdout || "git init failed").slice(0, 400),
      );
    }
    const add = run("git", ["remote", "add", "origin", parsed.cloneUrl], {
      cwd,
      timeoutMs: 15_000,
    });
    if (add.code !== 0) {
      return plainError(
        (add.stderr || add.stdout || "git remote add failed").slice(0, 400),
      );
    }
  } else {
    // Git repo but no origin
    const add = run("git", ["remote", "add", "origin", parsed.cloneUrl], {
      cwd,
      timeoutMs: 15_000,
    });
    if (add.code !== 0) {
      return plainError(
        (add.stderr || add.stdout || "git remote add failed").slice(0, 400),
      );
    }
  }

  const fetch = run("git", ["fetch", "origin"], { cwd, timeoutMs: 180_000 });
  if (fetch.code !== 0) {
    return {
      ok: true,
      data: {
        projectId: project.id,
        origin: originUrl(cwd),
        fetched: false,
        warning: (fetch.stderr || fetch.stdout || "fetch failed").slice(0, 400),
      },
    };
  }

  if (opts.setUpstream) {
    const branchR = run("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd,
      timeoutMs: 10_000,
    });
    const branch = branchR.stdout.trim();
    if (branch && branch !== "HEAD") {
      run(
        "git",
        ["branch", `--set-upstream-to=origin/${branch}`, branch],
        { cwd, timeoutMs: 15_000 },
      );
    }
  }

  return {
    ok: true,
    data: {
      projectId: project.id,
      origin: originUrl(cwd),
      repo: `${parsed.owner}/${parsed.repo}`,
      fetched: true,
      setUpstream: Boolean(opts.setUpstream),
    },
  };
}

export function createGithubRepoFromWorkspace(opts: {
  projectId: string;
  name?: string;
  visibility?: "private" | "public";
  confirm?: boolean;
  surface?: GithubSurface;
}): GithubResult {
  const surface = opts.surface || "gui";
  const gate = refuseMcpGithub(surface);
  if (gate) return gate;
  if (surface === "mcp" && !mcpGitWriteAllowed()) {
    return plainError(
      "MCP git write actions are disabled in Settings (required to push)",
    );
  }

  if (!opts.confirm) {
    return plainError(
      "Creating a GitHub repo requires confirm: true (GUI confirm dialog)",
    );
  }

  const project = loadProjects().get(String(opts.projectId || "").trim());
  if (!project) return plainError("project not found");
  const cwd = resolve(project.path);
  if (!existsSync(cwd)) return plainError("project path does not exist");

  const auth = githubAuthStatus();
  if (!auth.data?.loggedIn) {
    return plainError(
      String(auth.data?.hint || `Sign in to GitHub: ${GH_SIGNIN_HINT}`),
    );
  }

  if (!isGitRepo(cwd)) {
    const init = run("git", ["init", "-b", "main"], { cwd, timeoutMs: 30_000 });
    if (init.code !== 0) {
      return plainError(
        (init.stderr || init.stdout || "git init failed").slice(0, 400),
      );
    }
  }

  const existing = originUrl(cwd);
  if (existing) {
    return plainError(
      `This workspace already has origin (${existing}). Will not create another remote.`,
    );
  }

  const name =
    String(opts.name || "").trim() ||
    project.name.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 64) ||
    project.id;
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    return plainError("invalid GitHub repository name");
  }

  const visibility = opts.visibility === "public" ? "public" : "private";
  const createArgs = [
    "repo",
    "create",
    name,
    visibility === "public" ? "--public" : "--private",
    "--source=.",
    "--remote=origin",
  ];
  // Do not push via gh --push; we push ourselves without --force.
  const created = run("gh", createArgs, { cwd, timeoutMs: 120_000 });
  if (created.code !== 0) {
    // Fallback: create without --source then add remote
    const create2 = run(
      "gh",
      [
        "repo",
        "create",
        name,
        visibility === "public" ? "--public" : "--private",
      ],
      { timeoutMs: 120_000 },
    );
    if (create2.code !== 0) {
      return plainError(
        (created.stderr ||
          create2.stderr ||
          created.stdout ||
          "gh repo create failed").slice(0, 500),
      );
    }
    const urlMatch =
      (create2.stdout + "\n" + create2.stderr).match(
        /https:\/\/github\.com\/\S+/i,
      ) || [];
    const cloneUrl =
      urlMatch[0]?.replace(/\.git$/i, "") + ".git" ||
      `https://github.com/${auth.data.user}/${name}.git`;
    const add = run("git", ["remote", "add", "origin", cloneUrl], {
      cwd,
      timeoutMs: 15_000,
    });
    if (add.code !== 0) {
      return plainError(
        (add.stderr || add.stdout || "git remote add failed").slice(0, 400),
      );
    }
  }

  // Never force-push.
  const push = run("git", ["push", "-u", "origin", "HEAD"], {
    cwd,
    timeoutMs: 300_000,
  });
  if (push.code !== 0) {
    return {
      ok: false,
      error: (push.stderr || push.stdout || "git push failed").slice(0, 500),
      data: {
        origin: originUrl(cwd),
        pushed: false,
        note: "Repo may exist on GitHub; push failed (no force used).",
      },
    };
  }

  return {
    ok: true,
    data: {
      projectId: project.id,
      name,
      visibility,
      origin: originUrl(cwd),
      pushed: true,
    },
  };
}

/** Exported for unit tests — ensure push argv never includes force. */
export function pushArgvNeverForce(args: string[]): boolean {
  return (
    args[0] === "push" &&
    !args.some((a) => BLOCKED_ARG_RE.test(a) || a === "--force" || a === "-f")
  );
}
