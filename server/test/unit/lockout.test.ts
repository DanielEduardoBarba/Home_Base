import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "hb-lockout-"));
const runtime = join(root, ".runtime");
mkdirSync(runtime, { recursive: true });
process.env.HOMEBASE_HOME = root;
process.env.HOMEBASE_RUNTIME = runtime;

const { LOCKOUT_PATH, MCP_LOCKOUT_PATH, RUNTIME_DIR } = await import("../../src/config");
const auth = await import("../../src/auth");
const mcp = await import("../../src/mcp_server");

function envIsolated(): boolean {
  return RUNTIME_DIR.startsWith(root);
}
const describeIso = envIsolated() ? describe : describe.skip;

afterAll(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describeIso("human vs MCP lockout isolation", () => {
  test("MCP invalid tokens do not increment the human login lockout", () => {
    const before = auth.lockoutStatus();
    expect(before.locked).toBe(false);
    for (let i = 0; i < 8; i++) {
      try {
        mcp.verifyMcpBearerToken("hb_mcp_not-a-real-token", "203.0.113.10");
      } catch {
        /* expected */
      }
    }
    const human = auth.lockoutStatus();
    expect(human.failCount).toBe(before.failCount);
    expect(human.locked).toBe(false);
    if (existsSync(LOCKOUT_PATH)) {
      const raw = JSON.parse(readFileSync(LOCKOUT_PATH, "utf8")) as { failCount?: number };
      expect(Number(raw.failCount || 0)).toBe(before.failCount);
    }
    const mcpSt = auth.mcpLockoutStatus("203.0.113.10");
    expect(mcpSt.failCount).toBeGreaterThanOrEqual(auth.FAIL_THRESHOLD);
    expect(mcpSt.locked).toBe(true);
    expect(() => mcp.verifyMcpBearerToken("hb_mcp_still-bad", "203.0.113.10")).toThrow();
    // A different source is not locked, and a valid token later still works.
    const other = auth.mcpLockoutStatus("198.51.100.2");
    expect(other.locked).toBe(false);
    expect(existsSync(MCP_LOCKOUT_PATH)).toBe(true);
  });

  test("human failures do not lock MCP from another source", () => {
    const minted = mcp.mintMcpToken("qa-connector");
    for (let i = 0; i < 5; i++) {
      auth.recordFailure("192.0.2.8", "invalid_password");
    }
    const human = auth.lockoutStatus();
    expect(human.locked).toBe(true);
    expect(() => auth.assertNotLocked()).toThrow();
    const verified = mcp.verifyMcpBearerToken(minted.accessToken || minted.token, "198.51.100.9");
    expect(verified.id).toBe(minted.id);
    expect(auth.mcpLockoutStatus("198.51.100.9").locked).toBe(false);
  });

  test("assertNotLocked includes remaining time, code, and remainingAttempts", () => {
    try {
      auth.assertNotLocked();
      throw new Error("expected lockout");
    } catch (e) {
      const err = e as { status?: number; detail?: { code?: string; retryAfter?: number; remainingAttempts?: number } };
      expect(err.status).toBe(429);
      expect(err.detail?.code).toBe("auth_lockout");
      expect((err.detail?.retryAfter || 0) > 0).toBe(true);
      expect(err.detail?.remainingAttempts).toBe(0);
    }
  });
});
