# Home Base — R5 QA, version 1.19.1

- **When:** 2026-11-13, 12:38–12:43 AM America/New_York (EST).
- **Build tested:** `development_grok` tip **d0fba45** (`d0fba458cb015a9fd569632cf2956bc02e3b0ddf`, message `grok update`). `VERSION` **1.19.1** (1.19.0 plus `bbcece8` login-shell git/gh and Git & GitHub Settings).
- **Commits since c725d66:** `8046c10` (R4 QA docs), `d94ffc8` (ping uptime from process start), `268c8de` (safe.directory + blocked git actions return 400), `61f70a9` (MCP chat styling), `691cb0a` (Nerd Font for shell glyphs), `1577095` (Home Access off-by-default; quieter home), `0f5da88` (1.19.0 bump, typecheck/test nits), `bbcece8` (git/gh via operator login-shell, v1.19.1), `d0fba45` (grok update).
- **How:** Detached worktree of `d0fba45` at `/tmp/qa-hb-r5/src`. Throwaway Bun on **127.0.0.1:18090** (fresh data `/tmp/qa-hb-r5/data-fresh`) and **:18091** (settings snapshot for upgrade). Own `HOMEBASE_MCP_WORKSPACES_ROOT`. 1.19.1 web UI built **into the worktree `web/dist` only** (live `web/dist` dated 2026-11-11 was not overwritten). Headless Playwright from `~/APP_PROJECTS/qa/e2e/hb-r5-gui.mjs`; screenshots in `~/APP_PROJECTS/qa/screenshots/hb-r5/`. Live **:8090** (pid **1198759**) was not restarted, rebuilt, or reconfigured.
- **Not used:** Clock Trakr, Ekklesias, :4210, emulators, App Store Connect, WireGuard, Cursor API key (none on this box), `gh auth login`, or creating GitHub repos. No force-push, no `main` merge, no app-code edits. Tokens/passwords were not written into the repo or this doc. Self-deploy was **not** run.

## Verdict

**Pass.** The R4 fixes hold, 1.19.x features behaved as designed on the isolated instance, and 1.18.0 workspace/git/GitHub/ping/MCP-switch regressions were clean. No new HB-R5 bugs were filed. **HB-R3-01** still cannot be cleared without a Cursor API key.

**Ready to deploy**, with the same leftover caveat as R4: confirm invalid-model job handling (`composer-1`) on a laptop that has a Cursor key. Build **server + web together** so a stale `web/dist` does not hide the new Settings, Git tab, MCP chat colors, or Nerd Font.

## Results

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | HB-R4-01 ping uptime from boot | **Pass** | First `homebase_ping` after the process had been up ~42s returned `uptimeSec=41` (not 0). Three seconds later: 41 → 44. Implementation uses `process.uptime()`, not the first `import("./ping")`. Unit: `ping.test.ts` 3/3 including “uptimeSec tracks process.uptime not first-import clock.” |
| 2 | HB-R4-02 blocked git action is 400, not 500 | **Pass** | `POST /api/projects/homebase/git` with `reset`, `rebase`, and `force_push` all returned **HTTP 400** with a Zod enum detail (not 500). Unit: `http_errors.test.ts` 3/3. |
| 3 | HB-R3-01 invalid model is an error, not `done` | **Not tested** (no Cursor key) | `homebase_cursor_job` with `model: composer-1` still fails first with “Cursor API key not set on Home Base — human must add it in Settings” and does not create a job. The invalid-model path after kickoff was not reached. Carry **HB-R3-01 (Medium)** until a keyed laptop retries it on 1.19.1. |
| 4 | Git tools work on the Home Base project | **Pass** | GUI + MCP `git status` / branches / log on the registered `homebase` project (`/tmp/qa-hb-r5/src`, detached `HEAD` at d0fba45) returned 200 / `ok: true`. No “Not a git repository.” Git tab showed `HEAD`, ahead/behind, uncommitted changes (QA `node_modules` symlink only), Fetch, etc. (`hb-r5-08-git-homebase-project.png`). |
| 5 | MCP-sent chat messages look different | **Pass** | Seeded a chat with a web human message and an MCP user prompt (`source: mcp`, `sourceLabel: QA Bot`, model + job id). MCP bubble is violet (`rgba(124, 106, 240, 0.18)`) with meta **“QA Bot · via MCP · 12:39:37.564 AM · composer-2.5 · job r5job01”**. Human bubble is blue (`color(srgb 0.30 0.64 1 / 0.16)`) with a normal timestamp only. (`hb-r5-09-chat-mcp-vs-human.png`, `hb-r5-12-…png`). |
| 6 | Terminal git-status glyph + font | **Pass** | `SymbolsNerdFontMono-Regular.woff2` is served (1,086,300 bytes). `document.fonts.check('13px "Symbols Nerd Font Mono"')` is true; xterm `fontFamily` in source leads with that font. `printf` of U+E0A0 / U+F126 rendered as `  git-glyph-test` in the web shell (`hb-r5-10-shell-git-glyph.png`). This box’s default prompt is a plain bash prompt (no oh-my-zsh git segment); the bundled font still draws the glyphs. |
| 7 | Chat button hides while the keyboard is up | **Pass** (hook exercised in headless) | Mobile 390×844 viewport: FAB is visible on Work (`display: flex`, `hb-r5-11-mobile-work.png`). Headless Chrome does not open a real IME; with the composer focused we set the same `data-hb-keyboard` attribute `viewport.ts` applies when an editable is focused and the visual viewport shrinks. FAB goes to `display: none`; bottom nav also hides. Confirmed both with the dock open (`hb-r5-12-mobile-keyboard-fab-hidden.png`) and with the FAB still in the DOM (`hb-r5-13-mobile-fab-css-hide.png`: flex → none). |
| 8 | Redesign: UX, polish, noise, regressions, console | **Pass** | Home is quieter: Agent / Work / Vision / Settings only; Access is no longer on the landing grid (`hb-r5-01-home.png`, v1.19.1). Settings hub and Git & GitHub / Appearance / MCP panels are clear (`hb-r5-02`, `03`, `04`, `07`). No functional UI regressions vs 1.18.0 features we retested. One expected console `400 Bad Request` came from clicking **Use gh for git pushes** while `gh` was not signed in (same 400 the API returns). Chat shows a red “Cursor key missing…” notice on this box (accurate, not a product defect). |
| 9 | Home Access off by default; upgrade keeps settings, no lockout | **Pass** | Fresh :18090: Access card absent; Settings → Appearance → **Show Home Access** is `aria-checked=false` (`hb-r5-03`). (MCP feature flag `homeAccess` remains on — the UI copy says APIs/MCP stay available either way.) Upgrade :18091 was started on a copy of that install’s data (password + `allowMcpGitWrite: true`, other MCP allows still false). Login succeeded (HTTP 200, no lockout). MCP flags were unchanged. `hb-ui-show-access` is client localStorage; a 1.18.0 browser without that key will also hide the Access card until the new toggle is turned on — intentional off-by-default, not a lockout. |
| 10 | Git & GitHub Settings | **Pass** (in this build) | Present at Settings → Git & GitHub (`bbcece8` / `d0fba45`). Detects `git 2.47.3` at `/usr/bin/git` and `gh 2.103.0` at `/usr/local/bin/gh`. Shows **GitHub · not signed in** and the `gh auth login -h github.com` hint. **Use operator login env** defaults On. **Use gh for git pushes** (`gh auth setup-git`) and **Test connection** ran; setup-git returned a clear “not logged into any GitHub hosts” 400; test returned `gh.loggedIn=false` with no token in the response. Sign-in was **not** completed (`gh auth login` not run). Copy and `openGuidedGitShell` say the token is never stored; a scan of the throwaway worktree / MCP root found no session, MCP, or GitHub secrets. Destructive git remains blocked (400 + no MCP reset/delete tools). git/gh go through `operator_git_env` (login-shell env, argv allow-list, never a shell string); unit `operator_git_env.test.ts` 9/9. Screenshots `hb-r5-04`–`06`. |
| 11 | Regression + unit/tsc | **Pass** | Workspace create still works; MCP workspace-create and GitHub list_repos still refused when their switches are off; ping still does not start jobs; MCP allow switches still in Settings. Isolated `bun test`: workspace 10, git 14, github 10, ping 3, http_errors 3, operator_git_env 9, project_remove 3, cursor_jobs 5, static_compress 6 (after the worktree web build) — all pass. Full `bun test` without `web/dist` was 103 pass / 40 skip / 5 fail (the static tests, missing dist — not a product bug; they pass when dist is present). The old full-suite `removeRegisteredProject` failures now **skip** unless that file is run alone (still 3/3 pass alone). `tsc --noEmit`: **0 errors** (the pre-existing `usage_stats.ts` / `presence_window.ts` type errors are gone). |
| 12 | Self-deploy and rollback | **Pass** (code review only — **not deployed**) | `build.sh --deploy` still parks the current primary as `.bak` (+ `VERSION.bak`), installs the new binary atomically (`.new` then `mv`), copies `web/dist` and presets, probes the new primary, and **restores `.bak`** if self-test fails (sets `.running-backup`). Self-deploy from inside homebased schedules a detached systemd oneshot so stop/restart cannot kill the deploy. No `--deploy` was run on this box. |

## New bugs

None filed (**no HB-R5-xx**).

## Not tested, and why

- **HB-R3-01 with a live Cursor model** — this box has no Cursor API key; none was invented.
- **Creating a GitHub repo / signing in with `gh auth login`** — out of scope for this round. Setup-git and Test connection were exercised only in the unsigned-in path.
- **A real mobile IME** — FAB hide was verified via the app’s `data-hb-keyboard` hook in headless Chrome, not on a physical phone.
- **`--deploy` / rollback on this machine** — review only, as requested.
- **The live :8090 GUI** — on purpose. That process still serves a Nov 11 `web/dist` and was not restarted.

## Screenshots (throwaway :18090, not in this commit)

Under `~/APP_PROJECTS/qa/screenshots/hb-r5/`: `hb-r5-01-home.png` through `hb-r5-13-mobile-fab-css-hide.png` as referenced above.

## Cleanup

Throwaway processes on :18090 and :18091 were stopped. `/tmp/qa-hb-r5` (worktree, data, MCP root, one-off password and tokens, local remotes) was removed. Live :8090 (pid 1198759) and `~/APP_PROJECTS/qa/run/homebase/data` were not modified. Playwright scripts remain under `~/APP_PROJECTS/qa/e2e/` (scratch, not this repo).
