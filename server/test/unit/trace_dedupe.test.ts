import { describe, expect, test } from "bun:test";
import { appendTrace, listTrace, setTraceMirrorConsole } from "../../src/trace";

setTraceMirrorConsole(false);

describe("appendTrace", () => {
  test("logs client log ready only once per source", () => {
    const first = appendTrace("info", "client log ready", "client");
    const second = appendTrace("info", "client log ready", "client");
    expect(second.id).toBe(first.id);
    const count = listTrace(300).items.filter(
      (l) => l.source === "client" && l.message === "client log ready",
    ).length;
    expect(count).toBe(1);
  });
});
