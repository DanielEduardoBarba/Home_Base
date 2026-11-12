import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "hb-ws-"));
const runtime = join(root, "runtime");
const projectsPath = join(root, "projects.json");
const mcpRoot = join(root, "MCP_WORKSPACES");
const parents = join(root, "parents");
mkdirSync(join(runtime, "chats"), { recursive: true });
mkdirSync(parents, { recursive: true });
mkdirSync(mcpRoot, { recursive: true, mode: 0o700 });

process.env.HOMEBASE_RUNTIME = runtime;
process.env.HOMEBASE_PROJECTS = projectsPath;
process.env.HOMEBASE_MCP_WORKSPACES_ROOT = mcpRoot;
process.env.HOMEBASE_HOME = root;

writeFileSync(
  projectsPath,
  JSON.stringify({
    projects: [
      {
        id: "homebase",
        name: "Home Base",
        path: root,
        ports: [],
        actions: [],
      },
    ],
  }) + "\n",
);

const { PROJECTS_PATH, RUNTIME_DIR, loadProjects } = await import("../../src/config");
const mcp = await import("../../src/mcp_server");
const ws = await import("../../src/workspace");

function envIsolated(): boolean {
  return PROJECTS_PATH.startsWith(root) && RUNTIME_DIR.startsWith(root);
}

const describeWorkspace = envIsolated() ? describe : describe.skip;

afterAll(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describeWorkspace("createMcpWorkspace", () => {
  test("toggle default off rejects", () => {
    mcp.saveMcpServer({ allowMcpWorkspaceCreate: false });
    const r = ws.createMcpWorkspace("bot-demo");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/disabled in Settings/i);
    expect(existsSync(join(mcpRoot, "bot-demo"))).toBe(false);
  });

  test("toggle explicitly off", () => {
    mcp.saveMcpServer({ allowMcpWorkspaceCreate: true });
    mcp.saveMcpServer({ allowMcpWorkspaceCreate: false });
    const r = ws.createMcpWorkspace("bot-off");
    expect(r.ok).toBe(false);
    expect(existsSync(join(mcpRoot, "bot-off"))).toBe(false);
  });

  test("happy path creates folder and registers", () => {
    mcp.saveMcpServer({ allowMcpWorkspaceCreate: true });
    const r = ws.createMcpWorkspace("my-bot-app");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.project.path).toBe(join(mcpRoot, "my-bot-app"));
      expect(loadProjects().has(r.project.id)).toBe(true);
    }
    expect(existsSync(join(mcpRoot, "my-bot-app"))).toBe(true);
    const disk = JSON.parse(readFileSync(projectsPath, "utf8")) as {
      projects: { id: string }[];
    };
    expect(disk.projects.some((p) => p.id === "my-bot-app")).toBe(true);
  });

  test("invalid names", () => {
    mcp.saveMcpServer({ allowMcpWorkspaceCreate: true });
    for (const name of ["", ".hidden", "bad/name", "a".repeat(65)]) {
      const r = ws.createMcpWorkspace(name);
      expect(r.ok).toBe(false);
    }
  });

  test("duplicate folder rejected", () => {
    const r = ws.createMcpWorkspace("my-bot-app");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/already exists/i);
  });

  test("absolute path name rejected", () => {
    const r = ws.createMcpWorkspace("/etc/passwd");
    expect(r.ok).toBe(false);
  });

  test("symlink escape rejected", () => {
    const escape = join(root, "escape-target");
    mkdirSync(escape, { recursive: true });
    const trap = join(mcpRoot, "trap-link");
    try {
      symlinkSync(escape, trap);
    } catch {
      return;
    }
    const r = ws.createMcpWorkspace("trap-link");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.length).toBeGreaterThan(0);
  });
});

describeWorkspace("createHumanWorkspace", () => {
  test("creates under parent regardless of MCP toggle", () => {
    mcp.saveMcpServer({ allowMcpWorkspaceCreate: false });
    const parent = join(parents, "human");
    mkdirSync(parent, { recursive: true });
    const p = ws.createHumanWorkspace({
      parentPath: parent,
      folderName: "fresh-app",
      displayName: "Fresh App",
    });
    expect(existsSync(p.path)).toBe(true);
    expect(loadProjects().has(p.id)).toBe(true);
  });

  test("blocks system parent", () => {
    expect(() =>
      ws.createHumanWorkspace({
        parentPath: "/usr",
        folderName: "evil",
      }),
    ).toThrow(/system directory/i);
  });
});

describeWorkspace("validateWorkspaceName", () => {
  test("illegal characters", () => {
    expect(ws.validateWorkspaceName("ok-name")).toBeNull();
    expect(ws.validateWorkspaceName("bad name")).not.toBeNull();
  });
});
