# Home Base — 1.24.6 final review (`fb18f0a`)

- **When:** 2026-11-14, 5:57–6:12 PM America/New_York (EST).
- **Build tested:** `development_grok` tip **fb18f0a** (`fb18f0a7b8a7855a5921f2adeb4c531f2eb06985`, `feat(voice): default server STT model to gpt-4o-mini-transcribe (half Whisper's cost); HOMEBASE_TRANSCRIBE_MODEL overrides`), dated 2026-11-14 5:57:06 PM EST. After `git fetch origin development_grok`, local HEAD already equaled `origin/development_grok` (fast-forward not needed; no reset, no force). `VERSION` is **1.24.6**.
- **Ancestry:** `git merge-base --is-ancestor` confirms **fb18f0a contains c1b3109**, and also 72e6e1d, 93f9848, and 470cda9.
- **Diff `72e6e1d..fb18f0a`:** two files only, two lines changed: `server/src/speech_transcribe.ts` (model form field) and `docs/VOICE-IOS.md` (docs sentence). **No unit tests were added** in this commit (see HB-1246-02).
- **How:** Same rules as the 1.22.5 / 1.24.x voice passes. Isolated git worktree `/tmp/qa-hb-1246/src` at fb18f0a; Next export written only there. Isolated Bun on **:8190 / :8443** (no transcribe keys) and **:8191 / :8444** (dummy `HOMEBASE_TRANSCRIBE_API_KEY` only). Local CA generated only under `/tmp/qa-hb-1246/data*/.runtime/tls/` — not the system trust store, not live Home Base `.runtime`. Playwright from `~/APP_PROJECTS/qa/e2e` (Chromium 1254, iPhone/iPad device emulation + desktop). Transcribe POSTs were **stubbed**; a separate Bun fetch stub checked the model field. **No real Whisper / gpt-4o-mini-transcribe calls, no real API keys, no app-code edits, no deploy, no restart.** Live Home Base **:8090** (pid **1198759**, still `box`, lstart Fri Nov 13 11:47:23 PM EST) was not called, rebuilt, or touched. Live `web/dist/index.html` mtime stayed **2026-11-11 2:08:16 AM EST**.

## Interim notes (470cda9 / 93f9848) — not deploy verdicts

These earlier tips were mid-review when the target moved. Neither was scored for deploy.

- **1.24.4 `470cda9`** (`fix(voice): make Talk/Doodle speech work on iPhone/iPad`): first iOS Talk path (MediaRecorder fallback + SpeechRecognition). Isolated :8190 was up; unit tests at that tip were server **167/107/0** and web **58/58**; tsc clean; `c1b3109` was already an ancestor. Playwright for that tip was interrupted (Chromium revision mismatch, then Agent accessible-name / no-project setup issues). No 1.24.4 review was pushed.
- **1.24.5 `93f9848`** (`fix(voice): server STT primary on iOS + VPN HTTPS local CA`): introduced shared `useVoiceSession`, VPN HTTPS :8443 + local CA, silent-switch hint, and server STT as the iOS primary path **without** a no-key Safari fallback (that arrived in 72e6e1d). Isolated HTTPS and CA generation were proven on this host; model at 93f9848 was still hardcoded `whisper-1`. Tagged interim only.

## Verdict

**Fail.** Not ready for Dan’s self-deploy. **HB-1246-01 (High):** tapping Talk a second time to finish an iOS/server-STT recording increments `listenGen` before `MediaRecorder.stop()`, so `onBlob` is dropped and `/api/speech/transcribe` never runs. The documented “tap Talk again to send the clip” path is broken. Keep **1.20.3** as the rollback until this is fixed and retested. Other voice-matrix, HTTPS, hook, docs, and 1.22.5 regression checks passed as noted below.

## Findings

### HB-1246-01 — Second Talk tap discards the server-STT clip · High

`web/src/lib/useVoiceSession.ts` `stopListening()` does `listenGen.current += 1` and then `handle.stop()`. `beginRecord`’s `onBlob` returns immediately when `gen !== listenGen.current`. `toggleTalk()` (voice mode on → off) always goes through `stopListening()`, which is exactly the iOS “tap Talk again to finish the clip” action in `docs/VOICE-IOS.md`.

Chromium e2e on isolated HTTPS :8444 (dummy key, transcribe route stubbed, `MediaRecorder` stub emitting a non-empty blob): first Talk showed **Recording… tap Talk again to send audio for transcription.** After the second tap, **0** requests hit `/api/speech/transcribe`, and the composer never received the stub text. The same result in all three configured-server cells (`mx-ios-cfg-rec`, `mx-ios-cfg-norec`, `mx-desk-cfg-norec`). Status was cached (`/api/speech/status` fetched once). This is a logic bug, not a missing mic.

### HB-1246-02 — Model default has no test; labels still say Whisper · Low

`fb18f0a` defaults the OpenAI transcriptions `model` field to `gpt-4o-mini-transcribe` and honors `HOMEBASE_TRANSCRIBE_MODEL` (empty/whitespace falls back to the default). A stubbed `fetch` (no real network) confirmed: default `gpt-4o-mini-transcribe`, `HOMEBASE_TRANSCRIBE_MODEL=whisper-1` sends `whisper-1`, endpoint `https://api.openai.com/v1/audio/transcriptions`. The commit itself adds **no unit test** for that override. `/api/speech/status` still reports `provider: "openai-whisper"` when configured; `.env.example` still titles the block “Server speech transcription (Whisper)” and does not mention `HOMEBASE_TRANSCRIBE_MODEL`; the VOICE-IOS device table still says “MediaRecorder → Whisper”.

## Results

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | Selection matrix: iOS/WebKit × desktop/Chromium × STT configured/not × SpeechRecognition present/absent | **Fail** (server-commit cell) | Unit tests in `speech.test.ts` cover all 8 `selectVoiceListenPath` cells and passed. Chromium e2e: **iOS + key + rec/no rec → server** (Recording… shown, SpeechRecognition unused) but the commit tap does not POST (HB-1246-01). **iOS no key + rec → browser** (`rec.starts=2`, iOS-safe restart after `onend`, no STT post). **iOS/desktop no key + no rec → keyboard hint.** **Desktop + key + rec → browser fast path.** **Desktop + key + no rec → server** (same HB-1246-01 commit miss). `/api/speech/status` is cached (one fetch per Talk session). |
| 2 | Voice check shows the active path | **Pass** | Settings → Voice check: iOS + configured = **Mic path Server STT (primary)** / Server transcription Configured; iOS no key + rec = **Browser SpeechRecognition** / Not configured; iOS no key + no rec = **Keyboard mic / type**; HTTP VPN = Secure page **No — voice blocked**, HTTPS hint `https://10.6.0.5:8443/`, Download CA. Screens: `docs/qa/screens/home-base-1.24.6-fb18f0a-voice-check-*.png`. |
| 3 | Clear failure when neither path is available | **Pass** | iOS and desktop, no key, SpeechRecognition removed: Talk shows the not-configured / keyboard-mic message (`HOMEBASE_TRANSCRIBE_API_KEY`, “Browser speech recognition is unavailable or failed”, type still works). Mic-denied (not-allowed): “Microphone permission denied”; composer still accepted typed text. |
| 4 | Shared `useVoiceSession` hook; no duplicate Talk session | **Pass** | Only `ChatPanel.tsx` imports `useVoiceSession`. `HomeDoodleTab` embeds that same `ChatPanel` (`kid`). `startSpeechDictation` / `startMediaRecorderCapture` live in `speech.ts` and are called only from the hook. Tight grep of `web/src` found no Halloween/pagan/samhain/occult copy. |
| 5 | HTTPS :8443 local CA (temp dir only); HTTP still serves MCP | **Pass** | Isolated boot: “local TLS CA created under `/tmp/qa-hb-1246/data/.runtime/tls`”, HTTPS on 0.0.0.0:8443 / :8444, HTTP on :8190 / :8191, v1.24.6. `ca.key` and `server.key` mode **0600**; `ca.crt` downloadable over HTTP (`Content-Type: application/x-x509-ca-cert`). SANs include `localhost`, `127.0.0.1`, `172.30.0.2`, `10.6.0.5`, `10.6.0.1`, `homebase.local`. Live checkout `.runtime/tls` stayed absent. `git ls-files` has no `.crt`/`.key`/`.pem`. `POST /mcp` on HTTP returned **401** `mcp_token_invalid` (listener up, not TLS-only). Playwright `https://10.6.0.5:8443/` is a secure context; Talk proceeds (unlock + silent-switch hint). Plain `http://10.6.0.5:8190/` shows “Secure connection required” and the `https://10.6.0.5:8443` hint. System trust store was not modified. |
| 6 | Silent-switch hint | **Pass** | Shown in Talk UI when iOS UA + Talk on, and on Voice check (“Silent switch mutes spoken replies — flip to Ring and raise volume.”). Unit tests for `silentSwitchHintMessages` passed. Real hardware mute was not tried (needs Dan’s iPhone). |
| 7 | `docs/VOICE-IOS.md` accuracy | **Pass** with HB-1246-02 nits | Checklist, path table (server → webkitSpeechRecognition → keyboard), CA trust steps, HTTPS :8443, cached `/api/speech/status`, optional key, silent switch, and default `gpt-4o-mini-transcribe` / `HOMEBASE_TRANSCRIBE_MODEL=whisper-1` match the code, except the leftover “Whisper” wording noted in HB-1246-02 and the Talk-again flow that HB-1246-01 breaks. |
| 8 | Typing with voice off (Chat + Doodle); kids copy | **Pass** | Agent composer accepted “plain typed message with voice off”; Doodle “Draw something fun…” + typed “hello buddy from typing”; no unexpected console errors; no pagan/Halloween copy. Screens: `…-agent-typing-voice-off.png`, `…-doodle-https-talk.png`. |
| 9 | 1.22.5 regression + ancestor | **Pass** | Fake-agent selfqa: openFindings repeat **BLOCKS exit 2**; missing `openFindings` fail-closed **BLOCKED exit 2**. SW-SQ-10: `bash ./ship.sh`, absolute `ship.sh`, `pnpm exec firebase` / `eas` refused under `SELFQA_RUN=1` (StockWinter `ship.sh` **copy** only). HB-OWN-02 root probe: child **uid 1000 (`box`)**, parent 0, `bun.exe`; after repair `find .git ! -user box` empty; owner commit without sudo exit 0. This box has no `daniel` user. `fb18f0a` contains `c1b3109`. |
| 10 | Transcribe model (for pricing) | **Pass** (behavior); see HB-1246-02 | Default model **`gpt-4o-mini-transcribe`**. Override **`HOMEBASE_TRANSCRIBE_MODEL=whisper-1`**. Endpoint **`https://api.openai.com/v1/audio/transcriptions`**. Status `provider` is still `"openai-whisper"` when a key is set. Env key: `HOMEBASE_TRANSCRIBE_API_KEY` (fallback `OPENAI_API_KEY`). No real cloud calls were made. |
| 11 | tsc + unit tests | **Pass** | `server` tsc 0 errors; `web` tsc 0 errors. Server `bun test test/unit`: **170 pass / 107 skip / 0 fail** (277 tests, 45 files). Web `bun test`: **71 pass / 0 fail** (8 files). `web/tsconfig.tsbuildinfo` was restored and not committed. |

## Not tested, and why

- **Real iPhone / iPad Safari** — this host could not launch Playwright WebKit (`libevent-2.1.so.7`, `libgstgl-1.0.so.0`, `libgstcodecparsers-1.0.so.0`, `libavif.so.16`, `libmanette-0.2.so.0`, `libenchant-2.so.2`; apt mirrors returned 500). iOS behavior was Chromium + iPhone/iPad UA. Dan still needs to: trust **Home Base Local CA** on the phone, open `https://10.6.0.5:8443/`, allow Safari mic, confirm the silent switch actually mutes TTS, and retest Talk-again after HB-1246-01 is fixed (real `audio/mp4` MediaRecorder).
- **A successful cloud transcription** — dummy key / stubbed `fetch` and Playwright route only. Do not use a real key for QA.
- **A real Cursor Agent job, `./build.sh --setup` on the live checkout, or installing the CA in a system trust store** — out of scope; would mutate live config.
- **Live :8090 / live `web/dist`** — stale (built 2026-11-11); left running and untouched.

## Screenshots

Under `docs/qa/screens/`:

- `home-base-1.24.6-fb18f0a-insecure-vpn-talk.png`
- `home-base-1.24.6-fb18f0a-https-vpn-talk.png`
- `home-base-1.24.6-fb18f0a-voice-check-vc-ios-configured.png`
- `home-base-1.24.6-fb18f0a-voice-check-vc-ios-nokey-rec.png`
- `home-base-1.24.6-fb18f0a-voice-check-vc-ios-nokey-norec.png`
- `home-base-1.24.6-fb18f0a-voice-check-vc-http-vpn.png`
- `home-base-1.24.6-fb18f0a-mic-denied.png`
- `home-base-1.24.6-fb18f0a-agent-typing-voice-off.png`
- `home-base-1.24.6-fb18f0a-doodle-https-talk.png`

## Cleanup

Isolated :8190/:8191/:8443/:8444 and `/tmp/qa-hb-1246` (plus leftover 1.24.4/1.24.5 worktrees) will be stopped/removed after this commit. Live :8090 (pid 1198759) was not modified. `core.hooksPath` on the Home Base checkout is unset. `presence-app/` remains untracked and was not added.
