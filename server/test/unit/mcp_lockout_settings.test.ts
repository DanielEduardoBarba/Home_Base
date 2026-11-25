import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "hb-mcp-lockout-settings-"));
const runtime = join(root, ".runtime");
mkdirSync(runtime, { recursive: true });
process.env.HOMEBASE_HOME = root;
process.env.HOMEBASE_RUNTIME = runtime;
delete process.env.HOMEBASE_TRUSTED_PROXIES;

const { MCP_LOCKOUT_PATH, RUNTIME_DIR, LOCKOUT_SCHEMA_VERSION } = await import("../../src/config");
const auth = await import("../../src/auth");
const mcp = await import("../../src/mcp_server");
const recovery = await import("../../src/lockout_recovery");
const email = await import("../../src/email_alerts");
const slog = await import("../../src/security_log");
const pinMod = await import("../../src/app_pin");
const { app } = await import("../../src/app");
const cookies = await import("../../src/session_cookie");

function envIsolated(): boolean {
  return RUNTIME_DIR.startsWith(root);
}
const describeIso = envIsolated() ? describe : describe.skip;

const PASSWORD = "McpLockoutClear1!";

afterAll(() => {
  email.setEmailDeliverOverrideForTests(undefined);
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function seedMcpSource(source: string, failCount: number, lockedForSec: number): void {
  const file = recovery.loadMcpLockoutFile();
  file.sources[source] = {
    failCount,
    lockedUntil: lockedForSec > 0 ? Date.now() / 1000 + lockedForSec : 0,
  };
  recovery.saveMcpLockoutFile({
    schemaVersion: LOCKOUT_SCHEMA_VERSION,
    sources: file.sources,
  });
}

function setCookieLines(res: Response): string[] {
  const anyHeaders = res.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof anyHeaders.getSetCookie === "function") return anyHeaders.getSetCookie();
  const single = res.headers.get("set-cookie");
  return single ? [single] : [];
}

function cookieHeader(res: Response): string {
  return setCookieLines(res)
    .map((l) => l.split(";")[0])
    .filter(Boolean)
    .join("; ");
}

function csrfFrom(res: Response): string {
  const line = setCookieLines(res).find((l) =>
    l.toLowerCase().startsWith(`${cookies.CSRF_COOKIE}=`.toLowerCase()),
  );
  if (!line) return "";
  return decodeURIComponent(line.split("=")[1]?.split(";")[0] || "");
}

async function loginSession(): Promise<{ cookie: string; csrf: string }> {
  if (!auth.passwordIsSet()) auth.bootstrapPassword(PASSWORD);
  const res = await app.request(
    new Request("http://127.0.0.1/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: PASSWORD }),
    }),
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { csrfToken?: string };
  return {
    cookie: cookieHeader(res),
    csrf: body.csrfToken || csrfFrom(res),
  };
}

describeIso("MCP lockout Settings listing and clear", () => {
  test("listMcpLockouts returns every source with failCount, lockedUntil, and remaining time", () => {
    seedMcpSource("203.0.113.10", 3, 0);
    seedMcpSource("198.51.100.20", 8, 600);
    const listed = auth.listMcpLockouts();
    expect(listed.length).toBeGreaterThanOrEqual(2);
    const a = listed.find((s) => s.source === "203.0.113.10");
    const b = listed.find((s) => s.source === "198.51.100.20");
    expect(a?.failCount).toBe(3);
    expect(a?.locked).toBe(false);
    expect(a?.retryAfter).toBe(0);
    expect(a?.lockedUntil).toBe(0);
    expect(b?.failCount).toBe(8);
    expect(b?.locked).toBe(true);
    expect((b?.retryAfter || 0) > 0).toBe(true);
    expect((b?.lockedUntil || 0) > Date.now() / 1000).toBe(true);
  });

  test("clear one source and clear all write settings_clear and queue email", async () => {
    const sent: unknown[] = [];
    email.saveEmailAlerts({
      enabled: true,
      provider: "resend",
      to: "alerts@example.com",
      from: "Home Base <alerts@example.com>",
      resendApiKey: "re_test_not_a_real_key",
    });
    email.setEmailDeliverOverrideForTests(async (payload) => {
      sent.push(payload);
      return { ok: true };
    });

    seedMcpSource("10.0.0.5", 6, 300);
    seedMcpSource("10.0.0.6", 2, 0);
    const one = recovery.clearMcpLockoutFromSettings({
      source: "10.0.0.5",
      ip: "127.0.0.1",
      path: "/api/security/mcp-lockout/clear",
      userAgent: "QA-MCP-Clear/1",
    });
    expect(one.cleared).toBe(true);
    expect(one.method).toBe("settings_clear");
    expect(one.sourcesCleared).toBe(1);
    expect(one.sources).toEqual(["10.0.0.5"]);
    expect(auth.listMcpLockouts().some((s) => s.source === "10.0.0.5")).toBe(false);
    expect(auth.listMcpLockouts().some((s) => s.source === "10.0.0.6")).toBe(true);

    await recovery.flushLockoutEmails();
    const ev = slog
      .querySecurityLog({ event: "lockout_cleared", offset: 0, limit: 40 })
      .events.find((e) => e.method === "settings_clear" && String(e.message || "").includes("10.0.0.5"));
    expect(ev?.method).toBe("settings_clear");
    expect(ev?.source).toBe("ui");
    expect(ev?.previousFailCount).toBe(6);
    expect(slog.verifySecurityLog().ok).toBe(true);
    expect(sent.length).toBeGreaterThanOrEqual(1);
    const fieldText = JSON.stringify(sent[sent.length - 1]);
    expect(fieldText).toContain("Settings");
    expect(fieldText).not.toContain(PASSWORD);
    expect(fieldText).not.toContain("re_test");

    const all = recovery.clearMcpLockoutFromSettings({
      all: true,
      ip: "127.0.0.1",
      path: "/api/security/mcp-lockout/clear",
    });
    expect(all.cleared).toBe(true);
    expect(all.sourcesCleared).toBeGreaterThanOrEqual(1);
    expect(auth.listMcpLockouts().length).toBe(0);
    await recovery.flushLockoutEmails();
    expect(sent.length).toBeGreaterThanOrEqual(2);
    email.setEmailDeliverOverrideForTests(undefined);
  });

  test("clear endpoint rejects no session, MCP bearer, and wrong password or PIN", async () => {
    if (!auth.passwordIsSet()) auth.bootstrapPassword(PASSWORD);
    seedMcpSource("203.0.113.99", 5, 120);
    const before = JSON.stringify(recovery.loadMcpLockoutFile());

    const anon = await app.request(
      new Request("http://127.0.0.1/api/security/mcp-lockout/clear", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ all: true, password: PASSWORD }),
      }),
    );
    expect([401, 403]).toContain(anon.status);

    const minted = mcp.mintMcpToken("lockout-clear-block");
    const mcpRes = await app.request(
      new Request("http://127.0.0.1/api/security/mcp-lockout/clear", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${minted.accessToken}`,
        },
        body: JSON.stringify({ all: true, password: PASSWORD }),
      }),
    );
    expect(mcpRes.status).toBe(403);
    const mcpBody = (await mcpRes.json()) as { detail?: { code?: string } };
    expect(mcpBody.detail?.code).toBe("mcp_not_for_web");

    const session = await loginSession();
    const badPw = await app.request(
      new Request("http://127.0.0.1/api/security/mcp-lockout/clear", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: session.cookie,
          "x-csrf-token": session.csrf,
        },
        body: JSON.stringify({ source: "203.0.113.99", password: "WrongPassword!!" }),
      }),
    );
    expect(badPw.status).toBe(401);
    const badPwBody = (await badPw.json()) as { detail?: { code?: string } };
    expect(badPwBody.detail?.code).toBe("bad_password");

    if (!pinMod.isAppPinEnabled()) {
      pinMod.setAppPin("4242");
    }
    const badPin = await app.request(
      new Request("http://127.0.0.1/api/security/mcp-lockout/clear", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: session.cookie,
          "x-csrf-token": session.csrf,
        },
        body: JSON.stringify({ source: "203.0.113.99", pin: "1111" }),
      }),
    );
    expect(badPin.status).toBe(401);
    const badPinBody = (await badPin.json()) as { detail?: { code?: string } };
    expect(badPinBody.detail?.code).toBe("bad_pin");

    expect(JSON.stringify(recovery.loadMcpLockoutFile())).toBe(before);
    expect(auth.lockoutStatus().failCount).toBe(0);
    expect(auth.lockoutStatus().locked).toBe(false);

    const ok = await app.request(
      new Request("http://127.0.0.1/api/security/mcp-lockout/clear", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: session.cookie,
          "x-csrf-token": session.csrf,
        },
        body: JSON.stringify({ source: "203.0.113.99", password: PASSWORD }),
      }),
    );
    expect(ok.status).toBe(200);
    expect(auth.listMcpLockouts().some((s) => s.source === "203.0.113.99")).toBe(false);
  });
});

describeIso("valid MCP token on web-only route does not lock", () => {
  test("valid token on /api returns mcp_not_for_web without changing failCount or lockedUntil", async () => {
    const ip = "198.51.100.77";
    seedMcpSource(ip, 2, 0);
    const snapshotBefore = JSON.stringify(recovery.loadMcpLockoutFile());
    const before = auth.mcpLockoutStatus(ip);
    expect(before.failCount).toBe(2);
    expect(before.locked).toBe(false);

    const minted = mcp.mintMcpToken("web-surface-test");
    // Confirm the token is valid on the MCP surface first.
    expect(mcp.verifyMcpBearerToken(minted.accessToken, "10.6.0.1").id).toBe(minted.id);

    const res = await app.request(
      new Request("http://127.0.0.1/api/security/status", {
        headers: {
          authorization: `Bearer ${minted.accessToken}`,
        },
      }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { detail?: { code?: string } };
    expect(body.detail?.code).toBe("mcp_not_for_web");

    // Wrong surface must not bump any MCP lockout counters.
    expect(JSON.stringify(recovery.loadMcpLockoutFile())).toBe(snapshotBefore);
    const after = auth.mcpLockoutStatus(ip);
    expect(after.failCount).toBe(2);
    expect(after.locked).toBe(false);
    expect(after.retryAfter).toBe(0);
  });

  test("invalid MCP token still increments and can lock the source without locking human login", () => {
    const ip = "203.0.113.55";
    const humanBefore = auth.lockoutStatus();
    for (let i = 0; i < 5; i++) {
      try {
        mcp.verifyMcpBearerToken("hb_mcp_at_not_a_real_token", ip);
      } catch {
        /* expected */
      }
    }
    const mcpSt = auth.mcpLockoutStatus(ip);
    expect(mcpSt.failCount).toBeGreaterThanOrEqual(auth.FAIL_THRESHOLD);
    expect(mcpSt.locked).toBe(true);
    const human = auth.lockoutStatus();
    expect(human.failCount).toBe(humanBefore.failCount);
    expect(human.locked).toBe(false);
    expect(existsSync(MCP_LOCKOUT_PATH)).toBe(true);
    const raw = JSON.parse(readFileSync(MCP_LOCKOUT_PATH, "utf8")) as {
      sources?: Record<string, { failCount?: number }>;
    };
    expect(Number(raw.sources?.[ip]?.failCount || 0)).toBeGreaterThanOrEqual(auth.FAIL_THRESHOLD);
  });
});
