import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "hb-proj-rm-"));
const runtime = join(root, "runtime");
const projectsPath = join(root, "projects.json");
mkdirSync(join(runtime, "chats"), { recursive: true });

process.env.HOMEBASE_RUNTIME = runtime;
process.env.HOMEBASE_PROJECTS = projectsPath;

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
      {
        id: "demo-app",
        name: "Demo",
        path: root,
        ports: [],
        actions: [],
      },
    ],
  }) + "\n",
);

const { PROJECTS_PATH, RUNTIME_DIR, loadProjects } = await import("../../src/config");
const { createChat, getWorkspace } = await import("../../src/cursor");
const { removeRegisteredProject } = await import("../../src/project_remove");

function assertIsolatedEnv(): void {
  if (!PROJECTS_PATH.startsWith(root) || !RUNTIME_DIR.startsWith(root)) {
    throw new Error(
      `project_remove test env not applied (module cache polluted). ` +
        `Run this file alone. PROJECTS_PATH=${PROJECTS_PATH} RUNTIME_DIR=${RUNTIME_DIR}`,
    );
  }
}

afterAll(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("removeRegisteredProject", () => {
  test("refuses to remove homebase", () => {
    assertIsolatedEnv();
    const r = removeRegisteredProject("homebase");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Home Base/);
    expect(loadProjects().has("homebase")).toBe(true);
  });

  test("stops registry + chat artifacts for a normal app", () => {
    assertIsolatedEnv();
    const tab = createChat("demo-app", { title: "Work chat" });
    expect(getWorkspace("demo-app").tabs.some((t) => t.id === tab.id)).toBe(true);
    const chatFile = join(RUNTIME_DIR, "chats", "demo-app.json");
    expect(existsSync(chatFile)).toBe(true);

    const r = removeRegisteredProject("demo-app");
    expect(r.ok).toBe(true);
    expect(r.chatsDeleted).toBeGreaterThanOrEqual(1);
    expect(loadProjects().has("demo-app")).toBe(false);
    expect(existsSync(chatFile)).toBe(false);

    const disk = JSON.parse(readFileSync(PROJECTS_PATH, "utf8")) as {
      projects: { id: string }[];
    };
    expect(disk.projects.map((p) => p.id)).toEqual(["homebase"]);
  });

  test("missing id is not ok", () => {
    assertIsolatedEnv();
    const r = removeRegisteredProject("no-such-app");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not found/);
  });
});
