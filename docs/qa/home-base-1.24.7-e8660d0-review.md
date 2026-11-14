# Home Base — 1.24.7 final review (`e8660d0`)

- **When:** 2026-11-14, 6:17–6:25 PM America/New_York (EST).
- **Build tested:** `development_grok` tip **e8660d0** (`e8660d053d5de414e73783007ba2f9d12e962e33`, `fix(voice): preserve server-STT clip on Talk stop (HB-1246-01); model status + tests (HB-1246-02)`), dated 2026-11-14 6:17:24 PM EST. Local HEAD already equaled `origin/development_grok` (no fetch lag, no reset, no force). `VERSION` is **1.24.7**.
- **Ancestry:** `git merge-base --is-ancestor` confirms **e8660d0 contains c1b3109 and fb18f0a**, and also 72e6e1d, 93f9848, and 470cda9.
- **Diff `fb18f0a..e8660d0` (product):** `.env.example`, `VERSION`, `docs/VOICE-IOS.md`, `server/src/app.ts`, `server/src/speech_transcribe.ts`, `server/test/unit/speech_transcribe.test.ts`, `web/src/lib/api.ts`, `web/src/lib/speech.ts`, new `web/src/lib/speech_server_stt.test.ts`, `web/src/lib/useVoiceSession.ts`.
- **How:** Same rules as the 1.22.5 / 1.24.6 passes. Isolated git worktree `/tmp/qa-hb-1247/src` at e8660d0; Next export written only there (worktree `web/dist` mtime 2026-11-14 6:19:48 PM EST). Isolated Bun on **:8190 / :8443** (no transcribe keys) and **:8191 / :8444** (dummy `HOMEBASE_TRANSCRIBE_API_KEY` only). Local CA generated only under `/tmp/qa-hb-1247/data*/.runtime/tls/` — not the system trust store, not live Home Base `.runtime`. Playwright from `~/APP_PROJECTS/qa/e2e` (Chromium 1254, iPhone/iPad device emulation). Transcribe POSTs were **stubbed**. **No real Whisper / gpt-4o-mini-transcribe calls, no real API keys, no app-code edits, no deploy, no restart.** Live Home Base **:8090** (pid **1198759**, still `box`, lstart Fri Nov 13 11:47:23 PM EST) was not called, rebuilt, or touched. Live `web/dist/index.html` mtime stayed **2026-11-11 2:08:16 AM EST**.

This retest closes the two findings from the 1.24.6 final review (`fb18f0a`, docs commit `ffc4c75579c6d7b1c80b82f9d2b41ad742dc7cc8`).

## Verdict

**Pass.** Ready for Dan’s single self-deploy of **1.24.7 / e8660d0**. Keep **1.20.3** as the rollback. HB-1246-01 and HB-1246-02 are fixed. No new product findings. Real iPhone Safari mic, CA trust, silent-switch hardware, and a live cloud transcribe call remain untested on this host (WebKit host libs missing; apt proxy 500).

## Findings

None.

## HB-1246-01 retest — second Talk tap commits the clip · Pass

`useVoiceSession` now splits stop vs cancel. `toggleTalk` off calls `stopListening()` → `createServerSttSession.stop()`, which finishes the recorder and POSTs `/api/speech/transcribe` **without** bumping `discardThrough` / `listenGen`. `cancelListening()` and ChatPanel unmount still `cancel()`, which sets `discardThrough` so no fetch is sent. A new `start()` only cancels an *active* recorder, not a `stop()`’d in-flight upload.

Chromium e2e on isolated HTTPS :8444 (dummy key, transcribe route stubbed, `MediaRecorder` stub emitting a non-empty blob):

- **Chat:** second Talk tap → **exactly one** POST; composer received the stub text. `/api/speech/status` cached (2 fetches in that session, not per-tap).
- **Doodle (kid ChatPanel):** same — exactly one POST and stub text in the overlay composer.
- **No stale-generation drop:** stop, then immediately re-arm Talk; the first upload was kept (`posts=1`).
- **Cancel discards with no request:** unit test “cancel → no POST” passed. E2e: start Recording, leave Agent via **← Chats → ← Back → Home dashboard** (unmounts the held ChatPanel; the setup-only “Home dashboard” control is not visible while a chat is open). **0** `/api/speech/transcribe` POSTs. An earlier e2e miss was a harness selector issue, not a product bug.

Screens: `docs/qa/screens/home-base-1.24.7-e8660d0-chat-stt-commit.png`, `…-doodle-stt-commit.png`.

## HB-1246-02 retest — model tests, status, docs · Pass

`server/test/unit/speech_transcribe.test.ts` covers: status reflects env without exposing the key; default model **`gpt-4o-mini-transcribe`**; whitespace falls back to the default; `HOMEBASE_TRANSCRIBE_MODEL=whisper-1` override; `transcribeAudio` FormData `model` via stubbed `fetch`. All passed as part of the server unit run. Isolated `/api/speech/status`: no-key `{configured:false,provider:null,model:null}`; dummy-key `{configured:true,provider:"openai",model:"gpt-4o-mini-transcribe"}`. `.env.example` and `docs/VOICE-IOS.md` now document `gpt-4o-mini-transcribe` / `HOMEBASE_TRANSCRIBE_MODEL` and status `provider: "openai"` + `model`. Device table says “MediaRecorder → OpenAI transcribe”.

Observation (not a fail): Voice check still only shows “Server transcription: Configured / Not configured”; it does not print provider or model. The status API does.

## Results

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | HB-1246-01 server-STT commit / cancel / no stale drop | **Pass** | Chat + Doodle exactly one POST; cancel 0 POSTs; rapid stop→start keeps first upload. See section above. |
| 2 | HB-1246-02 model tests + status + docs | **Pass** | Unit tests exist and passed; status `openai` + `gpt-4o-mini-transcribe`; `.env.example` / VOICE-IOS wording updated. |
| 3 | No-key Safari SR fallback | **Pass** | iOS UA, no key, stub `webkitSpeechRecognition`: starts 1→2 (restart loop), **no** STT post, status cached once. |
| 4 | Neither-path hint | **Pass** | No key and SpeechRecognition removed: clear keyboard / not-configured hint; type still works. |
| 5 | Voice check shows the active path | **Pass** | iOS + configured = Server STT (primary) / Configured; iOS no key + rec = Browser SpeechRecognition / Not configured; iOS no key + no rec = Keyboard mic / type; HTTP VPN = Secure page **No — voice blocked**, HTTPS hint, Download CA. Screens: `docs/qa/screens/home-base-1.24.7-e8660d0-voice-check-*.png`. |
| 6 | Shared `useVoiceSession`; typing with voice off; kids copy | **Pass** | Only `ChatPanel` imports the hook; Doodle embeds that panel (`kid`). Agent and Doodle composers accepted typed text with Talk off. Tight grep of `web/src` found no Halloween/pagan/samhain/occult copy. |
| 7 | HTTPS :8443 local CA (temp dir only); HTTP still serves MCP | **Pass** | Isolated boot created CA only under `/tmp/qa-hb-1247/data*/.runtime/tls`. `ca.key` and `server.key` mode **0600**. Live checkout `.runtime/tls` stayed absent. `git ls-files` has no `.crt`/`.key`/`.pem`. `POST /mcp` on HTTP returned **401** `mcp_token_invalid` (listener up). `https://10.6.0.5:8443/` / `:8444` is a secure context; plain `http://10.6.0.5:8190/` shows “Secure connection required” and the HTTPS hint. System trust store was not modified. |
| 8 | Silent-switch hint | **Pass** | Shown on iOS UA + Talk / Voice check. Unit tests for `silentSwitchHintMessages` passed. Real hardware mute was not tried (needs Dan’s iPhone). |
| 9 | 1.22.5 regression + ancestry | **Pass** | Fake-agent selfqa: openFindings repeat **BLOCKS exit 2**; missing `openFindings` fail-closed **BLOCKED exit 2**. SW-SQ-10: `bash ./ship.sh`, absolute `ship.sh`, `pnpm exec firebase` / `eas` refused under `SELFQA_RUN=1`. HB-OWN-02 root probe: child **uid 1000 (`box`)**, parent 0, `bun.exe`; `find .git ! -user box` empty; owner commit without sudo exit 0. Residual: `selfqa_create_path_shims` still hits a bad-substitution / restore `mv` miss when PATH is narrowed — functional refusals still passed (same as 1.22.5). `e8660d0` contains `c1b3109` and `fb18f0a`. |
| 10 | tsc + unit tests | **Pass** | `server` tsc 0 errors; `web` tsc 0 errors. Server `bun test test/unit`: **172 pass / 107 skip / 0 fail** (279 tests, 45 files). Web `bun test`: **76 pass / 0 fail** (9 files, including new `speech_server_stt.test.ts`). `web/tsconfig.tsbuildinfo` was restored and not committed. Combined `bun test` still skips `envIsolated()` files when config is already imported — not a product defect. |

## Not tested, and why

- **Real iPhone / iPad Safari** — this host could not launch Playwright WebKit (`libevent-2.1.so.7`, `libgstgl-1.0.so.0`, `libgstcodecparsers-1.0.so.0`, `libavif.so.16`, `libmanette-0.2.so.0`, `libenchant-2.so.2`; apt mirrors returned 500). iOS behavior was Chromium + iPhone/iPad UA. Dan still needs to: trust **Home Base Local CA** on the phone, open `https://10.6.0.5:8443/`, allow Safari mic, confirm the silent switch actually mutes TTS, and confirm Talk-again with real `audio/mp4` MediaRecorder.
- **A successful cloud transcription** — dummy key / stubbed `fetch` and Playwright route only. Do not use a real key for QA.
- **A real Cursor Agent job, `./build.sh --setup` on the live checkout, or installing the CA in a system trust store** — out of scope; would mutate live config.
- **Live :8090 / live `web/dist`** — stale (built 2026-11-11); left running and untouched.

## Screenshots

Under `docs/qa/screens/`:

- `home-base-1.24.7-e8660d0-chat-stt-commit.png`
- `home-base-1.24.7-e8660d0-doodle-stt-commit.png`
- `home-base-1.24.7-e8660d0-insecure-vpn-talk.png`
- `home-base-1.24.7-e8660d0-voice-check-vc-ios-configured.png`
- `home-base-1.24.7-e8660d0-voice-check-vc-ios-nokey-rec.png`
- `home-base-1.24.7-e8660d0-voice-check-vc-ios-nokey-norec.png`
- `home-base-1.24.7-e8660d0-voice-check-vc-http-vpn.png`
- `home-base-1.24.7-e8660d0-agent-typing-voice-off.png`

## Cleanup

Isolated :8190/:8191/:8443/:8444 and `/tmp/qa-hb-1247` will be stopped/removed after this commit. Live :8090 (pid 1198759) was not modified. `core.hooksPath` on the Home Base checkout is unset. `presence-app/` remains untracked and was not added.
