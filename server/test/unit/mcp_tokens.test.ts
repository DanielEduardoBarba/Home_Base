import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "hb-mcp-tok-"));
const runtime = join(root, ".runtime");
mkdirSync(runtime, { recursive: true });
process.env.HOMEBASE_HOME = root;
process.env.HOMEBASE_RUNTIME = runtime;

const { RUNTIME_DIR } = await import("../../src/config");
const mcp = await import("../../src/mcp_server");
const auth = await import("../../src/auth");

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

function codeOf(e: unknown): string {
  const d = (e as { detail?: { code?: string } }).detail;
  return d?.code || "";
}

describeIso("MCP connector tokens", () => {
  test("mint issues access+refresh; access verifies; lastUsed is set", () => {
    const minted = mcp.mintMcpToken("grok-devcon1");
    expect(minted.accessToken.startsWith("hb_mcp_at_")).toBe(true);
    expect(minted.refreshToken.startsWith("hb_mcp_rt_")).toBe(true);
    expect(minted.token).toBe(minted.accessToken);
    const v = mcp.verifyMcpBearerToken(minted.accessToken, "10.6.0.5");
    expect(v.id).toBe(minted.id);
    expect(v.label).toBe("grok-devcon1");
    const listed = mcp.listMcpTokens().find((t) => t.id === minted.id);
    expect(listed?.lastUsedIp).toBe("10.6.0.5");
    expect((listed?.lastUsedAt || 0) > 0).toBe(true);
  });

  test("invalid vs expired use distinct 401 codes; expiry does not lock the source", () => {
    try {
      mcp.verifyMcpBearerToken("hb_mcp_at_deadbeef_nope", "203.0.113.50");
      throw new Error("expected throw");
    } catch (e) {
      expect(codeOf(e)).toBe("mcp_token_invalid");
    }
    const minted = mcp.mintMcpToken("expiring");
    // Force expiry by rotating internal clock via refresh path: mint a token then
    // call verify after patching expiresAt through a second mint? Direct: refresh
    // is tested below. Here, a refresh token is rejected on /mcp verify.
    try {
      mcp.verifyMcpBearerToken(minted.refreshToken, "203.0.113.51");
      throw new Error("expected throw");
    } catch (e) {
      expect(codeOf(e)).toBe("mcp_token_invalid");
    }
    const before = auth.mcpLockoutStatus("203.0.113.77");
    // expired access: simulate by verifying a token then calling refresh isn't expiry.
    // Use rotate + old access token (old access hash is replaced, so it is invalid not expired).
    // Explicit expired path: set accessExpiresAt in the past via refreshMcpTokens after
    // we can't easily. Call internal by verifying after refresh — old access should be invalid.
    const rotated = mcp.refreshMcpTokens(minted.refreshToken, "10.6.0.8");
    try {
      mcp.verifyMcpBearerToken(minted.accessToken, "10.6.0.8");
      throw new Error("expected throw");
    } catch (e) {
      expect(["mcp_token_invalid", "mcp_token_expired"]).toContain(codeOf(e));
    }
    expect(mcp.verifyMcpBearerToken(rotated.accessToken, "10.6.0.8").id).toBe(minted.id);
    expect(auth.mcpLockoutStatus("203.0.113.77").failCount).toBe(before.failCount);

    const exp = mcp.mintMcpToken("expire-now");
    const tokensPath = join(runtime, "mcp_tokens.json");
    const file = JSON.parse(readFileSync(tokensPath, "utf8")) as {
      tokens: { id: string; accessExpiresAt?: number }[];
    };
    const rec = file.tokens.find((x) => x.id === exp.id);
    expect(rec).toBeTruthy();
    rec!.accessExpiresAt = Math.floor(Date.now() / 1000) - 30;
    writeFileSync(tokensPath, JSON.stringify(file, null, 2));
    const failsBefore = auth.mcpLockoutStatus("10.6.0.20").failCount;
    try {
      mcp.verifyMcpBearerToken(exp.accessToken, "10.6.0.20");
      throw new Error("expected expired");
    } catch (e) {
      expect(codeOf(e)).toBe("mcp_token_expired");
    }
    expect(auth.mcpLockoutStatus("10.6.0.20").failCount).toBe(failsBefore);
  });

  test("refresh rotates tokens; reuse of the old refresh revokes the connector", () => {
    const minted = mcp.mintMcpToken("reuse-test");
    const first = mcp.refreshMcpTokens(minted.refreshToken, "10.6.0.5");
    expect(first.accessToken).not.toBe(minted.accessToken);
    expect(first.refreshToken).not.toBe(minted.refreshToken);
    expect(mcp.verifyMcpBearerToken(first.accessToken, "10.6.0.5").id).toBe(minted.id);
    try {
      mcp.refreshMcpTokens(minted.refreshToken, "10.6.0.5");
      throw new Error("expected reuse revoke");
    } catch (e) {
      expect(codeOf(e)).toBe("mcp_token_revoked");
    }
    expect(() => mcp.verifyMcpBearerToken(first.accessToken, "10.6.0.5")).toThrow();
    expect(mcp.listMcpTokens().some((t) => t.id === minted.id)).toBe(false);
  });

  test("unknown MCP source is rate-limited on its own key", () => {
    const ip = "198.51.100.44";
    for (let i = 0; i < 5; i++) {
      try {
        mcp.verifyMcpBearerToken("hb_mcp_wrong", ip);
      } catch {
        /* expected */
      }
    }
    expect(auth.mcpLockoutStatus(ip).locked).toBe(true);
    expect(auth.lockoutStatus().locked).toBe(false);
  });
});
