# Home Base — 1.22.1 Self-QA review (`d6f4da3`)

- **When:** 2026-11-13, 11:38–11:45 PM America/New_York (EST).
- **Build tested:** `development_grok` tip **d6f4da3** (`d6f4da3ed2d1039238d69a74cdb8707c59ec4da7`, message `fix(selfqa): harden 1.22.1 agent verify, cancel race, and setup install`, 2026-11-13 11:36:07 PM EST). `VERSION` is **1.22.1**. After `git fetch origin development_grok`, local HEAD and `origin/development_grok` were already this SHA. The worktree was not reset, force-pushed, or deployed.
- **Specs:** `~/APP_PROJECTS/qa/selfqa/QA-AGENT-SPEC.md` and the in-repo copy `docs/qa/selfqa-qa-spec.md`.
- **How:** Code review of `scripts/selfqa/`, `server/src/selfqa.ts`, `server/src/cursor_jobs.ts`, `server/src/homebase_tools.ts`, `server/src/app.ts`, `web/src/components/SelfQaPanel.tsx`, `web/src/components/CursorJobsPanel.tsx`, `build.sh` setup/onboarding, and `packaging/homebased.service`. Safe local tests only: `bun test` + `bunx tsc --noEmit` in `server/` and `web/`; runner `--dry-run` and live-gate checks in a temp clone at `/tmp/qa-hb-1221/src` (detached `d6f4da3`) with `agent` / `cursor-agent` removed from `PATH`; guardrail/verdict helpers; a **fake** `cursor-agent` (version string `2026.11.10-deadbeef` only) in throwaway repos under `/tmp/qa-hb-1221/ex` for repeat-BLOCKED, agent-exit, and timeout paths; an isolated in-process Self-QA cancel+webhook check on **127.0.0.1:18121** (not a Home Base server). **No real Cursor agent run, no production targets, no deploy, no restart.** Live Home Base **:8090** (pid **1198759**) was not called, rebuilt, or touched.

## Verdict

**Fail.** Branch refusal, localhost-only goals, repeat-finding stop-early (true positives), strict `VERDICT.json`, per-agent timeout, dry-run without the CLI, cancel (MCP + GUI path + cancelled callback + lock release), `agent --version` setup with no auto-login, unit tests, and `tsc` all held. This build is **not ready for Dan’s self-deploy** because a High code-enforced guardrail misses the usual `./ship.sh` form, and three Medium gaps remain in push-destination coverage, “open” finding extraction, and the price-change regex. Keep **1.20.3** as the rollback. The `.git` ownership fix is **still pending** on the separate ownership job (`homebased.service` is still `User=root`).

## Results

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | Branch refusal (High) | **Pass** | Live `run.sh --goal` on a temp repo on `main` exited **1** with `Error: Self-QA requires branch 'development_grok'`. The same runner on `development_grok` passed the gate and failed later on the missing CLI (install hint). Unit test `selfqa run.sh > branch refusal when not on development_grok` passed. `--dry-run` skips this gate on purpose (writes nothing). |
| 2 | Localhost-only targets (High) | **Pass** | `--goal "hit https://api.prod.example/v1 and fix it"` on `development_grok` exited **1** with `non-localhost target URL(s) not allowed`. `--goal "use http://localhost:3300/app"` was allowed and failed later on the missing CLI. Unit test `localhost-only refuses remote URLs` passed. |
| 3 | Stop-early: same finding in 2 consecutive rounds → `blocked` (High) | **Pass** (see HB-122-03) | Fake Cursor CLI, `--cycles 3 --testers 1`, same `ID: HB-R9-01` written in cycle 1 and 2 reports. Runner stopped after cycle 2, wrote `VERDICT.json` `{"verdict":"BLOCKED","reason":"repeat_finding","ids":["HB-R9-01"]}`, `SUMMARY.json` `verdict=BLOCKED`, `rounds=2`, and exited **2**. Did not start cycle 3. |
| 4 | Guardrails enforced in code, not only prompts (High); `--force` / `--trust` | **Fail** (HB-122-01, also HB-122-02 / HB-122-04) | Scanner in `scripts/selfqa/lib.sh` (`selfqa_scan_guardrails`, lines 118–130) plus post-step `selfqa_scan_deletions`. Hits confirmed: `./build.sh --deploy`, `firebase deploy`, `eas submit`, `git merge`, `git push --force` / `--force-with-lease`, `git push origin main\|master\|development`, `git branch -D`, `git push --delete`, `App Store Connect`, `sk_live_…`. `git push origin development_grok` is allowed. Headless runs use `cursor-agent -p --force --model auto` (`run.sh` ~308); **`--trust` is not used**. `--force` is documented in `--help` and `docs/SELFQA.md`. Mitigation is a **post-step** log/git scan, so a forbidden command can already have run before abort (exit **1**, `VERDICT.json` `BLOCKED`). |
| 5 | Strict verdict JSON; agent exit status; exit 0/2 (High / Medium) | **Pass** | `selfqa_read_verdict_json` accepts only `{"verdict":"PASS"\|"FAIL"\|"BLOCKED"}`. `Verdict: PASS` markdown and `{"verdict":"yes"}` return empty (treated as `FAIL`). No markdown PASS grep in `run.sh`. Fake agent exit **13** → runner exit **1**, `VERDICT.json` `FAIL`, `SUMMARY.json` written. Fake agent timeout (`SELFQA_AGENT_TIMEOUT_SEC=2`) → agent exit **124**, runner exit **1**, summary written. Repeat-BLOCKED path exits **2**. |
| 6 | Per-agent timeout; exactly one callback at the end, including cancelled (Medium) | **Pass** | Timeout wrapper uses `timeout --signal=TERM` (default 900s, overridable). Isolated cancel test: `cancelSelfQa` marked `cancelled`, POSTed **one** `type=homebase.selfqa` webhook with `"status":"cancelled"` and the dummy `Authorization` header, dummy token **not** in the body, then `projectHasActiveSelfQa` was null and a second start succeeded. Exit hook does not overwrite `cancelled` (`status !== "running"`). Cursor job unit test `cancels running job, fires callback, releases project lock` passed. |
| 7 | `--dry-run` prints the plan, exits 0 without the CLI, writes no `docs/selfqa/<run-id>` (Medium) | **Pass** | Temp clone of this SHA, `PATH=/usr/bin:/bin`, `SELFQA_IGNORE_LOCAL_BIN=1`: exit **0**, stdout contained `# Self-QA plan` and `Dry-run complete — no files written.`, agent labeled `(Cursor CLI not installed — ok for dry-run)`. `find docs` before/after was identical (no new `docs/selfqa/<run-id>`). Unit test `dry-run without Cursor CLI writes nothing and exits 0` passed. |
| 8 | `homebase_cursor_job_cancel` MCP + GUI Cancel (jobs and Self-QA) | **Pass** | MCP tool registered (`homebase_tools.ts` ~1018–1093): cancels a cursor job by `jobId`, a Self-QA run id, or the active Self-QA / job for `projectId`. HTTP: `POST /api/projects/:projectId/cursor-jobs/:jobId/cancel` and `POST /api/projects/:projectId/selfqa/stop`. GUI: `CursorJobsPanel` Cancel and `SelfQaPanel` Cancel → those APIs. Unit tests cover registration, job cancel+callback+lock, and Self-QA cancel+lock; isolated script covered the Self-QA cancelled webhook. |
| 9 | `build.sh` setup installs and verifies Cursor `agent` (no auto-login) | **Pass** | `ensure_cursor_agent_cli` in `build.sh` (726–786) is called from `cmd_setup` (and therefore `--onboarding`). It uses `selfqa_detect_agent` / `agent --version` (date-sha or Cursor help wording; incidental `"cursor"` substrings are not enough). If missing, official installer `curl https://cursor.com/install -fsS \| bash`, then re-verify. Comments and hints say setup **never** runs `agent login`. `selfqa_agent_install_hint` prints the same. Live `--setup` was **not** executed here (would write the checkout and may install the CLI). |
| 10 | Regression: `bun test` and `tsc` | **Pass** | `bunx tsc --noEmit` in `server/` and `web/`: **0** errors. Combined `bun test test/unit` in one process: **143 pass / 107 skip / 0 fail** (250 tests, 41 files). The 107 skips are `envIsolated()` guards (config already imported by an earlier file). The same 11 files rerun in fresh processes: **107 pass / 0 fail**. No product failures. A `web/tsconfig.tsbuildinfo` touch from `tsc` was restored and not committed. |
| 11 | `.git` ownership / `User=root` | **Pending** (separate job; not a 1.22.1 Self-QA gate) | `packaging/homebased.service` is still `User=root` / `Group=root`. PTY sessions and operator `git`/`gh` try `setpriv`/`runuser` as the seat user (`wrapArgvForSeat`, `operator_git_env.ts`). Cursor SDK jobs call `ensureSeatAgentEnv()` only (seat `HOME`/`PATH`, process **uid stays 0**, `cursor.ts` ~1402). `cursor_jobs.gitTip` uses unwrapped `spawnSync("git", …)`. This matches Dan’s `COMMIT_EDITMSG` permission denied after MCP/worktree writes as root. **Not fixed in d6f4da3.** Wait for the ownership-fix job before treating laptop `git commit` without sudo as verified. |

## New bugs

### HB-122-01

- **Severity:** High
- **Repro:**
  1. `source scripts/selfqa/lib.sh`
  2. Write a one-line log and run `selfqa_scan_guardrails` on it.
  3. Compare `ship.sh --all` vs `./ship.sh --all`, `bash ./ship.sh`, `/home/dan/app/ship.sh`, and `cd foo && ./ship.sh`.
- **Expected vs actual:** Spec High item 4 requires a code abort on ship scripts. `build.sh --deploy` already allows an optional `./` prefix (`lib.sh:118`), so `./ship.sh` should also abort. Actual: `ship.sh --all` and `bash ship.sh` return 1 (hit); `./ship.sh --all`, `bash ./ship.sh`, `/home/dan/app/ship.sh`, and `cd foo && ./ship.sh` return **0** (miss). Pattern is `lib.sh:119` `(^|[;|&[:space:]])ship\.sh\b` — the character before `ship.sh` in `./ship.sh` is `/`, so it does not match.
- **Evidence:** `/tmp/qa-hb-1221` scanner variants, 2026-11-13 11:42 PM EST. `scripts/selfqa/lib.sh:118-119`.

### HB-122-02

- **Severity:** Medium
- **Repro:**
  1. `selfqa_scan_guardrails` on `git push origin feature-foo` and on a bare `git push`.
  2. Confirm `git push origin main` / `master` / `development` still hit.
- **Expected vs actual:** Spec High item 4: abort `git push` to **any** branch other than `development_grok`. Actual: `main` / `master` / `development` are blocked and `development_grok` is allowed, but `git push origin feature-foo` and bare `git push` (implicit upstream) return **0**. `lib.sh:123-124`.
- **Evidence:** Same scanner run as HB-122-01.

### HB-122-03

- **Severity:** Medium
- **Repro:**
  1. Cycle 1 report contains open `ID: HB-R1-01`.
  2. Cycle 2 report lists `ID: HB-R1-01` as Pass/fixed and a new `ID: HB-R1-02` as Fail.
  3. Run `selfqa_extract_finding_ids` on the cycle 2 report, then `selfqa_repeat_findings`.
- **Expected vs actual:** Spec requires BLOCKED when the same id appears **as open** in 2 consecutive cycles. Actual: both `HB-R1-01` and `HB-R1-02` are extracted from the Pass+Fail report, so a fixed id mentioned again can stop the run as `BLOCKED`. The true-positive path (same still-open id) works — see item 3.
- **Evidence:** `selfqa_extract_finding_ids` in `lib.sh:75-90` (no open/closed filter); `/tmp/qa-hb-1221/ex` extract output.

### HB-122-04

- **Severity:** Medium
- **Repro:** `selfqa_scan_guardrails` on:
  - `we will change the subscription price tonight`
  - `change the price of the plan`
  - `set the subscription to 9.99`
  - `increase the price`
  - vs `subscription price change` and `price update coming`.
- **Expected vs actual:** Spec High item 4 should abort price / subscription changes. Actual: the regex `(price|subscription).{0,40}(change|update|set|increase|decrease)` (`lib.sh:130`) is order-sensitive. The first four phrases return **0**; `subscription price change` and `price update coming` return 1. `App Store Connect` wording is still caught by a separate pattern.
- **Evidence:** Same scanner run as HB-122-01.

## Observations (not filed)

- Guardrail abort writes `VERDICT.json` `BLOCKED` but exits **1**. Repeat-finding `BLOCKED` exits **2**. The spec table lists both “guardrail block” under 2 and “guardrail abort” under 1.
- `--dry-run` does not apply the branch or localhost gates. It writes nothing and exits 0, which matches the dry-run clause.
- `--force` on the Cursor CLI is accepted by the spec and documented; it is not a sandbox. A deploy/`./ship.sh` that the scanner also misses could complete before the runner aborts.
- Combined `bun test test/unit` skips the `envIsolated()` files when `config` was already imported. Not a product defect; those files passed in fresh processes.
- No throwaway Home Base GUI was started. Cancel UI coverage is code review plus the unit/isolated API tests above.

## Not tested, and why

- **A real Cursor `agent` / `cursor-agent` sprint** — this box has no Cursor Agent CLI and the brief forbade a real agent against prod. Repeat/timeout/failure paths used a fake CLI in temp repos.
- **`./build.sh --setup` actually installing the CLI** — would mutate the checkout and may download/install software. Install + `agent --version` + no auto-login were reviewed in script text only.
- **Live :8090 MCP/GUI and Dan’s laptop `.git` ownership after a real job** — on purpose. Pid 1198759 was left running. Ownership remains for the follow-up job.

## Cleanup

`/tmp/qa-hb-1221` will be removed after this doc is committed. Live :8090 (pid 1198759) and the Home Base checkout hooks/runtime were not modified. No secrets were committed.
