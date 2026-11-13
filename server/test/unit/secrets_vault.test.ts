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
  callbackAuthEnvSet,
  clearCallbackAuth,
  getCallbackAuthMeta,
  importCallbackAuthFromEnvIfNeeded,
  loadCallbackAuthFromVault,
  setCallbackAuth,
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

  test("callback auth set/clear never returns plaintext; env is only a boolean warning", () => {
    const prev = process.env.HOMEBASE_CALLBACK_AUTH;
    delete process.env.HOMEBASE_CALLBACK_AUTH;
    try {
      clearCallbackAuth();
      expect(getCallbackAuthMeta()).toEqual({
        configured: false,
        hint: null,
        envSet: false,
      });
      const secret = "Bearer vault-callback-token-long";
      const meta = setCallbackAuth(secret);
      expect(meta.configured).toBe(true);
      expect(meta.hint).toBe("Bear••••long");
      expect(meta.envSet).toBe(false);
      expect(JSON.stringify(meta)).not.toContain(secret);
      expect(loadCallbackAuthFromVault()).toBe(secret);
      expect(getCallbackAuthMeta().hint).not.toBe(secret);

      process.env.HOMEBASE_CALLBACK_AUTH = "Bearer leftover-env-token-zzzz";
      const warned = getCallbackAuthMeta();
      expect(warned.envSet).toBe(true);
      expect(callbackAuthEnvSet()).toBe(true);
      expect(JSON.stringify(warned)).not.toContain("leftover-env-token");
      expect(JSON.stringify(warned)).not.toContain(secret);
      // env is not used as the vault value
      expect(loadCallbackAuthFromVault()).toBe(secret);

      clearCallbackAuth();
      expect(getCallbackAuthMeta()).toEqual({
        configured: false,
        hint: null,
        envSet: true,
      });
    } finally {
      try {
        clearCallbackAuth();
      } catch {
        /* ignore */
      }
      if (prev === undefined) delete process.env.HOMEBASE_CALLBACK_AUTH;
      else process.env.HOMEBASE_CALLBACK_AUTH = prev;
    }
  });

  test("one-time env import fills an empty vault and does not overwrite an existing one", () => {
    const prev = process.env.HOMEBASE_CALLBACK_AUTH;
    try {
      clearCallbackAuth();
      process.env.HOMEBASE_CALLBACK_AUTH = "Bearer import-me-token-aaaa";
      const first = importCallbackAuthFromEnvIfNeeded();
      expect(first).toEqual({ imported: true, envSet: true });
      expect(loadCallbackAuthFromVault()).toBe("Bearer import-me-token-aaaa");

      process.env.HOMEBASE_CALLBACK_AUTH = "Bearer should-not-overwrite-bbbb";
      const second = importCallbackAuthFromEnvIfNeeded();
      expect(second).toEqual({ imported: false, envSet: true });
      expect(loadCallbackAuthFromVault()).toBe("Bearer import-me-token-aaaa");
    } finally {
      try {
        clearCallbackAuth();
      } catch {
        /* ignore */
      }
      if (prev === undefined) delete process.env.HOMEBASE_CALLBACK_AUTH;
      else process.env.HOMEBASE_CALLBACK_AUTH = prev;
    }
  });
});
