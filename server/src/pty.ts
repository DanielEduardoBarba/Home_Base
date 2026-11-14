/**
 * Real PTY sessions via Bun.Terminal (Bun.spawn `{ terminal }`).
 * Falls back to pipes if openpty fails (e.g. restricted sandboxes).
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { Subprocess, Terminal } from "bun";
import { enrichPtyEnv, loginEnvForUser, wrapArgvForUser } from "./shell_env";
import { resolveProjectOwner } from "./project_owner";
import { appendTrace } from "./trace";

export type SessionInfo = {
  id: string;
  projectId: string;
  kind: string;
  cwd: string;
  pid: number;
  createdAt: number;
  title: string;
  mode: "pty" | "pipe";
  cmdline?: string[];
};

/** SPA-facing session row for the client session list. */
export type SessionPublic = SessionInfo & {
  alive: boolean;
  label: string;
  cmdline: string[];
};

type Subscriber = {
  send: (data: string | Buffer) => void;
};

type PtyBackend = {
  pid: number;
  mode: "pty" | "pipe";
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  kill: () => void;
};

type PtySession = {
  info: SessionInfo;
  backend: PtyBackend;
  ring: string;
  subscribers: Set<Subscriber>;
  exited: boolean;
};

const sessions = new Map<string, PtySession>();
const MAX_RING = 200_000;

export type SessionExitListener = (
  sessionId: string,
  projectId: string,
  exitCode: number,
) => void;

const exitListeners = new Set<SessionExitListener>();

/** Register a listener for PTY/session process exit. Returns unsubscribe. */
export function onSessionExit(fn: SessionExitListener): () => void {
  exitListeners.add(fn);
  return () => {
    exitListeners.delete(fn);
  };
}

function emitSessionExit(
  sessionId: string,
  projectId: string,
  exitCode: number,
): void {
  for (const fn of exitListeners) {
    try {
      fn(sessionId, projectId, exitCode);
    } catch {
      /* ignore listener errors */
    }
  }
}

function pushRing(s: PtySession, chunk: string): void {
  s.ring += chunk;
  if (s.ring.length > MAX_RING) s.ring = s.ring.slice(-MAX_RING);
}

function broadcast(s: PtySession, msg: string): void {
  for (const sub of s.subscribers) {
    try {
      sub.send(msg);
    } catch {
      /* ignore */
    }
  }
}

function makePipeBackend(
  file: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
  onData: (d: string) => void,
  onExit: (code: number) => void,
): PtyBackend {
  const proc = Bun.spawn([file, ...args], {
    cwd,
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  }) as Subprocess & {
    stdin: { write: (d: string | Buffer) => number };
  };

  const pump = async (stream: unknown) => {
    if (!stream || typeof stream === "number") return;
    const reader = (stream as ReadableStream<Uint8Array>).getReader();
    // stream:true — chunks often split mid multi-byte UTF-8 (zsh ➜ etc.)
    const dec = new TextDecoder("utf-8", { fatal: false });
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        const tail = dec.decode();
        if (tail) onData(tail);
        break;
      }
      if (value?.byteLength) onData(dec.decode(value, { stream: true }));
    }
  };
  void pump(proc.stdout);
  void pump(proc.stderr);
  void proc.exited.then((code) => onExit(code ?? 0));

  return {
    pid: proc.pid,
    mode: "pipe",
    write: (data) => {
      try {
        proc.stdin.write(data);
      } catch {
        /* ignore */
      }
    },
    resize: () => {},
    kill: () => {
      try {
        proc.kill();
      } catch {
        /* ignore */
      }
    },
  };
}

function makePtyBackend(
  file: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
  cols: number,
  rows: number,
  onData: (d: string) => void,
  onExit: (code: number) => void,
): PtyBackend | null {
  try {
    let term: Terminal | undefined;
    const dec = new TextDecoder("utf-8", { fatal: false });
    const proc = Bun.spawn([file, ...args], {
      cwd,
      env,
      terminal: {
        cols,
        rows,
        data(_t, data) {
          if (typeof data === "string") {
            onData(data);
            return;
          }
          onData(dec.decode(data, { stream: true }));
        },
      },
    });
    term = proc.terminal;
    if (!term) return null;
    void proc.exited.then((code) => {
      const tail = dec.decode();
      if (tail) onData(tail);
      onExit(code ?? 0);
    });
    return {
      pid: proc.pid,
      mode: "pty",
      write: (data) => {
        try {
          term!.write(data);
        } catch {
          /* ignore */
        }
      },
      resize: (c, r) => {
        try {
          term!.resize(c, r);
        } catch {
          /* ignore */
        }
      },
      kill: () => {
        try {
          proc.kill();
        } catch {
          /* ignore */
        }
        try {
          term!.close();
        } catch {
          /* ignore */
        }
      },
    };
  } catch (e) {
    appendTrace(
      "warn",
      `Bun.Terminal open failed: ${e instanceof Error ? e.message : String(e)}`,
      "pty",
    );
    return null;
  }
}

export function toPublic(s: PtySession): SessionPublic {
  return {
    ...s.info,
    alive: !s.exited,
    label: s.info.title,
    cmdline: s.info.cmdline || [],
  };
}

export function listSessions(projectId?: string): SessionPublic[] {
  const out: SessionPublic[] = [];
  for (const s of sessions.values()) {
    if (projectId && s.info.projectId !== projectId) continue;
    out.push(toPublic(s));
  }
  // Alive first, then most recently created dead rows.
  out.sort((a, b) => {
    if (a.alive !== b.alive) return a.alive ? -1 : 1;
    return b.createdAt - a.createdAt;
  });
  return out;
}

/** Kill managed sessions for a project (optional kind filter). Interactive shells omitted unless kinds includes "shell". */
export function killByProject(
  projectId: string,
  kinds?: Set<string>,
): string[] {
  const ids: string[] = [];
  for (const [id, s] of sessions) {
    if (s.info.projectId !== projectId) continue;
    if (kinds && !kinds.has(s.info.kind)) continue;
    ids.push(id);
  }
  const killed: string[] = [];
  for (const id of ids) {
    if (killSession(id)) killed.push(id);
  }
  return killed;
}

export function getSession(id: string): PtySession | undefined {
  return sessions.get(id);
}

/** Read-only tail of a session's PTY ring (no secrets handling here). */
export function readSessionOutput(sessionId: string): {
  projectId: string;
  sessionId: string;
  output: string;
  alive: boolean;
  title: string;
} | undefined {
  const s = sessions.get(sessionId);
  if (!s) return undefined;
  return {
    projectId: s.info.projectId,
    sessionId: s.info.id,
    output: s.ring || "",
    alive: !s.exited,
    title: s.info.title,
  };
}

export function spawnShell(opts: {
  projectId: string;
  cwd: string;
  cols?: number;
  rows?: number;
  kind?: string;
  title?: string;
  command?: string[];
  env?: Record<string, string>;
}): SessionInfo {
  const id = randomBytes(8).toString("hex");
  // HB-OWN-01: run as checkout owner (fallback seat), never root in user repos.
  const seat = resolveProjectOwner(opts.cwd);
  const baseEnv = enrichPtyEnv({ ...loginEnvForUser(seat), ...(opts.env || {}) });
  const shell = seat.shell || "/bin/bash";
  let file = shell;
  let args = ["-l"];
  if (opts.command?.length) {
    const wrapped = wrapArgvForUser(seat, opts.command);
    file = wrapped[0]!;
    args = wrapped.slice(1);
  } else {
    const wrapped = wrapArgvForUser(seat, [shell, "-l"]);
    file = wrapped[0]!;
    args = wrapped.slice(1);
  }

  const cols = opts.cols || 100;
  const rows = opts.rows || 36;

  let session!: PtySession;

  const onData = (data: string) => {
    pushRing(session, data);
    broadcast(session, JSON.stringify({ type: "output", data }));
  };
  const onExit = (exitCode: number) => {
    session.exited = true;
    broadcast(session, JSON.stringify({ type: "exit", code: exitCode }));
    const tail = session.ring.replace(/\s+/g, " ").trim().slice(-360);
    appendTrace(
      exitCode === 0 ? "info" : "warn",
      tail
        ? `pty exit ${id} code=${exitCode} tail=${tail}`
        : `pty exit ${id} code=${exitCode}`,
      "pty",
    );
    emitSessionExit(id, opts.projectId, exitCode ?? 0);
    // Keep the row so the SPA can show dead + dismiss (X); DELETE removes it.
  };

  let backend =
    makePtyBackend(file, args, opts.cwd, baseEnv, cols, rows, onData, onExit) ||
    makePipeBackend(file, args, opts.cwd, baseEnv, onData, onExit);

  const info: SessionInfo = {
    id,
    projectId: opts.projectId,
    kind: opts.kind || "shell",
    cwd: opts.cwd,
    pid: backend.pid,
    createdAt: Date.now() / 1000,
    title: opts.title || "shell",
    mode: backend.mode,
    cmdline: opts.command ? [...opts.command] : [shell, "-l"],
  };

  session = {
    info,
    backend,
    ring: "",
    subscribers: new Set(),
    exited: false,
  };
  sessions.set(id, session);
  appendTrace("info", `pty spawn ${id} cwd=${opts.cwd} mode=${backend.mode}`, "pty");
  if (opts.command?.length) {
    const bins = (baseEnv.PATH || "").split(":");
    if (!bins.some((b) => b && existsSync(join(b, "pnpm")))) {
      appendTrace("warn", `pty spawn ${id} PATH has no pnpm — Run/Expo scripts will exit`, "pty");
    }
  }
  return info;
}

export function attachSubscriber(
  sessionId: string,
  sub: Subscriber,
): SessionInfo | null {
  const s = sessions.get(sessionId);
  if (!s) return null;
  s.subscribers.add(sub);
  if (s.ring) {
    try {
      sub.send(JSON.stringify({ type: "output", data: s.ring }));
    } catch {
      /* ignore */
    }
  }
  try {
    sub.send(JSON.stringify({ type: "ready", session: { id: s.info.id } }));
  } catch {
    /* ignore */
  }
  return s.info;
}

export function detachSubscriber(sessionId: string, sub: Subscriber): void {
  sessions.get(sessionId)?.subscribers.delete(sub);
}

export function writeInput(sessionId: string, data: string): void {
  sessions.get(sessionId)?.backend.write(data);
}

export function resize(sessionId: string, cols: number, rows: number): void {
  sessions.get(sessionId)?.backend.resize(cols, rows);
}

export function killSession(sessionId: string): boolean {
  const s = sessions.get(sessionId);
  if (!s) return false;
  try {
    s.backend.kill();
  } catch {
    /* ignore */
  }
  sessions.delete(sessionId);
  return true;
}

export function interruptSession(sessionId: string): boolean {
  const s = sessions.get(sessionId);
  if (!s) return false;
  try {
    s.backend.write("\x03");
    return true;
  } catch {
    return false;
  }
}
