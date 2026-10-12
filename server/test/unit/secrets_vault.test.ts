import { describe, expect, test } from "bun:test";
import {
  clearCursorApiKey,
  cursorApiKeyConfigured,
  decryptSecret,
  encryptSecret,
  loadCursorApiKey,
  setCursorApiKey,
} from "../../src/secrets_vault";

describe("secrets_vault", () => {
  test("encrypt/decrypt round-trip", () => {
    const blob = encryptSecret("hello-secret");
    expect(decryptSecret(blob)).toBe("hello-secret");
    expect(decryptSecret("not-json")).toBeNull();
  });

  test("cursor api key set and clear", () => {
    const prev = process.env.CURSOR_API_KEY;
    delete process.env.CURSOR_API_KEY;
    try {
      setCursorApiKey("sk-test-key");
      expect(cursorApiKeyConfigured()).toBe(true);
      expect(loadCursorApiKey()).toBe("sk-test-key");
      clearCursorApiKey();
      // env cleared; file gone — may still be false
      expect(cursorApiKeyConfigured()).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.CURSOR_API_KEY;
      else process.env.CURSOR_API_KEY = prev;
      try {
        clearCursorApiKey();
      } catch {
        /* ignore */
      }
      if (prev) process.env.CURSOR_API_KEY = prev;
    }
  });
});
