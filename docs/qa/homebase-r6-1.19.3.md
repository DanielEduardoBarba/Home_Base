# Home Base — R6 QA, version 1.19.3

- **When:** 2026-11-13, 6:51–6:58 AM America/New_York (EST).
- **Build tested:** `development_grok` tip **11fc8c7** (`11fc8c7a60c5a0e07d8fcf8c846592363cf3dd43`, message `feat(cursor-job): authenticated webhook callbacks (v1.19.3)`). `VERSION` **1.19.3**. After `git fetch origin development_grok`, local and `origin/development_grok` were already at this SHA — **the tip did not move** from the requested `11fc8c7`.
- **Commits since d0fba45 / R5 docs 688919e:** `30d004c` (`fix(cursor-job): treat invalid/empty agent runs as error (HB-R3-01, v1.19.2)`), `11fc8c7` (authenticated webhook callbacks, v1.19.3).
- **How:** Detached worktree of `11fc8c7` at `/tmp/qa-hb-r6/src`. Throwaway Bun on **127.0.0.1:18090** with a fresh data dir, runtime, and `HOMEBASE_MCP_WORKSPACES_ROOT` under `/tmp/qa-hb-r6`. 1.19.3 web UI built **into the worktree `web/dist` only** (live `web/dist` dated 2026-11-11 was not overwritten). Job-callback check used a second throwaway HTTP listener on **127.0.0.1:18092** and dummy test keys (never printed, never committed). Headless Playwright from `~/APP_PROJECTS/qa/e2e/hb-r6-gui.mjs`; screenshots in `~/APP_PROJECTS/qa/screenshots/hb-r6/`. Live **:8090** (pid **1198759**) was not restarted, rebuilt, or reconfigured.
- **Not used:** Clock Trakr, Ekklesias, :4210, emulators, App Store Connect, WireGuard, a Cursor API key (none on this box; `cursorConfigured=false` on both the throwaway and live health), `gh auth login`, or creating GitHub repos. No force-push, no `main` merge, no app-code edits. Tokens, passwords, and webhook keys were not written into the repo or this doc. Self-deploy was **not** run.

## Verdict

**Pass**, with one carried caveat. Callback Authorization is sent on the wire and is not echoed in job status, list, traces, webhook errors, GET endpoints, or logs. Closest-path coverage for HB-R3-01 (unit tests + stubbed `startCursorJob`) is green. A true live Cursor-agent invalid-model run is still **not tested** on this box.

**Ready for Dan’s self-deploy**, with the same leftover caveat as R5: confirm invalid-model job handling (`composer-1`) on a laptop that has a Cursor key. Build **server + web together** so a stale `web/dist` does not hide 1.19 Settings, Git, or MCP chat styling.

## Results

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | HB-R3-01: invalid model id ends as an error with a clear message, not `done` | **Pass** (closest path). **True live Cursor check: not tested.** | This box has no Cursor API key. `startCursorJob` still throws at `configured()` first (“Cursor API key not set on Home Base — human must add it in Settings”), so a live MCP kickoff never reaches `validateModel` or `evaluateIdleJobOutcome`. `assertKnownCursorModel` is also a no-op when `listModels()` returns an empty catalog (the no-key path). **Exercised:** (a) isolated `bun test test/unit/cursor_jobs.test.ts` — **17/17 pass**, including unknown model rejected up front with `Unknown Cursor model "composer-1"` and a valid-id list that includes `auto` / `composer-2.5`, empty assistant output → `error` not `done`, and post-kickoff `Unknown model composer-1` (exit/error after start) → `error` not `done`; (b) the same three paths via in-process `startCursorJob` with stubbed `configured` / `validateModel` / runner (not a live Cursor agent); (c) live MCP `homebase_cursor_job` on throwaway :18090 with `model: "composer-1"` — HTTP 200 tool result `{ ok: false, error: "Cursor API key not set on Home Base — human must add it in Settings" }`, no job created, status never `done`. **Not exercised:** a real Cursor agent run with an invalid model id. |
| 2 | Job callback auth: `callbackUrl` receives `Authorization` with the webhook key; key never appears in status, GET, logs, or errors | **Pass** | Stood up a local listener on **127.0.0.1:18092**. Drove `startCursorJob` in-process with stubbed Cursor deps (the running throwaway cannot finish a real job without a Cursor key) and dummy test keys (param and `HOMEBASE_CALLBACK_AUTH` env default). The listener received POST with `Authorization` set to the exact dummy value (no extra `Bearer` prefix). Job JSON has `callbackUrl` but no `callbackAuth` field; `webhookDelivered=true` on the 200 path. A forced 500 from the listener set `webhookError` without the key (redacted). Grep of `getCursorJob`, `listCursorJobs`, traces, `webhookError`, MCP `homebase_cursor_job` / `homebase_cursor_job_list` responses (including a no-key MCP call that passed `callbackAuth`), GET `/api/health`, `/api/legal`, `/api/cursor/models`, `/api/cursor/credentials`, `/api/activity`, `/api/mcp-server`, throwaway `server.log`, and the isolated runtime/data dirs: **clean**. There is no dedicated HTTP job-status route; public job JSON and the MCP list/status tools are the GET surfaces. A true MCP-finished webhook (job actually run by Cursor, then callback) was **not** possible here without a key. |
| 3 | Quick regressions: ping, git status, MCP message styling, Settings | **Pass** | `homebase_ping` on :18090 returned `ok: true`, `homebase: "up"`, `version: "1.19.3"`, `uptimeSec: 4` shortly after boot (still process uptime, not a stale first-import clock), and `apiKeyConfigured: false`. `homebase_git_status` was `ok: true` on a throwaway repo (clean `master`) and on the 1.19.3 worktree (detached `HEAD`, dirty only from the QA `node_modules` symlink + worktree-only `web/dist`). GUI Git tab showed `HEAD`, ahead/behind, uncommitted changes, Fetch (`hb-r6-06-git-tab.png`). Settings hub still has **Git & GitHub**, Appearance (**Show Home Access** present, `aria-checked=false`), and MCP Server allow switches (`hb-r6-02`–`05`). Seeded chat “R6 MCP vs human”: MCP bubble is violet (`rgba(124, 106, 240, 0.18)`) with meta **“QA Bot · via MCP · 6:56:42.000 AM · auto · job r6job00”**; human bubble is blue (`color(srgb 0.30 0.64 1 / 0.16)`) and has no MCP chrome (`hb-r6-07-chat-mcp-vs-human.png`). Home shows v1.19.3 (`hb-r6-01-home.png`). Playwright: 11/11. Expected red “Cursor key missing…” notice on Chat — accurate for this box, not a defect. |
| 4 | New/changed tests alone + `tsc` | **Pass** | Only test file changed since R5 (`688919e`) is `server/test/unit/cursor_jobs.test.ts`. Isolated `bun test test/unit/cursor_jobs.test.ts`: **17 pass / 0 fail**. Also re-ran `ping.test.ts` **3/3** and `git.test.ts` **14/14**. `bunx tsc --noEmit` in `server/`: **0 type errors**. |

## New bugs

None filed (**no HB-R6-xx**).

## Not tested, and why

- **True live HB-R3-01** (invalid model through a real Cursor agent) — this box has no Cursor API key; none was invented. Closest paths are documented in item 1.
- **True MCP-finished webhook delivery** — a job cannot start on the throwaway instance without a Cursor key, so the wire check used stubbed Cursor deps + a real local HTTP listener.
- **Creating a GitHub repo / signing in with `gh auth login`** — out of scope; Git & GitHub Settings were opened only, no Sign in click.
- **`--deploy` / rollback on this machine** — not run, as requested.
- **The live :8090 GUI** — on purpose. That process was left running (pid 1198759) and still serves a Nov 11 `web/dist`.

## Screenshots (throwaway :18090, not in this commit)

Under `~/APP_PROJECTS/qa/screenshots/hb-r6/`: `hb-r6-01-home.png`, `hb-r6-02-settings-hub.png`, `hb-r6-03-appearance.png`, `hb-r6-04-git-github.png`, `hb-r6-05-mcp-settings.png`, `hb-r6-06-git-tab.png`, `hb-r6-07-chat-mcp-vs-human.png`.

## Cleanup

Throwaway process on :18090 was stopped. `/tmp/qa-hb-r6` (worktree, data, MCP root, jobtest runtime, dummy keys, capture files, one-off password and tokens) was removed. Live :8090 (pid 1198759) and `~/APP_PROJECTS/qa/run/homebase/data` were not modified. Playwright scripts remain under `~/APP_PROJECTS/qa/e2e/` (scratch, not this repo).
