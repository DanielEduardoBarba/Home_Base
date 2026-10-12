import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const runtime = mkdtempSync(join(tmpdir(), "hb-chat-del-"));
process.env.HOMEBASE_RUNTIME = runtime;

const { createChat, deleteChat, listChatSummaries, getWorkspace } = await import(
  "../../src/cursor"
);

afterEach(() => {
  const ws = getWorkspace("p1");
  for (const t of [...ws.tabs]) deleteChat("p1", t.id);
});

afterAll(() => {
  try {
    rmSync(runtime, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("chat delete + summaries", () => {
  test("create, list lean summaries, delete", () => {
    const tab = createChat("p1", { title: "Hello", cwd: "web" });
    expect(tab.id).toBeTruthy();
    const list = listChatSummaries("p1");
    expect(list.chats).toHaveLength(1);
    expect(list.chats[0]!.title).toBe("Hello");
    expect(list.chats[0]!.cwd).toBe("web");
    expect(list.chats[0]!.messageCount).toBe(0);
    expect(list.chats[0]!.recent).toEqual([]);

    const r = deleteChat("p1", tab.id);
    expect(r.ok).toBe(true);
    expect(r.deleted).toBe(true);
    expect(listChatSummaries("p1").chats).toHaveLength(0);
  });

  test("delete is idempotent", () => {
    const tab = createChat("p1", { title: "X" });
    expect(deleteChat("p1", tab.id).deleted).toBe(true);
    expect(deleteChat("p1", tab.id).deleted).toBe(false);
    expect(deleteChat("p1", tab.id).ok).toBe(true);
  });
});
