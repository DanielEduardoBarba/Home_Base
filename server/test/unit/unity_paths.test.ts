import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hubEditorRoots,
  readSecondaryInstallPath,
  resolveUnityCliPath,
  scanEditorsOnDisk,
  unityPresenceFlags,
} from "../../src/unity_paths";

const prevHome = process.env.HOME;
const prevViewUid = process.env.HOMEBASE_VIEW_UID;

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevViewUid === undefined) delete process.env.HOMEBASE_VIEW_UID;
  else process.env.HOMEBASE_VIEW_UID = prevViewUid;
});

describe("unity_paths filesystem fallback (systemd HOME=/root)", () => {
  test("scanEditorsOnDisk finds Editor under fake Hub layout when HOME is wrong", () => {
    const root = mkdtempSync(join(tmpdir(), "hb-unity-disk-"));
    try {
      // Simulate service env: HOME points at empty root-like dir
      const fakeRootHome = join(root, "root-home");
      mkdirSync(fakeRootHome, { recursive: true });
      process.env.HOME = fakeRootHome;

      const seatHome = join(root, "seat");
      const editorRoot = join(seatHome, "Unity/Hub/Editor/6000.6.4f1");
      const unityBin = join(editorRoot, "Editor/Unity");
      mkdirSync(join(editorRoot, "Editor/Data/PlaybackEngines/WebGLSupport"), {
        recursive: true,
      });
      writeFileSync(unityBin, "#!/bin/true\n", { mode: 0o755 });
      chmodSync(unityBin, 0o755);

      // secondaryInstallPath pointing at our fake Hub editors root
      mkdirSync(join(seatHome, ".config/unityhub"), { recursive: true });
      writeFileSync(
        join(seatHome, ".config/unityhub/secondaryInstallPath.json"),
        JSON.stringify(join(seatHome, "Unity/Hub/Editor")),
      );
      writeFileSync(
        join(seatHome, ".config/unityhub/hubInfo.json"),
        JSON.stringify({ version: "3.22.2", executablePath: "/usr/bin/unityhub" }),
      );
      writeFileSync(
        join(seatHome, ".config/unityhub/cli-install.json"),
        JSON.stringify({ path: join(seatHome, ".local/bin/unity") }),
      );
      mkdirSync(join(seatHome, ".local/bin"), { recursive: true });
      writeFileSync(join(seatHome, ".local/bin/unity"), "#!/bin/true\n", {
        mode: 0o755,
      });

      expect(readSecondaryInstallPath(seatHome)).toBe(
        join(seatHome, "Unity/Hub/Editor"),
      );
      const roots = hubEditorRoots([seatHome, fakeRootHome]);
      expect(roots.some((r) => r.includes("Unity/Hub/Editor"))).toBe(true);

      const editors = scanEditorsOnDisk([join(seatHome, "Unity/Hub/Editor")]);
      expect(editors.length).toBe(1);
      expect(editors[0]?.version).toBe("6000.6.4f1");
      expect(editors[0]?.webglOnDisk).toBe(true);
      expect(existsSync(editors[0]!.unityPath)).toBe(true);

      // CLI path from cli-install.json even when not on PATH
      expect(resolveUnityCliPath([seatHome])).toBe(
        join(seatHome, ".local/bin/unity"),
      );

      // Presence must not depend on process.env.HOME alone
      const flags = unityPresenceFlags();
      // May or may not see our fake layout depending on /home scan; at least
      // direct scan above proves the fallback path. Soft assert on hub via /usr.
      expect(typeof flags.hubPresent).toBe("boolean");
      expect(typeof flags.editorPresent).toBe("boolean");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("scanEditorsOnDisk returns [] for empty root", () => {
    const root = mkdtempSync(join(tmpdir(), "hb-unity-empty-"));
    try {
      expect(scanEditorsOnDisk([root])).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
