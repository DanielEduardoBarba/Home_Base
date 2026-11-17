/**
 * Stop must not hang forever waiting on hung Task/subagent wait().
 */
import { describe, expect, test } from "bun:test";
import {
  raceTimeout,
  settleCancelledRun,
} from "../../src/cursor";

describe("cursor cancel settle", () => {
  test("raceTimeout resolves fallback when promise never settles", async () => {
    const never = new Promise<string>(() => {
      /* hang */
    });
    const t0 = Date.now();
    const got = await raceTimeout(never, 40, "fallback");
    expect(got).toBe("fallback");
    expect(Date.now() - t0).toBeLessThan(500);
  });

  test("raceTimeout prefers the real result when fast", async () => {
    const got = await raceTimeout(
      Promise.resolve("ok"),
      200,
      "fallback",
    );
    expect(got).toBe("ok");
  });

  test("settleCancelledRun does not hang on a never-resolving wait()", async () => {
    const hungWait = new Promise<{ status: string }>(() => {
      /* hung Task / subagent */
    });
    const t0 = Date.now();
    const result = await settleCancelledRun(hungWait, 50);
    expect(result.status).toBe("cancelled");
    expect(Date.now() - t0).toBeLessThan(500);
  });

  test("settleCancelledRun returns real wait() result when it finishes", async () => {
    const wait = Promise.resolve({
      status: "finished" as const,
      result: "done",
    });
    const result = await settleCancelledRun(wait, 200);
    expect(result.status).toBe("finished");
    expect(result.result).toBe("done");
  });

  test("settleCancelledRun maps wait() rejection to cancelled", async () => {
    const wait = Promise.reject(new Error("sdk blew up"));
    const result = await settleCancelledRun(wait, 200);
    expect(result.status).toBe("cancelled");
  });
});
