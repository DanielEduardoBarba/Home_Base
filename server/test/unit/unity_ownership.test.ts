import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  _setUnityCreateRunnerForTests,
  _setUnityRunnerForTests,
  chownUnityWorkspaceToSeat,
  scaffoldUnityProject,
} from "../../src/unity";

afterEach(() => {
  _setUnityRunnerForTests(null);
  _setUnityCreateRunnerForTests(null);
});

describe("unity ownership (HB-U-03)", () => {
  test("scaffoldUnityProject chowns via create runner and returns ok", () => {
    const root = mkdtempSync(join(tmpdir(), "hb-unity-own-"));
    const project = join(root, "game");
    const fakeUnity = join(root, "FakeUnity");
    try {
      writeFileSync(fakeUnity, "#!/bin/sh\nexit 0\n");
      chmodSync(fakeUnity, 0o755);

      _setUnityRunnerForTests((cmd, args) => {
        if (cmd === "bash" && args.some((a) => String(a).includes("command -v"))) {
          return { code: 0, stdout: `${fakeUnity}\n`, stderr: "" };
        }
        if (args[0] === "editors") {
          return {
            code: 0,
            stdout: JSON.stringify({
              data: {
                items: [
                  {
                    version: "6000.0.0f1",
                    location: fakeUnity,
                    moduleNames: ["webgl"],
                  },
                ],
              },
            }),
            stderr: "",
          };
        }
        if (args[0] === "--version") {
          return { code: 0, stdout: "6000.0.0f1\n", stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      });
      _setUnityCreateRunnerForTests((_bin, projectPath) => {
        mkdirSync(join(projectPath, "ProjectSettings"), { recursive: true });
        mkdirSync(join(projectPath, "Packages"), { recursive: true });
        writeFileSync(
          join(projectPath, "ProjectSettings/ProjectVersion.txt"),
          "m_EditorVersion: 6000.0.0f1\n",
        );
        writeFileSync(
          join(projectPath, "Packages/manifest.json"),
          JSON.stringify({ dependencies: {} }, null, 2) + "\n",
        );
        return { code: 0, stdout: "", stderr: "" };
      });

      const r = scaffoldUnityProject(project);
      expect(r.ok).toBe(true);
      expect(r.created).toBe(true);
      expect(
        existsSync(join(project, "ProjectSettings/ProjectVersion.txt")),
      ).toBe(true);
      // chownUnityWorkspaceToSeat is best-effort (no-op when not root)
      const own = chownUnityWorkspaceToSeat(project);
      expect(own.owner.uid).toBeGreaterThanOrEqual(0);
      expect(typeof own.repaired).toBe("number");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
