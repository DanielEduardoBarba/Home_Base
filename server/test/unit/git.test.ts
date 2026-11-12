import { afterAll, afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = mkdtempSync(join(tmpdir(), "hb-git-"));
const runtime = join(root, "runtime");
const projectsPath = join(root, "projects.json");
const repo = join(root, "repo");
mkdirSync(runtime, { recursive: true });
mkdirSync(repo, { recursive: true });

process.env.HOMEBASE_RUNTIME = runtime;
process.env.HOMEBASE_PROJECTS = projectsPath;
process.env.HOMEBASE_HOME = root;

function git(cwd: string, args: string[]) {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  }
  return r;
}

git(repo, ["init", "-b", "main"]);
git(repo, ["config", "user.email", "test@example.com"]);
git(repo, ["config", "user.name", "Test"]);
writeFileSync(join(repo, "README.md"), "hello\n");
git(repo, ["add", "README.md"]);
git(repo, ["commit", "-m", "init"]);

writeFileSync(
  projectsPath,
  JSON.stringify({
    projects: [
      {
        id: "demo",
        name: "Demo",
        path: repo,
        ports: [],
        actions: [],
      },
    ],
  }) + "\n",
);

const { PROJECTS_PATH, RUNTIME_DIR, loadProjects } = await import(
  "../../src/config"
);
const gitMod = await import("../../src/git");
const jobs = await import("../../src/cursor_jobs");

function envIsolated(): boolean {
  return PROJECTS_PATH.startsWith(root) && RUNTIME_DIR.startsWith(root);
}

const describeGit = envIsolated() ? describe : describe.skip;

afterAll(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

afterEach(() => {
  jobs._resetCursorJobsForTests();
});

describeGit("git allow-list / blocked", () => {
  test("allows status/log/fetch/pull shapes", () => {
    expect(gitMod.isArgvAllowed(["status", "--porcelain"])).toBe(true);
    expect(gitMod.isArgvAllowed(["log", "-n5"])).toBe(true);
    expect(gitMod.isArgvAllowed(["fetch", "--all"])).toBe(true);
    expect(gitMod.isArgvAllowed(["pull", "--no-rebase", "--ff"])).toBe(true);
    expect(gitMod.isArgvAllowed(["switch", "main"])).toBe(true);
    expect(gitMod.isArgvAllowed(["stash", "push", "-u"])).toBe(true);
  });

  test("blocks destructive argv", () => {
    expect(gitMod.assertSafeGitArgv(["reset", "--hard"])).toMatch(/not allowed|blocked/i);
    expect(gitMod.assertSafeGitArgv(["clean", "-fd"])).toMatch(/not allowed/i);
    expect(gitMod.assertSafeGitArgv(["rebase", "main"])).toMatch(/not allowed/i);
    expect(gitMod.assertSafeGitArgv(["push", "--force"])).toMatch(/blocked/i);
    expect(gitMod.assertSafeGitArgv(["push", "--force-with-lease"])).toMatch(
      /blocked/i,
    );
    expect(gitMod.assertSafeGitArgv(["push", "--delete", "origin", "x"])).toMatch(
      /not allowed|blocked/i,
    );
    expect(gitMod.assertSafeGitArgv(["branch", "-D", "x"])).toMatch(
      /not allowed|blocked/i,
    );
    expect(gitMod.assertSafeGitArgv(["checkout", "--", "."])).toMatch(
      /not allowed/i,
    );
    expect(gitMod.assertSafeGitArgv(["stash", "drop"])).toMatch(/not allowed/i);
    expect(gitMod.assertSafeGitArgv(["gc"])).toMatch(/not allowed/i);
    expect(gitMod.assertSafeGitArgv(["filter-branch"])).toMatch(/not allowed/i);
  });
});

describeGit("branch name validation", () => {
  test("accepts normal names", () => {
    expect(gitMod.validateBranchName("feature/x")).toBeNull();
    expect(gitMod.validateBranchName("development_grok")).toBeNull();
  });

  test("rejects bad names", () => {
    expect(gitMod.validateBranchName("")).toMatch(/required/i);
    expect(gitMod.validateBranchName("-bad")).toMatch(/dash|invalid/i);
    expect(gitMod.validateBranchName("has space")).toMatch(/whitespace|invalid/i);
    expect(gitMod.validateBranchName("a..b")).toMatch(/invalid/i);
  });
});

describeGit("path confinement", () => {
  test("allows inside project", () => {
    const p = loadProjects().get("demo")!;
    const abs = gitMod.confinePath(p, "README.md");
    expect(abs.startsWith(repo)).toBe(true);
  });

  test("rejects escape", () => {
    const p = loadProjects().get("demo")!;
    expect(() => gitMod.confinePath(p, "../outside.txt")).toThrow(/escapes/i);
    expect(() => gitMod.confinePath(p, "/etc/passwd")).toThrow(/escapes/i);
  });
});

describeGit("dirty-tree refusal", () => {
  test("pull/checkout refuse when dirty", () => {
    const p = loadProjects().get("demo")!;
    writeFileSync(join(repo, "dirty.txt"), "x\n");
    expect(gitMod.isWorkingTreeDirty(repo)).toBe(true);
    const pull = gitMod.runGitAction(p, { action: "pull" }, { surface: "gui" });
    expect(pull.ok).toBe(false);
    expect(pull.error).toMatch(/uncommitted|stash/i);
    const co = gitMod.runGitAction(
      p,
      { action: "checkout", branch: "main" },
      { surface: "gui" },
    );
    expect(co.ok).toBe(false);
    expect(co.error).toMatch(/uncommitted|stash/i);
    rmSync(join(repo, "dirty.txt"));
  });
});

describeGit("cursor job lock", () => {
  test("refuses writes while job queued/running", async () => {
    const p = loadProjects().get("demo")!;
    jobs._setCursorJobDepsForTests({
      configured: () => true,
      getProject: (id) => (id === "demo" ? { path: repo } : undefined),
      createChat: () => ({
        id: "c1",
        title: "t",
        cwd: "",
        running: true,
        messages: [],
      }) as never,
      workspace: () => ({
        tabs: [
          {
            id: "c1",
            title: "t",
            cwd: "",
            running: true,
            messages: [],
          },
        ],
      }) as never,
      runner: async () => {},
    });
    // Seed an active job via startCursorJob
    const job = await jobs.startCursorJob({
      projectId: "demo",
      prompt: "test",
      waitMs: 0,
      source: "test",
    });
    expect(job.status === "queued" || job.status === "running").toBe(true);
    const r = gitMod.runGitAction(p, { action: "fetch" }, { surface: "gui" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Cursor job/i);
  });
});

describeGit("status happy path", () => {
  test("returns branch and commits", () => {
    const p = loadProjects().get("demo")!;
    // ensure clean
    spawnSync("git", ["checkout", "--", "."], { cwd: repo });
    spawnSync("git", ["clean", "-fd"], { cwd: repo });
    const r = gitMod.runGitAction(p, { action: "status" }, { surface: "gui" });
    expect(r.ok).toBe(true);
    expect(r.data?.branch).toBeTruthy();
    expect(Array.isArray(r.data?.commits)).toBe(true);
  });

  test("MCP write gate default off", () => {
    const p = loadProjects().get("demo")!;
    const r = gitMod.runGitAction(
      p,
      { action: "fetch" },
      { surface: "mcp", mcpWriteAllowed: false },
    );
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/disabled in Settings/i);
  });
});

describeGit("create branch", () => {
  test("creates and switches", () => {
    const p = loadProjects().get("demo")!;
    spawnSync("git", ["reset", "--hard"], { cwd: repo });
    spawnSync("git", ["clean", "-fd"], { cwd: repo });
    spawnSync("git", ["switch", "main"], { cwd: repo });
    expect(gitMod.isWorkingTreeDirty(repo)).toBe(false);
    const name = `feat-test-${Date.now()}`;
    const r = gitMod.runGitAction(
      p,
      { action: "create_branch", name, checkout: true },
      { surface: "gui" },
    );
    expect(r.ok).toBe(true);
    expect(existsSync(join(repo, ".git"))).toBe(true);
    const cur = spawnSync("git", ["branch", "--show-current"], {
      cwd: repo,
      encoding: "utf8",
    });
    expect(cur.stdout.trim()).toBe(name);
    spawnSync("git", ["switch", "main"], { cwd: repo });
  });
});
