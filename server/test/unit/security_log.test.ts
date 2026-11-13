import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "hb-seclog-"));
const runtime = join(root, ".runtime");
mkdirSync(runtime, { recursive: true });
process.env.HOMEBASE_HOME = root;
process.env.HOMEBASE_RUNTIME = runtime;

const { RUNTIME_DIR, SECURITY_DIR } = await import("../../src/config");
const log = await import("../../src/security_log");
const devices = await import("../../src/devices");
const presence = await import("../../src/presence");
const auth = await import("../../src/auth");
const mcp = await import("../../src/mcp_server");
const notifications = await import("../../src/notifications");
const { ipMatchesAllowlist } = await import("../../src/http");

function envIsolated(): boolean {
  return RUNTIME_DIR.startsWith(root) && SECURITY_DIR.startsWith(root);
}
const describeIso = envIsolated() ? describe : describe.skip;

afterAll(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describeIso("security log, devices, IP allowlist", () => {
  test("appends hash-chained events and redacts secrets", () => {
    const a = log.recordSecurityEvent({
      event: "login_failure",
      source: "ui",
      result: "failure",
      ip: "192.168.0.2",
      userAgent: "Mozilla/5.0 test",
      message: "bad Bearer hb_mcp_supersecretvalue",
    });
    expect(a.prev).toBe("genesis");
    expect(a.mac.length).toBe(64);
    expect(a.message?.includes("hb_mcp_supersecretvalue")).toBe(false);
    expect(a.class === "lan" || a.class === "known_vpn_device").toBe(true);
    const b = log.recordSecurityEvent({
      event: "login_success",
      source: "ui",
      result: "success",
      ip: "192.168.0.2",
      userAgent: "Mozilla/5.0 test",
    });
    expect(b.prev).toBe(a.mac);
    const q = log.querySecurityLog({ limit: 10 });
    expect(q.total).toBeGreaterThanOrEqual(2);
    expect(q.events.some((e) => e.id === a.id)).toBe(true);
    expect(q.integrityOk).toBe(true);
    const csv = log.exportSecurityLog({}, "csv");
    expect(csv.body.split("\n")[0]).toContain("time,source,ip,event,result");
    expect(csv.body.includes("hb_mcp_supersecretvalue")).toBe(false);
    const json = log.exportSecurityLog({}, "json");
    expect(json.body.includes("hb_mcp_supersecretvalue")).toBe(false);
  });

  test("devices can be named and marked trusted; first seen is flagged", () => {
    log.recordSecurityEvent({
      event: "login_success",
      source: "ui",
      result: "success",
      ip: "10.0.0.42",
      userAgent: "TestUA/1.0",
    });
    const list = devices.listDevices();
    const dev = list.find((d) => d.ip === "10.0.0.42");
    expect(dev).toBeTruthy();
    expect(dev!.trusted).toBe(false);
    const updated = devices.updateDevice(dev!.id, { name: "Kitchen laptop", trusted: true });
    expect(updated?.name).toBe("Kitchen laptop");
    expect(updated?.trusted).toBe(true);
  });

  test("X-Forwarded-For is only trusted for allowlisted proxies", () => {
    expect(ipMatchesAllowlist("10.0.0.1", ["10.0.0.1"])).toBe(true);
    expect(ipMatchesAllowlist("10.0.0.2", ["10.0.0.0/24"])).toBe(true);
    expect(ipMatchesAllowlist("11.0.0.2", ["10.0.0.0/24"])).toBe(false);
    expect(ipMatchesAllowlist("8.8.8.8", [])).toBe(false);
  });

  function logPathFor(ev: { ts: string }): string {
    return join(SECURITY_DIR, `${ev.ts.slice(0, 10)}.jsonl`);
  }

  function readEvents(path: string): Array<Record<string, unknown>> {
    return readFileSync(path, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  }

  function writeEvents(path: string, events: Array<Record<string, unknown>>): void {
    writeFileSync(path, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  }

  function mutateLog(path: string, mutate: (rows: Array<Record<string, unknown>>) => Array<Record<string, unknown>>): () => void {
    const original = readFileSync(path, "utf8");
    writeEvents(path, mutate(readEvents(path)));
    return () => writeFileSync(path, original);
  }

  test("detects an edited security-log line (HB-R7-01)", () => {
    const a = log.recordSecurityEvent({
      event: "login_failure",
      source: "ui",
      result: "failure",
      ip: "203.0.113.10",
      message: "original-a",
    });
    const b = log.recordSecurityEvent({
      event: "login_failure",
      source: "ui",
      result: "failure",
      ip: "203.0.113.10",
      message: "original-b",
    });
    const c = log.recordSecurityEvent({
      event: "login_success",
      source: "ui",
      result: "success",
      ip: "203.0.113.10",
      message: "original-c",
    });
    const path = logPathFor(a);
    const idx = readEvents(path).findIndex((e) => e.id === b.id);
    expect(idx).toBeGreaterThanOrEqual(0);
    const restore = mutateLog(path, (rows) => {
      const next = rows.slice();
      next[idx] = { ...next[idx], message: "TAMPER-R7" };
      return next;
    });
    try {
      const q = log.querySecurityLog({ limit: 200 });
      expect(q.integrityOk).toBe(false);
      expect(q.integrityError).toBe(`tampered at line ${idx + 1}`);
      expect(q.tamperedAt?.line).toBe(idx + 1);
      expect(q.events.some((e) => e.message === "TAMPER-R7")).toBe(false);
      expect(q.events.some((e) => e.id === b.id)).toBe(false);
      expect(q.events.some((e) => e.id === a.id)).toBe(true);
      void c;
      const notes = notifications.listNotifications({ limit: 100 });
      expect(notes.items.some((n) => n.title === "Security log tampered")).toBe(true);
    } finally {
      restore();
    }
  });

  test("detects a deleted security-log line", () => {
    const prefix = log.recordSecurityEvent({
      event: "info",
      source: "api",
      result: "info",
      ip: "192.0.2.20",
      message: "del-head",
    });
    const a = log.recordSecurityEvent({
      event: "info",
      source: "api",
      result: "info",
      ip: "192.0.2.20",
      message: "keep-a",
    });
    const b = log.recordSecurityEvent({
      event: "info",
      source: "api",
      result: "info",
      ip: "192.0.2.20",
      message: "delete-me",
    });
    const c = log.recordSecurityEvent({
      event: "info",
      source: "api",
      result: "info",
      ip: "192.0.2.20",
      message: "keep-c",
    });
    const path = logPathFor(a);
    const rows = readEvents(path);
    const start = rows.findIndex((e) => e.id === a.id);
    const mid = rows.findIndex((e) => e.id === b.id);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(mid).toBeGreaterThan(start);
    const restore = mutateLog(path, (current) => current.filter((e) => e.id !== b.id));
    try {
      const q = log.querySecurityLog({ ip: "192.0.2.20", limit: 200 });
      expect(q.integrityOk).toBe(false);
      expect(q.integrityError).toMatch(/^tampered at line \d+$/);
      expect(q.events.some((e) => e.id === b.id || e.message === "delete-me")).toBe(false);
      expect(q.events.some((e) => e.id === a.id)).toBe(true);
      void prefix;
      void c;
    } finally {
      restore();
    }
  });

  test("detects reordered security-log lines", () => {
    const a = log.recordSecurityEvent({
      event: "info",
      source: "api",
      result: "info",
      ip: "192.0.2.21",
      message: "ord-a",
    });
    const b = log.recordSecurityEvent({
      event: "info",
      source: "api",
      result: "info",
      ip: "192.0.2.21",
      message: "ord-b",
    });
    const c = log.recordSecurityEvent({
      event: "info",
      source: "api",
      result: "info",
      ip: "192.0.2.21",
      message: "ord-c",
    });
    const path = logPathFor(a);
    const rows = readEvents(path);
    const ia = rows.findIndex((e) => e.id === a.id);
    const ib = rows.findIndex((e) => e.id === b.id);
    const ic = rows.findIndex((e) => e.id === c.id);
    expect(ia).toBeGreaterThanOrEqual(0);
    const restore = mutateLog(path, (current) => {
      const swapped = current.slice();
      const tmp = swapped[ib]!;
      swapped[ib] = swapped[ic]!;
      swapped[ic] = tmp;
      return swapped;
    });
    try {
      const q = log.querySecurityLog({ limit: 200 });
      expect(q.integrityOk).toBe(false);
      expect(q.integrityError).toBe(`tampered at line ${ib + 1}`);
    } finally {
      restore();
    }
  });

  test("human UI events stay human when the same IP has MCP presence (HB-R7-03)", () => {
    presence.upsertPresence({
      id: "mcp:qa-bot",
      kind: "ai",
      name: "QA Bot",
      label: "via MCP",
      peerIp: "127.0.0.1",
    });
    const minted = mcp.mintMcpToken("QA Bot connector");
    mcp.verifyMcpBearerToken(minted.accessToken || minted.token, "127.0.0.1");

    const human = log.recordSecurityEvent({
      event: "pin_success",
      source: "ui",
      result: "success",
      ip: "127.0.0.1",
      userAgent: "Mozilla/5.0 HomeBaseUI",
    });
    expect(human.class).toBe("lan");
    expect(human.classLabel).toBe("LAN");
    expect(human.connectorId).toBeUndefined();

    const bot = log.recordSecurityEvent({
      event: "mcp_ok",
      source: "mcp",
      result: "success",
      ip: "127.0.0.1",
      connectorId: minted.id,
      connectorLabel: minted.label || "QA Bot connector",
      userAgent: "GrokBot/1.0",
    });
    expect(bot.class).toBe("known_grok_bot");
    expect(bot.classLabel).toBe("Known Grok Bot");
  });

  test("PIN and password failures record user agent and path (HB-R7-02)", () => {
    auth.recordFailure("203.0.113.77", "invalid_pin", {
      userAgent: "Mozilla/5.0 QA-Pin",
      path: "/api/app-pin/unlock",
    });
    auth.recordFailure("203.0.113.78", "invalid_password", {
      userAgent: "Mozilla/5.0 QA-Login",
      path: "/api/login",
    });
    const pin = log.querySecurityLog({ event: "pin_failure", ip: "203.0.113.77", limit: 10 });
    const login = log.querySecurityLog({ event: "login_failure", ip: "203.0.113.78", limit: 10 });
    expect(pin.events[0]?.userAgent).toBe("Mozilla/5.0 QA-Pin");
    expect(pin.events[0]?.path).toBe("/api/app-pin/unlock");
    expect(login.events[0]?.userAgent).toBe("Mozilla/5.0 QA-Login");
    expect(login.events[0]?.path).toBe("/api/login");
  });

  test("burst alert fires when the fifth human failure is itself the lockout", () => {
    const ip = "198.51.100.77";
    for (let i = 0; i < 5; i++) {
      auth.recordFailure(ip, "invalid_password", { userAgent: "burst-test/1.0" });
    }
    const notes = notifications.listNotifications({ limit: 100 });
    expect(notes.items.some((n) => n.title === "Brute-force burst")).toBe(true);
    const ev = log.querySecurityLog({ ip, limit: 20 }).events;
    expect(ev.some((e) => e.result === "lockout")).toBe(true);
  });
});
