# Home Base — 1.22.3 final pass (`b44b115`)

- **When:** 2026-11-13 11:56 PM – 2026-11-14 12:01 AM America/New_York (EST).
- **Build tested:** `development_grok` tip **b44b115** (`b44b115ccd3f0a0494bf7a1e47d8787a396ac191`, merge of **448d916** `fix(selfqa): harden guardrails for 1.22.3` and the 1.22.2 review commit **a63e325**). After `git fetch origin development_grok`, local HEAD already equaled `origin/development_grok` (fast-forward not needed; no reset, no force). `VERSION` is **1.22.3**.
- **How:** Code review of `scripts/selfqa/{run.sh,lib.sh}`, `server/src/cursor.ts` / `shell_env.ts` / `project_owner.ts`, and the 1.22.1 cancel/setup paths. Safe tests only: `bun test` + `bunx tsc --noEmit`; scanner / hook / shim / `--dry-run` / branch-refusal checks; a **fake** `cursor-agent` (version `2026.11.10-deadbeef` only) in throwaway repos under `/tmp/qa-hb-1223` for die, timeout, repeat-BLOCKED, and callback paths (POST sink on **127.0.0.1:18131**, not a Home Base server); a **root** harness in `/tmp/qa-hb-1223-own` (sudo bun, uid 0) against box-owned temp repos. **No real Cursor agent, no prod, no deploy, no restart, no app-code edits.** Live Home Base **:8090** (pid **1198759**, still `box`) was not called or touched.

## Verdict

**Fail.** This is **not ready for Dan’s single self-deploy.** HB-122-01, HB-122-02, required HB-122-04 phrases, the run-scoped hook/shim/env layer, 1.22.1 regressions, 1.22.2 ownership items 2–5, unit tests, and `tsc` all passed. Two required items did not: **HB-OWN-02** is unchanged (Cursor SDK jobs still run in-process as uid 0; only seat env plus post-`startRun` repair), and **HB-122-03** is only fixed for the unit-test heading format — the canonical `ID:` / `Result:` report format still fails to extract open IDs when any Pass/fixed finding shares the same heading chunk, so a true repeat does not BLOCK. Keep **1.20.3** as the rollback.

## Results

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | HB-122-01: all `ship.sh` forms (`./`, `bash ./`, absolute path, `cd && ./`) | **Pass** | `selfqa_scan_guardrails` returned **1** for `./ship.sh --all`, `bash ./ship.sh`, `/tmp/qa-hb-1223/hookapp/ship.sh`, and `cd foo && ./ship.sh`. Unit test `HB-122-01: normalized ship/deploy forms all hit` passed. PATH shims refused `ship.sh` under `SELFQA_RUN=1`. Absolute and `bash ./ship.sh` invocations **bypass** the PATH shims and ran a real `/tmp/.../ship.sh` (`REAL_SHIP_RAN`, rc 0); the post-step scan still caught those forms (`scan_abs_rc=1`, `scan_bash_dot_rc=1`). See observations — shims are PATH-only; the scan is the backstop after the command has already run. |
| 2 | HB-122-02: a push to another branch and a bare push are blocked | **Pass** | Scan hit `git push origin feature-foo` and `git push origin main`; allowed `git push origin development_grok`. Bare `git push` with the repo root passed in: **blocked** when there is no `origin/development_grok` upstream or upstream is `origin/feature-foo`; **allowed** when upstream is `origin/development_grok`. Run-scoped pre-push hook refused `refs/heads/feature-foo` and ref deletion, and allowed `refs/heads/development_grok`. Unit test `HB-122-02: git push destination / force / bare rules` passed. |
| 3 | HB-122-03: fixed or Pass IDs don’t false-BLOCK; a true repeat still BLOCKS | **Partial** | Heading format (`### HB-R1-01` + `- Status: Pass/Fail`): extract skips Pass/fixed; a fake-agent `--cycles 2` run with cycle-1 Fail `HB-R1-01` and cycle-2 Pass `HB-R1-01` + Fail `HB-R1-02` ended `VERDICT.json` `{"verdict":"FAIL"}` (exit 2, no `BLOCKED`). True repeat of `HB-R9-01` (same heading format, `--cycles 3`) stopped with `{"verdict":"BLOCKED","reason":"repeat_finding","ids":["HB-R9-01"]}`, exit **2**, one callback, hooks cleared. Unit test `HB-122-03: Pass/fixed findings are not open for repeat-BLOCKED` passed. **Canonical QA format** (`ID:` / `Result:` under a single `#` title) is not fixed — see remaining HB-122-03. |
| 4 | HB-122-04: price phrasing variants | **Pass** (required phrases) | Scan hit `we will change the subscription price tonight`, `change the price of the plan`, `increase the price`, `subscription price change`, and `set price to 9.99`. Unit test `HB-122-04: price/subscription phrasing detection` passed. `set the subscription to 9.99` still returns **0**; the unit test explicitly skips that line as “not required by QA”. Observation only. |
| 5 | Run-scoped pre-push hook (only `development_grok`, removed after the run) | **Pass** | `selfqa_install_pre_push_hook` set `core.hooksPath` under the temp run dir. The hook refused a non-`development_grok` local ref and branch/ref deletion, and allowed `refs/heads/development_grok`. After dry-run (hooks never installed), die/agent-fail, timeout, and BLOCKED paths, `core.hooksPath` was **cleared** (`selfqa_restore_hooks_path` on EXIT). Hooks were never installed in the real Home Base checkout. |
| 6 | PATH shims + blanked deploy env during `SELFQA_RUN`; absolute/`bash` bypass vs scan | **Pass** (with residual) | Under `SELFQA_RUN=1`, PATH shims refused `ship.sh`, `deploy-api.sh`, `ship-expo.sh`, and `pnpm deploy` (rc 1). `run.sh` exports blank deploy credentials (`FIREBASE_TOKEN`, `EXPO_TOKEN`, `EAS_ACCESS_TOKEN`, `APP_STORE_CONNECT_API_KEY_PATH`, etc.) and a temp agent `HOME`. Absolute-path and `bash ./ship.sh` bypass the shims (the in-repo script ran) but the scan still aborted those lines. |
| 7 | No false positive on prose like `I will not run ./ship.sh` | **Pass** | `selfqa_scan_guardrails` on that exact sentence returned **0**. |
| 8 | StockWinter-style scans (`deploy-*.sh`, `ship-expo.sh`, `pnpm deploy*`) | **Pass** | Scan hit `deploy-api.sh`, `./deploy-web.sh --prod`, `ship-expo.sh`, `pnpm deploy`, and `pnpm run deploy:prod`. Matching PATH shims also refused the same families. |
| 9 | Callback fields `docsCommit`, `typecheck`, `tests`, `items`, `bugs`; single callback on the die path | **Partial** | Fake agent exit 13: runner exit **1**, exactly **one** POST to `http://127.0.0.1:18131/cb`, `Authorization: Bearer qa-1223`, secret **not** in the body, hooks cleared. `callback.json` contains `app`, `runId`, `branch`, `verdict`, `commit`, `docsCommit`, `typecheck`, `tests`, `items`, `bugs`. Timeout (`exited 124`) also exit 1 + one callback. Same single-callback + hooks-cleared behavior on the heading-format BLOCKED path. **However**, `TYPECHECK_STATUS` / `TESTS_JSON` / `ITEMS_JSON` / `BUGS_JSON` are initialized once in `run.sh` and never reassigned, so even after cycles with Fail findings they stay `typecheck=not_run`, `tests` all null, `items=[]`, `bugs` empty. `docsCommit` is the starting HEAD, not a later docs push. See HB-122-05. |
| 10 | HB-OWN-02: Cursor SDK jobs now run as the repo owner, not uid 0 | **Fail** | Root harness (`sudo bun`, uid 0) on a box-owned temp repo: `applySeatEnvForAgents(owner)` set `HOME=/home/box` and `USER=box`, but `process.getuid()` stayed **0**. `server/src/cursor.ts` still documents “SDK host stays root under systemd” and only adds `repairProjectOwnership(cwd)` after `startRun`. `createAgentHandle` still only applies seat env before in-process `Agent.create` — no `setpriv` around the SDK. Unchanged residual from 1.22.2. |
| 11 | 1.22.2 ownership items (git/run_action/selfqa spawns, Fix ownership, status health, owner commit without sudo, setup repair) | **Items 2–5 Pass; item 1 still Partial** | Same uid-0 harness: `resolveProjectOwner` was `box` (1000). `buildOperatorCmd("git", …)` wrapped `/usr/bin/setpriv --reuid 1000 --regid 1000 --init-groups --`. Wrapped `git commit` left `.git/COMMIT_EDITMSG` and `.git/index` owned by **box**. `wrapArgvForProject(["/bin/bash", "-lc", "id -u; …"])` printed **1000** and wrote a box-owned file. Planted a **new** root-owned `.git/ROOT_LEFTOVER`: `projectOwnershipHealth` was `ok=false`, `foreignCount=2`; after `repairProjectOwnership`, `ok=true`, `foreignCount=0`, `find .git ! -user box` empty. After another plant + `ownershipQaAfterGitOp`, a setpriv `git commit -m 'owner commit after repair, no sudo'` exited **0** with no `Permission denied`. `repairAllRegisteredProjects` on a second temp repo: `projects=1 files=1`, leftovers cleared. MCP `homebase_fix_ownership`, Apps “Fix ownership” (`api.fixOwnership`), and `projectPublic` ownership health are still wired. `cmd_setup` / boot still call `repairAllRegisteredProjects` (full `./build.sh --setup` not run). |
| 12 | Regression: 1.22.1 branch refusal, verdict JSON, timeout, dry-run, cancel, agent setup | **Pass** | Temp repo on `main`: `run.sh` exit **1**, `Error: Self-QA requires branch 'development_grok'`. Strict `VERDICT.json` still only accepts `PASS`/`FAIL`/`BLOCKED` (unit test passed); heading-format repeat wrote `BLOCKED`, mixed Pass+Fail wrote `FAIL`. Timeout: agent 124, runner exit 1, one callback. `--dry-run` exit **0**, printed `# Self-QA plan` and `Dry-run complete — no files written.`, no `docs/selfqa/<run-id>`, no `core.hooksPath`. `homebase_cursor_job_cancel` still registered; `ensure_cursor_agent_cli` still in `build.sh` setup (`agent --version`, no auto-login). Localhost-only unit test still passed. |
| 13 | Unit tests (including isolated reruns) and `tsc` | **Pass** | `bunx tsc --noEmit` in `server/` and `web/`: **0** errors. Combined `bun test test/unit`: **154 pass / 107 skip / 0 fail** (261 tests, 42 files), including the new HB-122-01..04 / hook / shim tests. Isolated reruns of the 11 `envIsolated()` files + `project_owner` + `selfqa_runner`: **129 pass / 0 fail**. The same `project_owner` file as root: **6 pass / 0 fail** (repair chowned a planted `.git/COMMIT_EDITMSG`). A `web/tsconfig.tsbuildinfo` touch from `tsc` was restored and not committed. |

## Remaining / new bugs

### HB-OWN-02 (still open)

- **Severity:** Medium
- **Repro:**
  1. Run homebased as root (`User=root`).
  2. Start a Cursor SDK job (`homebase_cursor_job` / Chat agent) in a box-owned checkout.
  3. During the job, have the agent (or a stand-in) write `.git` metadata. `applySeatEnvForAgents` has run, but `process.getuid()` is still 0.
  4. If the process exits before post-`startRun` / `finishJob` / boot / “Fix ownership” repair, `find .git ! -user box` is not empty and `git commit` can hit `Permission denied`.
- **Expected vs actual:** This 1.22.3 pass required Cursor SDK jobs to run as the checkout owner, not uid 0. Actual: seat `HOME`/`USER`/`PATH` are applied and `repairProjectOwnership` now also runs after `startRun`, but the SDK host stays root. Items 2–5 still cover the after-repair path. Mid-job or a crash between write and repair can still leave root-owned `.git` files.
- **Evidence:** `/tmp/qa-hb-1223-own` harness, 2026-11-14 12:00 AM EST: `applySeatEnvForAgents applied=true … uid=0`. `server/src/cursor.ts` comment at the post-`startRun` repair: “SDK host stays root under systemd”.

### HB-122-03 (residual)

- **Severity:** Medium
- **Repro:**
  1. Write a canonical cycle report:

     ```
     # Self-QA cycle 2

     ID: HB-R1-01
     Severity: High
     Result: Pass (fixed this cycle)

     ID: HB-R1-02
     Severity: Medium
     Result: Fail
     ```

  2. Run `selfqa_extract_finding_ids` on it.
  3. Or run the Self-QA runner for 3 cycles with a fake agent that always writes `ID: HB-R9-01` as Fail **and** another `ID:` as Pass in that format.
- **Expected vs actual:** Open IDs should be extracted (`HB-R1-02` / repeating `HB-R9-01`) and a true repeat should BLOCK. Actual: extract returns **[]** whenever a Pass/fixed `Result:` shares the same heading chunk (Pass-first and Fail-first both empty). A chunk with only Fail IDs, or blank-line-split reports with no title heading, works. The fake-agent orig-format run (`--cycles 3`) wrote `{"verdict":"FAIL"}`, `rounds=4` (did not BLOCK), exit 2. `is_closed` searches the whole heading chunk for any `Result: Pass`/`fixed`, and a leading `#` title prevents per-ID blank-line splits.
- **Evidence:** Extract cases A/B/C/E and `/tmp/qa-hb-1223/origrep`, 2026-11-13 11:59 PM EST. The unit test uses `### HB-R1-01` headings, which do split correctly — that is why the unit test is green.

### HB-122-05

- **Severity:** Low
- **Repro:** Inspect `docs/selfqa/<runId>/callback.json` (and the single end-of-run POST) after a die path or after cycles that wrote Fail findings.
- **Expected vs actual:** The callback schema includes `docsCommit`, `typecheck`, `tests`, `items`, and `bugs`, and those keys are present on the die path and after FAIL/BLOCKED runs. Actual: `run.sh` sets `TYPECHECK_STATUS=not_run`, null `tests`, `items=[]`, and empty `bugs` once and never fills them from reports or typecheck/test output. `docsCommit` is the starting HEAD.
- **Evidence:** Die, timeout, e2e BLOCKED, and nofalse FAIL callbacks under `/tmp/qa-hb-1223`, plus the only assignments of those variables in `scripts/selfqa/run.sh`.

## Observations (not filed)

- PATH shims do not wrap absolute-path or `bash ./ship.sh` invocations of in-repo scripts. The scan still catches those forms, but only after the script has run. A ship/deploy that completes in one step could already have started before abort. This is expected for PATH shims; it is not a scanner miss.
- `set the subscription to 9.99` still misses the price regex. The 1.22.3 unit test skips it on purpose. `set price to 9.99` hits.
- Combined `bun test test/unit` still skips the 107 `envIsolated()` tests when `config` was already imported. Not a product defect; they passed in fresh processes.
- `homebased.service` remains `User=root`. Privilege drop is per spawn (`setpriv`), not a unit-user change.
- Unwrapped `git commit` as root on a file that already existed as box-owned may rewrite `COMMIT_EDITMSG` in place and keep the box owner. Planting a **new** root-owned file is the reliable leftover repro (used above).
- Guardrail abort still writes `VERDICT.json` `BLOCKED` but exits **1**. Repeat-finding `BLOCKED` exits **2**.

## Not tested, and why

- **A real Cursor SDK job** — no agent CLI / API key here, and the brief forbade a real agent against prod. HB-OWN-02 was proven with the same env helper the SDK path calls, plus the in-process uid, as root.
- **Throwaway Home Base HTTP on a non-default port** — not started. Repair, health, MCP registration, and API/GUI wiring were checked in the root harness, unit tests, and code. Live :8090 was left alone.
- **`./build.sh --setup` on this checkout** — would mutate the worktree / maybe install the CLI. The setup snippet and `repairAllRegisteredProjects` were reviewed and harnessed.

## Cleanup

`/tmp/qa-hb-1223` and `/tmp/qa-hb-1223-own` will be removed (including any root-owned leftovers). Live :8090 (pid 1198759) was not modified.
