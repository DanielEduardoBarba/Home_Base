import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export function bundleRoot(): string {
  // Source tree: server/src → repo root. Installed Bun binary: prefer share dir.
  const share = "/usr/share/homebased";
  if (existsSync(join(share, "web", "dist", "index.html"))) return share;
  return resolve(here, "../..");
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
  for (const d of [ROOT, RUNTIME_DIR, join(RUNTIME_DIR, "logs"), CONFIG_DIR]) {
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
  const raw = (process.env.HOMEBASE_PORT || "8081").trim();
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 8081;
}
