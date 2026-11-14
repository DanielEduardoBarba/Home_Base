# Voice on iPhone & iPad (Home Base + Doodle)

Talk mode picks a mic path from `/api/speech/status` + browser capabilities:

1. **Server STT** when `HOMEBASE_TRANSCRIBE_API_KEY` / `OPENAI_API_KEY` is set (`MediaRecorder` → `POST /api/speech/transcribe`) — preferred on iOS/WebKit.
2. Else **browser `webkitSpeechRecognition`** (iOS-safe: `continuous=false` + restart loop; mic pauses while TTS speaks).
3. Else **keyboard mic / type** with a clear “not configured” message.

Desktop Chrome/Edge still uses on-device SpeechRecognition as the fast path. Spoken replies use browser **speechSynthesis**. Text chat always works even when voice does not.

## Quick checklist for Dan

1. **Use HTTPS on the VPN** — open `https://10.6.0.x:8443/` (or the URL from Settings / Voice check), not plain `http://`. iOS blocks mic outside a [secure context](https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts). Cloudflare Tunnel HTTPS also works.
2. **Trust the local CA once** (see below) so Safari accepts the self-signed VPN cert.
3. **Optional: set `HOMEBASE_TRANSCRIBE_API_KEY`** (or `OPENAI_API_KEY`) on the Home Base host — never commit keys. Without it, iPhone/iPad falls back to Safari’s built-in speech recognition; if that fails too, Talk shows a clear “not configured” message and you can use the keyboard mic / type.
4. Tap **Talk** once (user gesture) so iOS unlocks speech synthesis for later AI replies.
5. **Ring/Silent switch** — if replies are silent, flip the side switch to Ring and raise volume (speechSynthesis respects the mute switch).

In-app: **Settings → Voice check** (and **Settings → Doodle → Devices**) shows the **active mic path**, secure context, MediaRecorder, server transcription, HTTPS URLs, and the last error.

Implementation: `web/src/lib/speech.ts` + shared `web/src/lib/useVoiceSession.ts` (ChatPanel / every Doodle chat bot).

## Trust Home Base Local CA on iPhone / iPad

`./build.sh --setup` (and boot) create a local CA + server cert under `.runtime/tls/` (gitignored). HTTP keeps working for MCP; HTTPS listens on **8443** by default (`HOMEBASE_HTTPS_PORT`).

1. On the phone (WireGuard connected), open the **HTTP** CA download:  
   `http://10.6.0.1:8080/api/tls/ca.crt`  
   (or your VPN host + HTTP port — same path).
2. Install the profile when iOS prompts.
3. **Settings → General → About → Certificate Trust Settings** — enable full trust for **Home Base Local CA**.
4. Open **`https://10.6.0.1:8443/`** (or the `vpnHttps` URL from `/api/tls/status` / Voice check).

Regenerate SANs after IP changes: Settings API `POST /api/tls/ensure` with `{ "force": true }`, or delete `.runtime/tls` and re-run `./build.sh --setup`. Optional: `HOMEBASE_TLS_SANS=…`.

## Why plain HTTP fails

`getUserMedia` requires `window.isSecureContext === true` (HTTPS or `localhost`). Plain `http://` to a LAN or WireGuard IP is **not** secure on iPhone/iPad.

## Listen path (what Home Base does)

| Device | Server key | Recognition API | Mic path |
| --- | --- | --- | --- |
| iPhone / iPad / WebKit | configured | any | **Server STT** (MediaRecorder → OpenAI transcribe) |
| iPhone / iPad / WebKit | missing | present | **Browser** webkitSpeechRecognition (iOS-safe) |
| iPhone / iPad / WebKit | missing | absent | Keyboard mic / type (+ not-configured message) |
| Desktop Chrome / Edge | any | present | Browser SpeechRecognition (fast path) |
| Desktop | configured | absent | Server STT |
| Desktop | missing | absent | Keyboard mic / type |

Also: iOS TTS unlock + sentence chunking; mic pauses while speaking; silent-switch hint when Talk is on.

## Server transcription env

```bash
# Preferred dedicated key
HOMEBASE_TRANSCRIBE_API_KEY=sk-...

# Or fall back to a general OpenAI key
OPENAI_API_KEY=sk-...

# Optional model (default gpt-4o-mini-transcribe)
# HOMEBASE_TRANSCRIBE_MODEL=whisper-1
```

Uses OpenAI `gpt-4o-mini-transcribe` by default (about $0.003/min); set `HOMEBASE_TRANSCRIBE_MODEL=whisper-1` to switch. `/api/speech/status` reports `provider: "openai"`, a `model` field when configured, and `configured: false` when unset. The client caches that flag and picks the mic path above.

## Hands-free flow

1. Tap **Talk** (Agent) or the kid mic (Doodle) — unlocks TTS, starts recording / listening.
2. On iOS with server STT: tap Talk again to finish the clip → server transcribes into the composer.
3. On iOS without a key: Safari recognition listens with `continuous=false` + restart loop.
4. Mic pauses while the reply is spoken (chunked).
5. Listening resumes while Talk stays on.
6. Tap **Talk** again to stop.

## Still stuck?

Open **Voice check** on the device and note:

- Secure page = No → use VPN HTTPS (trust CA) or Cloudflare Tunnel  
- Mic path = Keyboard mic / type → set `HOMEBASE_TRANSCRIBE_API_KEY` or enable Dictation / allow mic  
- Server transcription = Not configured → optional; browser recognition is the fallback  
- Mic permission = denied → Safari site settings  
- Spoken replies silent → Ring switch + volume  
- Synth voices = 0 → tap **Unlock speech**, wait a second, Refresh  

See also: Settings → WireGuard; Settings → Cloudflare Tunnel; `.env.example`.
