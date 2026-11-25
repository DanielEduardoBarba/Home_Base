import { afterEach, describe, expect, test } from "bun:test";
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
  _setUnityCreateRunnerForTests,
  _setUnityRunnerForTests,
  ensureUnityMcpPackageInManifest,
  redactUnityText,
  scaffoldUnityProject,
  unityStatus,
} from "../../src/unity";
import {
  looksLikeUnityWorkspace,
  mcpWorkspaceUpsertFields,
} from "../../src/config";
import { installUnityWorkspaceScripts } from "../../src/workspace";

afterEach(() => {
  _setUnityRunnerForTests(null);
  _setUnityCreateRunnerForTests(null);
});

describe("unity redact", () => {
  test("redacts emails and serial-like tokens", () => {
    const s = redactUnityText(
      "user dan@example.com serial ABCD-EFGH-IJKL-MNOP tier Personal",
    );
    expect(s).not.toContain("dan@example.com");
    expect(s).toContain("[redacted-email]");
    expect(s).toContain("[redacted]");
    expect(s).toContain("Personal");
  });
});

describe("unity manifest + scaffold", () => {
  test("ensureUnityMcpPackageInManifest adds package once", () => {
    const root = mkdtempSync(join(tmpdir(), "hb-unity-man-"));
    try {
      mkdirSync(join(root, "Packages"), { recursive: true });
      writeFileSync(
        join(root, "Packages/manifest.json"),
        JSON.stringify({ dependencies: {} }, null, 2) + "\n",
      );
      const a = ensureUnityMcpPackageInManifest(root);
      expect(a.ok).toBe(true);
      expect(a.changed).toBe(true);
      const b = ensureUnityMcpPackageInManifest(root);
      expect(b.ok).toBe(true);
      expect(b.changed).toBe(false);
      const raw = JSON.parse(
        readFileSync(join(root, "Packages/manifest.json"), "utf8"),
      ) as { dependencies: Record<string, string> };
      expect(raw.dependencies["com.coplaydev.unity-mcp"]).toContain(
        "CoplayDev/unity-mcp",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("scaffoldUnityProject uses create runner and writes version", () => {
    const root = mkdtempSync(join(tmpdir(), "hb-unity-scaf-"));
    const project = join(root, "game");
    try {
      _setUnityRunnerForTests((cmd, args) => {
        const lc = args.find((a) => String(a).includes("command -v"));
        if (cmd === "bash" && lc) {
          return { code: 0, stdout: "/usr/bin/unity\n", stderr: "" };
        }
        if (args[0] === "editors") {
          return {
            code: 0,
            stdout: JSON.stringify({
              data: {
                items: [
                  {
                    version: "6000.6.4f1",
                    location: join(root, "fake-Unity"),
                    moduleNames: ["Web"],
                  },
                ],
              },
            }),
            stderr: "",
          };
        }
        return { code: 0, stdout: "1.0.0\n", stderr: "" };
      });
      writeFileSync(join(root, "fake-Unity"), "#!/bin/true\n", { mode: 0o755 });
      _setUnityCreateRunnerForTests((_bin, projectPath) => {
        mkdirSync(join(projectPath, "ProjectSettings"), { recursive: true });
        mkdirSync(join(projectPath, "Packages"), { recursive: true });
        writeFileSync(
          join(projectPath, "ProjectSettings/ProjectVersion.txt"),
          "m_EditorVersion: 6000.6.4f1\n",
        );
        writeFileSync(
          join(projectPath, "Packages/manifest.json"),
          JSON.stringify({ dependencies: {} }, null, 2) + "\n",
        );
        return { code: 0, stdout: "ok", stderr: "" };
      });
      const r = scaffoldUnityProject(project);
      expect(r.ok).toBe(true);
      expect(r.created).toBe(true);
      expect(r.mcpPackage).toBe(true);
      expect(existsSync(join(project, "ProjectSettings/ProjectVersion.txt"))).toBe(
        true,
      );
      expect(looksLikeUnityWorkspace(project)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("unity preset fields", () => {
  test("Unity project gets unity preset ports", () => {
    const root = mkdtempSync(join(tmpdir(), "hb-unity-preset-"));
    const prevHome = process.env.HOMEBASE_HOME;
    const prevProjects = process.env.HOMEBASE_PROJECTS;
    process.env.HOMEBASE_HOME = root;
    process.env.HOMEBASE_PROJECTS = join(root, "projects.json");
    mkdirSync(join(root, "config"), { recursive: true });
    writeFileSync(join(root, "projects.json"), '{"projects":[]}\n');
    try {
      const proj = join(root, "u1");
      mkdirSync(join(proj, "ProjectSettings"), { recursive: true });
      writeFileSync(
        join(proj, "ProjectSettings/ProjectVersion.txt"),
        "m_EditorVersion: 6000.6.4f1\n",
      );
      const fields = mcpWorkspaceUpsertFields({
        path: proj,
        id: "u1",
        name: "U1",
      });
      expect(fields.preset).toBe("unity");
      expect((fields.ports as { id: string }[]).some((p) => p.id === "webgl")).toBe(
        true,
      );
      expect(
        (fields.ports as { id: string }[]).some((p) => p.id === "mcp-bridge"),
      ).toBe(true);
    } finally {
      if (prevHome === undefined) delete process.env.HOMEBASE_HOME;
      else process.env.HOMEBASE_HOME = prevHome;
      if (prevProjects === undefined) delete process.env.HOMEBASE_PROJECTS;
      else process.env.HOMEBASE_PROJECTS = prevProjects;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("unity workspace scripts", () => {
  test("installUnityWorkspaceScripts copies helpers when present in bundle", () => {
    const root = mkdtempSync(join(tmpdir(), "hb-unity-scripts-"));
    try {
      installUnityWorkspaceScripts(root);
      // Bundle may or may not have scripts in test env; function must not throw.
      expect(existsSync(join(root, "scripts/unity"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("unityStatus (stubbed)", () => {
  test("returns checks without emails", async () => {
    _setUnityRunnerForTests((cmd, args) => {
      const lc = args.find((a) => String(a).includes("command -v"));
      if (cmd === "bash" && lc) {
        const m = String(lc).match(/command -v\s+(\S+)/);
        const bin = m?.[1] || "";
        if (bin === "unity") return { code: 0, stdout: "/usr/bin/unity\n", stderr: "" };
        if (bin === "unityhub") return { code: 0, stdout: "/usr/bin/unityhub\n", stderr: "" };
        if (bin === "xvfb-run" || bin === "Xvfb") {
          return { code: 0, stdout: `/usr/bin/${bin}\n`, stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "--version") {
        return { code: 0, stdout: "1.0.1\n", stderr: "" };
      }
      if (args[0] === "editors") {
        return {
          code: 0,
          stdout: JSON.stringify({
            data: {
              items: [
                {
                  version: "6000.6.4f1",
                  location: "/tmp/fake/Unity",
                  moduleNames: ["Web"],
                },
              ],
            },
          }),
          stderr: "",
        };
      }
      if (args[0] === "license") {
        return {
          code: 0,
          stdout: JSON.stringify({
            success: true,
            data: {
              items: [
                {
                  product: "Unity Personal",
                  type: "Assigned",
                  organization: "secret-org",
                  email: "hidden@example.com",
                },
              ],
            },
          }),
          stderr: "",
        };
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    const s = await unityStatus();
    expect(s.checks.length).toBeGreaterThan(3);
    expect(s.license.products[0]?.product).toBe("Unity Personal");
    const blob = JSON.stringify(s);
    expect(blob).not.toContain("hidden@example.com");
    expect(blob).not.toContain("secret-org");
  });
});
