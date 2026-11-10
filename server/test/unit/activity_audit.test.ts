import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(tmpdir(), `hb-act-${process.pid}-${Date.now()}`);
mkdirSync(root, { recursive: true });
process.env.HOMEBASE_HOME = root;
process.env.HOMEBASE_RUNTIME = join(root, ".runtime");

const audit = await import("../../src/activity_audit");

afterAll(() => {
  if (existsSync(root)) rmSync(root, { recursive: true, force: true });
});

describe("activity_audit", () => {
  test("records and lists events", () => {
    audit.recordActivity({
      source: "mcp",
      kind: "tool",
      summary: "homebase_list_projects",
      actor: "grok",
      peerIp: "10.0.0.2",
    });
    audit.recordActivity({
      source: "web",
      kind: "nav",
      summary: "Area → vision",
    });
    const listed = audit.listActivity({ limit: 50 });
    expect(listed.events.length).toBeGreaterThanOrEqual(2);
    expect(listed.events.some((e) => e.source === "mcp")).toBe(true);
    expect(listed.events.some((e) => e.source === "web")).toBe(true);
  });

  test("source filter", () => {
    const mcpOnly = audit.listActivity({ source: "mcp", limit: 50 });
    expect(mcpOnly.events.every((e) => e.source === "mcp")).toBe(true);
  });
});
