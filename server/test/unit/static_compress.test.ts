import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const repo = join(import.meta.dir, "../../..");
process.env.HOMEBASE_BUNDLE_ROOT = repo;

const { tryServeStatic, distRoot } = await import("../../src/static");

function firstJs(dir: string): string | null {
  if (!existsSync(dir)) return null;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      const nested = firstJs(p);
      if (nested) return nested;
    } else if (name.endsWith(".js")) {
      return p;
    }
  }
  return null;
}

describe("static precompress + cache", () => {
  test("serves index.html with brotli + no-cache", () => {
    const root = distRoot();
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
    const jsAbs = firstJs(join(root, "_next", "static"));
    expect(jsAbs).toBeTruthy();
    const rel = "/" + jsAbs!.slice(root.length + 1);
    expect(existsSync(jsAbs! + ".br")).toBe(true);
    const res = tryServeStatic(rel, "br, gzip");
    expect(res).not.toBeNull();
    expect(res!.headers.get("content-encoding")).toBe("br");
    expect(res!.headers.get("vary")).toBe("Accept-Encoding");
    expect(res!.headers.get("cache-control")).toContain("immutable");
  });
});
