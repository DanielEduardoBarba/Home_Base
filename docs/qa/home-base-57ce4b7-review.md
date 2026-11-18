# Home Base — 1.24.37 retest (`57ce4b7`)

- **When:** 2026-11-17, 7:15–7:17 PM America/New_York (EST).
- **Build tested:** `development_grok` tip **57ce4b7** (`57ce4b75ee24b2ea01d006190d3e12c86df17446`, `fix(sessions/ipc): align shell-exit list contract + WritableSink types (HB-49641-01/02)`), dated 2026-11-17 7:13:48 PM EST. After `git fetch origin development_grok`, local HEAD already equaled `origin/development_grok` (no reset, no force). `VERSION` is still **1.24.37**.
- **Ancestry:** `git merge-base --is-ancestor` confirms **57ce4b7 contains 49641a5** (and e8660d0). Also contains the 49641a5 review commit `3741e7d`.
- **How:** Isolated worktree `/tmp/qa-hb-57ce4b7/src` at 57ce4b7; Next export only there (worktree `web/dist` 2026-11-17 7:16:26 PM EST). Isolated Bun on **:8191 / :8544** (dummy `HOMEBASE_TRANSCRIBE_API_KEY` only), fake `HOME`, no `DISPLAY`, no Cursor token path. CA only under the temp runtime. Playwright Chromium + iPhone UA; transcribe POSTs stubbed. **No real paid API calls, no app-code edits, no deploy, no restart.** Live **:8090** (pid **1198759**, lstart Mon Nov 16 10:00:02 PM EST) and **https://10.6.0.1:8443** were read-only (`/api/version` both report 1.24.37; box `web/dist` mtime stayed 2026-11-11 2:08:16 AM EST). Live TLS dir stayed absent.

This retest closes the two findings from the 49641a5 review. **HB-49641-01 is reclassified as intended behavior** from `5780803` (interactive shells auto-drop on exit; run/Expo stay listed for dead+dismiss).

## Verdict

**Pass.** Ready for Dan’s single self-deploy of **57ce4b7** (1.24.37 + session/IPC follow-up). Keep **1.20.3** as the rollback. No new product findings.

## Findings

None. Prior HB-49641-01 and HB-49641-02 are fixed as specified.

## HB-49641-01 retest — shell-exit contract aligned · Pass

- `session_public.test.ts` no longer expects exited interactive shells to stay listed. New test **`interactive shells are removed after exit`** (`kind: "shell"`, `bash -c "exit 0"`) passed (~52ms).
- New regression tests **`exited run sessions stay listed until removed`** and **`exited expo sessions stay listed until removed`** both passed: dead row remains with the right label until `killSession`, then it disappears.
- `ShellTab` empty-state copy now reads: “Interactive shells close on exit; dead run/Expo sessions get an X to dismiss.” That matches `pty.ts` (30ms auto-delete for `shell`/`interactive` only).

## HB-49641-02 retest — server tsc + partial writes · Pass

- Server `tsc --noEmit` is **clean** (0 errors). Web `tsc` also 0.
- `WritableSink.write` now accepts `Uint8Array` only (no `string`), matching `writeAll`.
- New test **`FramedWriter retries partial numeric writes`** passed (multiple `write` calls, length-prefix + JSON round-trip).

## Results

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | 57ce4b7 contains 49641a5 | **Pass** | `merge-base --is-ancestor` exit 0. |
| 2 | session_public + ShellTab match 5780803 | **Pass** | See HB-49641-01 section. 5/5 session tests passed. |
| 3 | run/Expo stay listed until closed | **Pass** | New unit tests passed. |
| 4 | server tsc + partial-write test | **Pass** | See HB-49641-02. |
| 5 | tsc + both test suites | **Pass** | Server tsc 0, web tsc 0. Server `bun test test/unit`: **198 pass / 110 skip / 0 fail** (308 tests, 51 files; static_compress green after worktree dist). Web `bun test`: **80 pass / 0 fail** (10 files). |
| 6 | Isolated smoke: Chat Talk-once + Doodle typing | **Pass** | HTTPS :8544, dummy key, stub transcribe, iPhone UA. Chat: “Turn off talk mode” after Recording… → **exactly one** POST, stub text in composer. Doodle: dismissed tablet-remember, opened Talk!, typed “hello buddy from typing.” Screens: `docs/qa/screens/home-base-57ce4b7-chat-stt-commit.png`, `…-doodle-typing.png`. |

## Not tested, and why

Same limits as the 49641a5 review: real iPhone/Safari mic, CA trust, silent-switch hardware, real cloud STT, BrowserDock live screencast, `./build.sh --deploy`, live Cursor Spending, a real Agent job. Box :8090 still predates this tip (process started Nov 16); left running.

## Cleanup

Isolated :8191/:8544 and `/tmp/qa-hb-57ce4b7` will be stopped/removed after this commit. Live :8090 (pid 1198759) was not modified. `core.hooksPath` is unset. `presence-app/` remains untracked. A dirty `web/tsconfig.tsbuildinfo` in the live checkout was restored before this work and was not committed.
