/**
 * Self-QA shared runner (scripts/selfqa) — code-enforced gates from
 * docs/qa/selfqa-qa-spec.md.
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const REPO = join(import.meta.dir, "../../..");
const RUNNER = join(REPO, "scripts/selfqa/run.sh");
const LIB = join(REPO, "scripts/selfqa/lib.sh");
const root = mkdtempSync(join(tmpdir(), "hb-selfqa-runner-"));

afterAll(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function bash(script: string, opts?: { cwd?: string; env?: Record<string, string> }) {
  return spawnSync("bash", ["-c", script], {
    cwd: opts?.cwd || root,
    env: { ...process.env, ...(opts?.env || {}) },
    encoding: "utf8",
  });
}

function initRepo(dir: string, branch = "development_grok") {
  mkdirSync(dir, { recursive: true });
  const r = spawnSync(
    "bash",
    [
      "-c",
      `git init -q && git checkout -q -b ${branch} && git config user.email t@t && git config user.name t && echo hi > README && git add README && git commit -q -m init`,
    ],
    { cwd: dir, encoding: "utf8" },
  );
  if (r.status !== 0) {
    throw new Error(`git init failed: ${r.stderr || r.stdout}`);
  }
}

describe("selfqa lib helpers", () => {
  test("strict verdict JSON only", () => {
    const f = join(root, "verdict.json");
    writeFileSync(f, '{"verdict":"PASS"}\n');
    const ok = bash(`source "${LIB}"; selfqa_read_verdict_json "${f}"`);
    expect(ok.stdout.trim()).toBe("PASS");
    writeFileSync(f, "Verdict: PASS\n");
    const bad = bash(`source "${LIB}"; selfqa_read_verdict_json "${f}"`);
    expect(bad.stdout.trim()).toBe("");
  });

  test("guardrail abort on deploy pattern", () => {
    const f = join(root, "agent.log");
    writeFileSync(f, "running ./build.sh --deploy now\n");
    const r = bash(`source "${LIB}"; selfqa_scan_guardrails "${f}"; echo rc=$?`);
    expect(r.stdout).toMatch(/rc=1/);
  });

  test("repeat findings detection", () => {
    const a = join(root, "a.txt");
    const b = join(root, "b.txt");
    writeFileSync(a, "HB-R1-01\nHB-R1-02\n");
    writeFileSync(b, "HB-R1-01\nHB-R2-99\n");
    const r = bash(
      `source "${LIB}"; selfqa_repeat_findings "${a}" "${b}"; echo rc=$?`,
    );
    expect(r.stdout).toMatch(/HB-R1-01/);
    expect(r.stdout).toMatch(/rc=0/);
  });

  test("localhost-only refuses remote URLs", () => {
    const r = bash(
      `source "${LIB}"; selfqa_localhost_only_text 'hit https://api.prod.example/v1'; echo rc=$?`,
    );
    expect(r.stdout + r.stderr).toMatch(/non-localhost/i);
    expect(r.stdout).toMatch(/rc=1/);
    const ok = bash(
      `source "${LIB}"; selfqa_localhost_only_text 'use http://localhost:3000/app'; echo rc=$?`,
    );
    expect(ok.stdout).toMatch(/rc=0/);
  });
});

describe("selfqa run.sh", () => {
  test("dry-run without Cursor CLI writes nothing and exits 0", () => {
    const app = join(root, "dry-app");
    initRepo(app);
    const before = existsSync(join(app, "docs/selfqa"))
      ? readdirSync(join(app, "docs/selfqa")).length
      : 0;
    const r = spawnSync(
      "bash",
      [RUNNER, "--dry-run", "--goal", "preview plan only"],
      {
        cwd: app,
        env: {
          ...process.env,
          SELFQA_TARGET_ROOT: app,
          PATH: "/usr/bin:/bin", // no cursor-agent
        },
        encoding: "utf8",
      },
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Self-QA plan/);
    expect(r.stdout).toMatch(/Dry-run complete/);
    const after = existsSync(join(app, "docs/selfqa"))
      ? readdirSync(join(app, "docs/selfqa")).length
      : 0;
    expect(after).toBe(before);
  });

  test("branch refusal when not on development_grok", () => {
    const app = join(root, "wrong-branch");
    initRepo(app, "main");
    const r = spawnSync(
      "bash",
      [RUNNER, "--goal", "should refuse"],
      {
        cwd: app,
        env: {
          ...process.env,
          SELFQA_TARGET_ROOT: app,
          // Provide a fake agent so we don't fail for missing CLI first
          PATH: `${join(root, "fake-bin")}:${process.env.PATH || ""}`,
        },
        encoding: "utf8",
      },
    );
    // Create fake cursor-agent so branch check is what fails (branch runs before agent detect... actually agent is after branch)
    expect(r.status).toBe(1);
    expect(r.stderr + r.stdout).toMatch(/requires branch 'development_grok'/i);
  });

  test("--goal and --goal-file are mutually exclusive", () => {
    const app = join(root, "mutex");
    initRepo(app);
    const gf = join(app, "goal.txt");
    writeFileSync(gf, "from file\n");
    const r = spawnSync(
      "bash",
      [RUNNER, "--dry-run", "--goal", "a", "--goal-file", gf],
      {
        cwd: app,
        env: { ...process.env, SELFQA_TARGET_ROOT: app },
        encoding: "utf8",
      },
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/mutually exclusive/i);
  });
});
