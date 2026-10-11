import { describe, expect, test } from "bun:test";
import {
  getPolicy,
  listPending,
  requestApproval,
  resolveApproval,
  setPolicy,
} from "../../src/approvals";
import { subscribeCursor } from "../../src/cursor";

describe("approvals", () => {
  test("auto policy allows immediately", async () => {
    setPolicy("auto");
    expect(getPolicy()).toBe("auto");
    const r = await requestApproval({
      kind: "shell",
      tool: "Shell",
      detail: "ls",
    });
    expect(r.permission).toBe("allow");
    setPolicy("ask");
  });

  test("ask policy with a Chat listener blocks until resolveApproval", async () => {
    setPolicy("ask");
    const seen: unknown[] = [];
    const unsub = subscribeCursor("test-proj", (msg) => seen.push(msg));
    try {
      const pending = requestApproval({
        kind: "shell",
        tool: "Shell",
        detail: "echo hi",
        command: "echo hi",
      });
      // Allow the approval broadcast to land.
      await Bun.sleep(20);
      expect(listPending().length).toBe(1);
      const id = listPending()[0]!.id;
      expect(seen.some((m) => (m as { type?: string }).type === "approval")).toBe(true);
      expect(resolveApproval(id, true)).toBe(true);
      const r = await pending;
      expect(r.permission).toBe("allow");
      expect(listPending().length).toBe(0);
    } finally {
      unsub();
      setPolicy("ask");
    }
  });
});
