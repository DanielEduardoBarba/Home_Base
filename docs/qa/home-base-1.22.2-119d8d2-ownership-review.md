# Home Base — 1.22.2 HB-OWN-01 ownership review (`119d8d2`)

- **When:** 2026-11-13, 11:48–11:52 PM America/New_York (EST).
- **Build tested:** `development_grok` tip **119d8d2** (`119d8d277518dae38969a216c95328c3c9c512d2`, merge of **fe6bc7c** `fix(ownership): run project spawns as checkout owner (HB-OWN-01, v1.22.2)` and the 1.22.1 review commit `dfbee30`). After `git fetch origin development_grok`, local HEAD already equaled `origin/development_grok` (fast-forward not needed; no reset, no force). `VERSION` is **1.22.2**.
- **How:** Code review of `server/src/project_owner.ts` plus spawn/git/MCP/API/GUI/setup hooks. Safe tests only: `bun test` + `bunx tsc --noEmit`; a **root** harness in `/tmp/qa-hb-1222` (sudo bun, uid 0) against a box-owned temp repo, simulating `homebased.service User=root`; the same `project_owner` unit tests rerun as root. **No real Cursor agent, no prod, no deploy, no restart.** Live Home Base **:8090** (pid **1198759**) was not called or touched. Full `./build.sh --setup` was not run on the checkout.
- **HB-122-01..04:** still open, as expected (this job does not change `scripts/selfqa/lib.sh`).

## Verdict

**Item 1 is partial.** Git, `run_action`, and Self-QA PTY spawns drop to the checkout owner via `setpriv`. Cursor SDK jobs still run **in-process as uid 0**; only `HOME`/`USER`/`PATH` are applied, then `finishJob` repairs afterwards. Items **2–5 passed**. Dan’s leftover `.git/COMMIT_EDITMSG` case is fixed by repair (MCP/GUI/setup/boot) and owner `git commit` then works without sudo. **HB-OWN-02** filed for the remaining SDK uid-0 gap. HB-122-01..04 remain open, so this is not a Self-QA pass and not a deploy recommendation; keep **1.20.3** as the rollback until those are fixed too.

## Results

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | git, cursor_job, run_action, and selfqa spawns run as the checkout owner, not root | **Partial** | On a uid-0 harness, `resolveProjectOwner(/tmp/qa-hb-1222/repo)` was `box` (1000). `buildOperatorCmd("git", …, {cwd})` wrapped `/usr/bin/setpriv --reuid 1000 --regid 1000 --init-groups -- /usr/bin/git …`. A wrapped `git add` + `git commit` left `.git/COMMIT_EDITMSG` and `.git/index` owned by **box**. `wrapArgvForProject(["bash", "build.sh", "--selfqa"], repo)` used the same setpriv prefix (the `spawnShell` path used by `run_action` and `startSelfQa`). A wrapped `/bin/bash -lc 'id -u; echo wrapped > pty-write.txt'` printed **1000** and wrote a **box**-owned file. **Cursor SDK:** `applySeatEnvForAgents(owner)` set `HOME=/home/box` and `USER=box`, but `process.getuid()` stayed **0**. `createAgentHandle` still only calls that env helper before in-process `Agent.create` — no setpriv around SDK shells. See HB-OWN-02. `packaging/homebased.service` is still `User=root` (expected; drop is per spawn). |
| 2 | `homebase_fix_ownership` + Apps “Fix ownership” repair root-owned `.git` | **Pass** | Planted a root-owned `.git/COMMIT_EDITMSG` in the temp repo. `repairProjectOwnership` repaired 5 root leftovers (including that file). `find .git ! -user box -print` printed **nothing**. `project_owner.test.ts` rerun as root: the same plant/repair case passed (`repaired=1 sample=.git/COMMIT_EDITMSG`). MCP tool `homebase_fix_ownership` is registered under `projects` and calls the same repair + health functions. GUI: Apps tab shows ownership and a “Fix ownership” button (`api.fixOwnership` → `POST /api/projects/:id/fix-ownership`). No throwaway HTTP server was started (harness + unit tests exercised the same functions). |
| 3 | `homebase_project_status` reports ownership health, including root-owned files | **Pass** | Before repair, `projectOwnershipHealth` was `ok=false`, `foreignCount=5`, samples included `.git/COMMIT_EDITMSG` (and other root leftovers), `owner.name=box`. After repair, `ok=true`, `foreignCount=0`. `projectPublic` (used by `homebase_project_status` and `GET /api/projects/:id`) now includes `ownership: {ok, owner, foreignCount, samples}`. MCP description mentions “.git ownership health”. |
| 4 | After a simulated job or MCP commit, the owner’s `git commit` works without sudo | **Pass** | Wrapped operator `git commit` already wrote box-owned git metadata. After planting a root `COMMIT_EDITMSG` (SDK leftover) and running `repairProjectOwnership` + `ownershipQaAfterGitOp` (the `finishJob` / post-commit path), a `setpriv --reuid 1000` `git commit -m 'owner commit after repair, no sudo'` exited **0** with no `Permission denied`. `git log -1` showed that commit. |
| 5 | Setup repairs ownership on every repo once | **Pass** (code + harness; full setup not run) | `cmd_setup` in `build.sh` calls `repairAllRegisteredProjects(loadProjects().values())` after seeding. `entry.ts` boot does the same. Harness: a second temp repo with a root-owned `.git/COMMIT_EDITMSG` was repaired (`projects=1 files=1`); `find .git ! -user box` was empty. Full `./build.sh --setup` was not executed on this checkout. |
| 6 | Regression: unit tests and `tsc` | **Pass** | `bunx tsc --noEmit` in `server/` and `web/`: **0** errors. Combined `bun test test/unit`: **149 pass / 107 skip / 0 fail** (256 tests, 42 files), including 6 new `project_owner` tests (the root-repair case is a shape check when not root). Isolated reruns of the 11 `envIsolated()` files + `project_owner`: **113 pass / 0 fail**. The same `project_owner` file as root: **6 pass / 0 fail** (repair actually chowned a planted `.git/COMMIT_EDITMSG`). A `web/tsconfig.tsbuildinfo` touch from `tsc` was restored and not committed. |
| 7 | HB-122-01..04 still open | **Confirmed open** | `scripts/selfqa/lib.sh` is unchanged. `./ship.sh --all` still misses (bare `ship.sh` still hits). `git push origin feature-foo` still misses (`main` still hits). Extract of a Pass+Fail report still includes `HB-R1-01`. “change the subscription price” still misses (“subscription price change” still hits). |

## New bugs

### HB-OWN-02

- **Severity:** Medium
- **Repro:**
  1. Run homebased as root (`User=root`).
  2. Start a Cursor SDK job (`homebase_cursor_job` / Chat agent) in a box-owned checkout.
  3. During the job, have the agent (or a stand-in) write `.git/COMMIT_EDITMSG` or other git metadata. `process.getuid()` in `createAgentHandle` is still 0; only `applySeatEnvForAgents(checkoutOwner)` has run.
  4. If the process exits before `finishJob` / boot / “Fix ownership” repair, `find .git ! -user box` is not empty and `git commit` can hit `Permission denied`.
- **Expected vs actual:** HB-OWN-01 required Cursor SDK jobs, which previously ran as uid 0, to run as the checkout owner. Actual: env (`HOME`/`USER`/`PATH`) is switched to the owner, but the SDK stays in-process as root. `finishJob` then calls `repairProjectOwnership` + `ownershipQaAfterGitOp`, and boot/setup/MCP/GUI can repair leftovers. After a normal settle, the owner can commit (item 4). Mid-job or a crash between write and repair can still leave root-owned `.git` files until the next repair.
- **Evidence:** `server/src/cursor.ts` `ensureSeatAgentEnv` / `createAgentHandle` (~1360–1410); root harness `cursor-sdk-env-applied` and `cursor-sdk-process-still-root`; post-job repair coverage in items 2 and 4.

## Observations (not filed)

- `homebased.service` remains `User=root`. Privilege drop is per spawn (`setpriv`), not a unit-user change.
- Unwrapped `git commit` as root on a file that already existed as box-owned may rewrite `COMMIT_EDITMSG` in place and keep the box owner. Planting a new root-owned file is the reliable leftover repro (used above).
- Combined `bun test test/unit` still skips `envIsolated()` files in one process. Not a product defect; they passed in fresh processes.

## Not tested, and why

- **A real Cursor SDK job** — no agent CLI / API key here, and the brief forbade a real agent against prod. The in-process uid-0 behavior was read in code and confirmed by applying the env helper as root.
- **Throwaway Home Base HTTP on a non-default port** — not started. Repair, health, MCP registration, and API/GUI wiring were checked in the root harness, unit tests, and code. Live :8090 was left alone.
- **`./build.sh --setup` on this checkout** — would mutate the worktree / maybe install the CLI. The setup snippet and `repairAllRegisteredProjects` were reviewed and harnessed.

## Cleanup

`/tmp/qa-hb-1222` will be removed (including any root-owned leftovers). Live :8090 (pid 1198759) was not modified.
