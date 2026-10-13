import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const root = join(tmpdir(), `hb-legal-${process.pid}-${Date.now()}`);
mkdirSync(root, { recursive: true });
process.env.HOMEBASE_HOME = root;

const {
  LEGAL_DOC_VERSION,
  acceptLegal,
  clearLegal,
  isLegalAccepted,
  legalPublic,
  requireLegalAccepted,
} = await import("../../src/legal_state");
const { HttpError } = await import("../../src/auth");

afterEach(() => {
  clearLegal();
});

describe("legal_state", () => {
  test("starts unaccepted", () => {
    expect(isLegalAccepted()).toBe(false);
    expect(legalPublic().accepted).toBe(false);
    expect(legalPublic().version).toBe(LEGAL_DOC_VERSION);
  });

  test("accept current version", () => {
    const out = acceptLegal(LEGAL_DOC_VERSION);
    expect(out.accepted).toBe(true);
    expect(out.acceptedVersion).toBe(LEGAL_DOC_VERSION);
    expect(isLegalAccepted()).toBe(true);
    expect(() => requireLegalAccepted()).not.toThrow();
  });

  test("rejects stale version", () => {
    expect(() => acceptLegal("0")).toThrow(HttpError);
  });

  test("requireLegalAccepted throws when missing", () => {
    expect(() => requireLegalAccepted()).toThrow(HttpError);
  });
});

afterEach(() => {
  if (existsSync(root)) rmSync(root, { recursive: true, force: true });
});
