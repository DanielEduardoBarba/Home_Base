import { describe, expect, test, beforeEach } from "bun:test";
import {
  _resetUnityBuildStatusForTests,
  getUnityBuildStatus,
  markUnityBuildBuilding,
  markUnityBuildFinished,
} from "../../src/unity_build_status";

describe("unity_build_status", () => {
  beforeEach(() => {
    _resetUnityBuildStatusForTests();
  });

  test("building then error with timestamp", () => {
    const b = markUnityBuildBuilding("game1", { sessionId: "s1" });
    expect(b.state).toBe("building");
    expect(b.message).toBe("building");
    expect(getUnityBuildStatus("game1")?.state).toBe("building");

    const err = markUnityBuildFinished("game1", {
      ok: false,
      message: "Unity not found at /missing/Unity",
    });
    expect(err.state).toBe("error");
    expect(err.message).toContain("Unity not found");
    expect(err.at).toBeGreaterThan(0);
    expect(getUnityBuildStatus("game1")?.state).toBe("error");
  });

  test("building then ok", () => {
    markUnityBuildBuilding("game2", { jobId: "uj_1" });
    const ok = markUnityBuildFinished("game2", { ok: true, jobId: "uj_1" });
    expect(ok.state).toBe("ok");
    expect(getUnityBuildStatus("game2")?.state).toBe("ok");
  });
});
