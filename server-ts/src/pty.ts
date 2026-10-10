/**
 * Shell sessions (pipe-backed).
 * Full PTY (node-pty) crashes Bun 1.3.11 — see REVIEW R-004.
 */
import { randomBytes } from "node:crypto";
import type { Subprocess } from "bun";
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
};

type Subscriber = {
  send: (data: string | Buffer) => void;
};

type PtyBackend = {
  pid: number;
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  kill: () => void;
  onData: (cb: (data: string) => void) => void;
  onExit: (cb: (code: number) => void) => void;
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

function makePipeBackend(
  file: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
): PtyBackend {
  const proc = Bun.spawn([file, ...args], {
    cwd,
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  }) as Subprocess & {
    stdin: { write: (d: string | Buffer) => number; end: () => void };
  };

  const dataCbs: Array<(d: string) => void> = [];
  const exitCbs: Array<(c: number) => void> = [];

  void (async () => {
    const out = proc.stdout;
    if (out && typeof out !== "number") {
      const reader = (out as ReadableStream<Uint8Array>).getReader();
      const dec = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = dec.decode(value);
        for (const cb of dataCbs) cb(text);
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
        const text = dec.decode(value);
        for (const cb of dataCbs) cb(text);
      }
    }
  })();

  void proc.exited.then((code) => {
    for (const cb of exitCbs) cb(code ?? 0);
  });

  return {
    pid: proc.pid,
    write: (data: string) => {
      try {
        proc.stdin.write(data);
      } catch {
        /* ignore */
      }
    },
    resize: () => {
      /* pipes have no resize */
    },
    kill: () => {
      try {
        proc.kill();
      } catch {
        /* ignore */
      }
    },
    onData: (cb) => {
      dataCbs.push(cb);
    },
    onExit: (cb) => {
      exitCbs.push(cb);
    },
  };
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
  if (opts.command && opts.command.length) {
    const wrapped = wrapArgvForSeat(opts.command);
    file = wrapped[0]!;
    args = wrapped.slice(1);
  } else {
    const wrapped = wrapArgvForSeat([shell, "-l"]);
    file = wrapped[0]!;
    args = wrapped.slice(1);
  }

  const backend = makePipeBackend(file, args, opts.cwd, baseEnv);
  const info: SessionInfo = {
    id,
    projectId: opts.projectId,
    kind: opts.kind || "shell",
    cwd: opts.cwd,
    pid: backend.pid,
    createdAt: Date.now() / 1000,
    title: opts.title || "shell",
  };

  const session: PtySession = {
    info,
    backend,
    ring: "",
    subscribers: new Set(),
    exited: false,
  };
  sessions.set(id, session);

  backend.onData((data) => {
    pushRing(session, data);
    const msg = JSON.stringify({ type: "output", data });
    for (const sub of session.subscribers) {
      try {
        sub.send(msg);
      } catch {
        /* ignore */
      }
    }
  });

  backend.onExit((exitCode) => {
    session.exited = true;
    const msg = JSON.stringify({ type: "exit", code: exitCode });
    for (const sub of session.subscribers) {
      try {
        sub.send(msg);
      } catch {
        /* ignore */
      }
    }
    appendTrace("info", `shell exit ${id} code=${exitCode}`, "pty");
    sessions.delete(id);
  });

  appendTrace("info", `shell spawn ${id} cwd=${opts.cwd} mode=pipe`, "pty");
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
  const s = sessions.get(sessionId);
  if (!s) return;
  s.subscribers.delete(sub);
}

export function writeInput(sessionId: string, data: string): void {
  sessions.get(sessionId)?.backend.write(data);
}

export function resize(sessionId: string, cols: number, rows: number): void {
  try {
    sessions.get(sessionId)?.backend.resize(cols, rows);
  } catch {
    /* ignore */
  }
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
