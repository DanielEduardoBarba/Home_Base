import { afterEach, describe, expect, test } from "bun:test";
import {
  _putUnityJobForTests,
  _resetUnityJobsForTests,
  getUnityJob,
  listUnityJobs,
  startUnityJob,
} from "../../src/unity_jobs";

afterEach(() => {
  _resetUnityJobsForTests();
});

describe("unity async jobs", () => {
  test("job status round-trip", () => {
    _putUnityJobForTests({
      id: "uj_test1",
      projectId: "demo",
      kind: "webgl_build",
      status: "done",
      startedAt: Date.now() - 1000,
      finishedAt: Date.now(),
      summary: "ok",
      result: { sizeBytes: 12 },
    });
    const j = getUnityJob("uj_test1");
    expect(j?.status).toBe("done");
    expect(j?.result?.sizeBytes).toBe(12);
    expect(listUnityJobs(5).some((x) => x.id === "uj_test1")).toBe(true);
  });

  test("startUnityJob refuses unknown project", () => {
    const r = startUnityJob({
      projectId: "does-not-exist-xyz",
      kind: "webgl_build",
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not found/i);
  });
});
