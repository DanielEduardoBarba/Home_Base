/**
 * Real PTY sessions via Bun.Terminal (Bun.spawn `{ terminal }`).
 * Falls back to pipes if openpty fails (e.g. restricted sandboxes).
 */
import { randomBytes } from "node:crypto";
import type { Subprocess, Terminal } from "bun";
import { detectSeatUser, loginEnvForSeat, wrapArgvForSeat } from "./shell_env";
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

  void (async () => {
    const out = proc.stdout;
    if (out && typeof out !== "number") {
      const reader = (out as ReadableStream<Uint8Array>).getReader();
      const dec = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        onData(dec.decode(value));
      }
    }
  })();
  void (async () => {
    const err = proc.stderr;
    if (err && typeof err !== "number") {
      const reader = (err as ReadableStream<Uint8Array>).getReader();
      const dec = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        onData(dec.decode(value));
      }
    }
  })();
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
    const proc = Bun.spawn([file, ...args], {
      cwd,
      env,
      terminal: {
        cols,
        rows,
        data(_t, data) {
          const text =
            typeof data === "string" ? data : new TextDecoder().decode(data);
          onData(text);
        },
      },
    });
    term = proc.terminal;
    if (!term) return null;
    void proc.exited.then((code) => onExit(code ?? 0));
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

export function listSessions(projectId?: string): SessionInfo[] {
  const out: SessionInfo[] = [];
  for (const s of sessions.values()) {
    if (!projectId || s.info.projectId === projectId) out.push(s.info);
  }
  return out;
}

export function getSession(id: string): PtySession | undefined {
  return sessions.get(id);
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
  const seat = detectSeatUser();
  const baseEnv = { ...loginEnvForSeat(), ...(opts.env || {}) };
  const shell = seat.shell || "/bin/bash";
  let file = shell;
  let args = ["-l"];
  if (opts.command?.length) {
    const wrapped = wrapArgvForSeat(opts.command);
    file = wrapped[0]!;
    args = wrapped.slice(1);
  } else {
    const wrapped = wrapArgvForSeat([shell, "-l"]);
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
    appendTrace("info", `pty exit ${id} code=${exitCode}`, "pty");
    sessions.delete(id);
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
