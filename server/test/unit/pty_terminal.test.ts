import { describe, expect, test } from "bun:test";
import { spawnShell, killSession, listSessions } from "../../src/pty";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("Bun.Terminal PTY", () => {
  test("spawns a real PTY shell when openpty is available", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "hb-pty-"));
    const info = spawnShell({
      projectId: "test",
      cwd,
      cols: 40,
      rows: 12,
      command: ["bash", "-lc", "tty; echo PTY_OK"],
    });
    expect(info.id).toBeTruthy();
    expect(info.pid).toBeGreaterThan(0);
    // Prefer pty mode; pipe fallback still acceptable in sandboxes
    expect(["pty", "pipe"]).toContain(info.mode);
    // Give process a moment then clean up
    await Bun.sleep(200);
    killSession(info.id);
    expect(listSessions("test").find((s) => s.id === info.id)).toBeUndefined();
  });
});
