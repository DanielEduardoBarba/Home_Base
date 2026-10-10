import { existsSync, readFileSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import { BUNDLE_ROOT } from "./config";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
  ".map": "application/json",
};

export function distRoot(): string {
  return join(BUNDLE_ROOT, "web", "dist");
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
  };
  if (encoding) headers["content-encoding"] = encoding;
  const data = readFileSync(bodyPath);
  return new Response(data, { status: 200, headers });
}
