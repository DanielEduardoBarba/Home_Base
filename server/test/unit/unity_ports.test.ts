import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  allocateUnityPorts,
  mcpWorkspaceUpsertFields,
  syncUnityActionPorts,
  upsertProjectFromInput,
} from "../../src/config";
import { projectLanEnv } from "../../src/network";

describe("syncUnityActionPorts", () => {
  test("replaces hard-coded 8410 args and sets UNITY_WEBGL_PORT env", () => {
    const out = syncUnityActionPorts(
      [
        {
          id: "webgl",
          script: "scripts/unity/live-webgl.sh",
          args: ["8410"],
        },
        {
          id: "webgl_serve",
          script: "npx --yes serve -l 8410 Builds/WebGL",
          args: [],
        },
        { id: "editor", script: "scripts/unity/start-editor-bridge.sh", args: [] },
      ],
      [
        { id: "webgl", port: 8411 },
        { id: "mcp-bridge", port: 6400 },
      ],
    );
    const webgl = out.find((a) => a.id === "webgl") as {
      args: string[];
      env: Record<string, string>;
    };
    const serve = out.find((a) => a.id === "webgl_serve") as {
      args: string[];
      env: Record<string, string>;
      script: string;
    };
    const editor = out.find((a) => a.id === "editor") as {
      env: Record<string, string>;
    };
    expect(webgl.args[0]).toBe("8411");
    expect(webgl.env.UNITY_WEBGL_PORT).toBe("8411");
    expect(serve.env.UNITY_WEBGL_PORT).toBe("8411");
    expect(serve.args[0]).toBe("8411");
    expect(serve.script).toContain("-l 8411");
    expect(serve.script).not.toContain("8410");
    expect(editor.env.UNITY_MCP_PORT).toBe("6400");
  });

  test("upsertProjectFromInput syncs webgl port into action args/env", () => {
    const root = mkdtempSync(join(tmpdir(), "hb-unity-port-"));
    const prevHome = process.env.HOMEBASE_HOME;
    const prevProjects = process.env.HOMEBASE_PROJECTS;
    process.env.HOMEBASE_HOME = root;
    process.env.HOMEBASE_PROJECTS = join(root, "projects.json");
    mkdirSync(join(root, "config"), { recursive: true });
    writeFileSync(join(root, "projects.json"), '{"projects":[]}\n');
    try {
      const proj = join(root, "game");
      mkdirSync(join(proj, "ProjectSettings"), { recursive: true });
      writeFileSync(
        join(proj, "ProjectSettings/ProjectVersion.txt"),
        "m_EditorVersion: 6000.6.4f1\n",
      );
      const project = upsertProjectFromInput({
        path: proj,
        preset: "unity",
        id: "game",
        name: "Game",
        ports: [
          { id: "webgl", label: "WebGL", port: 8417 },
          { id: "mcp-bridge", label: "MCP Bridge", port: 6400 },
        ],
      });
      const live = project.actions.find((a) => a.id === "webgl");
      const serve = project.actions.find((a) => a.id === "webgl_serve");
      expect(live?.args[0]).toBe("8417");
      expect(live?.env.UNITY_WEBGL_PORT).toBe("8417");
      expect(serve?.env.UNITY_WEBGL_PORT).toBe("8417");
      expect(project.actions.some((a) => a.id === "unity_dev")).toBe(true);
    } finally {
      if (prevHome === undefined) delete process.env.HOMEBASE_HOME;
      else process.env.HOMEBASE_HOME = prevHome;
      if (prevProjects === undefined) delete process.env.HOMEBASE_PROJECTS;
      else process.env.HOMEBASE_PROJECTS = prevProjects;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("projectLanEnv always sets UNITY_WEBGL_PORT even without advertise host", () => {
    const env = projectLanEnv([
      { id: "webgl", port: 8413 },
      { id: "mcp-bridge", port: 6400 },
    ]);
    expect(env.UNITY_WEBGL_PORT).toBe("8413");
    expect(env.UNITY_MCP_PORT).toBe("6400");
  });

  test("HB-U-11: preset unity without ports allocates free webgl+bridge (not 8410/6400 when taken)", () => {
    const root = mkdtempSync(join(tmpdir(), "hb-unity-alloc-"));
    const prevHome = process.env.HOMEBASE_HOME;
    const prevProjects = process.env.HOMEBASE_PROJECTS;
    process.env.HOMEBASE_HOME = root;
    process.env.HOMEBASE_PROJECTS = join(root, "projects.json");
    mkdirSync(join(root, "config"), { recursive: true });
    writeFileSync(join(root, "projects.json"), '{"projects":[]}\n');
    try {
      const taken = join(root, "taken");
      mkdirSync(join(taken, "ProjectSettings"), { recursive: true });
      writeFileSync(
        join(taken, "ProjectSettings/ProjectVersion.txt"),
        "m_EditorVersion: 6000.6.4f1\n",
      );
      upsertProjectFromInput({
        path: taken,
        id: "taken",
        name: "Taken",
        ports: [
          { id: "webgl", label: "WebGL", port: 8410 },
          { id: "mcp-bridge", label: "MCP Bridge", port: 6400 },
        ],
        actions: [],
      });

      const next = join(root, "next");
      mkdirSync(join(next, "ProjectSettings"), { recursive: true });
      writeFileSync(
        join(next, "ProjectSettings/ProjectVersion.txt"),
        "m_EditorVersion: 6000.6.4f1\n",
      );
      // Simulate POST /api/projects { preset: "unity" } — no ports in body.
      const project = upsertProjectFromInput({
        path: next,
        preset: "unity",
        id: "next",
        name: "Next",
      });
      const webgl = project.ports.find((p) => p.id === "webgl")?.port;
      const bridge = project.ports.find((p) => p.id === "mcp-bridge")?.port;
      expect(webgl).not.toBe(8410);
      expect(bridge).not.toBe(6400);
      expect(Number(webgl)).toBeGreaterThan(8410);
      expect(Number(bridge)).toBeGreaterThan(6400);
    } finally {
      if (prevHome === undefined) delete process.env.HOMEBASE_HOME;
      else process.env.HOMEBASE_HOME = prevHome;
      if (prevProjects === undefined) delete process.env.HOMEBASE_PROJECTS;
      else process.env.HOMEBASE_PROJECTS = prevProjects;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("HB-U-12: MCP path allocates unique bridge ports; preserves lastmanholdout", () => {
    const root = mkdtempSync(join(tmpdir(), "hb-unity-bridge-"));
    const prevHome = process.env.HOMEBASE_HOME;
    const prevProjects = process.env.HOMEBASE_PROJECTS;
    process.env.HOMEBASE_HOME = root;
    process.env.HOMEBASE_PROJECTS = join(root, "projects.json");
    mkdirSync(join(root, "config"), { recursive: true });
    writeFileSync(join(root, "projects.json"), '{"projects":[]}\n');
    try {
      const holdout = join(root, "LastManHoldout");
      mkdirSync(join(holdout, "ProjectSettings"), { recursive: true });
      writeFileSync(
        join(holdout, "ProjectSettings/ProjectVersion.txt"),
        "m_EditorVersion: 6000.6.4f1\n",
      );
      upsertProjectFromInput({
        path: holdout,
        id: "lastmanholdout",
        name: "LastManHoldout",
        ports: [
          { id: "webgl", label: "WebGL", port: 8411 },
          { id: "mcp-bridge", label: "MCP Bridge", port: 6400 },
        ],
        actions: [],
      });

      const a = join(root, "u-a");
      const b = join(root, "u-b");
      for (const p of [a, b]) {
        mkdirSync(join(p, "ProjectSettings"), { recursive: true });
        writeFileSync(
          join(p, "ProjectSettings/ProjectVersion.txt"),
          "m_EditorVersion: 6000.6.4f1\n",
        );
      }
      const fa = mcpWorkspaceUpsertFields({ path: a, id: "ua", name: "A" });
      upsertProjectFromInput({
        path: a,
        id: "ua",
        name: "A",
        preset: "unity",
        ports: fa.ports as { id: string; label: string; port: number }[],
      });
      const fb = mcpWorkspaceUpsertFields({ path: b, id: "ub", name: "B" });
      const portsA = fa.ports as { id: string; port: number }[];
      const portsB = fb.ports as { id: string; port: number }[];
      const bridgeA = portsA.find((p) => p.id === "mcp-bridge")!.port;
      const bridgeB = portsB.find((p) => p.id === "mcp-bridge")!.port;
      const webglA = portsA.find((p) => p.id === "webgl")!.port;
      const webglB = portsB.find((p) => p.id === "webgl")!.port;
      expect(bridgeA).not.toBe(6400);
      expect(bridgeB).not.toBe(bridgeA);
      expect(webglA).not.toBe(webglB);

      const kept = allocateUnityPorts({ path: holdout });
      expect(kept.webgl).toBe(8411);
      expect(kept.bridge).toBe(6400);
    } finally {
      if (prevHome === undefined) delete process.env.HOMEBASE_HOME;
      else process.env.HOMEBASE_HOME = prevHome;
      if (prevProjects === undefined) delete process.env.HOMEBASE_PROJECTS;
      else process.env.HOMEBASE_PROJECTS = prevProjects;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
