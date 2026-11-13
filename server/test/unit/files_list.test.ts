import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listDir, permissionDeniedMessage } from "../../src/files";
import type { Project } from "../../src/config";

function tempProject(): { root: string; project: Project; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "hb-files-"));
  const project: Project = {
    id: "qa",
    name: "qa",
    path: root,
    ports: [],
    actions: [],
    stateDir: join(root, ".state"),
  };
  return {
    root,
    project,
    cleanup: () => {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    },
  };
}

describe("listDir", () => {
  const temps: Array<() => void> = [];
  afterEach(() => {
    while (temps.length) temps.pop()?.();
  });

  test("lists a readable folder", () => {
    const { root, project, cleanup } = tempProject();
    temps.push(cleanup);
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "README.md"), "hi");
    const listed = listDir(project, root);
    const names = (listed.entries as { name: string }[]).map((e) => e.name);
    expect(names).toContain("src");
    expect(names).toContain("README.md");
  });

  test("throws a clear permission message for an unreadable folder", () => {
    // Root bypasses directory mode bits — chmod 0 is not a meaningful EACCES probe.
    if (typeof process.getuid === "function" && process.getuid() === 0) {
      return;
    }
    const { root, project, cleanup } = tempProject();
    temps.push(cleanup);
    const locked = join(root, "locked");
    mkdirSync(locked);
    chmodSync(locked, 0);
    try {
      expect(() => listDir(project, locked)).toThrow(permissionDeniedMessage(locked));
    } finally {
      chmodSync(locked, 0o700);
    }
  });
});
