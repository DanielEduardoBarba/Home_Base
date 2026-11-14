import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(tmpdir(), `hb-mcp-${process.pid}-${Date.now()}`);
mkdirSync(root, { recursive: true });
process.env.HOMEBASE_HOME = root;
process.env.HOMEBASE_RUNTIME = join(root, ".runtime");

const mcp = await import("../../src/mcp_server");
const tools = await import("../../src/homebase_tools");

afterAll(() => {
  if (existsSync(root)) rmSync(root, { recursive: true, force: true });
});

describe("mcp_server state + tokens", () => {
  test("defaults enabled when file absent", () => {
    expect(mcp.loadMcpServer().enabled).toBe(true);
    expect(mcp.mcpServerEnabled()).toBe(true);
  });

  test("feature defaults: vision off, others on", () => {
    const feats = mcp.loadMcpServer().features;
    expect(feats.projects).toBe(true);
    expect(feats.notifications).toBe(true);
    expect(feats.status).toBe(true);
    expect(feats.homeAccess).toBe(true);
    expect(feats.presence).toBe(true);
    expect(feats.vision).toBe(false);
  });

  test("toggle features persists", () => {
    mcp.saveMcpServer({ features: { vision: true, projects: false } });
    const feats = mcp.mcpServerFeatures();
    expect(feats.vision).toBe(true);
    expect(feats.projects).toBe(false);
    expect(feats.homeAccess).toBe(true);
    mcp.saveMcpServer({
      features: { vision: false, projects: true },
    });
  });

  test("toggle off persists", () => {
    mcp.saveMcpServer({ enabled: false });
    expect(mcp.mcpServerEnabled()).toBe(false);
    mcp.saveMcpServer({ enabled: true });
    expect(mcp.mcpServerEnabled()).toBe(true);
  });

  test("mint verify revoke fence", () => {
    const minted = mcp.mintMcpToken("test-client");
    expect(minted.token.startsWith("hb_mcp_")).toBe(true);
    const verified = mcp.verifyMcpBearerToken(minted.token);
    expect(verified.id).toBe(minted.id);
    expect(mcp.listMcpTokens().some((t) => t.id === minted.id)).toBe(true);
    expect(mcp.revokeMcpToken(minted.id)).toBe(true);
    expect(() => mcp.verifyMcpBearerToken(minted.token)).toThrow();
  });

  test("session-looking strings rejected", () => {
    expect(() => mcp.verifyMcpBearerToken("eyJhbGciOiJIUzI1NiJ9.fake")).toThrow();
    expect(() => mcp.verifyMcpBearerToken(undefined)).toThrow();
  });

  test("catalog respects vision default off", () => {
    mcp.saveMcpServer({
      enabled: true,
      features: { ...tools.MCP_FEATURE_DEFAULTS },
    });
    const pub = mcp.mcpServerPublic();
    expect(pub.features.vision).toBe(false);
    expect(pub.catalog.allowed.some((t) => t.name.startsWith("homebase_vision_"))).toBe(
      false,
    );
    expect(pub.catalog.disabled.some((t) => t.name === "homebase_vision_screenshot")).toBe(
      true,
    );
    expect(pub.grokGuide.includes("WireGuard")).toBe(true);
  });
});

describe("homebase tools AI deny + feature filter", () => {
  test("cursor and mcp surfaces omit security controls", () => {
    const cursor = tools.buildHomebaseTools("p1", false, {}, "cursor");
    const mcpTools = tools.buildHomebaseTools("", false, {}, "mcp");
    expect(cursor.homebase_wireguard_control).toBeUndefined();
    expect(cursor.homebase_restart_homebased).toBeUndefined();
    expect(mcpTools.homebase_wireguard_control).toBeUndefined();
    expect(mcpTools.homebase_restart_homebased).toBeUndefined();
    expect(cursor.homebase_propose_mode).toBeDefined();
    expect(mcpTools.homebase_propose_mode).toBeUndefined();
    expect(mcpTools.homebase_list_projects).toBeDefined();
    expect(mcpTools.homebase_run_action).toBeDefined();
    expect(mcpTools.homebase_selfqa).toBeDefined();
  });

  test("buildMcpTools filters by features", () => {
    const withVision = tools.buildMcpTools({
      ...tools.MCP_FEATURE_DEFAULTS,
      vision: true,
    });
    expect(withVision.homebase_vision_screenshot).toBeDefined();
    const without = tools.buildMcpTools(tools.MCP_FEATURE_DEFAULTS);
    expect(without.homebase_vision_screenshot).toBeUndefined();
    expect(without.homebase_list_projects).toBeDefined();
    const noProjects = tools.buildMcpTools({
      ...tools.MCP_FEATURE_DEFAULTS,
      projects: false,
    });
    expect(noProjects.homebase_list_projects).toBeUndefined();
    expect(noProjects.homebase_access_list).toBeDefined();
  });
});
