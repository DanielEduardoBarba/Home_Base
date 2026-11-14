import { describe, expect, test } from "bun:test";
import {
  speechTranscribeConfigured,
  speechTranscribeStatus,
  transcribeApiKey,
} from "../../src/speech_transcribe";

describe("speech_transcribe env helpers", () => {
  test("status reflects env without exposing the key", () => {
    const prevA = process.env.HOMEBASE_TRANSCRIBE_API_KEY;
    const prevB = process.env.OPENAI_API_KEY;
    try {
      delete process.env.HOMEBASE_TRANSCRIBE_API_KEY;
      delete process.env.OPENAI_API_KEY;
      expect(speechTranscribeConfigured()).toBe(false);
      expect(speechTranscribeStatus()).toEqual({
        configured: false,
        provider: null,
      });

      process.env.OPENAI_API_KEY = "sk-test-openai";
      expect(speechTranscribeConfigured()).toBe(true);
      expect(transcribeApiKey()).toBe("sk-test-openai");
      expect(speechTranscribeStatus().provider).toBe("openai-whisper");

      process.env.HOMEBASE_TRANSCRIBE_API_KEY = "sk-dedicated";
      expect(transcribeApiKey()).toBe("sk-dedicated");
    } finally {
      if (prevA === undefined) delete process.env.HOMEBASE_TRANSCRIBE_API_KEY;
      else process.env.HOMEBASE_TRANSCRIBE_API_KEY = prevA;
      if (prevB === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prevB;
    }
  });
});
