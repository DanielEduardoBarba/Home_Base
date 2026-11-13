import { afterAll, afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "hb-gh-"));
const runtime = join(root, "runtime");
const projectsPath = join(root, "projects.json");
const mcpRoot = join(root, "MCP_WORKSPACES");
mkdirSync(runtime, { recursive: true });
mkdirSync(mcpRoot, { recursive: true, mode: 0o700 });
mkdirSync(join(runtime, "chats"), { recursive: true });

process.env.HOMEBASE_RUNTIME = runtime;
process.env.HOMEBASE_PROJECTS = projectsPath;
process.env.HOMEBASE_MCP_WORKSPACES_ROOT = mcpRoot;
process.env.HOMEBASE_HOME = root;
process.env.HOMEBASE_OPERATOR_GIT_ENV = "0";

writeFileSync(
  projectsPath,
  JSON.stringify({
    projects: [
      {
        id: "demo",
        name: "Demo",
        path: join(root, "demo-ws"),
        ports: [],
        actions: [],
      },
    ],
  }) + "\n",
);
mkdirSync(join(root, "demo-ws"), { recursive: true });

const { PROJECTS_PATH, RUNTIME_DIR } = await import("../../src/config");
const mcp = await import("../../src/mcp_server");
const gh = await import("../../src/github");
const ws = await import("../../src/workspace");

function envIsolated(): boolean {
  return PROJECTS_PATH.startsWith(root) && RUNTIME_DIR.startsWith(root);
}

const describeGh = envIsolated() ? describe : describe.skip;

afterAll(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

afterEach(() => {
  gh._setGithubRunnerForTests(null);
  mcp.saveMcpServer({
    allowMcpGithubRepos: false,
    allowMcpWorkspaceCreate: false,
    allowMcpGitWrite: false,
  });
});

describeGh("github parse + validation", () => {
  test("parses owner/repo and URLs", () => {
    expect(gh.parseGithubRepoRef("acme/widget")?.repo).toBe("widget");
    expect(
      gh.parseGithubRepoRef("https://github.com/acme/widget.git")?.owner,
    ).toBe("acme");
    expect(gh.parseGithubRepoRef("git@github.com:acme/widget.git")?.repo).toBe(
      "widget",
    );
    expect(gh.parseGithubRepoRef("../escape")).toBeNull();
    expect(gh.parseGithubRepoRef("acme/wi;dget")).toBeNull();
  });

  test("workspace name validation reused", () => {
    expect(ws.validateWorkspaceName("ok-app")).toBeNull();
    expect(ws.validateWorkspaceName("../x")).not.toBeNull();
    expect(ws.validateWorkspaceName(".hidden")).not.toBeNull();
  });

  test("push argv never force", () => {
    expect(gh.pushArgvNeverForce(["push", "-u", "origin", "HEAD"])).toBe(true);
    expect(gh.pushArgvNeverForce(["push", "--force", "origin", "HEAD"])).toBe(
      false,
    );
    expect(gh.pushArgvNeverForce(["push", "-f", "origin", "HEAD"])).toBe(false);
  });
});

describeGh("github MCP toggles", () => {
  test("list repos refused when GitHub access off", () => {
    mcp.saveMcpServer({ allowMcpGithubRepos: false });
    const r = gh.listGithubRepos({ surface: "mcp" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/GitHub repo access is disabled/i);
  });

  test("clone refused without workspace create toggle", () => {
    mcp.saveMcpServer({
      allowMcpGithubRepos: true,
      allowMcpWorkspaceCreate: false,
    });
    const r = gh.cloneGithubWorkspace({
      repo: "acme/widget",
      workspaceName: "widget",
      surface: "mcp",
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/workspace creation is disabled/i);
  });

  test("create repo refused without git write toggle", () => {
    mcp.saveMcpServer({
      allowMcpGithubRepos: true,
      allowMcpGitWrite: false,
    });
    const r = gh.createGithubRepoFromWorkspace({
      projectId: "demo",
      confirm: true,
      surface: "mcp",
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/git write actions are disabled/i);
  });

  test("status works without GitHub access toggle", () => {
    mcp.saveMcpServer({ allowMcpGithubRepos: false });
    gh._setGithubRunnerForTests((cmd, args) => {
      if (cmd === "gh" && args[0] === "auth") {
        return {
          code: 1,
          stdout: "",
          stderr: "You are not logged into any GitHub hosts.",
        };
      }
      return { code: 1, stdout: "", stderr: "unexpected" };
    });
    const r = gh.githubAuthStatus();
    expect(r.ok).toBe(true);
    expect(r.data?.loggedIn).toBe(false);
    expect(String(r.data?.hint || "")).toMatch(/gh auth login/);
  });
});

describeGh("github path confinement + origin refusal", () => {
  test("clone refuses non-empty existing folder", () => {
    mcp.saveMcpServer({
      allowMcpGithubRepos: true,
      allowMcpWorkspaceCreate: true,
    });
    const name = "taken-ws";
    const target = join(mcpRoot, name);
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "keep.txt"), "x\n");
    gh._setGithubRunnerForTests(() => ({
      code: 0,
      stdout: "",
      stderr: "",
    }));
    const r = gh.cloneGithubWorkspace({
      repo: "acme/widget",
      workspaceName: name,
      surface: "mcp",
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/already exists and is not empty/i);
    expect(existsSync(join(target, "keep.txt"))).toBe(true);
  });

  test("connect refuses different existing origin", () => {
    mcp.saveMcpServer({ allowMcpGithubRepos: true });
    const cwd = join(root, "demo-ws");
    let step = 0;
    gh._setGithubRunnerForTests((cmd, args, opts) => {
      if (cmd === "git" && args[0] === "rev-parse") {
        return { code: 0, stdout: "true\n", stderr: "" };
      }
      if (cmd === "git" && args[0] === "remote" && args[1] === "get-url") {
        return {
          code: 0,
          stdout: "https://github.com/other/repo.git\n",
          stderr: "",
        };
      }
      step++;
      return {
        code: 1,
        stdout: "",
        stderr: `unexpected ${cmd} ${args.join(" ")} in ${opts?.cwd}`,
      };
    });
    const r = gh.connectWorkspaceToGithub({
      projectId: "demo",
      repo: "acme/widget",
      surface: "mcp",
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/different origin/i);
    expect(r.error).toMatch(/will not remove/i);
    expect(step).toBe(0);
  });

  test("clone path stays under MCP root", () => {
    mcp.saveMcpServer({
      allowMcpGithubRepos: true,
      allowMcpWorkspaceCreate: true,
    });
    const calls: string[] = [];
    gh._setGithubRunnerForTests((cmd, args, opts) => {
      calls.push(`${cmd} ${args.join(" ")} @ ${opts?.cwd || ""}`);
      if (cmd === "git" && args[0] === "clone") {
        // Simulate successful clone by creating .git marker
        const cwd = opts?.cwd || "";
        if (cwd) mkdirSync(join(cwd, ".git"), { recursive: true });
        return { code: 0, stdout: "", stderr: "" };
      }
      if (cmd === "git" && args[0] === "rev-parse" && args[1] === "--abbrev-ref") {
        return { code: 0, stdout: "main\n", stderr: "" };
      }
      if (cmd === "git" && args[0] === "show-ref") {
        return { code: 1, stdout: "", stderr: "" };
      }
      if (cmd === "git" && args[0] === "switch") {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (cmd === "git" && args[0] === "remote" && args[1] === "get-url") {
        return {
          code: 0,
          stdout: "https://github.com/acme/widget.git\n",
          stderr: "",
        };
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    const r = gh.cloneGithubWorkspace({
      repo: "acme/widget",
      workspaceName: "confined-app",
      surface: "mcp",
    });
    expect(r.ok).toBe(true);
    const path = String(r.data?.path || "");
    expect(path.startsWith(mcpRoot + "/")).toBe(true);
    expect(path.includes("..")).toBe(false);
    expect(readdirSync(mcpRoot)).toContain("confined-app");
  });
});
