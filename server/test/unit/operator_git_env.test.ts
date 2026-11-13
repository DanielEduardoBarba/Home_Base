import { describe, expect, test } from "bun:test";

// Do not override HOMEBASE_* here — that poisons config for sibling test files.
// Exercise the runner with forceLoginEnv / stubs only.
const op = await import("../../src/operator_git_env");

describe("operator git env runner", () => {
  test("allow-list only git and gh", () => {
    const bad = op.buildOperatorCmd("bash", ["-c", "echo hi"], {
      forceLoginEnv: false,
    });
    expect("error" in bad).toBe(true);
    if ("error" in bad) expect(bad.error).toMatch(/not allow-listed/i);

    const ok = op.buildOperatorCmd("git", ["--version"], {
      forceLoginEnv: false,
    });
    expect("error" in ok).toBe(false);
  });

  test("argv only — rejects shell metacharacters", () => {
    expect(op.assertSafeOperatorArgv(["status"])).toBeNull();
    expect(op.assertSafeOperatorArgv(["push", "origin;evil"])).toMatch(
      /metacharacters/i,
    );
    expect(op.assertSafeOperatorArgv(["log", "`id`"])).toMatch(/metacharacters/i);
    expect(op.assertSafeOperatorArgv(["x", "a|b"])).toMatch(/metacharacters/i);
    expect(op.assertSafeOperatorArgv(["x", "a&b"])).toMatch(/metacharacters/i);
  });

  test("buildOperatorCmd never joins into a shell string", () => {
    const built = op.buildOperatorCmd("git", ["status", "--porcelain"], {
      forceLoginEnv: true,
    });
    expect("error" in built).toBe(false);
    if ("error" in built) return;
    expect(built.argv.every((a) => typeof a === "string")).toBe(true);
    expect(built.argv.some((a) => a.includes("git status"))).toBe(false);
    expect(built.args).toContain("--porcelain");
  });

  test("login env carries HOME and PATH", () => {
    const built = op.buildOperatorCmd("gh", ["auth", "status"], {
      forceLoginEnv: true,
    });
    expect("error" in built).toBe(false);
    if ("error" in built) return;
    expect(built.usedLoginEnv).toBe(true);
    expect(built.env.HOME).toBeTruthy();
    expect(built.env.PATH).toBeTruthy();
    expect(String(built.env.PATH)).toMatch(/:/);
    expect(built.env.USER || built.seat.name).toBeTruthy();
  });

  test("forceLoginEnv false still allow-lists binaries", () => {
    const built = op.buildOperatorCmd("git", ["--version"], {
      forceLoginEnv: false,
    });
    expect("error" in built).toBe(false);
    if ("error" in built) return;
    expect(built.usedLoginEnv).toBe(false);
    const denied = op.buildOperatorCmd("curl", ["https://example.com"], {
      forceLoginEnv: false,
    });
    expect("error" in denied).toBe(true);
  });

  test("runner stub is argv-preserving", () => {
    const seen: string[][] = [];
    op._setOperatorCmdRunnerForTests((cmd, args) => {
      seen.push([cmd, ...args]);
      return { code: 0, stdout: "ok\n", stderr: "", argv: [cmd, ...args] };
    });
    const r = op.runOperatorCmd("git", ["ls-remote", "--heads", "origin"]);
    expect(r.code).toBe(0);
    expect(seen[0]).toEqual(["git", "ls-remote", "--heads", "origin"]);
    op._setOperatorCmdRunnerForTests(null);
  });

  test("gitEnvCheck returns structure without tokens", () => {
    const check = op.gitEnvCheck();
    expect(check.seat.home).toBeTruthy();
    expect(check.git).toBeTruthy();
    expect(check.gh).toBeTruthy();
    const blob = JSON.stringify(check);
    expect(blob).not.toMatch(/gho_/);
    expect(blob).not.toMatch(/ghp_/);
    expect(blob).not.toMatch(/github_pat_/);
  });

  test("gh auth login argv is fixed and safe", () => {
    expect([...op.GH_AUTH_LOGIN_ARGV]).toEqual([
      "gh",
      "auth",
      "login",
      "-h",
      "github.com",
    ]);
  });

  test("missing settings file defaults useOperatorLoginEnv on", () => {
    // Semantics: unset / missing → on (unless HOMEBASE_OPERATOR_GIT_ENV=0).
    const settings = op.loadOperatorGitSettings();
    expect(typeof settings.useOperatorLoginEnv).toBe("boolean");
    // Default when key absent is treated as on:
    expect(settings.useOperatorLoginEnv !== false).toBe(true);
  });
});
