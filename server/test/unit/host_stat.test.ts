import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { statHostPath } from "../../src/config";

describe("statHostPath", () => {
  test("rejects relative and missing paths", () => {
    expect(statHostPath("relative/path").exists).toBe(false);
    expect(statHostPath("relative/path").error).toContain("absolute");
    const missing = statHostPath("/tmp/homebase-qa-missing-folder-xyz");
    expect(missing.exists).toBe(false);
    expect(missing.error).toContain("does not exist");
  });

  test("accepts a real directory and rejects a file", () => {
    const dir = mkdtempSync(join(tmpdir(), "hb-stat-"));
    mkdirSync(join(dir, "app"), { recursive: true });
    const ok = statHostPath(join(dir, "app"));
    expect(ok.exists).toBe(true);
    expect(ok.isDirectory).toBe(true);
    const file = join(dir, "app", "readme.txt");
    writeFileSync(file, "x");
    const asFile = statHostPath(file);
    expect(asFile.exists).toBe(true);
    expect(asFile.isDirectory).toBe(false);
    expect(asFile.error).toContain("not a directory");
  });
});
