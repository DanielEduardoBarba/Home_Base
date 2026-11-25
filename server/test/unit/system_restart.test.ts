import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BUNDLE_ROOT, readVersion } from "../../src/config";
import {
  readGitCommit,
  systemStatus,
  underHomebasedService,
} from "../../src/system";

describe("underHomebasedService", () => {
  test("returns a boolean without throwing", () => {
    expect(typeof underHomebasedService()).toBe("boolean");
  });
});

describe("systemStatus version + commit", () => {
  test("readVersion matches BUNDLE_ROOT/VERSION", () => {
    const fromFile = readFileSync(join(BUNDLE_ROOT, "VERSION"), "utf8")
      .trim()
      .split("\n")[0]
      ?.trim();
    expect(readVersion()).toBe(fromFile);
  });

  test("systemStatus includes version and short commit", () => {
    const s = systemStatus();
    expect(typeof s.version).toBe("string");
    expect(String(s.version).length).toBeGreaterThan(0);
    expect(s.version).toBe(readVersion());
    const commit = s.commit;
    expect(commit === null || typeof commit === "string").toBe(true);
    if (typeof commit === "string") {
      expect(commit).toMatch(/^[0-9a-f]{4,40}$/i);
    }
    // Checkout should resolve a SHA.
    const local = readGitCommit();
    expect(local).toMatch(/^[0-9a-f]{4,40}$/i);
    expect(s.commit).toBe(local);
  });
});
