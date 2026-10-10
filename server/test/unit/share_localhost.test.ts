import { describe, expect, test } from "bun:test";
import { isLocalhostBrowser } from "../../src/share";

describe("localhost browser gate", () => {
  test("accepts localhost Origin", () => {
    const h = new Headers({ origin: "http://localhost:3081" });
    expect(isLocalhostBrowser(h)).toBe(true);
  });

  test("rejects LAN Origin even with loopback Host", () => {
    const h = new Headers({
      origin: "http://deltabravo.local:3081",
      host: "127.0.0.1:8081",
    });
    expect(isLocalhostBrowser(h)).toBe(false);
  });

  test("allows loopback Host when no Origin", () => {
    const h = new Headers({ host: "127.0.0.1:8081" });
    expect(isLocalhostBrowser(h)).toBe(true);
  });
});
