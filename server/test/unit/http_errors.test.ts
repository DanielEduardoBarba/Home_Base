import { describe, expect, test } from "bun:test";
import { ZodError } from "zod";
import { HttpError } from "../../src/auth";
import { jsonError } from "../../src/http";

function fakeContext(path = "/api/projects/demo/git") {
  const headers: Record<string, string> = {};
  return {
    req: {
      method: "POST",
      path,
      url: `http://127.0.0.1${path}`,
      header: () => undefined,
      query: () => undefined,
    },
    json: (body: unknown, status?: number) =>
      new Response(JSON.stringify(body), {
        status: status ?? 200,
        headers: { "content-type": "application/json" },
      }),
  } as never;
}

describe("jsonError", () => {
  test("HttpError 400 stays 400", async () => {
    const res = jsonError(fakeContext(), new HttpError(400, "blocked"));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { detail: string };
    expect(body.detail).toBe("blocked");
  });

  test("ZodError for blocked/unknown git action is 400 not 500", async () => {
    const err = new ZodError([
      {
        code: "invalid_enum_value",
        options: ["fetch", "pull", "status"],
        path: ["action"],
        message:
          "Invalid enum value. Expected 'fetch' | 'pull' | …, received 'reset'",
        received: "reset",
      },
    ]);
    const res = jsonError(fakeContext(), err);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { detail: string };
    expect(body.detail).toMatch(/action|Invalid enum|reset/i);
    expect(res.status).not.toBe(500);
  });

  test("unknown Error is still 500", async () => {
    const res = jsonError(fakeContext(), new Error("boom"));
    expect(res.status).toBe(500);
  });
});
