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
          expect(html).toContain("Build in progress");
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

  test("live-webgl stops bridge for build then restarts it; serves first", () => {
    const sh = readFileSync(
      join(BUNDLE_ROOT, "scripts/unity/live-webgl.sh"),
      "utf8",
    );
    expect(sh).toContain("stop_bridge_if_ours");
    expect(sh).toContain("restart_bridge");
    expect(sh).toContain("start-editor-bridge.sh");
    // Port comes up before optional initial build (placeholder).
    const serveIdx = sh.indexOf('serve-webgl.sh"');
    const buildIdx = sh.indexOf("no build yet");
    expect(serveIdx).toBeGreaterThan(0);
    expect(buildIdx).toBeGreaterThan(serveIdx);
  });

  test("build-webgl.sh stages into WebGL.next and atomically swaps", () => {
    const sh = readFileSync(
      join(BUNDLE_ROOT, "scripts/unity/build-webgl.sh"),
      "utf8",
    );
    expect(sh).toContain("WebGL.next");
    expect(sh).toContain(".prev");
    expect(sh).toMatch(/mv "\$NEXT" "\$OUT"/);
    expect(sh).toContain("leaving $OUT untouched");
    expect(sh).toContain('Path.GetFullPath("Builds/WebGL.next")');
  });

  test("serve-webgl.mjs re-resolves build root per request", () => {
    const js = readFileSync(
      join(BUNDLE_ROOT, "scripts/unity/serve-webgl.mjs"),
      "utf8",
    );
    expect(js).toContain("function buildRoot()");
    expect(js).toContain("Build in progress");
  });

  test("unity preset webgl_build/stop are kind action (keep preview)", () => {
    const preset = JSON.parse(
      readFileSync(join(BUNDLE_ROOT, "config/presets/unity.json"), "utf8"),
    ) as { actions: { id: string; kind: string }[] };
    const build = preset.actions.find((a) => a.id === "webgl_build");
    const stop = preset.actions.find((a) => a.id === "stop");
    expect(build?.kind).toBe("action");
    expect(stop?.kind).toBe("action");
  });

  test("serve survives atomic WebGL → .prev / .next → WebGL swap", async () => {
    const root = mkdtempSync(join(tmpdir(), "hb-webgl-swap-"));
    roots.push(root);
    const dir = join(root, "Builds", "WebGL");
    const next = `${dir}.next`;
    const prev = `${dir}.prev`;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "index.html"), "<html><body>OLD_BUILD</body></html>\n");

    const script = join(BUNDLE_ROOT, "scripts/unity/serve-webgl.mjs");
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

    const fetchOk = async (needle: string) => {
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        try {
          const r = await fetch(`http://127.0.0.1:${port}/`);
          if (r.ok) {
            const html = await r.text();
            if (html.includes(needle)) return html;
          }
        } catch {
          /* retry */
        }
        await Bun.sleep(100);
      }
      return null;
    };

    try {
      expect(await fetchOk("OLD_BUILD")).toBeTruthy();

      mkdirSync(next, { recursive: true });
      writeFileSync(
        join(next, "index.html"),
        "<html><body>NEW_BUILD</body></html>\n",
      );
      // Same swap sequence as build-webgl.sh
      rmSync(prev, { recursive: true, force: true });
      // renameSync via mv semantics
      const { renameSync } = await import("node:fs");
      renameSync(dir, prev);
      renameSync(next, dir);
      rmSync(prev, { recursive: true, force: true });

      const after = await fetchOk("NEW_BUILD");
      expect(after).toBeTruthy();
      expect(after!).toContain("NEW_BUILD");
      expect(after!).not.toContain("OLD_BUILD");
    } finally {
      child.kill("SIGTERM");
    }
  });
});
