import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  projectOwnershipHealth,
  repairProjectOwnership,
  resolveProjectOwner,
  wrapArgvForProject,
} from "../../src/project_owner";
import { setprivPrefix, wrapArgvForUser, type SeatUser } from "../../src/shell_env";
import { buildOperatorCmd } from "../../src/operator_git_env";

describe("project owner spawn wrapper (HB-OWN-01)", () => {
  test("resolveProjectOwner reads directory uid", () => {
    const dir = mkdtempSync(join(tmpdir(), "hb-own-"));
    try {
      const owner = resolveProjectOwner(dir);
      expect(owner.uid).toBeGreaterThan(0);
      const st = Bun.spawnSync(["stat", "-c", "%u", dir], { stdout: "pipe" });
      const uid = Number(st.stdout.toString().trim());
      // Root-owned checkouts fall back to the seat user (never treat root as owner).
      if (uid === 0) {
        expect(owner.uid).not.toBe(0);
      } else {
        expect(owner.uid).toBe(uid);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("wrapArgvForUser prefixes setpriv when root and target uid differs", () => {
    const fake: SeatUser = {
      uid: 12345,
      gid: 12345,
      name: "hbtest",
      home: "/home/hbtest",
      shell: "/bin/bash",
    };
    const uid = typeof process.getuid === "function" ? process.getuid() : -1;
    const wrapped = wrapArgvForUser(fake, ["git", "status"]);
    if (uid === 0) {
      const prefix = setprivPrefix(fake);
      expect(prefix).not.toBeNull();
      expect(wrapped[0]).toMatch(/setpriv|runuser/);
      expect(wrapped).toContain("git");
      expect(wrapped).toContain("status");
    } else {
      expect(wrapped).toEqual(["git", "status"]);
    }
  });

  test("wrapArgvForProject chooses owner from checkout path", () => {
    const dir = mkdtempSync(join(tmpdir(), "hb-own-wrap-"));
    try {
      const argv = wrapArgvForProject(["true"], dir);
      expect(argv.length).toBeGreaterThanOrEqual(1);
      expect(argv[argv.length - 1]).toBe("true");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("buildOperatorCmd with cwd uses project-owner seat", () => {
    const dir = mkdtempSync(join(tmpdir(), "hb-own-git-"));
    try {
      const built = buildOperatorCmd("git", ["status"], {
        forceLoginEnv: true,
        cwd: dir,
      });
      expect("error" in built).toBe(false);
      if ("error" in built) return;
      const owner = resolveProjectOwner(dir);
      expect(built.seat.uid).toBe(owner.uid);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("ownership repair detection (HB-OWN-01)", () => {
  test("health reports ok when all files match owner", () => {
    const dir = mkdtempSync(join(tmpdir(), "hb-own-ok-"));
    try {
      writeFileSync(join(dir, "a.txt"), "x\n");
      mkdirSync(join(dir, ".git"), { recursive: true });
      writeFileSync(join(dir, ".git", "COMMIT_EDITMSG"), "msg\n");
      const owner = resolveProjectOwner(dir);
      // When the harness is root, temp dirs start root-owned — chown to the
      // resolved owner so health sees a clean seat-owned tree.
      if (typeof process.getuid === "function" && process.getuid() === 0 && owner.uid > 0) {
        Bun.spawnSync([
          "chown",
          "-R",
          `${owner.uid}:${owner.gid}`,
          dir,
        ]);
      }
      const h = projectOwnershipHealth(dir);
      expect(h.ok).toBe(true);
      expect(h.foreignCount).toBe(0);
      expect(h.owner.uid).toBe(owner.uid);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("repair detects root-owned paths when running as root", () => {
    const dir = mkdtempSync(join(tmpdir(), "hb-own-fix-"));
    try {
      mkdirSync(join(dir, ".git"), { recursive: true });
      const victim = join(dir, ".git", "COMMIT_EDITMSG");
      writeFileSync(victim, "root leftover\n");
      chmodSync(victim, 0o644);

      const uid = typeof process.getuid === "function" ? process.getuid() : -1;
      if (uid === 0) {
        // Create a root-owned file (already root), then chown the dir to a
        // non-root owner so health sees a mismatch — only works if a seat uid exists.
        const owner = resolveProjectOwner(dir);
        if (owner.uid === 0) {
          const h = projectOwnershipHealth(dir);
          expect(h.foreignCount).toBeGreaterThanOrEqual(0);
          return;
        }
        // Make directory owned by seat while leaving a file as root.
        Bun.spawnSync(["chown", `${owner.uid}:${owner.gid}`, dir, join(dir, ".git")]);
        // victim stays root-owned
        const before = projectOwnershipHealth(dir);
        expect(before.ok).toBe(false);
        expect(before.foreignCount).toBeGreaterThan(0);
        expect(before.samples.some((s) => s.includes("COMMIT_EDITMSG"))).toBe(true);

        const repaired = repairProjectOwnership(dir);
        expect(repaired.repaired).toBeGreaterThan(0);
        const after = projectOwnershipHealth(dir);
        expect(after.ok).toBe(true);
      } else {
        // Non-root: repair is a no-op skip; still assert API shape.
        const repaired = repairProjectOwnership(dir);
        expect(repaired.skipped === "not-root" || repaired.repaired === 0).toBe(
          true,
        );
        const h = projectOwnershipHealth(dir);
        expect(typeof h.foreignCount).toBe("number");
        expect(Array.isArray(h.samples)).toBe(true);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
