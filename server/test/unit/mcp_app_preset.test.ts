import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("mcp app preset helpers", () => {
  let root = "";
  let prevHome = "";
  let prevRuntime = "";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "hb-mcp-preset-"));
    prevHome = process.env.HOMEBASE_HOME || "";
    prevRuntime = process.env.HOMEBASE_RUNTIME || "";
    process.env.HOMEBASE_HOME = root;
    process.env.HOMEBASE_RUNTIME = join(root, "runtime");
    mkdirSync(join(root, "config"), { recursive: true });
    writeFileSync(
      join(root, "config", "projects.json"),
      JSON.stringify({ projects: [] }, null, 2) + "\n",
    );
  });

  afterEach(() => {
    if (prevHome) process.env.HOMEBASE_HOME = prevHome;
    else delete process.env.HOMEBASE_HOME;
    if (prevRuntime) process.env.HOMEBASE_RUNTIME = prevRuntime;
    else delete process.env.HOMEBASE_RUNTIME;
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  test("bare folder stays without Run/Ship", async () => {
    const { mcpWorkspaceUpsertFields } = await import("../../src/config");
    const bare = join(root, "empty-bot");
    mkdirSync(bare, { recursive: true });
    const fields = mcpWorkspaceUpsertFields({ path: bare, id: "empty-bot", name: "Empty" });
    expect(fields.preset).toBeUndefined();
    expect(fields.ports).toBeUndefined();
  });

  test("build.sh checkout gets example preset + free ports", async () => {
    const {
      mcpWorkspaceUpsertFields,
      upsertProjectFromInput,
      loadProjects,
    } = await import("../../src/config");
    const app = join(root, "DoodlePie");
    mkdirSync(app, { recursive: true });
    writeFileSync(join(app, "build.sh"), "#!/bin/sh\n", { mode: 0o755 });
    const fields = mcpWorkspaceUpsertFields({
      path: app,
      id: "doodlepie",
      name: "DoodlePie",
    });
    expect(fields.preset).toBe("example");
    expect(Array.isArray(fields.ports)).toBe(true);
    expect((fields.ports as { port: number }[]).length).toBe(3);
    const project = upsertProjectFromInput(fields);
    expect(project.actions.some((a) => a.group === "main")).toBe(true);
    expect(project.actions.some((a) => a.group === "ship")).toBe(true);
    expect(project.ports.length).toBe(3);
    expect(loadProjects().get("doodlepie")?.ports.length).toBe(3);
  });

  test("healEmptyAppProject fills bare registered app", async () => {
    const {
      upsertProjectFromInput,
      healEmptyAppProject,
      loadProjects,
    } = await import("../../src/config");
    const app = join(root, "HealMe");
    mkdirSync(app, { recursive: true });
    writeFileSync(join(app, "build.sh"), "#!/bin/sh\n", { mode: 0o755 });
    upsertProjectFromInput({ path: app, id: "healme", name: "HealMe" });
    expect(loadProjects().get("healme")?.actions.length).toBe(0);
    const healed = healEmptyAppProject(loadProjects().get("healme")!);
    expect(healed).toBeTruthy();
    expect(healed!.actions.some((a) => a.group === "ship")).toBe(true);
  });
});
