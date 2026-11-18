# Home Base — 1.24.37 review (`49641a5`)

- **When:** 2026-11-17, 6:55–7:09 PM America/New_York (EST).
- **Build tested:** `development_grok` tip **49641a5** (`49641a541881d0c7aad1e5372109cbcd0665e5ed`, `Merge development (Dan's Chrome session, deploy-overwrite fix, security updates) into development_grok`), dated 2026-11-17 6:51:59 PM EST. After `git fetch origin development_grok`, local HEAD already equaled `origin/development_grok` (no reset, no force). `VERSION` is **1.24.37**.
- **Ancestry:** `git merge-base --is-ancestor` confirms **49641a5 contains e8660d0, fb18f0a, and c1b3109**. Merge parents: `9c485bb` (usage/contingency line) and `d6fce9e` (Security updates). Dan’s three commits: `0fe94f1` (deploy-overwrite, 1.24.22), `5780803` (Chrome session + inline chat, 1.24.36), `d6fce9e` (security updates, 1.24.37). Also on the tip: `0f8093d` / `3a29264` / `7c11e1b` (usage), `5ec0e76` / `9c485bb` (contingency).
- **How:** Same isolation rules as the 1.24.7 pass. Isolated worktree `/tmp/qa-hb-49641a5/src` at 49641a5; Next export written only there (worktree `web/dist` 2026-11-17 6:58:31 PM EST). Isolated Bun on **:8190 / :8543** (no transcribe keys) and **:8191 / :8544** (dummy `HOMEBASE_TRANSCRIBE_API_KEY` only), `HOMEBASE_HOST=0.0.0.0`, fake `HOME`, no `DISPLAY`, no Cursor token path. Local CA only under `/tmp/qa-hb-49641a5/data*/.runtime/tls/`. Playwright Chromium 1254 (desktop + iPhone UA). Transcribe POSTs stubbed; usage numbers also rendered from a fixture (no live Cursor Spending calls). Isolated Chrome live test used Xvfb (`HB_BROWSER_LIVE=1`) against a throwaway runtime. **No real Whisper / gpt-4o-mini-transcribe / Cursor API / paid calls, no real keys, no app-code edits, no deploy, no restart.**

## Live read-only checks (no sessions, writes, deploys, or restarts)

- Box **:8090** (pid **1198759**, still `box`, lstart Mon Nov 16 10:00:02 PM EST): `GET /api/version` and `/api/health` report **1.24.37**; page 200. `/api/speech/status` returned `Not found`. Live `web/dist/index.html` mtime stayed **2026-11-11 2:08:16 AM EST**. The process predates `5780803` (Nov 16 11:16:41 PM) and `d6fce9e` (Nov 17 6:46:37 PM); the VERSION file was pulled later, so the **running box code may be older than 49641a5**. Left untouched.
- **https://10.6.0.1:8443/**: `GET /api/version` **1.24.37**, health `ok` + `cursorConfigured: true`, page 200. `/api/speech/status` requires auth (`missing_token`). `http://10.6.0.1:8090/` did not connect. No login, usage fetch, or session was started on this host.

## Verdict

**Fail.** Not a clean ship of 49641a5 / 1.24.37. The server unit suite is red on `session_public` “exited sessions stay listed until removed,” and that failure is a real behavior change, not a 2s flake (HB-49641-01, Medium). Server `tsc` still has two pre-existing `WritableSink` errors (HB-49641-02, Low). Chrome session start/stop, usage panel, deploy-overwrite merge, 1.24.7 Chat voice, typing, and 1.22.5 selfqa tests otherwise passed as noted below. Keep **1.20.3** as the rollback. Align the shell-exit contract with the test + Shell tab copy (or update both to the new auto-delete policy) and fix the `WritableSink` types before Dan’s self-deploy of this tip.

## Findings

### HB-49641-01 — Exited interactive shells are dropped after 30ms · Medium

`5780803` changed `server/src/pty.ts`: on exit, `kind === "shell" || kind === "interactive"` rows are `sessions.delete`’d after **30ms**. `run` / `expo` still stay listed for dead+dismiss. The unit test `exited sessions stay listed until removed` still uses `kind: "shell"` and `bash -c "exit 0"`, then waits up to 2s for `row && !row.alive`.

Confirmed at 49641a5, four consecutive isolated runs, each **fail ~2010ms** with `session did not exit in time`. Logs show `pty exit … code=0` within ~1ms of spawn — the process *did* exit. The 2s timeout does **not** hide a hang or a missed exit; by the first 50ms poll the row is already gone, so the test can never observe a dead-but-listed shell. This is the new contract in code, but:

- The test (and its name) still asserts the old “keep until DELETE” contract.
- `ShellTab` still tells operators: “Dead sessions get an X to dismiss.”

If auto-delete of interactive shells is intended, update the test and the Sessions copy. If the SPA still needs dismiss-X for shells, this is a product regression. `run`/`expo` keep behavior was not contradicted.

### HB-49641-02 — Server `tsc` errors on `WritableSink` · Low

`npx tsc --noEmit` in the worktree server: two errors, both parameter contravariance. `WritableSink.write` is typed to accept `string | Uint8Array`, but `cursor_sdk_host.ts` and `ipc_framing.test.ts` pass sinks whose `write` accepts only `Uint8Array`. `writeAll` only ever writes a `Buffer`. Runtime `ipc_framing` unit tests passed. Type-only; pre-existing relative to this QA pass (introduced with the Chrome/IPC work).

### Observation (not scored as a ship finding)

Isolated UI “New shell” against the example **My App** project (`/absolute/path/to/repo`, not a real cwd) logged `Bun.Terminal open failed: ENOENT … posix_spawn '/bin/bash'` and an `unhandledRejection`. The PTY unit test spawns bash fine when cwd exists. Treat as a harness/example-path issue; the unhandled rejection on spawn failure is worth tightening later.

## Results

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | Chrome session start/stop/list | **Pass** (module) | `HB_BROWSER_LIVE=1` `browser_session.test.ts`: 7/7. Opens on **Xvfb** (`mode=xvfb display=:90`), screenshot under `.runtime/browser/shots`, take-control → agent clicks rejected, human click allowed, release, `browserClose` → `running: false`. Isolated profile path `.runtime/browser/profile`. Idle `/api/browser/status` on isolated :8544: `ok`, `running: false`, isolated profile. **BrowserDock live screencast** on the isolated server was not exercised (dock renders only while Chrome is running; there is no HTTP open — MCP `homebase_browser_open` was not invoked). |
| 2 | Inline chat flow | **Pass** | Agent chat shows `← Chats`, composer, Talk (`Talk — dictate + speak replies` / `Turn off talk mode`), Confirm. Typed “plain typed message with voice off.” Email Approve/Deny and ask-secret cards were code-reviewed (`compose_gate` tests passed); no live Gmail send was attempted. |
| 3 | Usage & billing panel | **Pass** | Isolated panel (no Cursor token on this box): “Sign in to Cursor on this laptop.” + Current plan **Spending**, no secret-like strings. `/api/usage` 200 JSON, keys `homebase,cursor,ai,spending,projects,generatedAt`; no access token / `sk-` leak (`len=3234`). Fixture render: **Pro**, Included **12% used**, Other Models **0%**, Grok Bot **3%**. Did not call Cursor Spending on live `10.6.0.1` or hit checkout/on-demand. |
| 4 | Deploy-overwrite fix | **Pass** (code + isolated) | `build.sh merge_projects_json` no longer blindly `cp`s over prod: repo wins on shared ids, prod-only MCP apps are kept. Isolated Python merge: `homebase`+`shared` from repo, `mcp-app` preserved. `workspace.test.ts` in a fresh bun process: **12/12**, including already-registered folder, orphan re-register after projects.json wipe, `reconcileMcpWorkspaces` restores orphans and skips tombstones. **`./build.sh --deploy` was not run.** |
| 5 | Security updates (`d6fce9e`) | **Pass** (diff review) | Adds observe / fill / wait; keeps Isolated Chrome under `.runtime/browser/profile`; MCP **browser** still default Off; `ask_secret` / propose-email guidance still says never put secrets in chat. No new auth-bypass or key-logging found. Residual: Gmail compose still uses `innerHTML` (existing pattern). Docs (`AGENTS.md`, MCP guides) updated. |
| 6 | 1.24.7 voice regression | **Pass** (Chat; Doodle typing) | Isolated HTTPS :8544, dummy key, stub transcribe, iPhone UA. Chat: second control (“Turn off talk mode”) → **exactly one** `/api/speech/transcribe`, stub text in composer. Cancel via `← Chats` → `← Back` → Home: **0** posts. Doodle: kids hint present, typed “hello buddy from typing,” no Halloween/pagan copy (`web/src` tight grep clean). Doodle STT commit was not fully e2e’d (tablet-remember dialog + buddy vs Talk controls); same `useVoiceSession` / `createServerSttSession` already covered by Chat e2e and web unit tests (**80 pass / 0 fail**, including HB-1246-01 cases). Speech status after login: `{configured:true,provider:"openai",model:"gpt-4o-mini-transcribe"}`. HTTP `POST /mcp` on :8190 returned **401** `mcp_token_invalid` (listener up). CA download `/api/tls/ca.crt` 200. |
| 7 | 1.22.5 items | **Pass** | `selfqa_runner.test.ts` + `cursor_sdk_host.test.ts`: **22/22**, including strict `openFindings`, fail-closed missing field, SW-SQ-10 ship/`pnpm exec firebase|eas` refuses, HB-122-01..05, pre-push PATH shim. Live checkout `find .git ! -user box` empty; this box has no `daniel` user. Residual PATH-shim restore issue from 1.22.5 was not re-litigated; unit coverage still green. |
| 8 | tsc + unit tests | **Fail** (see findings) | Web `tsc` 0. Server `tsc` **2** errors (HB-49641-02). Web `bun test`: **80 pass / 0 fail** (10 files). Server `bun test test/unit` before SPA export: 189 pass / 110 skip / **6 fail** (5 were `static_compress` because worktree had no `web/dist`; those **5 passed** after the isolated Next export). Remaining fail: **session_public** (HB-49641-01). Isolated workspace tests 12/12 in a fresh process. Combined `bun test` still skips `envIsolated()` files when config is already imported — not a product defect. `web/tsconfig.tsbuildinfo` was not committed. |

## Not tested, and why

- **Real iPhone / Safari mic, CA trust on a device, silent-switch hardware, real `audio/mp4`, real cloud transcription** — WebKit still cannot launch here (missing host libs; apt proxy 500 earlier). Dummy key / stubbed routes only.
- **BrowserDock live screencast / MCP `homebase_browser_open` on the isolated server, live `propose_email` / `ask_secret`, a real Cursor Agent job, `./build.sh --deploy` or `--setup` on the live checkout** — would start extra Chrome on the box, touch Gmail, or mutate prod.
- **Live Cursor Spending / plan checkout** — no token on this box; live `10.6.0.1` was not queried.
- **Isolated UI PTY start/stop against a real cwd** — example My App path is not a directory; spawn failed (see observation). Exit-list contract was proven in unit tests.
- **Live box :8090 as 49641a5** — VERSION matches, running process and `web/dist` likely do not. Left running.

## Screenshots

Under `docs/qa/screens/`:

- `home-base-49641a5-usage-panel.png`
- `home-base-49641a5-usage-numbers.png`
- `home-base-49641a5-agent-typing-voice-off.png`
- `home-base-49641a5-chat-stt-commit.png`
- `home-base-49641a5-doodle-typing.png`
- `home-base-49641a5-shell-sessions.png`
- `home-base-49641a5-work-tab.png`

## Cleanup

Isolated :8190/:8191/:8543/:8544 and `/tmp/qa-hb-49641a5` will be stopped/removed after this commit. Live :8090 (pid 1198759) and `https://10.6.0.1:8443` were not modified. `core.hooksPath` on the Home Base checkout is unset. `presence-app/` remains untracked and was not added.
