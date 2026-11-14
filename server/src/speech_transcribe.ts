/**
 * Server-side speech transcription (OpenAI Whisper-compatible).
 * PRIMARY Talk mic path on iOS / iPadOS / WebKit (MediaRecorder audio/mp4).
 * Desktop Chrome may still use on-device SpeechRecognition as a fast path.
 *
 * Env (never commit secrets):
 *   HOMEBASE_TRANSCRIBE_API_KEY — preferred dedicated key
 *   OPENAI_API_KEY              — fallback if the dedicated key is unset
 *
 * When neither is set, /api/speech/status reports configured:false and the
 * UI shows a clear "not configured" message (keyboard mic / type still work).
 */
import { HttpError } from "./auth";

const OPENAI_TRANSCRIBE_URL = "https://api.openai.com/v1/audio/transcriptions";
const MAX_BYTES = 12 * 1024 * 1024;

export function transcribeApiKey(): string {
  return (
    (process.env.HOMEBASE_TRANSCRIBE_API_KEY || "").trim() ||
    (process.env.OPENAI_API_KEY || "").trim()
  );
}

export function speechTranscribeConfigured(): boolean {
  return Boolean(transcribeApiKey());
}

export function speechTranscribeStatus(): {
  configured: boolean
  provider: string | null
} {
  const configured = speechTranscribeConfigured();
  return {
    configured,
    provider: configured ? "openai-whisper" : null,
  };
}

function extForMime(mime: string): string {
  const m = (mime || "").toLowerCase();
  if (m.includes("mp4") || m.includes("m4a") || m.includes("aac")) return "m4a";
  if (m.includes("ogg")) return "ogg";
  if (m.includes("wav")) return "wav";
  if (m.includes("mpeg") || m.includes("mp3")) return "mp3";
  return "webm";
}

/**
 * Transcribe an audio blob via OpenAI Whisper. Throws HttpError on failure.
 */
export async function transcribeAudio(input: {
  bytes: Uint8Array | ArrayBuffer
  mime?: string
  filename?: string
  language?: string
}): Promise<{ text: string; configured: true }> {
  const key = transcribeApiKey();
  if (!key) {
    throw new HttpError(503, {
      code: "speech_not_configured",
      message:
        "Server transcription is not configured. Set HOMEBASE_TRANSCRIBE_API_KEY (or OPENAI_API_KEY) on the Home Base host.",
    });
  }

  const buf =
    input.bytes instanceof Uint8Array
      ? input.bytes
      : new Uint8Array(input.bytes);
  if (!buf.byteLength) {
    throw new HttpError(400, {
      code: "empty_audio",
      message: "Empty audio upload",
    });
  }
  if (buf.byteLength > MAX_BYTES) {
    throw new HttpError(413, {
      code: "audio_too_large",
      message: `Audio too large (max ${MAX_BYTES} bytes)`,
    });
  }

  const mime = (input.mime || "audio/webm").split(";")[0]!.trim() || "audio/webm";
  const filename =
    (input.filename || "").trim() || `speech.${extForMime(mime)}`;
  const form = new FormData();
  form.append(
    "file",
    new Blob([buf], { type: mime }),
    filename,
  );
  form.append("model", (process.env.HOMEBASE_TRANSCRIBE_MODEL || "").trim() || "gpt-4o-mini-transcribe");
  const lang = (input.language || "").trim();
  if (lang) form.append("language", lang.slice(0, 8));

  let res: Response;
  try {
    res = await fetch(OPENAI_TRANSCRIBE_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      body: form,
    });
  } catch (e) {
    throw new HttpError(502, {
      code: "transcribe_network",
      message: e instanceof Error ? e.message : "Transcription request failed",
    });
  }

  const raw = await res.text();
  if (!res.ok) {
    let detail = raw.slice(0, 240);
    try {
      const j = JSON.parse(raw) as { error?: { message?: string } };
      if (j?.error?.message) detail = j.error.message;
    } catch {
      /* keep raw */
    }
    throw new HttpError(res.status >= 400 && res.status < 600 ? res.status : 502, {
      code: "transcribe_failed",
      message: detail || `Transcription failed (${res.status})`,
    });
  }

  let text = "";
  try {
    const j = JSON.parse(raw) as { text?: string };
    text = typeof j.text === "string" ? j.text.trim() : "";
  } catch {
    text = raw.trim();
  }
  return { text, configured: true };
}
