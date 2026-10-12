import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export function bundleRoot(): string {
  const override = (process.env.HOMEBASE_BUNDLE_ROOT || "").trim();
  if (override) return resolve(override);
  // Source tree: server/src → repo root. Prefer the checkout when present so
  // ./build.sh --setup/--run never pick /usr/share just because prod is installed.
  const sourceRoot = resolve(here, "../..");
  if (existsSync(join(sourceRoot, "build.sh"))) return sourceRoot;
  // Bun --compile: import.meta is inside the binary; use execPath (…/dist/homebase
  // → repo root) so local probes don't inherit a stale /usr/share VERSION.
  try {
    const execDir = dirname(process.execPath);
    const fromDist = resolve(execDir, "..");
    if (existsSync(join(fromDist, "build.sh"))) return fromDist;
    if (existsSync(join(execDir, "VERSION"))) return execDir;
  } catch {
    /* ignore */
  }
  const share = "/usr/share/homebased";
  if (existsSync(join(share, "web", "dist", "index.html"))) return share;
  return sourceRoot;
}

export function homeRoot(): string {
  const env = (process.env.HOMEBASE_HOME || "").trim();
  if (env) return resolve(env);
  const bundle = bundleRoot();
  if (existsSync(join(bundle, "build.sh"))) return bundle;
  for (const candidate of ["/var/lib/homebased", "/var/lib/homebase"]) {
    if (existsSync(candidate)) return candidate;
  }
  return "/var/lib/homebased";
}

export const BUNDLE_ROOT = bundleRoot();
export const ROOT = homeRoot();

function loadDotEnv(path: string): void {
  try {
    if (!existsSync(path)) return;
    const text = readFileSync(path, "utf8");
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (key && process.env[key] === undefined) {
        process.env[key] = val;
      }
    }
  } catch {
    /* seat helpers may lack read on root .env */
  }
}

loadDotEnv(join(ROOT, ".env"));

export const RUNTIME_DIR = resolve(
  process.env.HOMEBASE_RUNTIME || join(ROOT, ".runtime"),
);
export const CONFIG_DIR = join(ROOT, "config");
export const PROJECTS_PATH = resolve(
  process.env.HOMEBASE_PROJECTS || join(CONFIG_DIR, "projects.json"),
);
export const AGENTS_PATH = join(RUNTIME_DIR, "agents.json");
export const LOCKOUT_PATH = join(RUNTIME_DIR, "lockout.json");
export const NOTIFICATIONS_PATH = join(RUNTIME_DIR, "notifications.jsonl");
export const AUTH_PATH = join(RUNTIME_DIR, "auth.json");
export const JWT_SECRET_PATH = join(RUNTIME_DIR, "jwt_secret");

export function ensureRuntimeDirs(): void {
  for (const d of [
    ROOT,
    RUNTIME_DIR,
    join(RUNTIME_DIR, "logs"),
    join(RUNTIME_DIR, "chats"),
    CONFIG_DIR,
  ]) {
    try {
      mkdirSync(d, { recursive: true });
    } catch {
      /* ignore */
    }
  }
}

export type PortDef = {
  id: string;
  port: number;
  label: string;
  health?: string;
};

export type ActionDef = {
  id: string;
  label: string;
  type: string;
  script: string;
  args: string[];
  kind: string;
  group: string;
  variant: string;
  hint: string;
  restartAction: string;
  compose: string[];
  env: Record<string, string>;
};

export type Project = {
  id: string;
  name: string;
  path: string;
  ports: PortDef[];
  actions: ActionDef[];
  stateDir: string;
};

function actionFromRaw(raw: Record<string, unknown>): ActionDef {
  const envRaw = (raw.env as Record<string, string> | undefined) || {};
  const composeRaw = (raw.compose as unknown[]) || [];
  return {
    id: String(raw.id),
    label: String(raw.label || raw.id),
    type: String(raw.type || "script"),
    script: String(raw.script || ""),
    args: ((raw.args as unknown[]) || []).map(String),
    kind: String(raw.kind || "action"),
    group: String(raw.group || "main"),
    variant: String(raw.variant || "default"),
    hint: String(raw.hint || ""),
    restartAction: String(raw.restartAction || raw.restart_action || ""),
    compose: composeRaw.map(String),
    env: Object.fromEntries(
      Object.entries(envRaw).map(([k, v]) => [String(k), String(v)]),
    ),
  };
}

function presetsDir(): string {
  const bundled = join(BUNDLE_ROOT, "config", "presets");
  if (existsSync(bundled)) return bundled;
  return join(CONFIG_DIR, "presets");
}

export function loadPreset(name: string): Record<string, unknown> {
  const path = join(presetsDir(), `${name}.json`);
  if (!existsSync(path)) {
    throw new Error(`Unknown preset: ${name}`);
  }
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

export function listPresets(): { id: string; name: string }[] {
  const dir = presetsDir();
  if (!existsSync(dir)) return [];
  const out: { id: string; name: string }[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(".json")) continue;
    const id = name.slice(0, -5);
    try {
      const raw = JSON.parse(readFileSync(join(dir, name), "utf8")) as {
        id?: string;
        name?: string;
      };
      out.push({
        id: String(raw.id || id),
        name: String(raw.name || raw.id || id),
      });
    } catch {
      out.push({ id, name: id });
    }
  }
  return out;
}

function slugId(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "")
      .replace(/^-+|-+$/g, "") || "app"
  );
}

/** Upsert from preset name and/or raw fields (used by REST + Chat tools). */
export function upsertProjectFromInput(input: {
  path: string;
  preset?: string;
  id?: string;
  name?: string;
  ports?: unknown[];
  actions?: unknown[];
}): Project {
  const abs = resolve(String(input.path || "").trim());
  if (!abs) throw new Error("path required");
  let raw: Record<string, unknown>;
  if (input.preset) {
    raw = { ...loadPreset(input.preset) };
    delete raw.path;
  } else {
    raw = {
      ports: input.ports || [],
      actions: input.actions || [],
    };
  }
  raw.path = abs;
  raw.id = String(input.id || raw.id || slugId(basename(abs)));
  raw.name = String(input.name || raw.name || basename(abs));
  if (input.ports) raw.ports = input.ports;
  if (input.actions) raw.actions = input.actions;
  return upsertProject(raw);
}

export function deleteProject(id: string): boolean {
  const want = String(id || "").trim();
  if (!want) throw new Error("project id required");
  ensureProjectsFile();
  const data = JSON.parse(
    readFileSync(PROJECTS_PATH, "utf8") || '{"projects":[]}',
  ) as { projects?: Record<string, unknown>[] };
  const projects = Array.isArray(data.projects) ? data.projects : [];
  const next = projects.filter((p) => String(p?.id) !== want);
  if (next.length === projects.length) return false;
  data.projects = next;
  writeFileSync(PROJECTS_PATH, `${JSON.stringify(data, null, 2)}\n`);
  return true;
}

/** Seed / refresh the Home Base repo itself as a project. */
export function seedHomebaseProject(repoRoot?: string): Project {
  const root = resolve(repoRoot || BUNDLE_ROOT);
  return upsertProjectFromInput({
    path: root,
    preset: "homebase",
    id: "homebase",
    name: "Home Base",
  });
}

function ensureProjectsFile(): void {
  ensureRuntimeDirs();
  if (existsSync(PROJECTS_PATH)) return;
  const example = join(BUNDLE_ROOT, "config", "projects.example.json");
  const seed = existsSync(example)
    ? readFileSync(example, "utf8")
    : '{\n  "projects": []\n}\n';
  writeFileSync(PROJECTS_PATH, seed.endsWith("\n") ? seed : `${seed}\n`);
}

/** Insert or replace a project raw object in config/projects.json. */
export function upsertProject(raw: Record<string, unknown>): Project {
  const id = String(raw.id || "").trim();
  if (!id) throw new Error("project id required");
  const path = String(raw.path || "").trim();
  if (!path) throw new Error("project path required");
  ensureProjectsFile();
  const data = JSON.parse(readFileSync(PROJECTS_PATH, "utf8") || '{"projects":[]}') as {
    projects?: Record<string, unknown>[];
  };
  const projects = Array.isArray(data.projects) ? [...data.projects] : [];
  let replaced = false;
  for (let i = 0; i < projects.length; i++) {
    if (String(projects[i]?.id) === id) {
      projects[i] = raw;
      replaced = true;
      break;
    }
  }
  if (!replaced) projects.push(raw);
  data.projects = projects;
  writeFileSync(PROJECTS_PATH, `${JSON.stringify(data, null, 2)}\n`);
  const ports = ((raw.ports as Record<string, unknown>[]) || []).map((p) => ({
    id: String(p.id),
    port: Number(p.port),
    label: String(p.label || ""),
    health: p.health != null ? String(p.health) : undefined,
  }));
  return {
    id,
    name: String(raw.name || id),
    path,
    ports,
    actions: ((raw.actions as Record<string, unknown>[]) || []).map(actionFromRaw),
    stateDir: String(raw.stateDir || raw.state_dir || ""),
  };
}

export function loadProjects(): Map<string, Project> {
  const map = new Map<string, Project>();
  if (!existsSync(PROJECTS_PATH)) return map;
  try {
    const data = JSON.parse(readFileSync(PROJECTS_PATH, "utf8")) as {
      projects?: Record<string, unknown>[];
    };
    for (const raw of data.projects || []) {
      const ports = ((raw.ports as Record<string, unknown>[]) || []).map((p) => ({
        id: String(p.id),
        port: Number(p.port),
        label: String(p.label || ""),
        health: p.health != null ? String(p.health) : undefined,
      }));
      const proj: Project = {
        id: String(raw.id),
        name: String(raw.name || raw.id),
        path: String(raw.path),
        ports,
        actions: ((raw.actions as Record<string, unknown>[]) || []).map(
          actionFromRaw,
        ),
        stateDir: String(raw.stateDir || raw.state_dir || ""),
      };
      map.set(proj.id, proj);
    }
  } catch {
    /* empty */
  }
  return map;
}

export function readVersion(): string {
  for (const p of [
    join(BUNDLE_ROOT, "VERSION"),
    join(ROOT, "VERSION"),
    "/usr/share/homebased/VERSION",
  ]) {
    try {
      if (existsSync(p)) {
        const v = readFileSync(p, "utf8").trim().split("\n")[0]?.trim();
        if (v) return v;
      }
    } catch {
      /* continue */
    }
  }
  return "0.0.0";
}

export function isBackupBinary(): boolean {
  return process.env.HOMEBASE_RUNNING_BACKUP === "1";
}

export function bindHost(): string {
  return (process.env.HOMEBASE_HOST || "0.0.0.0").trim() || "0.0.0.0";
}

export function bindPort(): number {
  const raw = (process.env.HOMEBASE_PORT || "8080").trim();
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 8080;
}
