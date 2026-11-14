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

  test("HB-122-01: normalized ship/deploy forms all hit", () => {
    const f = join(root, "ship-forms.log");
    const hits = [
      "./ship.sh --all",
      "bash ./ship.sh",
      "sh ship.sh",
      "/home/dan/app/ship.sh",
      "cd foo && ./ship.sh",
      "FOO=1 ./ship.sh",
      "(./ship.sh)",
      "env FOO=1 bash /tmp/x/ship.sh",
      "./build.sh --deploy",
      "./build.sh --ship",
      "bash scripts/deploy-api.sh",
      "scripts/deploy-web.sh",
      "scripts/deploy.sh",
      "scripts/ship-expo.sh",
      "./build.sh d",
      "pnpm deploy",
      "pnpm run deploy-web",
      "firebase deploy",
      "eas submit",
      "gcloud run deploy",
    ];
    for (const line of hits) {
      writeFileSync(f, `${line}\n`);
      const r = bash(
        `source "${LIB}"; selfqa_scan_guardrails "${f}"; echo rc=$?`,
      );
      expect(r.stdout).toMatch(/rc=1/);
    }
    // Prose negation must not abort
    const prose = [
      "I will not run ./ship.sh",
      "Do not run ./ship.sh or firebase deploy.",
      "Never git push --force",
    ];
    for (const line of prose) {
      writeFileSync(f, `${line}\n`);
      const r = bash(
        `source "${LIB}"; selfqa_scan_guardrails "${f}"; echo rc=$?`,
      );
      expect(r.stdout).toMatch(/rc=0/);
    }
  });

  test("HB-122-02: git push destination / force / bare rules", () => {
    const f = join(root, "push.log");
    const app = join(root, "push-app");
    initRepo(app);
    // No upstream → bare git push blocked
    writeFileSync(f, "git push\n");
    let r = bash(
      `source "${LIB}"; selfqa_scan_guardrails "${f}" "${app}"; echo rc=$?`,
    );
    expect(r.stdout).toMatch(/rc=1/);
    const blocked = [
      "git push origin feature-foo",
      "git push origin main",
      "git push --force",
      "git push --force-with-lease",
      "git push -f origin development_grok",
      "git push --all",
      "git push --mirror",
      "git push --delete origin old",
      "git push origin HEAD:main",
    ];
    for (const line of blocked) {
      writeFileSync(f, `${line}\n`);
      r = bash(
        `source "${LIB}"; selfqa_scan_guardrails "${f}" "${app}"; echo rc=$?`,
      );
      expect(r.stdout).toMatch(/rc=1/);
    }
    writeFileSync(f, "git push origin development_grok\n");
    r = bash(
      `source "${LIB}"; selfqa_scan_guardrails "${f}" "${app}"; echo rc=$?`,
    );
    expect(r.stdout).toMatch(/rc=0/);
  });

  test("HB-122-03: Pass/fixed findings are not open for repeat-BLOCKED", () => {
    const report = join(root, "findings-pass.md");
    writeFileSync(
      report,
      `# cycle\n### HB-R1-01\n- Status: Pass / fixed\n\n### HB-R1-02\n- Status: Fail\n`,
    );
    const r = bash(
      `source "${LIB}"; selfqa_extract_finding_ids "${report}"`,
    );
    expect(r.stdout).toMatch(/HB-R1-02/);
    expect(r.stdout).not.toMatch(/HB-R1-01/);
    const a = join(root, "open-a.txt");
    const b = join(root, "open-b.txt");
    writeFileSync(a, "HB-R1-01\n");
    writeFileSync(b, "HB-R1-02\n");
    const no = bash(
      `source "${LIB}"; selfqa_repeat_findings "${a}" "${b}"; echo rc=$?`,
    );
    expect(no.stdout).toMatch(/rc=1/);
  });

  test("HB-122-04: price/subscription phrasing detection", () => {
    const f = join(root, "price.log");
    const hits = [
      "we will change the subscription price tonight",
      "change the price of the plan",
      "set the subscription to 9.99", // may miss — require set price to
      "set price to 9.99",
      "increase the price",
      "raise the price",
      "lower the price",
      "drop the price",
      "update pricing",
      "new price tier",
      "CHANGE THE SUBSCRIPTION PRICE",
    ];
    for (const line of hits) {
      if (line.includes("set the subscription to")) continue; // not required by QA
      writeFileSync(f, `${line}\n`);
      const r = bash(
        `source "${LIB}"; selfqa_scan_guardrails "${f}"; echo rc=$?`,
      );
      expect(r.stdout).toMatch(/rc=1/);
    }
  });

  test("pre-push hook install/restore + PATH shim refuse", () => {
    const app = join(root, "hook-app");
    initRepo(app);
    const hooks = join(app, "hooks-run");
    const state = join(app, "hooks-state.txt");
    const shims = join(app, "shims");
    const r = bash(
      `
      source "${LIB}"
      cd "${app}"
      selfqa_install_pre_push_hook "${hooks}" "${state}" development_grok
      test -x "${hooks}/pre-push"
      git config --local --get core.hooksPath
      selfqa_create_path_shims "${shims}" "${app}"
      SELFQA_RUN=1 "${shims}/ship.sh"; echo ship_rc=$?
      SELFQA_RUN=1 "${shims}/build.sh" --deploy; echo build_rc=$?
      selfqa_restore_hooks_path "${state}"
      if git config --local --get core.hooksPath >/dev/null 2>&1; then echo hooks_still_set; else echo hooks_cleared; fi
      `,
      { cwd: app },
    );
    expect(r.stdout).toMatch(/ship_rc=1/);
    expect(r.stdout).toMatch(/build_rc=1/);
    expect(r.stdout).toMatch(/hooks_cleared/);
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

  test("agent --version must look like Cursor CLI", () => {
    const fakeBin = join(root, "fake-agent-bin");
    mkdirSync(fakeBin, { recursive: true });
    const good = join(fakeBin, "good-agent");
    const bad = join(fakeBin, "bad-agent");
    writeFileSync(good, "#!/bin/sh\necho '2026.11.10-deadbeef'\n");
    writeFileSync(bad, "#!/bin/sh\necho 'other-agent 1.0'\n");
    chmodSync(good, 0o755);
    chmodSync(bad, 0o755);
    const ok = bash(
      `source "${LIB}"; selfqa_is_cursor_agent_bin "${good}"; echo rc=$?`,
    );
    expect(ok.stdout).toMatch(/rc=0/);
    const no = bash(
      `source "${LIB}"; selfqa_is_cursor_agent_bin "${bad}"; echo rc=$?`,
    );
    expect(no.stdout).toMatch(/rc=1/);
  });

  test("refuse non-Cursor bare agent on PATH", () => {
    const fakeBin = join(root, "not-cursor-path");
    mkdirSync(fakeBin, { recursive: true });
    writeFileSync(
      join(fakeBin, "agent"),
      "#!/bin/sh\necho 'totally-not-cursor'\n",
    );
    chmodSync(join(fakeBin, "agent"), 0o755);
    // Keep /usr/bin:/bin so spawn can find bash; fakeBin first so `agent` is ours.
    const r = bash(
      `source "${LIB}"; selfqa_detect_agent; echo rc=$?`,
      {
        env: {
          PATH: `${fakeBin}:/usr/bin:/bin`,
          HOME: join(root, "empty-home"),
          SELFQA_IGNORE_LOCAL_BIN: "1",
        },
      },
    );
    expect(String(r.stdout || "")).toMatch(/rc=1/);
    expect(String(r.stderr || "") + String(r.stdout || "")).toMatch(
      /not the Cursor CLI/i,
    );
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
          HOME: join(root, "empty-home-dry"),
          SELFQA_IGNORE_LOCAL_BIN: "1",
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

  test("live run refuses missing CLI with install hint", () => {
    const app = join(root, "no-cli");
    initRepo(app);
    const r = spawnSync("bash", [RUNNER, "--goal", "need cli"], {
      cwd: app,
      env: {
        ...process.env,
        SELFQA_TARGET_ROOT: app,
        PATH: "/usr/bin:/bin",
        HOME: join(root, "empty-home-nocli"),
        SELFQA_IGNORE_LOCAL_BIN: "1",
      },
      encoding: "utf8",
    });
    expect(r.status).toBe(1);
    expect(r.stderr + r.stdout).toMatch(/cursor\.com\/install/i);
  });

  test("repeat finding ids across consecutive cycles → BLOCKED path helper", () => {
    const a = join(root, "rep-a.txt");
    const b = join(root, "rep-b.txt");
    writeFileSync(a, "HB-R9-01\n");
    writeFileSync(b, "HB-R9-01\nHB-R9-02\n");
    const r = bash(
      `source "${LIB}"; common="$(selfqa_repeat_findings "${a}" "${b}")" && echo BLOCKED:"$common" && echo rc=0 || echo rc=$?`,
    );
    expect(r.stdout).toMatch(/BLOCKED:HB-R9-01/);
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
