import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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
});
