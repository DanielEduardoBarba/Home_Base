import { describe, expect, test } from "bun:test";
import {
  DEFAULT_TRANSCRIBE_MODEL,
  speechTranscribeConfigured,
  speechTranscribeStatus,
  transcribeApiKey,
  transcribeAudio,
  transcribeModel,
} from "../../src/speech_transcribe";

describe("speech_transcribe env helpers", () => {
  test("status reflects env without exposing the key", () => {
    const prevA = process.env.HOMEBASE_TRANSCRIBE_API_KEY;
    const prevB = process.env.OPENAI_API_KEY;
    const prevM = process.env.HOMEBASE_TRANSCRIBE_MODEL;
    try {
      delete process.env.HOMEBASE_TRANSCRIBE_API_KEY;
      delete process.env.OPENAI_API_KEY;
      delete process.env.HOMEBASE_TRANSCRIBE_MODEL;
      expect(speechTranscribeConfigured()).toBe(false);
      expect(speechTranscribeStatus()).toEqual({
        configured: false,
        provider: null,
        model: null,
      });

      process.env.OPENAI_API_KEY = "sk-test-openai";
      expect(speechTranscribeConfigured()).toBe(true);
      expect(transcribeApiKey()).toBe("sk-test-openai");
      expect(speechTranscribeStatus()).toEqual({
        configured: true,
        provider: "openai",
        model: DEFAULT_TRANSCRIBE_MODEL,
      });

      process.env.HOMEBASE_TRANSCRIBE_API_KEY = "sk-dedicated";
      expect(transcribeApiKey()).toBe("sk-dedicated");
    } finally {
      if (prevA === undefined) delete process.env.HOMEBASE_TRANSCRIBE_API_KEY;
      else process.env.HOMEBASE_TRANSCRIBE_API_KEY = prevA;
      if (prevB === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prevB;
      if (prevM === undefined) delete process.env.HOMEBASE_TRANSCRIBE_MODEL;
      else process.env.HOMEBASE_TRANSCRIBE_MODEL = prevM;
    }
  });

  test("HOMEBASE_TRANSCRIBE_MODEL defaults to gpt-4o-mini-transcribe; override whisper-1", () => {
    const prevM = process.env.HOMEBASE_TRANSCRIBE_MODEL;
    const prevA = process.env.HOMEBASE_TRANSCRIBE_API_KEY;
    const prevB = process.env.OPENAI_API_KEY;
    try {
      process.env.HOMEBASE_TRANSCRIBE_API_KEY = "sk-status";
      delete process.env.OPENAI_API_KEY;
      delete process.env.HOMEBASE_TRANSCRIBE_MODEL;
      expect(transcribeModel()).toBe("gpt-4o-mini-transcribe");
      expect(DEFAULT_TRANSCRIBE_MODEL).toBe("gpt-4o-mini-transcribe");
      expect(speechTranscribeStatus()).toEqual({
        configured: true,
        provider: "openai",
        model: "gpt-4o-mini-transcribe",
      });

      process.env.HOMEBASE_TRANSCRIBE_MODEL = "   ";
      expect(transcribeModel()).toBe("gpt-4o-mini-transcribe");

      process.env.HOMEBASE_TRANSCRIBE_MODEL = "whisper-1";
      expect(transcribeModel()).toBe("whisper-1");
      expect(speechTranscribeStatus()).toEqual({
        configured: true,
        provider: "openai",
        model: "whisper-1",
      });
    } finally {
      if (prevM === undefined) delete process.env.HOMEBASE_TRANSCRIBE_MODEL;
      else process.env.HOMEBASE_TRANSCRIBE_MODEL = prevM;
      if (prevA === undefined) delete process.env.HOMEBASE_TRANSCRIBE_API_KEY;
      else process.env.HOMEBASE_TRANSCRIBE_API_KEY = prevA;
      if (prevB === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prevB;
    }
  });

  test("transcribeAudio sends default or overridden model via FormData", async () => {
    const prevKey = process.env.HOMEBASE_TRANSCRIBE_API_KEY;
    const prevModel = process.env.HOMEBASE_TRANSCRIBE_MODEL;
    try {
      process.env.HOMEBASE_TRANSCRIBE_API_KEY = "sk-test";
      delete process.env.HOMEBASE_TRANSCRIBE_MODEL;

      const seen: string[] = [];
      const fakeFetch = async (_url: string, init?: RequestInit) => {
        const body = init?.body as FormData;
        seen.push(String(body.get("model")));
        return new Response(JSON.stringify({ text: "hi" }), { status: 200 });
      };

      const a = await transcribeAudio({
        bytes: new Uint8Array([1, 2, 3]),
        mime: "audio/webm",
        fetchImpl: fakeFetch,
      });
      expect(a.model).toBe("gpt-4o-mini-transcribe");
      expect(seen).toEqual(["gpt-4o-mini-transcribe"]);

      process.env.HOMEBASE_TRANSCRIBE_MODEL = "whisper-1";
      const b = await transcribeAudio({
        bytes: new Uint8Array([1, 2, 3]),
        mime: "audio/webm",
        fetchImpl: fakeFetch,
      });
      expect(b.model).toBe("whisper-1");
      expect(seen).toEqual(["gpt-4o-mini-transcribe", "whisper-1"]);
    } finally {
      if (prevKey === undefined) delete process.env.HOMEBASE_TRANSCRIBE_API_KEY;
      else process.env.HOMEBASE_TRANSCRIBE_API_KEY = prevKey;
      if (prevModel === undefined) delete process.env.HOMEBASE_TRANSCRIBE_MODEL;
      else process.env.HOMEBASE_TRANSCRIBE_MODEL = prevModel;
    }
  });
});
