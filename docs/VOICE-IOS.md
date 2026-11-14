# Voice on iPhone & iPad (Home Base + Doodle)

Talk mode (mic + spoken replies) uses the browser **SpeechRecognition** and **speechSynthesis** APIs. On iOS Safari / Add-to-Home-Screen these only work under specific conditions. Text chat always works even when voice does not.

## Quick checklist for Dan

1. **Use HTTPS** — open the Cloudflare Tunnel URL (`https://…`), not `http://192.168.…` or a WireGuard VPN IP. iOS blocks mic / recognition outside a [secure context](https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts).
2. **Settings → Siri & Dictation** (wording varies by iOS version) — turn **Dictation** on. Or **Settings → General → Keyboard → Enable Dictation**.
3. **Settings → Safari → Microphone** (or the site’s **Aa** menu → Website Settings) — allow microphone for your Home Base host.
4. **Screen Time → Content & Privacy Restrictions** — if enabled, allow Dictation / Siri & Dictation; otherwise you often get `service-not-allowed`.
5. Tap **Talk** once (user gesture) so iOS unlocks speech synthesis for later AI replies.
6. Optional: **Add to Home Screen** — voice still needs the same HTTPS origin; do not bookmark the LAN http URL.

In-app: **Settings → Voice check** (and **Settings → Doodle → Devices**, which embeds the same panel) shows secure context, recognition API, mic permission, synth voice count, and the last error.

Full field notes: `docs/VOICE-IOS.md` (this file). Implementation: `web/src/lib/speech.ts`.

## Why LAN / VPN http fails

`getUserMedia` and `webkitSpeechRecognition` require `window.isSecureContext === true` (HTTPS or `localhost` / `127.0.0.1`). Plain `http://` to a LAN or WireGuard address is **not** secure on iPhone/iPad, so Talk fails until you use the tunnel.

**Fix:** Settings → **Cloudflare Tunnel** — install/configure, set hostname, start, then open the `publicUrl` (`https://your-host`) on the phone. Setup wizard HTTPS step is the same idea.

## iOS SpeechRecognition quirks (what Home Base does)

| Issue | Mitigation in `speech.ts` |
| --- | --- |
| `continuous=true` unreliable | iOS uses `continuous=false` + controlled restart loop |
| Must start from a tap | Talk / mic button unlocks synth + starts recognition in the gesture |
| Async TTS silent | `unlockSpeechSynthesis()` empty utterance + `resume()` on first tap |
| Long replies cut off | Sentence chunking + English voice pick after `voiceschanged` |
| Synth stuck / paused | Watchdog `cancel` + `resume` |
| Echo / audio session | Stop recognition while speaking; restart on TTS `onend` |
| `service-not-allowed` | Clear message → enable Dictation / fix Screen Time |
| API missing | MediaRecorder (`audio/mp4` on iOS) → optional server Whisper |

## Server transcription fallback (optional)

When on-device recognition is missing or blocked, Talk can **record** a short clip and POST it to:

`POST /api/speech/transcribe` (session or Doodle cookie)

Set **one** of these on the Home Base host (never commit secrets):

```bash
# Preferred dedicated key
HOMEBASE_TRANSCRIBE_API_KEY=sk-...

# Or fall back to a general OpenAI key
OPENAI_API_KEY=sk-...
```

Uses OpenAI Whisper (`whisper-1`). If unset, `/api/speech/status` reports `configured: false` and the UI hints to use the **keyboard mic** (iOS dictation) or type. No key → no cloud audio.

## Hands-free flow

1. Tap **Talk** (Agent) or the kid mic (Doodle) — unlocks TTS, starts listening.
2. Speak → text lands in the composer → send / Confirm.
3. Mic pauses while the reply is spoken (chunked).
4. Listening resumes automatically while Talk stays on.
5. Tap **Talk** again to stop.

## Still stuck?

Open **Voice check** on the device and note:

- Secure page = No → switch to the HTTPS tunnel URL  
- Recognition API = Missing → try another browser or rely on MediaRecorder / keyboard mic  
- Mic permission = denied → Safari site settings  
- Last error = `service-not-allowed` → Dictation / Screen Time  
- Synth voices = 0 → tap **Unlock speech**, wait a second, Refresh  

See also: Settings → Cloudflare Tunnel; `.env.example` for `HOMEBASE_TRANSCRIBE_API_KEY`.
