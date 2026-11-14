/**
 * Run git/gh with the operator (seat) login environment.
 *
 * homebased often runs as root under systemd (HOME=/root). Dan's gh/git
 * credentials live under the seat user's HOME + keyring. When enabled
 * (default), we spawn via setpriv/runuser as the seat user with their
 * login PATH/HOME — argv arrays only, never a shell string.
 */
import {
  chmodSync,
  existsSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { RUNTIME_DIR, ensureRuntimeDirs, loadProjects } from "./config";
import {
  detectSeatUser,
  loginEnvForUser,
  wrapArgvForUser,
  type SeatUser,
} from "./shell_env";
import { resolveProjectOwner } from "./project_owner";

const STATE_PATH = join(RUNTIME_DIR, "git_github.json");

export type OperatorGitSettings = {
  /** Run git/gh as the seat user with their login env (default true). */
  useOperatorLoginEnv: boolean;
  updatedAt?: number;
};

export type OperatorCmdResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  argv: string[];
};

const ALLOWED_BINS = new Set(["git", "gh"]);

function writeJsonAtomic(path: string, data: unknown): void {
  ensureRuntimeDirs();
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  try {
    chmodSync(tmp, 0o600);
  } catch {
    /* ignore */
  }
  renameSync(tmp, path);
}

export function loadOperatorGitSettings(): OperatorGitSettings {
  if (!existsSync(STATE_PATH)) {
    return { useOperatorLoginEnv: true };
  }
  try {
    const raw = JSON.parse(readFileSync(STATE_PATH, "utf8")) as Partial<OperatorGitSettings>;
    return {
      useOperatorLoginEnv: raw.useOperatorLoginEnv !== false,
      updatedAt: Number(raw.updatedAt) || undefined,
    };
  } catch {
    return { useOperatorLoginEnv: true };
  }
}

export function saveOperatorGitSettings(
  patch: Partial<Pick<OperatorGitSettings, "useOperatorLoginEnv">>,
): OperatorGitSettings {
  const cur = loadOperatorGitSettings();
  const next: OperatorGitSettings = {
    useOperatorLoginEnv:
      typeof patch.useOperatorLoginEnv === "boolean"
        ? patch.useOperatorLoginEnv
        : cur.useOperatorLoginEnv !== false,
    updatedAt: Date.now(),
  };
  writeJsonAtomic(STATE_PATH, next);
  return next;
}

export function operatorLoginEnvEnabled(): boolean {
  // Test harness escape hatch: root-owned 0700 temp dirs are not readable after setpriv.
  if (process.env.HOMEBASE_OPERATOR_GIT_ENV === "0") return false;
  return loadOperatorGitSettings().useOperatorLoginEnv !== false;
}

/**
 * Refuse shell metacharacters in argv (defense in depth).
 * Destructive git flags stay in git.ts / github.ts allow-lists — this layer
 * only ensures we never open a shell-injection surface when spawning.
 */
export function assertSafeOperatorArgv(args: string[]): string | null {
  for (const a of args) {
    if (typeof a !== "string" || a.includes("\0")) return "invalid argument";
    if (/[;|&`$]/.test(a)) return "shell metacharacters are not allowed";
  }
  return null;
}

function resolveBin(name: string, pathEnv: string): string | null {
  if (!ALLOWED_BINS.has(name)) return null;
  for (const dir of pathEnv.split(":")) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  // Fall back to well-known absolute paths (still argv, never shell).
  for (const candidate of [`/usr/bin/${name}`, `/bin/${name}`, `/usr/local/bin/${name}`]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export type BuiltOperatorCmd = {
  file: string;
  args: string[];
  /** Full argv including setpriv wrapper when used (for diagnostics/tests). */
  argv: string[];
  env: NodeJS.ProcessEnv;
  seat: SeatUser;
  usedLoginEnv: boolean;
  wrappedForSeat: boolean;
};

/**
 * Build spawn argv + env for git/gh. Never joins into a shell string.
 * When `cwd` is set, drop privileges to that checkout's owner (HB-OWN-01).
 * Exported for unit tests.
 */
export function buildOperatorCmd(
  cmd: string,
  args: string[],
  opts: { forceLoginEnv?: boolean; cwd?: string } = {},
): BuiltOperatorCmd | { error: string } {
  if (!ALLOWED_BINS.has(cmd)) {
    return { error: `binary not allow-listed: ${cmd}` };
  }
  const bad = assertSafeOperatorArgv(args);
  if (bad) return { error: bad };

  const useLogin =
    typeof opts.forceLoginEnv === "boolean"
      ? opts.forceLoginEnv
      : operatorLoginEnvEnabled();
  const seat =
    opts.cwd && String(opts.cwd).trim()
      ? resolveProjectOwner(opts.cwd)
      : detectSeatUser();

  let env: NodeJS.ProcessEnv;
  if (useLogin) {
    const login = loginEnvForUser(seat);
    env = {
      ...login,
      GIT_TERMINAL_PROMPT: "0",
      GH_PROMPT_DISABLED: "1",
      GIT_OPTIONAL_LOCKS: "0",
      HOME: seat.home,
      USER: seat.name,
      LOGNAME: seat.name,
      SHELL: seat.shell || login.SHELL || "/bin/bash",
    };
  } else {
    env = {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GH_PROMPT_DISABLED: "1",
      GIT_OPTIONAL_LOCKS: "0",
    };
  }

  // Prefer additive GIT_CONFIG_* safe.directory (seat-owned trees under root).
  const existing = Number(env.GIT_CONFIG_COUNT || "0");
  let hasSafe = false;
  for (let i = 0; i < existing; i++) {
    if (env[`GIT_CONFIG_KEY_${i}`] === "safe.directory") {
      hasSafe = true;
      break;
    }
  }
  if (!hasSafe) {
    const n = Number.isFinite(existing) && existing > 0 ? existing : 0;
    env.GIT_CONFIG_COUNT = String(n + 1);
    env[`GIT_CONFIG_KEY_${n}`] = "safe.directory";
    env[`GIT_CONFIG_VALUE_${n}`] = "*";
  }

  const bin = resolveBin(cmd, env.PATH || process.env.PATH || "") || cmd;
  let argv = [bin, ...args];
  let wrappedForSeat = false;
  if (useLogin) {
    const wrapped = wrapArgvForUser(seat, argv);
    if (wrapped.length !== argv.length || wrapped[0] !== argv[0]) {
      wrappedForSeat = true;
      argv = wrapped;
    }
  }

  return {
    file: argv[0]!,
    args: argv.slice(1),
    argv,
    env,
    seat,
    usedLoginEnv: useLogin,
    wrappedForSeat,
  };
}

export type OperatorCmdRunner = (
  cmd: string,
  args: string[],
  opts?: { cwd?: string; timeoutMs?: number; forceLoginEnv?: boolean },
) => OperatorCmdResult;

function defaultOperatorRunner(
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number; forceLoginEnv?: boolean } = {},
): OperatorCmdResult {
  const built = buildOperatorCmd(cmd, args, {
    forceLoginEnv: opts.forceLoginEnv,
    cwd: opts.cwd,
  });
  if ("error" in built) {
    return { code: 1, stdout: "", stderr: built.error, argv: [cmd, ...args] };
  }
  const r = spawnSync(built.file, built.args, {
    cwd: opts.cwd,
    encoding: "utf8",
    timeout: opts.timeoutMs ?? 180_000,
    maxBuffer: 8 * 1024 * 1024,
    env: built.env,
  });
  return {
    code: r.status,
    stdout: (r.stdout || "").toString(),
    stderr:
      (r.stderr || "").toString() ||
      (r.error ? String(r.error.message) : ""),
    argv: built.argv,
  };
}

let runner: OperatorCmdRunner = defaultOperatorRunner;

/** Test-only: stub git/gh runner. Pass null to restore. */
export function _setOperatorCmdRunnerForTests(next: OperatorCmdRunner | null): void {
  runner = next || defaultOperatorRunner;
}

export function runOperatorCmd(
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number; forceLoginEnv?: boolean } = {},
): OperatorCmdResult {
  return runner(cmd, args, opts);
}

function toolProbe(bin: "git" | "gh"): {
  found: boolean;
  path: string | null;
  version: string | null;
} {
  const built = buildOperatorCmd(bin, ["--version"]);
  if ("error" in built) {
    return { found: false, path: null, version: null };
  }
  const r = spawnSync(built.file, built.args, {
    encoding: "utf8",
    timeout: 8_000,
    env: built.env,
  });
  const text = `${r.stdout || ""}${r.stderr || ""}`.trim();
  const version = text.split("\n")[0]?.trim() || null;
  // Prefer the real binary path (last argv after setpriv --).
  const dashDash = built.argv.indexOf("--");
  const path =
    dashDash >= 0 && built.argv[dashDash + 1]
      ? built.argv[dashDash + 1]!
      : built.argv[0] || null;
  return {
    found: r.status === 0 && Boolean(version),
    path: path && path !== "setpriv" && path !== "runuser" ? path : resolveBin(bin, built.env.PATH || "") ,
    version: r.status === 0 ? version : null,
  };
}

export type DistroInstallPlan = {
  id: string;
  packages: string[];
  /** Fixed argv for guided install (never a shell string). */
  argv: string[];
  hint: string;
  needsConfirm: true;
};

export function detectInstallPlan(missing: Array<"git" | "gh">): DistroInstallPlan | null {
  if (!missing.length) return null;
  let id = "linux";
  try {
    const os = readFileSync("/etc/os-release", "utf8");
    if (/ubuntu|debian|pop|linuxmint/i.test(os)) id = "debian";
    else if (/fedora|rhel|centos|rocky|alma/i.test(os)) id = "fedora";
    else if (/arch|manjaro/i.test(os)) id = "arch";
  } catch {
    /* keep linux */
  }
  const pkgs = [...missing];
  if (id === "debian") {
    return {
      id,
      packages: pkgs,
      argv: ["sudo", "apt-get", "install", "-y", ...pkgs],
      hint: `Install with: sudo apt-get install -y ${pkgs.join(" ")} (confirm in Shell; never silent sudo).`,
      needsConfirm: true,
    };
  }
  if (id === "fedora") {
    return {
      id,
      packages: pkgs,
      argv: ["sudo", "dnf", "install", "-y", ...pkgs],
      hint: `Install with: sudo dnf install -y ${pkgs.join(" ")} (confirm in Shell).`,
      needsConfirm: true,
    };
  }
  if (id === "arch") {
    return {
      id,
      packages: pkgs,
      argv: ["sudo", "pacman", "-S", "--noconfirm", ...pkgs],
      hint: `Install with: sudo pacman -S ${pkgs.join(" ")} (confirm in Shell).`,
      needsConfirm: true,
    };
  }
  return {
    id,
    packages: pkgs,
    argv: ["sudo", "apt-get", "install", "-y", ...pkgs],
    hint: `Install git/gh for your distro, then re-test. Suggested: sudo apt-get install -y ${pkgs.join(" ")}`,
    needsConfirm: true,
  };
}

export type GitEnvCheck = {
  useOperatorLoginEnv: boolean;
  seat: { name: string; uid: number; home: string; shell: string };
  service: { user: string | null; home: string | null; uid: number | null };
  env: {
    HOME: string | null;
    PATH: string | null;
    USER: string | null;
    LOGNAME: string | null;
    SHELL: string | null;
    XDG_CONFIG_HOME: string | null;
    GH_CONFIG_DIR: string | null;
    wrappedForSeat: boolean;
  };
  git: { found: boolean; path: string | null; version: string | null };
  gh: { found: boolean; path: string | null; version: string | null };
  install: DistroInstallPlan | null;
  hint: string | null;
};

export function gitEnvCheck(): GitEnvCheck {
  const settings = loadOperatorGitSettings();
  const seat = detectSeatUser();
  const built = buildOperatorCmd("git", ["--version"]);
  const envSnap =
    "error" in built
      ? {
          HOME: process.env.HOME || null,
          PATH: process.env.PATH || null,
          USER: process.env.USER || null,
          LOGNAME: process.env.LOGNAME || null,
          SHELL: process.env.SHELL || null,
          XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME || null,
          GH_CONFIG_DIR: process.env.GH_CONFIG_DIR || null,
          wrappedForSeat: false,
        }
      : {
          HOME: built.env.HOME || null,
          PATH: built.env.PATH || null,
          USER: built.env.USER || null,
          LOGNAME: built.env.LOGNAME || null,
          SHELL: built.env.SHELL || null,
          XDG_CONFIG_HOME: built.env.XDG_CONFIG_HOME || null,
          GH_CONFIG_DIR: built.env.GH_CONFIG_DIR || null,
          wrappedForSeat: built.wrappedForSeat,
        };

  const git = toolProbe("git");
  const gh = toolProbe("gh");
  const missing: Array<"git" | "gh"> = [];
  if (!git.found) missing.push("git");
  if (!gh.found) missing.push("gh");
  const install = detectInstallPlan(missing);

  const loginOn =
    process.env.HOMEBASE_OPERATOR_GIT_ENV === "0"
      ? false
      : settings.useOperatorLoginEnv !== false;

  let hint: string | null = null;
  if (missing.length) {
    hint = install?.hint || `Missing: ${missing.join(", ")}`;
  } else if (!loginOn) {
    hint =
      "Operator login env is off — git/gh may run as the service user (often root) without your gh keyring.";
  } else if (
    typeof process.getuid === "function" &&
    process.getuid() === 0 &&
    seat.uid > 0 &&
    !envSnap.wrappedForSeat
  ) {
    hint =
      "Could not wrap with setpriv/runuser — install setpriv so git/gh run as your seat user.";
  }

  return {
    useOperatorLoginEnv: loginOn,
    seat: {
      name: seat.name,
      uid: seat.uid,
      home: seat.home,
      shell: seat.shell,
    },
    service: {
      user: process.env.USER || null,
      home: process.env.HOME || null,
      uid: typeof process.getuid === "function" ? process.getuid() : null,
    },
    env: envSnap,
    git,
    gh,
    install,
    hint,
  };
}

export type ConnectionTestResult = {
  ok: boolean;
  gh: {
    ok: boolean;
    loggedIn: boolean;
    user: string | null;
    detail: string;
  };
  lsRemote: {
    ok: boolean;
    projectId: string | null;
    origin: string | null;
    detail: string;
  };
  env: GitEnvCheck;
  hint: string | null;
};

export function testGitGithubConnection(opts: {
  projectId?: string;
} = {}): ConnectionTestResult {
  const env = gitEnvCheck();
  const auth = runOperatorCmd("gh", ["auth", "status"], { timeoutMs: 15_000 });
  const text = `${auth.stdout}\n${auth.stderr}`;
  const userMatch =
    text.match(/Logged in to github\.com account (\S+)/i) ||
    text.match(/account (\S+)/i);
  const user = userMatch?.[1]?.replace(/[()]/g, "") || null;
  const loggedIn =
    auth.code === 0 &&
    /Logged in to github\.com/i.test(text) &&
    !/token .* is invalid/i.test(text) &&
    !/Failed to log in/i.test(text);

  let projectId = String(opts.projectId || "").trim() || null;
  const projects = loadProjects();
  if (!projectId) {
    projectId = projects.has("homebase")
      ? "homebase"
      : [...projects.keys()][0] || null;
  }
  const project = projectId ? projects.get(projectId) : undefined;
  let origin: string | null = null;
  let lsOk = false;
  let lsDetail = "No project selected";
  if (project) {
    const originR = runOperatorCmd("git", ["remote", "get-url", "origin"], {
      cwd: project.path,
      timeoutMs: 10_000,
    });
    origin = originR.code === 0 ? originR.stdout.trim() || null : null;
    if (origin) {
      // Strip embedded credentials from display / response.
      const safeOrigin = origin.replace(/^(https?:\/\/)[^/@]+@/i, "$1");
      const ls = runOperatorCmd("git", ["ls-remote", "--heads", "origin"], {
        cwd: project.path,
        timeoutMs: 60_000,
      });
      lsOk = ls.code === 0;
      lsDetail = lsOk
        ? `ls-remote ok (${safeOrigin})`
        : (ls.stderr || ls.stdout || "git ls-remote failed").slice(0, 300);
      origin = safeOrigin;
    } else {
      lsDetail = "No origin remote on this project";
    }
  }

  const ghOk = loggedIn;
  const ok = ghOk && (lsOk || !project);
  let hint: string | null = null;
  if (!env.git.found || !env.gh.found) {
    hint = env.hint || env.install?.hint || "Install git and gh first";
  } else if (!loggedIn) {
    hint =
      "Sign in to GitHub in Settings → Git & GitHub (opens Shell: gh auth login -h github.com)";
  } else if (project && !lsOk) {
    hint =
      "gh is signed in but git ls-remote failed — run “Use gh for git pushes” (gh auth setup-git), then re-test.";
  }

  return {
    ok,
    gh: {
      ok: ghOk,
      loggedIn,
      user,
      detail: loggedIn
        ? `Signed in as ${user}`
        : (auth.stderr || auth.stdout || "gh not signed in").slice(0, 240),
    },
    lsRemote: {
      ok: lsOk,
      projectId,
      origin,
      detail: lsDetail,
    },
    env,
    hint,
  };
}

export function runGhAuthSetupGit(): {
  ok: boolean;
  stdout: string;
  stderr: string;
  error?: string;
} {
  const r = runOperatorCmd("gh", ["auth", "setup-git"], { timeoutMs: 30_000 });
  return {
    ok: r.code === 0,
    stdout: r.stdout,
    stderr: r.stderr,
    error: r.code === 0 ? undefined : (r.stderr || r.stdout || "gh auth setup-git failed").slice(0, 400),
  };
}

/** Fixed argv for interactive gh sign-in (human finishes in web terminal). */
export const GH_AUTH_LOGIN_ARGV = ["gh", "auth", "login", "-h", "github.com"] as const;

function pickProjectForShell(projectId?: string): { id: string; path: string } | null {
  const projects = loadProjects();
  const want = String(projectId || "").trim();
  if (want && projects.has(want)) {
    const p = projects.get(want)!;
    return { id: p.id, path: p.path };
  }
  if (projects.has("homebase")) {
    const p = projects.get("homebase")!;
    return { id: p.id, path: p.path };
  }
  const first = [...projects.values()][0];
  return first ? { id: first.id, path: first.path } : null;
}

export async function openGuidedGitShell(opts: {
  kind: "signin" | "install";
  projectId?: string;
  confirmInstall?: boolean;
}): Promise<{
  ok: boolean;
  error?: string;
  sessionId?: string;
  projectId?: string;
  argv?: string[];
  hint?: string;
}> {
  const { spawnShell } = await import("./pty");
  const project = pickProjectForShell(opts.projectId);
  if (!project) {
    return { ok: false, error: "No project available to host a Shell session" };
  }

  let argv: string[];
  let title: string;
  if (opts.kind === "signin") {
    argv = [...GH_AUTH_LOGIN_ARGV];
    title = "gh auth login";
  } else {
    const env = gitEnvCheck();
    const plan = env.install;
    if (!plan) {
      return {
        ok: false,
        error: "git and gh are already installed",
        hint: "Nothing to install",
      };
    }
    if (!opts.confirmInstall) {
      return {
        ok: false,
        error: "Install requires confirmInstall: true (never silent sudo)",
        argv: plan.argv,
        hint: plan.hint,
      };
    }
    argv = [...plan.argv];
    title = `install ${plan.packages.join(" ")}`;
  }

  // spawnShell wraps with seat setpriv + login env; argv stays an array.
  const info = spawnShell({
    projectId: project.id,
    cwd: project.path,
    kind: "shell",
    title,
    command: argv,
  });
  return {
    ok: true,
    sessionId: info.id,
    projectId: project.id,
    argv,
    hint:
      opts.kind === "signin"
        ? "Finish sign-in in the Shell tab. Home Base never stores the token."
        : "Confirm the sudo prompt in Shell if asked. Home Base does not run silent sudo.",
  };
}
