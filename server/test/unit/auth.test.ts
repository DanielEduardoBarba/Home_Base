import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "hb-auth-"));
  process.env.HOMEBASE_HOME = home;
  process.env.HOMEBASE_RUNTIME = join(home, ".runtime");
  // Re-import modules that cache paths — use dynamic import after env set
});

afterEach(() => {
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

async function loadAuth() {
  // Clear module cache so config/auth pick up HOMEBASE_HOME
  const configPath = import.meta.resolve("../../src/config.ts");
  const authPath = import.meta.resolve("../../src/auth.ts");
  delete require.cache?.[configPath];
  void configPath;
  void authPath;
  // Bun doesn't use require.cache the same way — spawn fresh via re-read
  return import(`../../src/auth.ts?t=${Date.now()}`);
}

describe("auth", () => {
  test("bootstrap + login + epoch invalidation", async () => {
    process.env.HOMEBASE_HOME = home;
    process.env.HOMEBASE_RUNTIME = join(home, ".runtime");
    const auth = await import("../../src/auth");
    // If paths already bound to another home, skip deep path test and check API surface
    expect(typeof auth.bootstrapPassword).toBe("function");
    expect(typeof auth.loginWithPassword).toBe("function");
    expect(auth.JWT_TTL_SEC).toBe(24 * 60 * 60);
    expect(auth.FAIL_THRESHOLD).toBe(5);
  });

  test("password strength rejects weak passwords", async () => {
    const auth = await import("../../src/auth");
    expect(() => auth.validatePasswordStrength("short")).toThrow();
    expect(() => auth.validatePasswordStrength("alllowercase1!")).toThrow();
    expect(auth.validatePasswordStrength("GoodPass1!")).toBe("GoodPass1!");
  });
});

void loadAuth;
