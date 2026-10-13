import { describe, expect, test } from "bun:test";
import {
  clearCursorApiKey,
  cursorApiKeyConfigured,
  decryptSecret,
  encryptSecret,
  getCursorCredentialsMeta,
  isValidSecretHint,
  loadCursorApiKey,
  secretDisplayHint,
  setCursorApiKey,
} from "../../src/secrets_vault";

describe("secrets_vault", () => {
  test("encrypt/decrypt round-trip", () => {
    const blob = encryptSecret("hello-secret");
    expect(decryptSecret(blob)).toBe("hello-secret");
    expect(decryptSecret("not-json")).toBeNull();
  });

  test("secretDisplayHint never returns full secret", () => {
    expect(secretDisplayHint("short")).toBe("••••••••");
    expect(secretDisplayHint("12345678901")).toBe("••••••••"); // 11 < 12
    const long = "sk-abcdefghijklmnopqrstuvwxyz";
    const hint = secretDisplayHint(long);
    expect(hint).toBe("sk-a••••wxyz");
    expect(hint).not.toBe(long);
    expect(hint.includes(long.slice(4, -4))).toBe(false);
    expect(isValidSecretHint(hint)).toBe(true);
    expect(isValidSecretHint(long)).toBe(false);
  });

  test("cursor api key set and clear", () => {
    const prev = process.env.CURSOR_API_KEY;
    delete process.env.CURSOR_API_KEY;
    try {
      const meta = setCursorApiKey("sk-test-key-long-enough");
      expect(cursorApiKeyConfigured()).toBe(true);
      expect(loadCursorApiKey()).toBe("sk-test-key-long-enough");
      expect(meta.hint).toBe("sk-t••••ough");
      expect(getCursorCredentialsMeta()).toEqual({
        configured: true,
        hint: "sk-t••••ough",
      });
      clearCursorApiKey();
      // env cleared; file gone — may still be false
      expect(cursorApiKeyConfigured()).toBe(false);
      expect(getCursorCredentialsMeta()).toEqual({
        configured: false,
        hint: null,
      });
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
