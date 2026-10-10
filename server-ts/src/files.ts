import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import type { Project } from "./config";

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".venv",
  "venv",
  "dist",
  "build",
  ".next",
  ".expo",
  "__pycache__",
  ".pnpm-store",
  "coverage",
  ".turbo",
  ".cache",
]);

const MAX_READ_BYTES = 1_500_000;
const MAX_WRITE_BYTES = 1_500_000;

function isAbsoluteApiPath(path: string): boolean {
  return (path || "").startsWith("/");
}

function resolvePath(project: Project, path: string): string {
  const raw = (path || "").trim();
  if (raw.includes("\0")) throw new Error("Invalid path");
  if (isAbsoluteApiPath(raw)) return resolve(raw);
  const root = resolve(project.path);
  if (!raw || raw === ".") return root;
  const target = resolve(join(root, raw));
  const rel = relative(root, target);
  if (rel.startsWith("..") || resolve(join(root, rel)) !== target) {
    // Also reject if target is outside root
    if (!target.startsWith(root + "/") && target !== root) {
      throw new Error("Path escapes project root");
    }
  }
  return target;
}

function entryPath(requestPath: string, child: string): string {
  if (isAbsoluteApiPath(requestPath)) return child;
  const rel = requestPath.replace(/^\/+|\/+$/g, "");
  const name = basename(child);
  return rel ? `${rel}/${name}` : name;
}

export function listDir(
  project: Project,
  rel = "",
  includeIgnored = false,
): { path: string; entries: unknown[]; includeIgnored: boolean } {
  const target = resolvePath(project, rel);
  if (!existsSync(target)) throw new Error("not_found");
  const st = statSync(target);
  if (!st.isDirectory()) throw new Error("not_dir");
  const absMode = isAbsoluteApiPath(rel);
  const children = readdirSync(target)
    .map((name) => join(target, name))
    .sort((a, b) => {
      const ad = statSync(a).isDirectory() ? 0 : 1;
      const bd = statSync(b).isDirectory() ? 0 : 1;
      if (ad !== bd) return ad - bd;
      return basename(a).toLowerCase().localeCompare(basename(b).toLowerCase());
    });
  const items = [];
  for (const child of children) {
    const name = basename(child);
    if (!includeIgnored && SKIP_DIRS.has(name)) continue;
    let size = 0;
    let isDir = false;
    try {
      const cst = statSync(child);
      isDir = cst.isDirectory();
      size = isDir ? 0 : cst.size;
    } catch {
      /* ignore */
    }
    items.push({
      name,
      path: entryPath(rel, child).replace(/\\/g, "/"),
      type: isDir ? "dir" : "file",
      size,
      ignored: SKIP_DIRS.has(name),
    });
  }
  return {
    path: absMode ? target : rel || ".",
    entries: items,
    includeIgnored,
  };
}

function guessLanguage(path: string): string {
  const ext = extname(path).toLowerCase();
  const map: Record<string, string> = {
    ".py": "python",
    ".ts": "typescript",
    ".tsx": "tsx",
    ".js": "javascript",
    ".jsx": "jsx",
    ".json": "json",
    ".md": "markdown",
    ".css": "css",
    ".html": "html",
    ".sh": "shell",
  };
  return map[ext] || "plaintext";
}

export function readFile(
  project: Project,
  rel: string,
): { path: string; content: string; size: number; language: string } {
  const path = resolvePath(project, rel);
  if (!existsSync(path) || !statSync(path).isFile()) throw new Error("not_found");
  const size = statSync(path).size;
  if (size > MAX_READ_BYTES) throw new Error(`File too large to edit in browser (${size} bytes)`);
  const raw = readFileSync(path);
  let text: string;
  try {
    text = raw.toString("utf8");
  } catch {
    throw new Error("Binary file — cannot open in text editor");
  }
  // detect invalid utf8
  if (Buffer.from(text, "utf8").length !== raw.length && raw.includes(0)) {
    throw new Error("Binary file — cannot open in text editor");
  }
  const outPath = isAbsoluteApiPath(rel) ? path : rel;
  return { path: outPath, content: text, size, language: guessLanguage(outPath) };
}

export function writeFile(
  project: Project,
  rel: string,
  content: string,
): { path: string; size: number; ok: boolean } {
  if (Buffer.byteLength(content, "utf8") > MAX_WRITE_BYTES) {
    throw new Error("Content too large");
  }
  const path = resolvePath(project, rel);
  if (existsSync(path) && statSync(path).isDirectory()) throw new Error("is_dir");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
  const outPath = isAbsoluteApiPath(rel) ? path : rel;
  return { path: outPath, size: statSync(path).size, ok: true };
}
