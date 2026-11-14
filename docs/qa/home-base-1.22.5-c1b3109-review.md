# Home Base — 1.22.5 final review (`c1b3109`)

- **When:** 2026-11-14, 12:24–12:26 AM America/New_York (EST).
- **Build tested:** `development_grok` tip **c1b3109** (`c1b3109b5b2e4719d62bce8c4db46baf77dcb14d`, merge of **cc21007** `fix(selfqa): use VERDICT.json openFindings for repeat-bug detection (HB-122-03)` and the interim 1.22.4 review **abb8308**). After `git fetch origin development_grok`, local HEAD already equaled `origin/development_grok` (fast-forward not needed; no reset, no force). `VERSION` is **1.22.5**.
- **How:** Same rules as the 1.22.3 / interim 1.22.4 reviews. Code review of `scripts/selfqa/{run.sh,lib.sh}`, `docs/SELFQA.md`, `docs/qa/selfqa-qa-spec.md`, and `scripts/selfqa/prompts/qa_manager.md`. Safe tests only: `bun test` + `bunx tsc --noEmit`; verdict/extract/warning helpers; hook/shim/injected-guard checks in temp repos; a **fake** `cursor-agent` (`2026.11.10-deadbeef` only) under `/tmp/qa-hb-1225` (callback sink **127.0.0.1:18151**); a **root** SDK probe/ownership harness in `/tmp/qa-hb-1225-own`. **No real Cursor agent, no prod, no deploy, no restart, no app-code edits.** Live Home Base **:8090** (pid **1198759**, still `box`) was not called or touched.

## Verdict

**Pass.** This build is ready for Dan’s single self-deploy. Keep **1.20.3** as the rollback. HB-122-03 now uses required `VERDICT.json` `openFindings` as the source of truth (fail closed when missing or malformed; report text is a warning cross-check only). Prior 06d87ca items still hold on this tip. No new findings were filed.

## Results

| # | Item | Status | Evidence |
|---|---|---|---|
| 1a | Same open finding in 2 rounds BLOCKS, exit 2 | **Pass** | Fake QA Manager wrote `{"verdict":"FAIL","openFindings":[{"id":"HB-R9-01",…}]}` in cycles 1 and 2 (`--cycles 3`). Runner stopped with `{"verdict":"BLOCKED","reason":"repeat_finding","ids":["HB-R9-01"],"openFindings":[…]}`, exit **2**, exactly one callback, hooks cleared. Unit test `HB-122-03: openFindings from VERDICT.json` passed. |
| 1b | Finding fixed/passed in round 2 does not block | **Pass** | Cycle 1 `openFindings` had `HB-R1-01`; cycle 2 listed only new `HB-R1-02` (fixed id in the markdown report only). Final `VERDICT.json` was `FAIL` (not `BLOCKED`). Callback bugs/items contained `HB-R1-02` only. |
| 1c | Missing or malformed `VERDICT.json` / `openFindings` fails closed as BLOCKED | **Pass** | `selfqa_read_verdict_json` returns empty for: missing file, bad JSON, `{"verdict":"FAIL"}` (no `openFindings`), `openFindings` as a string, and an item missing `title`. Fake-agent runs that wrote those last two shapes: runner logged `Invalid VERDICT.json … fail closed BLOCKED`, wrote `{"verdict":"BLOCKED","reason":"invalid_verdict","openFindings":[]}`, exit **2**, one callback each. |
| 1d | Report-text scan is warning-only | **Pass** | `selfqa_extract_finding_ids` prints only `openFindings` ids. A report that also had `HB-X-99` Fail logged `warn: report text open-ids cross-check differs … (report is not source of truth)` and still extracted only `HB-R9-01`. End-to-end: markdown repeated Fail `HB-R9-01` in cycle 2 but `openFindings` listed only `HB-R1-02` — no BLOCKED; the warning appeared in `runner.log`. Unit test `HB-122-03: report text is warning cross-check only` passed. |
| 1e | Callback `items`/`bugs` come from `openFindings`; exactly one callback | **Pass** | On the repeat-BLOCKED path: `items=[{text:"HB-R9-01: Repeating open bug",status:"fail"}]`, `bugs.high=[{id:"HB-R9-01",summary:"Repeating open bug"}]`; Pass `HB-R1-99` (report only) was omitted. `typecheck=pass` and `tests={expected:10,passed:9,failed:1}` still came from the report. One POST to `:18151` with `Authorization: Bearer qa-1225`, secret not in the body. Same single-callback behavior on no-false-BLOCK, invalid verdict, die (exit 1), and timeout (exit 1, agent 124). Die `docsCommit` was the latest `docs/qa` commit, not a later non-docs HEAD. Unit test `HB-122-05: callback items/bugs from VERDICT openFindings` passed. |
| 1f | `docs/SELFQA.md` and the QA prompt match the behavior | **Pass** | `docs/SELFQA.md` and `docs/qa/selfqa-qa-spec.md` document required `openFindings`, fail-closed `BLOCKED` when missing/malformed, callback use of that list, and report text as a warning cross-check. `scripts/selfqa/prompts/qa_manager.md` requires the same JSON shape, lists only still-open ids, calls `openFindings` the source of truth for repeat detection and callback `items`/`bugs`, and says missing/malformed fails closed as `BLOCKED`. The live QA Manager phase prompt in `run.sh` asks for that schema. |
| 2 | Regression of 06d87ca passed items | **Pass** | **HB-OWN-02 probe:** root harness, `execPath` basename `bun.exe`, child `uid=1000` (`box`; this box has no `daniel` user), parent stayed 0. Root `cursor_sdk_host` + `project_owner` tests: 8 pass. **HB-122-01/02/04:** scan hits `./ship.sh`, `bash ./ship.sh`, `cd && ./ship.sh`, `deploy-api.sh`, `ship-expo.sh`, `pnpm deploy`, `git push origin feature-foo`, and the price phrases including `set the subscription to 9.99`; `development_grok` push and prose “I will not run ./ship.sh” allowed. **SW-SQ-10:** injected guard on a *copy* of StockWinter `ship.sh` refused `bash ./` and absolute path under `SELFQA_RUN=1`; PATH shims refused `pnpm exec firebase`/`eas`; guards restored. Hook (installed only inside a temp repo) refused `feature-foo`, allowed `development_grok`, then cleared; Home Base `core.hooksPath` stayed unset. Dry-run exit 0, no files; branch refusal exit 1. **Ownership:** after a planted root `.git/ROOT_LEFTOVER` and `ownershipQaAfterGitOp`, `find .git ! -user box` printed nothing and a setpriv owner `git commit` exited 0. **tsc:** 0 errors in `server/` and `web/`. **Unit tests:** combined **159 pass / 107 skip / 0 fail** (266 tests, 43 files). Isolated reruns of the 11 `envIsolated()` files + `project_owner` + `selfqa_runner` + `cursor_sdk_host`: **134 pass / 0 fail**. `web/tsconfig.tsbuildinfo` was restored and not committed. |

## Observations (not filed)

- The text scan still misses the strings `pnpm exec firebase deploy` / `pnpm exec eas submit`. Runtime refusal remains the PATH shim (same residual as 1.22.4).
- A cycle that ends `FAIL` with remaining open findings still exits **2** (same as prior reviews). Repeat and invalid-verdict `BLOCKED` also exit 2. Die/timeout exit 1.
- Combined `bun test test/unit` still skips the 107 `envIsolated()` tests in one process; they passed in fresh processes.
- `qa_manager.md` does not use the exact phrase “warning cross-check”; it states the same rule (openFindings is the source of truth; Pass/fixed belong only in the markdown report).

## Not tested, and why

- **A real Cursor SDK `Agent` job** — no API key / no prod target. HB-OWN-02 was rechecked with the official `probeSdkOwnerChildUid` as root on this box’s `bun.exe` path.
- **Throwaway Home Base HTTP, or a real MCP git commit against a server** — not started. Ownership after repair and owner `git commit` without sudo were harnessed. Live :8090 was left alone.
- **`./build.sh --setup` on this checkout** — would mutate the worktree / maybe install the CLI.

## Cleanup

`/tmp/qa-hb-1225` and `/tmp/qa-hb-1225-own` will be removed. Live :8090 (pid 1198759) was not modified.
