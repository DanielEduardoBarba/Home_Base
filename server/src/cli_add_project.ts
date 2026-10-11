/**
 * CLI for ./build.sh --add-project (preset upsert into config/projects.json).
 *
 *   bun run src/cli_add_project.ts --preset example --path /abs/repo [--id x] [--name Y]
 *   bun run src/cli_add_project.ts --path /abs/repo [--id x] [--name Y]
 */
import { basename, resolve } from "node:path";
import { existsSync, statSync } from "node:fs";
import { loadPreset, upsertProject } from "./config";

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  if (i < 0) return undefined;
  return process.argv[i + 1];
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9_-]+/g, "").replace(/^-+|-+$/g, "") || "app";
}

const preset = arg("--preset");
const pathRaw = arg("--path");
const idOverride = arg("--id");
const nameOverride = arg("--name");

if (!pathRaw) {
  console.error("Error: --path is required");
  process.exit(1);
}
const abs = resolve(pathRaw);
if (!existsSync(abs) || !statSync(abs).isDirectory()) {
  console.error(`Error: path does not exist or is not a directory: ${abs}`);
  process.exit(1);
}

if (preset) {
  const raw = loadPreset(preset);
  delete raw.path;
  raw.path = abs;
  if (idOverride) raw.id = idOverride;
  if (nameOverride) raw.name = nameOverride;
  if (!raw.id) raw.id = slug(basename(abs));
  if (!raw.name) raw.name = basename(abs);
  upsertProject(raw);
  console.log(`Added preset '${preset}': ${raw.id} → ${raw.path}`);
} else {
  const id = idOverride || slug(basename(abs));
  const name = nameOverride || basename(abs);
  upsertProject({
    id,
    name,
    path: abs,
    ports: [],
    actions: [],
  });
  console.log(`Added project: ${id} → ${abs}`);
  console.log("Edit config/projects.json to add button → script → args actions.");
}
