import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("home access create idempotency", () => {
  test("double create with the same label, kind, and hook returns one widget", async () => {
    const root = mkdtempSync(join(tmpdir(), "hb-access-"));
    const serverRoot = join(import.meta.dir, "../..");
    const runner = join(root, "run.ts");
    writeFileSync(
      runner,
      `
        import { upsertAccessWidget, listAccessWidgets, deleteAccessWidget } from ${JSON.stringify(
          join(serverRoot, "src/home_access.ts"),
        )};
        const payload = { kind: "button" as const, label: "QA Lamp", hook: { type: "static" as const } };
        const a = upsertAccessWidget(payload);
        const b = upsertAccessWidget(payload);
        if (b.id !== a.id) throw new Error("expected same id, got " + a.id + " and " + b.id);
        const matches = listAccessWidgets().filter((w) => w.label === "QA Lamp");
        if (matches.length !== 1) throw new Error("expected 1 widget, got " + matches.length);
        const c = upsertAccessWidget({ kind: "button", label: "QA Lamp B", hook: { type: "static" } });
        if (c.id === a.id) throw new Error("distinct control reused id");
        deleteAccessWidget(a.id);
        deleteAccessWidget(c.id);
      `,
    );
    const proc = Bun.spawn(["bun", runner], {
      env: {
        ...process.env,
        HOMEBASE_HOME: root,
        HOMEBASE_RUNTIME: join(root, ".runtime"),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exit] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    expect(exit, `${stdout}\n${stderr}`).toBe(0);
  });
});
