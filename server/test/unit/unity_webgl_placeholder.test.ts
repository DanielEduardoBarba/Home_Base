import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { BUNDLE_ROOT } from "../../src/config";

describe("unity webgl placeholder", () => {
  const roots: string[] = [];
  afterAll(() => {
    for (const r of roots) rmSync(r, { recursive: true, force: true });
  });

  test("serve-webgl.mjs serves placeholder when index.html missing", async () => {
    const root = mkdtempSync(join(tmpdir(), "hb-webgl-ph-"));
    roots.push(root);
    const dir = join(root, "Builds", "WebGL");
    mkdirSync(dir, { recursive: true });
    const script = join(BUNDLE_ROOT, "scripts/unity/serve-webgl.mjs");
    expect(existsSync(script)).toBe(true);

    // Pick a free port
    const port = await new Promise<number>((resolve, reject) => {
      const s = createServer();
      s.listen(0, "127.0.0.1", () => {
        const addr = s.address();
        if (!addr || typeof addr === "string") {
          reject(new Error("no port"));
          return;
        }
        const p = addr.port;
        s.close(() => resolve(p));
      });
    });

    const child = spawn("node", [script], {
      env: {
        ...process.env,
        UNITY_WEBGL_PORT: String(port),
        UNITY_WEBGL_DIR: dir,
        HB_WEBGL_BIND: "127.0.0.1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let ready = false;
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/`);
        if (r.ok) {
          ready = true;
          const html = await r.text();
          expect(html).toContain("No WebGL build yet");
          expect(r.headers.get("x-homebase-webgl")).toBe("placeholder");
          break;
        }
      } catch {
        await Bun.sleep(100);
      }
    }
    child.kill("SIGTERM");
    expect(ready).toBe(true);
  });

  test("serve-webgl.sh does not require pre-existing Builds/WebGL", () => {
    const sh = readFileSync(
      join(BUNDLE_ROOT, "scripts/unity/serve-webgl.sh"),
      "utf8",
    );
    expect(sh).toContain("mkdir -p");
    expect(sh).not.toMatch(/\[\[ -d "\$DIR" \]\] \|\| \{ echo "error: WebGL build dir missing/);
  });
});
