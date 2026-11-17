import { describe, expect, test } from "bun:test";

/** Mirror of process.sessionFailHint extraction for unit coverage. */
function extractFailHint(output: string): string {
  const raw = String(output || "")
    .replace(/\x1b\[[0-9;]*m/g, "")
    .replace(/\r/g, "")
    .trim();
  const lines = raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const errLine =
    [...lines].reverse().find((l) => /error:|die |missing |failed|fatal/i.test(l)) ||
    lines[lines.length - 1] ||
    "";
  const clipped = errLine.slice(0, 240);
  return clipped
    ? `Run failed: ${clipped}`
    : "Run session exited before ports were ready";
}

describe("compose gate fail hint", () => {
  test("picks the Missing .env error line", () => {
    const out = `
════════════════════════════════════════
  Doodle Pie · development
════════════════════════════════════════

\x1b[31merror:\x1b[0m Missing apps/api/.env — run ./build.sh --setup first
`;
    expect(extractFailHint(out)).toContain("Missing apps/api/.env");
  });

  test("falls back when empty", () => {
    expect(extractFailHint("")).toContain("exited before ports");
  });
});
