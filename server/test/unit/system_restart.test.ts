import { describe, expect, test } from "bun:test";
import { underHomebasedService } from "../../src/system";

describe("underHomebasedService", () => {
  test("returns a boolean without throwing", () => {
    expect(typeof underHomebasedService()).toBe("boolean");
  });
});
