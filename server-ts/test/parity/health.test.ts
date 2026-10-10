import { describe, expect, test } from "bun:test";
import { app } from "../../src/app";

describe("parity health/version", () => {
  test("GET /api/health shape", async () => {
    const res = await app.request("http://localhost/api/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(typeof body.passwordSet).toBe("boolean");
    expect(typeof body.jwtTtlSec).toBe("number");
    expect(body.runtime).toBe("bun");
  });

  test("GET /api/version shape", async () => {
    const res = await app.request("http://localhost/api/version");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.version).toBe("string");
    expect(typeof body.backup).toBe("boolean");
  });
});
