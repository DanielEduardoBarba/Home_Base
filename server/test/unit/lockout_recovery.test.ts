import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "hb-lockout-recovery-"));
const runtime = join(root, ".runtime");
mkdirSync(runtime, { recursive: true });
process.env.HOMEBASE_HOME = root;
process.env.HOMEBASE_RUNTIME = runtime;
delete process.env.HOMEBASE_TRUSTED_PROXIES;

const { LOCKOUT_PATH, LOCAL_LOCKOUT_PATH, MCP_LOCKOUT_PATH, RUNTIME_DIR, LOCKOUT_SCHEMA_VERSION } =
  await import("../../src/config");
const auth = await import("../../src/auth");
const pin = await import("../../src/app_pin");
const localSeat = await import("../../src/local_seat");
const recovery = await import("../../src/lockout_recovery");
const email = await import("../../src/email_alerts");
const slog = await import("../../src/security_log");
const cli = await import("../../src/cli_unlock");
const sessionOut = await import("../../src/session_output");
const tools = await import("../../src/homebase_tools");

function envIsolated(): boolean {
  return RUNTIME_DIR.startsWith(root);
}
const describeIso = envIsolated() ? describe : describe.skip;

const PASSWORD = "LockoutRecover1!";

afterAll(() => {
  email.setEmailDeliverOverrideForTests(undefined);
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function headers(extra?: Record<string, string>): Headers {
  const h = new Headers();
  if (extra) {
    for (const [k, v] of Object.entries(extra)) h.set(k, v);
  }
  return h;
}

function lockHuman(failCount = 18, lockedForSec = 86_400): void {
  recovery.saveHumanLockout({
    schemaVersion: LOCKOUT_SCHEMA_VERSION,
    failCount,
    lockedUntil: Date.now() / 1000 + lockedForSec,
  });
}

async function ensurePassword(): Promise<void> {
  if (!auth.passwordIsSet()) {
    auth.bootstrapPassword(PASSWORD);
  }
}

async function tryLogin(opts: {
  password?: string;
  socketIp: string;
  headers?: Headers;
  clientIp?: string;
}) {
  await ensurePassword();
  const h = opts.headers || headers();
  const elig = localSeat.evaluateLocalSeatPasswordBypass({
    socketIp: opts.socketIp,
    headers: h,
  });
  return auth.loginWithPassword(opts.password ?? PASSWORD, opts.clientIp || opts.socketIp, {
    localSeat: elig.ok,
    socketIp: opts.socketIp,
    path: "/api/login",
    userAgent: "QA-Lockout/1.20.3",
  });
}

function expectLocked(fn: () => unknown, code = "auth_lockout"): { status?: number; detail?: Record<string, unknown> } {
  try {
    fn();
    throw new Error("expected lockout");
  } catch (e) {
    const err = e as { status?: number; detail?: Record<string, unknown> };
    expect(err.status).toBe(429);
    expect(err.detail?.code).toBe(code);
    return err;
  }
}

async function expectLoginRefused(opts: Parameters<typeof tryLogin>[0], code = "auth_lockout"): Promise<void> {
  try {
    await tryLogin(opts);
    throw new Error("expected login to be refused");
  } catch (e) {
    const err = e as { status?: number; detail?: { code?: string } };
    expect(err.status).toBe(429);
    expect(err.detail?.code).toBe(code);
  }
  expect(auth.lockoutStatus().locked).toBe(true);
}

function clearedEvents() {
  return slog.querySecurityLog({ event: "lockout_cleared", offset: 0, limit: 200 }).events;
}

describeIso("local-seat eligibility refusals", () => {
  const FORWARDING = [
    "x-forwarded-for",
    "x-forwarded-host",
    "x-forwarded-proto",
    "forwarded",
    "x-real-ip",
    "cf-connecting-ip",
    "true-client-ip",
  ] as const;

  for (const name of FORWARDING) {
    test(`refuses bypass when ${name} is present, even on loopback`, () => {
      const elig = localSeat.evaluateLocalSeatPasswordBypass({
        socketIp: "127.0.0.1",
        headers: headers({ [name]: name === "x-forwarded-proto" ? "https" : "203.0.113.9" }),
      });
      expect(elig.ok).toBe(false);
      expect(elig.reason).toBe("forwarding_header");
      expect(elig.header).toBe(name);
    });
  }

  test("refuses bypass when HOMEBASE_TRUSTED_PROXIES is set, even on loopback with no forwarding headers", () => {
    process.env.HOMEBASE_TRUSTED_PROXIES = "127.0.0.1";
    try {
      const elig = localSeat.evaluateLocalSeatPasswordBypass({
        socketIp: "127.0.0.1",
        headers: headers(),
      });
      expect(elig.ok).toBe(false);
      expect(elig.reason).toBe("trusted_proxies");
    } finally {
      delete process.env.HOMEBASE_TRUSTED_PROXIES;
    }
  });

  test("refuses VPN peer 10.6.0.5", () => {
    const elig = localSeat.evaluateLocalSeatPasswordBypass({
      socketIp: "10.6.0.5",
      headers: headers(),
    });
    expect(elig.ok).toBe(false);
    expect(elig.reason).toBe("not_loopback");
  });

  test("refuses LAN peer 192.168.1.50", () => {
    const elig = localSeat.evaluateLocalSeatPasswordBypass({
      socketIp: "192.168.1.50",
      headers: headers(),
    });
    expect(elig.ok).toBe(false);
    expect(elig.reason).toBe("not_loopback");
  });

  test("allows IPv4-mapped loopback ::ffff:127.0.0.1", () => {
    const elig = localSeat.evaluateLocalSeatPasswordBypass({
      socketIp: "::ffff:127.0.0.1",
      headers: headers(),
    });
    expect(elig.ok).toBe(true);
  });

  test("refuses IPv4-mapped VPN ::ffff:10.6.0.5", () => {
    const elig = localSeat.evaluateLocalSeatPasswordBypass({
      socketIp: "::ffff:10.6.0.5",
      headers: headers(),
    });
    expect(elig.ok).toBe(false);
    expect(elig.reason).toBe("not_loopback");
  });

  test("allows ::1", () => {
    expect(
      localSeat.evaluateLocalSeatPasswordBypass({
        socketIp: "::1",
        headers: headers(),
      }).ok,
    ).toBe(true);
  });

  test("refuses a Bearer token even on loopback", () => {
    const elig = localSeat.evaluateLocalSeatPasswordBypass({
      socketIp: "127.0.0.1",
      headers: headers({ authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.e30.sig" }),
    });
    expect(elig.ok).toBe(false);
    expect(elig.reason).toBe("bearer_or_mcp");
  });

  test("refuses an MCP connector Bearer token even on loopback", () => {
    const elig = localSeat.evaluateLocalSeatPasswordBypass({
      socketIp: "127.0.0.1",
      headers: headers({ authorization: "Bearer hb_mcp_connector-token-value" }),
    });
    expect(elig.ok).toBe(false);
    expect(elig.reason).toBe("bearer_or_mcp");
  });

  test("refuses a raw hb_mcp_ credential without Bearer", () => {
    const elig = localSeat.evaluateLocalSeatPasswordBypass({
      socketIp: "127.0.0.1",
      headers: headers({ authorization: "hb_mcp_raw-token" }),
    });
    expect(elig.ok).toBe(false);
    expect(elig.reason).toBe("bearer_or_mcp");
  });

  test("X-Forwarded-For spoof of 127.0.0.1 from a VPN socket is refused", () => {
    const elig = localSeat.evaluateLocalSeatPasswordBypass({
      socketIp: "10.6.0.5",
      headers: headers({ "x-forwarded-for": "127.0.0.1" }),
    });
    expect(elig.ok).toBe(false);
  });
});

describeIso("local-seat password login vs PIN and backoff", () => {
  test("correct password from 127.0.0.1 clears the human lockout", async () => {
    await ensurePassword();
    lockHuman();
    expect(auth.lockoutStatus().locked).toBe(true);
    const session = await tryLogin({ socketIp: "127.0.0.1" });
    expect(session.token.length).toBeGreaterThan(20);
    expect(auth.lockoutStatus().locked).toBe(false);
  });

  test("correct password from ::1 clears the human lockout", async () => {
    lockHuman();
    const session = await tryLogin({ socketIp: "::1" });
    expect(session.kind).toBe("session");
    expect(auth.lockoutStatus().locked).toBe(false);
  });

  test("correct password from ::ffff:127.0.0.1 clears the human lockout", async () => {
    lockHuman();
    await tryLogin({ socketIp: "::ffff:127.0.0.1" });
    expect(auth.lockoutStatus().locked).toBe(false);
  });

  test("each forwarding header blocks a correct local password from clearing the lockout", async () => {
    for (const name of localSeat.FORWARDING_HEADER_NAMES) {
      lockHuman();
      await expectLoginRefused({
        socketIp: "127.0.0.1",
        headers: headers({ [name]: "1" }),
      });
    }
  });

  test("HOMEBASE_TRUSTED_PROXIES blocks a correct local password from clearing the lockout", async () => {
    lockHuman();
    process.env.HOMEBASE_TRUSTED_PROXIES = "10.0.0.1";
    try {
      await expectLoginRefused({ socketIp: "127.0.0.1" });
    } finally {
      delete process.env.HOMEBASE_TRUSTED_PROXIES;
    }
  });

  test("VPN and LAN peers with the correct password stay locked", async () => {
    lockHuman();
    await expectLoginRefused({ socketIp: "10.6.0.5" });
    await expectLoginRefused({ socketIp: "192.168.1.50" });
    await expectLoginRefused({ socketIp: "::ffff:10.6.0.5" });
  });

  test("Bearer / MCP / connector tokens cannot use the local bypass", async () => {
    lockHuman();
    await expectLoginRefused({
      socketIp: "127.0.0.1",
      headers: headers({ authorization: "Bearer unused" }),
    });
    await expectLoginRefused({
      socketIp: "127.0.0.1",
      headers: headers({ authorization: "Bearer hb_mcp_abc" }),
    });
  });

  test("PIN-only attempt cannot bypass an active human lockout", () => {
    lockHuman();
    try {
      pin.setAppPin("4242");
    } catch {
      /* already set */
    }
    try {
      pin.unlockAppPin("4242", "127.0.0.1", { path: "/api/app-pin/unlock" });
      throw new Error("PIN should not bypass");
    } catch (e) {
      const err = e as { status?: number; detail?: { code?: string } };
      expect(err.status).toBe(429);
      expect(err.detail?.code).toBe("auth_lockout");
    }
    expect(auth.lockoutStatus().locked).toBe(true);
  });

  test("wrong password from loopback counts toward local backoff and never clears the lockout", async () => {
    lockHuman(18, 86_400);
    const humanBefore = auth.lockoutStatus();
    recovery.saveLocalLockout({ schemaVersion: LOCKOUT_SCHEMA_VERSION, failCount: 0, lockedUntil: 0 });
    try {
      await tryLogin({ socketIp: "127.0.0.1", password: "WrongPass1!" });
      throw new Error("expected invalid password");
    } catch (e) {
      const err = e as { status?: number; detail?: { code?: string; localSeat?: boolean } };
      expect(err.status).toBe(401);
      expect(err.detail?.code).toBe("invalid_password");
    }
    const humanAfter = auth.lockoutStatus();
    expect(humanAfter.locked).toBe(true);
    expect(humanAfter.failCount).toBe(humanBefore.failCount);
    const local = recovery.localLockoutStatus();
    expect(local.failCount).toBe(1);
    expect(local.locked).toBe(false);
  });

  test("exceeding the local try limit delays further local attempts", async () => {
    lockHuman();
    recovery.saveLocalLockout({ schemaVersion: LOCKOUT_SCHEMA_VERSION, failCount: 0, lockedUntil: 0 });
    for (let i = 0; i < recovery.LOCAL_FAIL_THRESHOLD; i++) {
      try {
        await tryLogin({ socketIp: "127.0.0.1", password: "WrongPass1!" });
      } catch {
        /* expected */
      }
    }
    const local = recovery.localLockoutStatus();
    expect(local.failCount).toBe(recovery.LOCAL_FAIL_THRESHOLD);
    expect(local.locked).toBe(true);
    expect(local.retryAfter).toBeGreaterThan(0);
    try {
      await tryLogin({ socketIp: "127.0.0.1" });
      throw new Error("correct password should still wait out local backoff");
    } catch (e) {
      const err = e as { status?: number; detail?: { code?: string } };
      expect(err.status).toBe(429);
      expect(err.detail?.code).toBe("local_auth_lockout");
    }
    expect(auth.lockoutStatus().locked).toBe(true);
  });
});

describeIso("lockout_cleared audit, email, migration, and CLI", () => {
  test("successful local clear writes exactly one lockout_cleared event that verifies in the HMAC chain, and triggers one email alert", async () => {
    await ensurePassword();
    recovery.saveLocalLockout({ schemaVersion: LOCKOUT_SCHEMA_VERSION, failCount: 0, lockedUntil: 0 });
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
    const before = clearedEvents().length;
    lockHuman(18, 86_400);
    await tryLogin({ socketIp: "127.0.0.1" });
    await recovery.flushLockoutEmails();
    const events = clearedEvents().slice(0, clearedEvents().length - before ? undefined : undefined);
    const fresh = slog.querySecurityLog({ event: "lockout_cleared", offset: 0, limit: 200 }).events;
    const newEvents = fresh.filter((ev) => ev.method === "local_password_signin");
    // Count only those written after `before` by taking the newest ones.
    const added = fresh.length - before;
    expect(added).toBe(1);
    const ev = newEvents[0];
    expect(ev?.event).toBe("lockout_cleared");
    expect(ev?.method).toBe("local_password_signin");
    expect(ev?.previousFailCount).toBe(18);
    expect(ev?.ip).toBe("127.0.0.1");
    expect(ev?.userAgent).toBe("QA-Lockout/1.20.3");
    expect(ev?.path).toBe("/api/login");
    expect(ev?.emailSent).toBe(true);
    const integrity = slog.verifySecurityLog();
    expect(integrity.ok).toBe(true);
    expect(sent.length).toBe(1);
    const payload = sent[0] as { subject?: string; fields?: { label: string; value: string }[] };
    expect(payload.subject).toContain("lockout cleared");
    const fieldText = JSON.stringify(payload);
    expect(fieldText).toContain("Local password sign-in");
    expect(fieldText).toContain("18");
    expect(fieldText).toContain("127.0.0.1");
    expect(fieldText).not.toContain(PASSWORD);
    expect(fieldText).not.toContain("re_test");
    email.setEmailDeliverOverrideForTests(undefined);
  });

  test("a lockout clear with no email recipient still logs and reports the gap", () => {
    email.saveEmailAlerts({
      enabled: false,
      to: "",
      resendApiKey: "",
    });
    lockHuman(9, 120);
    const result = recovery.clearHumanLockout({
      method: "cli_unlock",
      ip: "local",
      path: "cli:homebase unlock",
      source: "api",
    });
    expect(result.cleared).toBe(true);
    expect(result.emailed).toBe(false);
    expect(result.emailGap).toMatch(/no email recipient|disabled|not configured/i);
    const ev = clearedEvents()[0];
    expect(ev?.method).toBe("cli_unlock");
    expect(ev?.emailSent).toBe(false);
    expect(String(ev?.emailGap || ev?.message || "")).toMatch(/recipient|disabled|not configured/i);
  });

  test("upgrade migration resets a legacy 1.19.x lockout file once, logs, and emails", async () => {
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
    writeFileSync(
      LOCKOUT_PATH,
      JSON.stringify({ failCount: 18, lockedUntil: Date.now() / 1000 + 86_400 }, null, 2) + "\n",
    );
    const first = recovery.migrateLegacyLockoutIfNeeded();
    expect(first?.method).toBe("upgrade_migration");
    expect(first?.cleared).toBe(true);
    expect(first?.previousFailCount).toBe(18);
    expect(first?.hadLegacySchema).toBe(true);
    await recovery.flushLockoutEmails();
    const raw = JSON.parse(readFileSync(LOCKOUT_PATH, "utf8")) as {
      schemaVersion?: number;
      failCount?: number;
      lockedUntil?: number;
    };
    expect(raw.schemaVersion).toBe(LOCKOUT_SCHEMA_VERSION);
    expect(raw.failCount).toBe(0);
    expect(raw.lockedUntil).toBe(0);
    expect(auth.lockoutStatus().locked).toBe(false);
    const ev = slog.querySecurityLog({ event: "lockout_cleared", offset: 0, limit: 20 }).events.find(
      (e) => e.method === "upgrade_migration",
    );
    expect(ev?.previousFailCount).toBe(18);
    expect(slog.verifySecurityLog().ok).toBe(true);
    expect(sent.length).toBe(1);
    const again = recovery.migrateLegacyLockoutIfNeeded();
    expect(again).toBeNull();
    expect(sent.length).toBe(1);
    email.setEmailDeliverOverrideForTests(undefined);
  });

  test("a versioned 1.20.3 lockout file is not migrated away", () => {
    lockHuman(7, 600);
    const again = recovery.migrateLegacyLockoutIfNeeded();
    expect(again).toBeNull();
    expect(auth.lockoutStatus().locked).toBe(true);
    expect(auth.lockoutStatus().failCount).toBe(7);
  });

  test("sudo homebase unlock as root clears human (and optionally MCP) lockouts, logs, and emails", async () => {
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
    lockHuman(12, 3600);
    writeFileSync(
      MCP_LOCKOUT_PATH,
      JSON.stringify({ sources: { "203.0.113.10": { failCount: 8, lockedUntil: Date.now() / 1000 + 600 } } }, null, 2),
    );
    const lines: string[] = [];
    const code = await cli.runUnlockCli(["unlock", "--mcp"], {
      uid: 0,
      log: (l) => lines.push(l),
      error: (l) => lines.push(l),
    });
    expect(code).toBe(0);
    expect(auth.lockoutStatus().locked).toBe(false);
    expect(existsSync(MCP_LOCKOUT_PATH) ? Object.keys(JSON.parse(readFileSync(MCP_LOCKOUT_PATH, "utf8")).sources || {}).length : 0).toBe(0);
    const text = lines.join("\n");
    expect(text).toContain("Cleared human lockout");
    expect(text).toContain("failCount=12");
    expect(text).toContain("Cleared 1 MCP lockout source");
    expect(text).toContain("lockout_cleared");
    await recovery.flushLockoutEmails();
    expect(sent.length).toBe(1);
    email.setEmailDeliverOverrideForTests(undefined);
  });

  test("non-root homebase unlock is refused and leaves the lockout in place", async () => {
    lockHuman(5, 300);
    const errs: string[] = [];
    const code = await cli.runUnlockCli(["unlock"], {
      uid: 1000,
      log: () => undefined,
      error: (l) => errs.push(l),
    });
    expect(code).toBe(1);
    expect(errs.join("\n")).toMatch(/must be run as root/i);
    expect(auth.lockoutStatus().locked).toBe(true);
    expect(auth.lockoutStatus().failCount).toBe(5);
  });
});

describeIso("session output redaction and MCP tool", () => {
  test("redactSecrets strips tokens, Bearer, keys, and password patterns", () => {
    const raw = [
      "token=hb_mcp_abcDEF123",
      "Authorization: Bearer super-secret-token",
      "jwt eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0.signaturepart",
      "password=Hunter2!",
      "api_key: sk-live-abcdef",
      "-----BEGIN PRIVATE KEY-----\nMINIKEY\n-----END PRIVATE KEY-----",
    ].join("\n");
    const out = slog.redactSecrets(raw);
    expect(out).not.toContain("hb_mcp_abcDEF123");
    expect(out).not.toContain("super-secret-token");
    expect(out).not.toContain("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");
    expect(out).not.toContain("Hunter2!");
    expect(out).not.toContain("sk-live-abcdef");
    expect(out).not.toContain("MINIKEY");
    expect(out).toContain("[redacted]");
  });

  test("takeLastLines caps at 500 and homebase_session_output is a documented read-only tool", () => {
    const lines = Array.from({ length: 600 }, (_, i) => `line-${i}`).join("\n");
    const tail = sessionOut.takeLastLines(lines, 800);
    expect(tail.split("\n").length).toBe(500);
    expect(tail).toContain("line-599");
    expect(tail).not.toContain("line-0");
    const missing = sessionOut.homebaseSessionOutput({
      projectId: "homebase",
      sessionId: "no-such-session",
      lines: 20,
    });
    expect((missing as { error?: string }).error).toBe("session not found");
    const built = tools.buildHomebaseTools("homebase", true, {}, "mcp");
    expect(built.homebase_session_output).toBeTruthy();
    expect(tools.MCP_TOOL_FEATURE.homebase_session_output).toBe("projects");
  });
});
