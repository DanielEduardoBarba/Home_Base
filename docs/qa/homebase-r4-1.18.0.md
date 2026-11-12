# Home Base — R4 QA, version 1.18.0 (workspace creation, Git, GitHub hookup, homebase_ping)

- **When:** 2026-11-12, 6:20–6:30 PM America/New_York (EST).
- **Build tested:** `development_grok` tip **c725d66** (`feat: GitHub workspace hookup, homebase_ping, and v1.18.0`). Ancestors confirmed: **773086b** (safe Git GUI+MCP), **660bda6** (workspace creation). `VERSION` file **1.18.0**.
- **How:** Detached git worktree of `c725d66` at `/tmp/qa-hb-r4/src`. Throwaway Bun instance on **127.0.0.1:18090** with its own data dir (`/tmp/qa-hb-r4/data`), throwaway `HOMEBASE_MCP_WORKSPACES_ROOT=/tmp/qa-hb-r4/MCP_WORKSPACES`, and a one-off password/MCP token (not committed). Headless Playwright (Chrome) from `~/APP_PROJECTS/qa/e2e/hb-r4-gui.mjs`; screenshots in `~/APP_PROJECTS/qa/screenshots/hb-r4/`. The 1.18.0 web UI was built **into the worktree** `web/dist` only. The live box instance on **:8090** (pid **1198759**, data `~/APP_PROJECTS/qa/run/homebase/data`, its `web/dist` dated 2026-11-11) was not restarted, rebuilt, or pointed at this work.
- **Not used:** Clock Trakr, Ekklesias, :4210, emulators, App Store Connect, WireGuard, or any Cursor API key (this box has none). No force-push. `main` was not merged into `development_grok`. No GitHub repo was created (see below). Tokens and passwords were not written into the repo or QA doc.

## Verdict

Workspace creation, the Git panel + MCP git tools (against a local `file://` remote only), GitHub input validation / permission toggles / sign-in messaging, and `homebase_ping` all behaved as designed on the isolated 1.18.0 instance. Existing registered projects were left intact. MCP workspace-create, git-write, and GitHub-repo switches are **off by default** and enforced server-side. Destructive git/GitHub operations are not exposed as tools and are rejected by allow-lists.

Two **Low** findings were filed (ping uptime baseline; Zod 500 on unknown git actions). **HB-R3-01** (invalid model `composer-1` reported `done`) could not be retested with a real Cursor key and remains **open**. Creating a private `qa-homebase-test` repo was **not completed**: `gh` is signed in as `DanielEduardoBarba`, but the token on this box lacks the `createRepository` scope. Clone of a tiny public repo into the MCP workspaces root did pass.

**Ready for Dan to build** 1.18.0, with the caveats in Limits: confirm `create_repo` once on a `gh` login that can create a private repo, and re-check HB-R3-01 on a laptop with a Cursor API key. Build **server + web together** — the source is 1.18.0, but a previously built `web/dist` will not show the new wizard, Git tab, or MCP switches.

## Unit tests

Workspace / git / GitHub / ping files **skip themselves** in a full `bun test` unless `PROJECTS_PATH` / `RUNTIME_DIR` stay inside that file’s temp root (`describe.skip` via `envIsolated()`). Run each file alone.

| Suite | Result |
|---|---|
| Full `cd server && bun test` | **95 pass**, **33 skip** (the isolated workspace/git/github/ping cases), **3 fail** |
| The 3 full-suite failures (`removeRegisteredProject` in `project_remove.test.ts`) | **Pre-existing env pollution**, not a 1.18.0 regression. Message: “project_remove test env not applied (module cache polluted). Run this file alone.” `bun test test/unit/project_remove.test.ts` → **3 pass / 0 fail** |
| `bun test test/unit/workspace.test.ts` | **10 pass / 0 fail** (toggle default off, happy path, invalid names, absolute path, symlink escape, human create, system parent) |
| `bun test test/unit/git.test.ts` | **11 pass / 0 fail** (allow-list, destructive argv blocked, branch names, path confinement, dirty-tree refusal, job lock, write-gate default off, create branch) |
| `bun test test/unit/github.test.ts` | **10 pass / 0 fail** (parse/URLs, never-force push argv, MCP toggles, non-empty folder, different origin, clone stays under MCP root) |
| `bun test test/unit/ping.test.ts` | **2 pass / 0 fail** (version/uptime without starting chats/jobs; lists jobs without mutating the queue) |
| `server` `tsc --noEmit` | **3 pre-existing type errors**, not a 1.18.0 regression: `usage_stats.ts:340` and `:341` (`DayBucket` vs `Record<string, number>`), plus `presence_window.ts:6` (`Subprocess` is not exported from `node:child_process`) |

## Per-feature results

| Area | Result | Notes |
|---|---|---|
| (1) Workspace creation | **Pass** | GUI: New workspace → Create folder and Existing both created/registered the intended folders (`playwright-created`, `playwright-created2`, `playwright-existing`, plus API `gui-new-folder` / `register-me`). MCP `homebase_create_mcp_workspace` rejected while the switch was off (`MCP workspace creation is disabled in Settings`); after the switch was on, `mcp-ok-workspace` was created only under `/tmp/qa-hb-r4/MCP_WORKSPACES`. Bad names, `..`, absolute paths, slashes, metacharacters, and leading dots rejected. Symlink / existing-link name rejected (`workspace folder already exists`); the outside target was not emptied. `/etc` as a GUI parent rejected (`cannot create workspace under a system directory`). Seed project `existing-qa` stayed registered; its `README.md` was unchanged. |
| (2) Git panel + MCP git tools | **Pass** | All exercised against a throwaway repo with a local **bare `file://` remote only** (nothing pushed to GitHub). GUI HTTP and Git tab buttons: status, branches, log, remotes, fetch, pull, checkout, create_branch, merge (fast-forward), commit, push, stash push/list/pop. Playwright: Fetch showed a green **“Fetch complete”**; panel also has Pull, Push, Stash, Pop, Switch, New branch, Merge, Commit. MCP read tools worked with the write switch off; fetch/pull/checkout/create_branch/merge/commit/push/stash were refused until **Allow MCP git write actions** was turned on, then the same writes succeeded to `file://`. Deliberate merge conflict (`conflict-b` into `main`) returned 400, `Merge … hit conflicts and was aborted`, no `MERGE_HEAD`, no conflict markers, HEAD unchanged, clean porcelain. Destructive HTTP actions (`reset`, `clean`, `rebase`, `force_push`, `delete_branch`) rejected by the Zod allow-list (see HB-R4-02). MCP has no `homebase_git_reset` / `clean` / `rebase` / `force_push` / `delete_branch` tools (`Unknown tool`). |
| (3) GitHub hookup | **Pass**, with create-repo happy path **not completed** | Instance started **without** `GITHUB_TOKEN`: `/api/github/status` and the From GitHub wizard / Git panel “Connect to GitHub” all showed **“Sign in to GitHub on this laptop: gh auth login -h github.com”**. `gh auth login` was not run. After a throwaway restart that inherited the box token (value never logged or written to the repo): status `loggedIn=true` user `DanielEduardoBarba`. GUI `list_repos` returned 10 repos. MCP `list_repos` refused while **Allow MCP GitHub repo access** was off; worked after it was on. `homebase_github_status` works with the toggle off. Invalid refs (traversal, `;rm`, non-github host, `$(whoami)`, `..`) rejected as `Invalid GitHub repo — use owner/repo or a github.com URL` on both GUI and MCP once the toggle was on. `create-repo` requires `confirm: true`. Bad name `evil;rm` on a clean workspace: `invalid GitHub repository name`. Connect on a workspace that already had a `file://` origin refused to replace it. GUI clone of public `octocat/Hello-World` as workspace `qa-r4-hello` landed only under the throwaway MCP root; MCP clone into the same folder then refused (non-empty). A follow-up `create-repo` of private `qa-homebase-test` failed with `GraphQL: Resource not accessible by personal access token (createRepository)` — token scope, not a Home Base crash; **no repo was created** (`gh repo view` still 404). Code review: no MCP/HTTP tools to delete/archive a GitHub repo, change visibility of an existing repo, or force-push; `pushArgvNeverForce` is unit-tested; create defaults to private (`visibility` may be set to `public` by an explicit argument — we did not create a public repo). Tokens/passwords were not found in throwaway workspaces or clone trees. |
| (4) `homebase_ping` | **Pass**, with HB-R4-01 | Five MCP pings in a row: `homebase: "up"`, `version: "1.18.0"`. Counts stayed `{ chatsSample: 0, jobsTotal: 0, jobsActive: 0 }`. `cursor.apiKeyConfigured=false` with `apiKeyError: "Cursor API key not configured in Home Base Settings"`; CLI probe reported agent/CLI not found — not a false “alive.” Job list after the pings was empty. Starting `homebase_cursor_job` with model `composer-1` (no key) returned `{ ok: false, error: "Cursor API key not set on Home Base — human must add it in Settings" }` and did not increment job/chat counts. |
| HB-R3-01 (invalid model `composer-1` reports `done`) | **Not retested with a key; still open** | On this box the job path still fails in `configured()` before a chat or job record is created, so the “done in ~2s with no reply” behavior could not be reproduced or cleared. Carry **HB-R3-01 (Medium)** until a laptop with a Cursor API key tries `composer-1` on 1.18.0. |
| Live :8090 left alone | **Pass** | pid **1198759** unchanged from before this round; `/api/health` stayed `ok`, `port=8090`, `version=1.18.0` (VERSION file on disk), `cursorConfigured=false`. |

## Bugs

### HB-R4-01 — `homebase_ping` `uptimeSec` starts at first ping, not process boot (Low)

- **Steps:** Start Home Base; wait a few minutes; call `homebase_ping` for the first time; call it again a few seconds later.
- **Expected:** `uptimeSec` is seconds since the Home Base process started.
- **Actual:** First call on a process that had been up ~2 minutes 50 seconds returned `uptimeSec: 0`. A later pair of calls 5 seconds apart went 25 → 30 (the counter increments, but the baseline is the first dynamic `import("./ping")`, not boot). `pingStartedAtMs()` / `STARTED_AT_MS` live at module load; `homebase_tools.ts` imports `./ping` only inside the tool handler.
- **Severity:** Low (diagnostic only; does not start chats/jobs).
- **Screenshots:** n/a (API).

### HB-R4-02 — Unknown git actions return HTTP 500 instead of 400 (Low)

- **Steps:** `POST /api/projects/:projectId/git` with `{ "action": "reset" }` (also `clean`, `rebase`, `force_push`, `delete_branch`).
- **Expected:** 400, a short “unknown / not allowed action” message. The command must not run (it does not).
- **Actual:** HTTP **500** with a raw Zod `invalid_enum_value` payload listing the allowed actions. The allow-list still blocks the action; `jsonError` maps non-`HttpError` parse failures to 500.
- **Severity:** Low (API hygiene; no destructive command ran).
- **Screenshots:** n/a (API).

## What was not tested, and why

- **Real Cursor chat / HB-R3-01 with a live model** — this box has no Cursor API key and none was invented. Invalid-model handling after kickoff remains unobserved on 1.18.0.
- **`create_repo` happy path** (private `qa-homebase-test`, then `gh repo delete`) — `gh` was already authenticated as `DanielEduardoBarba`, but the token cannot call `createRepository`. Home Base surfaced that GraphQL error clearly and did not leave a repo behind. Needs Dan (or a token with repo-create) to confirm create + default-private + non-force push once.
- **Force-push, `reset --hard`, `clean`, rebase, branch/tag delete, history rewrite** as successful operations — they are not offered by the GUI/MCP API; blocked in unit tests and by argv checks. They were not “run and cancelled”; they were refused or absent.
- **Changing visibility of an existing GitHub repo, delete, or archive via Home Base** — no such tools exist (catalog + calls). Not tested as live `gh` mutations.
- **The live :8090 GUI** — on purpose. That process still serves a `web/dist` built 2026-11-11, which does **not** contain the 1.18.0 “From GitHub” wizard, Git tab, or the three MCP allow switches. 1.18.0 UI behavior was verified only on the throwaway instance after a worktree-only web build.

## Screenshots (throwaway :18090, not in this commit)

Under `~/APP_PROJECTS/qa/screenshots/hb-r4/`:

- `hb-r4-01-home.png` — control plane, v1.18.0
- `hb-r4-02-wizard-create-folder.png` / `03` / `04` / `05` — New workspace, Create folder, confirm, result
- `hb-r4-06-wizard-existing.png` / `07` — register existing folder
- `hb-r4-08-wizard-github-signin.png` — From GitHub, clear `gh auth login -h github.com` hint
- `hb-r4-09-settings-hub.png` / `10-settings-mcp-switches-off.png` — MCP Server; workspace create, git write, and GitHub repo access toggles visually off (“Off by default”)
- `hb-r4-11-git-panel.png` / `12-git-fetch.png` — Git tab on the throwaway repo (`origin` is `file:///tmp/qa-hb-r4/git-remote.git`); Fetch complete; GitHub connect shows the same sign-in hint

## Cleanup

The throwaway process on :18090 was stopped. `/tmp/qa-hb-r4` (worktree, data, MCP workspaces, one-off password and MCP token files, local git remotes, cloned Hello-World) was removed. Live :8090 (pid 1198759) and `~/APP_PROJECTS/qa/run/homebase/data` were not modified. No `qa-homebase-test` repo was left on GitHub. Playwright scripts remain under `~/APP_PROJECTS/qa/e2e/` (scratch, not this repo).
