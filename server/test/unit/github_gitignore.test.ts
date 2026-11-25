import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureWorkspaceGitignore,
  UNITY_GITIGNORE,
} from "../../src/github";

describe("ensureWorkspaceGitignore (HB-U-04)", () => {
  test("writes Unity gitignore for Unity workspaces", () => {
    const root = mkdtempSync(join(tmpdir(), "hb-gi-"));
    try {
      mkdirSync(join(root, "ProjectSettings"), { recursive: true });
      writeFileSync(
        join(root, "ProjectSettings/ProjectVersion.txt"),
        "m_EditorVersion: 6000.0.0f1\n",
      );
      const a = ensureWorkspaceGitignore(root);
      expect(a.written).toBe(true);
      expect(a.kind).toBe("unity");
      const body = readFileSync(join(root, ".gitignore"), "utf8");
      expect(body).toContain("[Ll]ibrary/");
      expect(body).toContain("Builds/WebGL/");
      expect(body).toContain(UNITY_GITIGNORE.split("\n")[1]!);
      const b = ensureWorkspaceGitignore(root);
      expect(b.written).toBe(false);
      expect(b.kind).toBe("existing");
      expect(existsSync(join(root, ".gitignore"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("writes default gitignore for non-Unity folders", () => {
    const root = mkdtempSync(join(tmpdir(), "hb-gi2-"));
    try {
      writeFileSync(join(root, "README.md"), "hi\n");
      const a = ensureWorkspaceGitignore(root);
      expect(a.written).toBe(true);
      expect(a.kind).toBe("default");
      expect(readFileSync(join(root, ".gitignore"), "utf8")).toContain(
        "node_modules/",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
