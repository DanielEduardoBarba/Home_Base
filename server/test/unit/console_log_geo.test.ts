import { describe, expect, test } from "bun:test";
import {
  coerceLevel,
  formatFields,
  formatLogLine,
  setLogLevel,
} from "../../src/console_log";
import {
  classifyIp,
  clearGeoCache,
  formatGeo,
  normalizeIp,
} from "../../src/geo";

describe("console_log", () => {
  test("formatLogLine is readable without color", () => {
    const line = formatLogLine(
      "info",
      "GET /api/projects",
      "http",
      { ip: "10.6.0.2", geo: "private/VPN", status: 200, ms: 12 },
      false,
      new Date("2026-10-11T16:32:01.123Z"),
    );
    expect(line).toContain("INFO ");
    expect(line).toContain("http");
    expect(line).toContain("GET /api/projects");
    expect(line).toContain("ip=10.6.0.2");
    expect(line).toContain("geo=private/VPN");
    expect(line).not.toContain("\x1b[");
  });

  test("formatLogLine includes ANSI when color on", () => {
    const line = formatLogLine("error", "boom", "boot", undefined, true);
    expect(line).toContain("\x1b[");
    expect(line).toContain("ERROR");
    expect(line).toContain("boom");
  });

  test("formatFields quotes spaced strings", () => {
    expect(formatFields({ ua: "Mozilla Foo" })).toBe('ua="Mozilla Foo"');
  });

  test("coerceLevel maps aliases", () => {
    expect(coerceLevel("warning")).toBe("warn");
    expect(coerceLevel("fatal")).toBe("error");
    expect(coerceLevel("trace")).toBe("debug");
    expect(coerceLevel("info")).toBe("info");
  });

  test("setLogLevel accepts debug", () => {
    setLogLevel("debug");
    setLogLevel("info");
  });
});

describe("geo", () => {
  test("normalizeIp unwraps v4-mapped and zones", () => {
    expect(normalizeIp("::ffff:192.168.1.5")).toBe("192.168.1.5");
    expect(normalizeIp("[fe80::1%eth0]")).toBe("fe80::1");
  });

  test("classify private / loopback / LAN", () => {
    expect(classifyIp("127.0.0.1").kind).toBe("loopback");
    expect(classifyIp("10.6.0.2").label).toBe("private/VPN");
    expect(classifyIp("192.168.0.10").label).toBe("LAN");
    expect(classifyIp("172.16.5.1").kind).toBe("private");
    expect(classifyIp("8.8.8.8").kind).toBe("public");
    expect(formatGeo(classifyIp("10.0.0.1"))).toBe("private/VPN");
  });

  test("clearGeoCache is safe", () => {
    clearGeoCache();
  });
});
