import { existsSync, readFileSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import { bundleRoot } from "./config";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
  ".map": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

export function distRoot(): string {
  // Resolve each request so HOMEBASE_BUNDLE_ROOT / install layout stay correct in tests.
  return join(bundleRoot(), "web", "dist");
}

function cacheControl(rel: string, ext: string): string {
  if (ext === ".html") return "no-cache";
  // Next hashed chunks under /_next/static/
  if (rel.includes("/_next/static/")) {
    return "public, max-age=31536000, immutable";
  }
  if (ext === ".woff2" || ext === ".woff" || ext === ".svg" || ext === ".ico") {
    return "public, max-age=86400";
  }
  return "public, max-age=3600";
}

export function tryServeStatic(
  pathname: string,
  acceptEncoding: string,
): Response | null {
  const root = distRoot();
  if (!existsSync(root)) return null;
  let rel = pathname === "/" ? "/index.html" : pathname;
  if (rel.includes("..")) return null;
  let filePath = join(root, rel);
  if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
    // SPA fallback
    filePath = join(root, "index.html");
    if (!existsSync(filePath)) return null;
    rel = "/index.html";
  }

  const enc = acceptEncoding.toLowerCase();
  let encoding: string | null = null;
  let bodyPath = filePath;
  if (enc.includes("br") && existsSync(filePath + ".br")) {
    bodyPath = filePath + ".br";
    encoding = "br";
  } else if (enc.includes("gzip") && existsSync(filePath + ".gz")) {
    bodyPath = filePath + ".gz";
    encoding = "gzip";
  }

  const ext = extname(filePath).toLowerCase();
  const headers: Record<string, string> = {
    "content-type": MIME[ext] || "application/octet-stream",
    "cache-control": cacheControl(rel, ext),
  };
  if (encoding) {
    headers["content-encoding"] = encoding;
    headers["vary"] = "Accept-Encoding";
  }
  const data = readFileSync(bodyPath);
  return new Response(data, { status: 200, headers });
}
