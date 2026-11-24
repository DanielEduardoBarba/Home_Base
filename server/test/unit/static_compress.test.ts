import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliCompressSync } from "node:zlib";

/**
 * These tests must not require a prebuilt web/dist from `next build`.
 * Build a minimal static fixture under a temp HOMEBASE_BUNDLE_ROOT before import.
 */
const fixtureRoot = mkdtempSync(join(tmpdir(), "hb-static-bundle-"));
const dist = join(fixtureRoot, "web", "dist");

function writeBr(abs: string, body: string | Buffer): void {
  writeFileSync(abs, body);
  writeFileSync(abs + ".br", brotliCompressSync(Buffer.from(body)));
}

mkdirSync(join(dist, "_next/static/chunks/app/[[...slug]]"), {
  recursive: true,
});
mkdirSync(join(dist, "work"), { recursive: true });

writeBr(join(dist, "index.html"), "<!doctype html><title>fixture</title>");
// Hashed-looking chunk large enough for the percent-encoded size assertion.
const chunkBody = `/* fixture chunk */\n` + "x".repeat(12_000);
writeBr(join(dist, "_next/static/chunks/app-fixture.js"), chunkBody);
writeBr(
  join(dist, "_next/static/chunks/app/[[...slug]]/page-fixture.js"),
  chunkBody,
);
writeFileSync(
  join(dist, "work/files.html"),
  "<!doctype html><title>files</title>",
);

process.env.HOMEBASE_BUNDLE_ROOT = fixtureRoot;

afterAll(() => {
  try {
    rmSync(fixtureRoot, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

const { tryServeStatic, distRoot } = await import("../../src/static");

function firstJs(dir: string): string | null {
  if (!existsSync(dir)) return null;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    // Prefer top-level chunks/; skip nested app/ used by catch-all tests.
    if (name === "app") continue;
    if (name.endsWith(".js")) return p;
  }
  return null;
}

describe("static precompress + cache", () => {
  test("serves index.html with brotli + no-cache", () => {
    const root = distRoot();
    expect(root).toBe(dist);
    expect(existsSync(join(root, "index.html"))).toBe(true);
    expect(existsSync(join(root, "index.html.br"))).toBe(true);
    const res = tryServeStatic("/", "br");
    expect(res).not.toBeNull();
    expect(res!.headers.get("content-encoding")).toBe("br");
    expect(res!.headers.get("vary")).toBe("Accept-Encoding");
    expect(res!.headers.get("cache-control")).toBe("no-cache");
  });

  test("serves Next _next/static JS with immutable cache", () => {
    const root = distRoot();
    const jsAbs = firstJs(join(root, "_next", "static", "chunks"));
    expect(jsAbs).toBeTruthy();
    const rel = "/" + jsAbs!.slice(root.length + 1);
    expect(existsSync(jsAbs! + ".br")).toBe(true);
    const res = tryServeStatic(rel, "br, gzip");
    expect(res).not.toBeNull();
    expect(res!.headers.get("content-encoding")).toBe("br");
    expect(res!.headers.get("vary")).toBe("Accept-Encoding");
    expect(res!.headers.get("cache-control")).toContain("immutable");
  });

  test("serves Next catch-all chunk whose path contains .. as a substring", () => {
    const root = distRoot();
    const dir = join(root, "_next/static/chunks/app/[[...slug]]");
    expect(existsSync(dir)).toBe(true);
    const name = readdirSync(dir).find(
      (n) => n.endsWith(".js") && !n.endsWith(".map"),
    );
    expect(name).toBeTruthy();
    const rel = `/_next/static/chunks/app/[[...slug]]/${name}`;
    const res = tryServeStatic(rel, "identity");
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    expect(res!.headers.get("content-type") || "").toContain("javascript");
  });

  test("serves the catch-all chunk when the path is percent-encoded", async () => {
    const root = distRoot();
    const dir = join(root, "_next/static/chunks/app/[[...slug]]");
    const name = readdirSync(dir).find(
      (n) => n.endsWith(".js") && !n.endsWith(".map"),
    );
    expect(name).toBeTruthy();
    const encoded = `/_next/static/chunks/app/${encodeURIComponent("[[...slug]]")}/${name}`;
    const res = tryServeStatic(encoded, "identity");
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    expect(res!.headers.get("content-type") || "").toContain("javascript");
    const buf = Buffer.from(await res!.arrayBuffer());
    expect(buf.byteLength).toBeGreaterThan(10_000);
  });

  test("rejects path traversal outside dist", () => {
    const res = tryServeStatic("/_next/static/../../../etc/passwd", "identity");
    if (res) {
      expect(res.headers.get("content-type") || "").toContain("html");
    } else {
      expect(res).toBeNull();
    }
  });

  test("serves pre-rendered /work/files.html for the extensionless URL", () => {
    const res = tryServeStatic("/work/files", "identity");
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    expect(res!.headers.get("content-type") || "").toContain("html");
  });
});
