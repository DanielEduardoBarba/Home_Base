import { describe, expect, test } from "bun:test";
import { listSessions, spawnShell, killSession, killByProject } from "../../src/pty";

describe("session public shape", () => {
  test("listSessions includes alive + label", () => {
    const info = spawnShell({
      projectId: "test-proj",
      cwd: process.cwd(),
      kind: "run",
      title: "Run",
      command: ["bash", "-c", "sleep 30"],
    });
    try {
      const rows = listSessions("test-proj");
      const row = rows.find((s) => s.id === info.id);
      expect(row).toBeTruthy();
      expect(row!.alive).toBe(true);
      expect(row!.label).toBe("Run");
      expect(Array.isArray(row!.cmdline)).toBe(true);
    } finally {
      killSession(info.id);
    }
  });

  test("exited sessions stay listed until removed", async () => {
    const info = spawnShell({
      projectId: "exit-proj",
      cwd: process.cwd(),
      kind: "shell",
      title: "Shell",
      command: ["bash", "-c", "exit 0"],
    });
    for (let i = 0; i < 40; i++) {
      const row = listSessions("exit-proj").find((s) => s.id === info.id);
      if (row && !row.alive) {
        expect(row.label).toBe("Shell");
        expect(killSession(info.id)).toBe(true);
        expect(listSessions("exit-proj").some((s) => s.id === info.id)).toBe(false);
        return;
      }
      await Bun.sleep(50);
    }
    killSession(info.id);
    throw new Error("session did not exit in time");
  });

  test("killByProject only hits matching kinds", () => {
    const run = spawnShell({
      projectId: "kill-proj",
      cwd: process.cwd(),
      kind: "run",
      title: "Run",
      command: ["bash", "-c", "sleep 30"],
    });
    const shell = spawnShell({
      projectId: "kill-proj",
      cwd: process.cwd(),
      kind: "shell",
      title: "Shell",
      command: ["bash", "-c", "sleep 30"],
    });
    try {
      const killed = killByProject("kill-proj", new Set(["run", "expo"]));
      expect(killed).toContain(run.id);
      expect(killed).not.toContain(shell.id);
      expect(listSessions("kill-proj").some((s) => s.id === shell.id)).toBe(true);
    } finally {
      killSession(shell.id);
      killSession(run.id);
    }
  });
});
