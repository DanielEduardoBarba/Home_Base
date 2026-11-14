import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Project } from "../../src/config";

const root = mkdtempSync(join(tmpdir(), "hb-selfqa-"));

const selfqa = await import("../../src/selfqa");
const {
  buildSelfQaArgs,
  projectSupportsSelfQa,
  _resetSelfQaForTests,
  _setSelfQaDepsForTests,
} = selfqa;
const { watchActionSessions, _resetActionCallbacksForTests } = await import(
  "../../src/action_callbacks"
);
const tools = await import("../../src/homebase_tools");

function makeProject(id: string, path: string): Project {
  return {
    id,
    name: id,
    path,
    ports: [],
    actions: [],
    stateDir: "",
  };
}

afterAll(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

beforeEach(() => {
  _resetSelfQaForTests();
  _resetActionCallbacksForTests();
});

afterEach(() => {
  _resetSelfQaForTests();
  _resetActionCallbacksForTests();
});

describe("buildSelfQaArgs", () => {
  test("includes flags and clamps testers", () => {
    const args = buildSelfQaArgs({
      goal: "fix login",
      cycles: 2,
      maxMinutes: 30,
      testers: 99,
      dryRun: true,
    });
    expect(args).toContain("--selfqa");
    expect(args).toContain("--goal");
    expect(args).toContain("fix login");
    expect(args).toContain("--cycles");
    expect(args).toContain("2");
    expect(args).toContain("--testers");
    expect(args).toContain("6");
    expect(args).toContain("--dry-run");
  });
});

describe("projectSupportsSelfQa", () => {
  test("rejects missing build.sh", () => {
    const pdir = join(root, "proj-missing");
    mkdirSync(pdir, { recursive: true });
    const r = projectSupportsSelfQa(makeProject("missing", pdir));
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/no build\.sh/i);
  });

  test("rejects build.sh without --selfqa", () => {
    const pdir = join(root, "proj-nosupport");
    mkdirSync(pdir, { recursive: true });
    writeFileSync(join(pdir, "build.sh"), "#!/bin/bash\necho hi\n");
    const r = projectSupportsSelfQa(makeProject("nosupport", pdir));
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/does not support --selfqa/);
  });

  test("accepts build.sh with --selfqa", () => {
    const pdir = join(root, "proj-ok");
    mkdirSync(pdir, { recursive: true });
    writeFileSync(
      join(pdir, "build.sh"),
      "#!/bin/bash\n# --selfqa\ncase $1 in --selfqa) exit 0;; esac\n",
    );
    chmodSync(join(pdir, "build.sh"), 0o755);
    const r = projectSupportsSelfQa(makeProject("ok", pdir));
    expect(r.ok).toBe(true);
  });
});

describe("startSelfQa", () => {
  test("errors clearly when unsupported", async () => {
    const pdir = join(root, "proj-bad");
    mkdirSync(pdir, { recursive: true });
    writeFileSync(join(pdir, "build.sh"), "#!/bin/bash\necho no\n");
    const proj = makeProject("bad", pdir);
    _setSelfQaDepsForTests({ getProject: (id) => (id === "bad" ? proj : undefined) });
    await expect(
      selfqa.startSelfQa({ projectId: "bad", dryRun: true }),
    ).rejects.toThrow(/does not support --selfqa/);
  });

  test("enforces one active Self-QA per project", async () => {
    const pdir = join(root, "proj-one");
    mkdirSync(pdir, { recursive: true });
    writeFileSync(
      join(pdir, "build.sh"),
      "#!/usr/bin/env bash\n# --selfqa\nsleep 60\nexit 0\n",
    );
    chmodSync(join(pdir, "build.sh"), 0o755);
    const proj = makeProject("one", pdir);
    _setSelfQaDepsForTests({ getProject: (id) => (id === "one" ? proj : undefined) });
    const first = await selfqa.startSelfQa({
      projectId: "one",
      dryRun: true,
      goal: "first",
    });
    expect(first.status).toBe("running");
    expect(first.sessionId).toBeTruthy();
    await expect(
      selfqa.startSelfQa({ projectId: "one", dryRun: true }),
    ).rejects.toThrow(/already has an active Self-QA/);
    selfqa.stopSelfQa("one");
  });
});

describe("action callbacks", () => {
  test("watchActionSessions accepts http callbackUrl", () => {
    const r = watchActionSessions({
      projectId: "p",
      actionId: "run",
      sessionIds: ["abc"],
      callbackUrl: "http://127.0.0.1:9/hook",
    });
    expect(r.callbackUrl).toMatch(/^http/);
    expect(r.callbackId).toBeTruthy();
  });

  test("rejects non-http callbackUrl", () => {
    expect(() =>
      watchActionSessions({
        projectId: "p",
        actionId: "run",
        sessionIds: ["abc"],
        callbackUrl: "ftp://example/x",
      }),
    ).toThrow();
  });
});

describe("mcp tool registration", () => {
  test("homebase_selfqa is registered under projects", () => {
    expect(tools.MCP_TOOL_FEATURE.homebase_selfqa).toBe("projects");
    const mcp = tools.buildMcpTools({
      ...tools.MCP_FEATURE_DEFAULTS,
      projects: true,
    });
    expect(mcp.homebase_selfqa).toBeDefined();
    expect(mcp.homebase_run_action).toBeDefined();
    const runAction = mcp.homebase_run_action!;
    const schema = runAction.parameters as {
      properties?: Record<string, unknown>;
    };
    expect(schema.properties?.callbackUrl).toBeDefined();
    expect(schema.properties?.callbackAuth).toBeDefined();
  });
});
