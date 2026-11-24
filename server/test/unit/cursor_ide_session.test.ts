import { createCipheriv, pbkdf2Sync } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  decryptOsCryptAes,
  isJwtAccessToken,
  parseSafeStorageEnvelope,
} from "../../src/cursor_ide_session";

const SALT = Buffer.from("saltysalt");
const IV = Buffer.alloc(16, 0x20);

function encryptOsCrypt(plaintext: string, password: string, version: "v10" | "v11"): Buffer {
  const key = pbkdf2Sync(password, SALT, 1, 16, "sha1");
  const cipher = createCipheriv("aes-128-cbc", key, IV);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([Buffer.from(version, "latin1"), body]);
}

describe("cursor_ide_session safeStorage", () => {
  test("detects plain JWTs and safe-storage envelopes", () => {
    expect(isJwtAccessToken("aaa.bbb.ccc")).toBe(true);
    expect(isJwtAccessToken("cursor-safe-storage:v1:abc")).toBe(false);
    expect(parseSafeStorageEnvelope("not-an-envelope")).toBeNull();
  });

  test("decrypts Chromium OSCrypt v10 peanuts blobs", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyXzEifQ.sig";
    const blob = encryptOsCrypt(jwt, "peanuts", "v10");
    expect(decryptOsCryptAes(blob, "peanuts")).toBe(jwt);

    const envelope = `cursor-safe-storage:v1:${blob.toString("base64")}`;
    const parsed = parseSafeStorageEnvelope(envelope);
    expect(parsed).not.toBeNull();
    expect(decryptOsCryptAes(parsed!, "peanuts")).toBe(jwt);
  });

  test("decrypts Chromium OSCrypt v11 with a keyring password", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyXzIifQ.sig";
    const password = "unit-test-master-password";
    const blob = encryptOsCrypt(jwt, password, "v11");
    expect(decryptOsCryptAes(blob, password)).toBe(jwt);
    expect(decryptOsCryptAes(blob, "wrong")).toBeNull();
  });
});
