/**
 * HB-OWN-02: Cursor SDK job child must run as checkout owner uid (setpriv),
 * not just HOME/USER on a root process.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  probeSdkOwnerChildUid,
  shouldRunSdkAsOwner,
} from "../../src/cursor_sdk_host";
import { resolveProjectOwner } from "../../src/project_owner";
import { setprivPrefix } from "../../src/shell_env";

describe("cursor SDK owner child (HB-OWN-02)", () => {
  test("shouldRunSdkAsOwner is true only when process is root and owner differs", () => {
    const dir = mkdtempSync(join(tmpdir(), "hb-sdk-own-"));
    try {
      const uid = typeof process.getuid === "function" ? process.getuid() : -1;
      const owner = resolveProjectOwner(dir);
      if (uid === 0 && owner.uid > 0) {
        expect(shouldRunSdkAsOwner(dir)).toBe(true);
      } else {
        expect(shouldRunSdkAsOwner(dir)).toBe(false);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("probe child getuid() equals checkout owner uid", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hb-sdk-probe-"));
    try {
      const owner = resolveProjectOwner(dir);
      const uid = typeof process.getuid === "function" ? process.getuid() : -1;

      if (uid === 0 && owner.uid > 0) {
        // Ensure setpriv/runuser is available for the drop.
        expect(setprivPrefix(owner)).not.toBeNull();
        // Make the temp dir owned by the seat so resolve matches.
        Bun.spawnSync(["chown", `${owner.uid}:${owner.gid}`, dir]);
        const ready = await probeSdkOwnerChildUid(dir, owner);
        expect(ready.uid).toBe(owner.uid);
        expect(ready.gid).toBe(owner.gid);
        expect(ready.pid).toBeGreaterThan(0);
      } else {
        // Non-root harness: child runs as current user; still assert probe shape.
        const ready = await probeSdkOwnerChildUid(dir, owner);
        expect(ready.uid).toBe(uid === -1 ? ready.uid : uid);
        expect(typeof ready.gid).toBe("number");
        expect(ready.pid).toBeGreaterThan(0);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
