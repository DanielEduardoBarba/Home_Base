import { describe, expect, test } from "bun:test";
import { compactWorkspace, historySlice, slimTabsForClient, type ChatTab } from "../../src/cursor";

describe("chat workspace size", () => {
  test("clips huge tool logs and keeps the phone payload small", () => {
    const huge = "x".repeat(2_000_000);
    const tabs: ChatTab[] = [
      {
        id: "t1",
        title: "big",
        cwd: "/tmp",
        messages: [
          {
            id: "m1",
            role: "tool",
            text: "",
            tool: { name: "shell", status: "done", output: huge },
          },
          { id: "m2", role: "assistant", text: "hello" },
        ],
      },
    ];
    const ws = { tabs, activeId: "t1" };
    expect(compactWorkspace(ws)).toBe(true);
    expect(ws.tabs[0]!.messages[0]!.tool!.output!.length).toBeLessThan(20_000);
    expect(ws.tabs[0]!.messages[1]!.text).toBe("hello");
    expect(compactWorkspace(ws)).toBe(false);
    const wire = slimTabsForClient(ws.tabs);
    expect(JSON.stringify(wire).length).toBeLessThan(1_200_000);
    expect(wire[0]!.messages.some((m) => m.id === "m2" && m.text === "hello")).toBe(true);
  });

  test("trims stored history past the cap once", () => {
    const messages = Array.from({ length: 250 }, (_, i) => ({
      id: `m${i}`,
      role: "assistant",
      text: `line ${i}`,
    }));
    const ws = {
      tabs: [{ id: "t", title: "t", cwd: "", messages }],
      activeId: "t",
    };
    expect(compactWorkspace(ws)).toBe(true);
    expect(ws.tabs[0]!.messages.length).toBe(200);
    expect(ws.tabs[0]!.messages[0]!.role).toBe("system");
    expect(ws.tabs[0]!.messages.at(-1)!.id).toBe("m249");
    expect(compactWorkspace(ws)).toBe(false);
  });

  test("first wire window reports how much history is still behind it", () => {
    const messages = Array.from({ length: 100 }, (_, i) => ({
      id: `m${i}`,
      role: "assistant",
      text: `line ${i}`,
    }));
    const [tab] = slimTabsForClient([
      { id: "t", title: "t", cwd: "", messages },
    ]);
    expect(tab!.historyTotal).toBe(100);
    expect(tab!.messages).toHaveLength(80);
    expect(tab!.historyFrom).toBe(20);
    expect(tab!.messages[0]!.id).toBe("m20");
  });

  test("history page walks backward and stops at the start", () => {
    const messages = ["a", "b", "c", "d", "e"].map((id) => ({
      id,
      role: "user",
      text: id,
    }));
    const mid = historySlice(messages, "d", 2);
    expect(mid.messages.map((m) => m.id)).toEqual(["b", "c"]);
    expect(mid.total).toBe(5);
    expect(mid.done).toBe(false);
    const start = historySlice(messages, "b", 2);
    expect(start.messages.map((m) => m.id)).toEqual(["a"]);
    expect(start.done).toBe(true);
    expect(historySlice(messages, "missing", 2).done).toBe(true);
  });
});
