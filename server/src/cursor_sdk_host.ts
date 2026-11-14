/**
 * HB-OWN-02: Spawn Cursor SDK jobs as a setpriv/runuser child of the checkout
 * owner (real uid/gid/groups), not just HOME/USER env on a root process.
 */
import { spawn, type Subprocess } from "bun";
import { mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import {
  loginEnvForUser,
  setprivPrefix,
  type SeatUser,
} from "./shell_env";
import { resolveProjectOwner } from "./project_owner";
import { appendTrace } from "./trace";

export type SdkWorkerReady = {
  uid: number;
  gid: number;
  pid: number;
};

type Json = Record<string, unknown>;

type ToolDef = {
  description?: string;
  inputSchema?: Record<string, unknown>;
  execute: (args: Record<string, unknown>) => Promise<string>;
};

type AgentRunLike = {
  id?: string;
  status?: string;
  stream: () => AsyncIterable<unknown>;
  wait: () => Promise<{
    status?: string;
    result?: string;
    error?: { message?: string; code?: string };
  }>;
  cancel?: () => Promise<void> | void;
};

type AgentHandleLike = {
  agentId?: string;
  send: (
    message:
      | string
      | {
          text: string;
          images?: Array<{
            data: string;
            mimeType: string;
            dimension?: { width: number; height: number };
          }>;
        },
    options?: {
      mode?: string;
      onDelta?: (args: { update: Record<string, unknown> }) => void | Promise<void>;
    },
  ) => Promise<AgentRunLike>;
  close?: () => Promise<void> | void;
};

function resolveSdkWorkerCmd(): string[] {
  const exec = process.execPath;
  const base = basename(exec).toLowerCase();
  const isBun = base === "bun" || base.startsWith("bun-");
  if (isBun) {
    // Direct worker module — avoid loading entry.ts (ensureAskpass / app boot).
    const worker = join(import.meta.dir, "cursor_sdk_worker.ts");
    return [exec, "run", worker];
  }
  return [exec, "--cursor-sdk-worker"];
}

function encodeMsg(obj: Json): Uint8Array {
  const data = Buffer.from(JSON.stringify(obj), "utf8");
  const hdr = Buffer.alloc(4);
  hdr.writeUInt32BE(data.length, 0);
  return Buffer.concat([hdr, data]);
}

type ByteReader = {
  read: () => Promise<{ done: boolean; value?: Uint8Array }>;
};

async function readExact(
  reader: ByteReader,
  n: number,
  buf: { cur: Uint8Array },
): Promise<Uint8Array> {
  while (buf.cur.length < n) {
    const { done, value } = await reader.read();
    if (done || !value) throw new Error("sdk-worker EOF");
    const next = new Uint8Array(buf.cur.length + value.length);
    next.set(buf.cur);
    next.set(value, buf.cur.length);
    buf.cur = next;
  }
  const out = buf.cur.slice(0, n);
  buf.cur = buf.cur.slice(n);
  return out;
}

async function readMsg(
  reader: ByteReader,
  buf: { cur: Uint8Array },
): Promise<Json> {
  const hdr = await readExact(reader, 4, buf);
  const n = new DataView(hdr.buffer, hdr.byteOffset, hdr.byteLength).getUint32(
    0,
    false,
  );
  if (n <= 0 || n > 64 * 1024 * 1024) throw new Error(`bad size ${n}`);
  const data = await readExact(reader, n, buf);
  return JSON.parse(Buffer.from(data).toString("utf8")) as Json;
}

/** True when homebased is root and the checkout owner is a real non-root user. */
export function shouldRunSdkAsOwner(cwd: string): boolean {
  if (typeof process.getuid !== "function" || process.getuid() !== 0) {
    return false;
  }
  const owner = resolveProjectOwner(cwd);
  return owner.uid > 0 && owner.uid !== 0;
}

/**
 * Spawn a short-lived setpriv child and return its real getuid()/getgid().
 * Used by unit/harness tests (HOMEBASE_SDK_PROBE=1).
 */
export async function probeSdkOwnerChildUid(
  cwd: string,
  owner?: SeatUser,
): Promise<SdkWorkerReady> {
  const seat = owner && owner.uid > 0 ? owner : resolveProjectOwner(cwd);
  const session = await spawnSdkWorkerSession(seat, { probe: true });
  try {
    return session.ready;
  } finally {
    await session.kill();
  }
}

type WorkerSession = {
  ready: SdkWorkerReady;
  proc: Subprocess;
  send: (obj: Json) => void;
  next: () => Promise<Json>;
  kill: () => Promise<void>;
};

async function spawnSdkWorkerSession(
  seat: SeatUser,
  opts: { probe?: boolean } = {},
): Promise<WorkerSession> {
  const inner = resolveSdkWorkerCmd();
  if (opts.probe) inner.push("--probe");

  let cmd = inner;
  const prefix = setprivPrefix(seat);
  if (prefix) {
    cmd = [...prefix, ...inner];
  } else if (typeof process.getuid === "function" && process.getuid() === 0) {
    throw new Error(
      "setpriv/runuser required to run Cursor SDK jobs as checkout owner",
    );
  }

  const scratch = `/tmp/homebase-sdk-${seat.uid}-${process.pid}`;
  try {
    mkdirSync(scratch, { recursive: true });
    if (typeof process.getuid === "function" && process.getuid() === 0) {
      Bun.spawnSync(["chown", `${seat.uid}:${seat.gid}`, scratch]);
      Bun.spawnSync(["chmod", "700", scratch]);
    }
  } catch {
    /* best-effort */
  }

  const login = loginEnvForUser(seat);
  const env: Record<string, string> = {
    ...login,
    HOME: seat.home,
    USER: seat.name,
    LOGNAME: seat.name,
    HOMEBASE_SDK_WORKER: "1",
    HOMEBASE_HOME: scratch,
    HOMEBASE_RUNTIME: join(scratch, ".runtime"),
    TMPDIR: scratch,
  };
  if (opts.probe) env.HOMEBASE_SDK_PROBE = "1";
  delete env.HOMEBASE_SELF_TEST;

  const proc = spawn(cmd, {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env,
  });

  const stdout = proc.stdout as ReadableStream<Uint8Array>;
  const reader = stdout.getReader() as ByteReader;
  const buf = { cur: new Uint8Array(0) };

  void (async () => {
    const err = proc.stderr;
    if (err && typeof err !== "number") {
      const r = (err as ReadableStream<Uint8Array>).getReader();
      const dec = new TextDecoder();
      for (;;) {
        const { done, value } = await r.read();
        if (done) break;
        const line = dec.decode(value).trim();
        if (line) appendTrace("info", `sdk-worker: ${line}`, "cursor");
      }
    }
  })();

  const readyMsg = await Promise.race([
    readMsg(reader, buf),
    proc.exited.then((code) => {
      throw new Error(`sdk-worker exited before ready (${code ?? "?"})`);
    }),
  ]);
  if (String(readyMsg.type) !== "ready") {
    try {
      proc.kill();
    } catch {
      /* ignore */
    }
    throw new Error(`sdk-worker expected ready, got ${readyMsg.type}`);
  }
  const ready: SdkWorkerReady = {
    uid: Number(readyMsg.uid),
    gid: Number(readyMsg.gid),
    pid: Number(readyMsg.pid) || (proc.pid ?? -1),
  };

  const stdin = proc.stdin as { write: (b: Uint8Array) => number | void; end?: () => void };
  const send = (obj: Json) => {
    stdin.write(encodeMsg(obj));
  };

  return {
    ready,
    proc,
    send,
    next: () => readMsg(reader, buf),
    kill: async () => {
      try {
        send({ type: "close" });
      } catch {
        /* ignore */
      }
      try {
        stdin.end?.();
      } catch {
        /* ignore */
      }
      try {
        proc.kill();
      } catch {
        /* ignore */
      }
      try {
        await proc.exited;
      } catch {
        /* ignore */
      }
    },
  };
}

/**
 * Create an Agent-compatible handle that runs inside a setpriv child as `owner`.
 * Homebase custom tools execute back in the parent via IPC.
 */
export async function createOwnerSdkAgentHandle(opts: {
  cwd: string;
  apiKey: string;
  model: string;
  mode: string;
  agentId?: string | null;
  tools: Record<string, ToolDef>;
  owner?: SeatUser;
}): Promise<{ agent: AgentHandleLike; childUid: number; childGid: number }> {
  const seat =
    opts.owner && opts.owner.uid > 0
      ? opts.owner
      : resolveProjectOwner(opts.cwd);
  const session = await spawnSdkWorkerSession(seat, { probe: false });

  if (session.ready.uid !== seat.uid) {
    await session.kill();
    throw new Error(
      `sdk-worker uid mismatch: got ${session.ready.uid}, expected owner ${seat.uid}`,
    );
  }

  appendTrace(
    "info",
    `sdk-worker started uid=${session.ready.uid} gid=${session.ready.gid} owner=${seat.name} cwd=${opts.cwd}`,
    "cursor",
  );

  const toolMeta: Record<
    string,
    { description?: string; inputSchema?: Record<string, unknown> }
  > = {};
  for (const [name, t] of Object.entries(opts.tools)) {
    toolMeta[name] = {
      description: t.description,
      inputSchema: t.inputSchema,
    };
  }

  const waiters = new Map<
    string,
    { resolve: (m: Json) => void; reject: (e: Error) => void }
  >();
  const runDeltas = new Map<
    string,
    (update: Record<string, unknown>) => void | Promise<void>
  >();
  const runDone = new Map<
    string,
    {
      resolve: (r: {
        status?: string;
        result?: string;
        error?: { message?: string; code?: string };
      }) => void;
      reject: (e: Error) => void;
    }
  >();

  let pumpError: Error | null = null;
  const pump = (async () => {
    try {
      for (;;) {
        const msg = await session.next();
        const type = String(msg.type || "");
        if (type === "tool_req") {
          const callId = String(msg.callId || "");
          const name = String(msg.name || "");
          const args = (msg.args || {}) as Record<string, unknown>;
          const tool = opts.tools[name];
          try {
            const result = tool
              ? await tool.execute(args)
              : `unknown tool: ${name}`;
            session.send({ type: "tool_res", callId, result: String(result) });
          } catch (e) {
            session.send({
              type: "tool_res",
              callId,
              error: e instanceof Error ? e.message : String(e),
            });
          }
          continue;
        }
        if (type === "delta") {
          const runId = String(msg.runId || "");
          const cb = runDeltas.get(runId);
          if (cb && msg.update && typeof msg.update === "object") {
            await cb(msg.update as Record<string, unknown>);
          }
          continue;
        }
        if (type === "send_done") {
          const runId = String(msg.runId || "");
          const w = runDone.get(runId);
          if (w) {
            runDone.delete(runId);
            runDeltas.delete(runId);
            const result = (msg.result || {}) as {
              status?: string;
              result?: string;
              error?: { message?: string; code?: string };
            };
            w.resolve(result);
          }
          continue;
        }
        if (
          type === "created" ||
          type === "send_started" ||
          type === "error" ||
          type === "cancelled" ||
          type === "closed" ||
          type === "pong"
        ) {
          const reqId = String(msg.reqId || "");
          if (reqId && waiters.has(reqId)) {
            const w = waiters.get(reqId)!;
            waiters.delete(reqId);
            if (type === "error") {
              w.reject(new Error(String(msg.error || "sdk-worker error")));
            } else {
              w.resolve(msg);
            }
          } else if (type === "error" && !reqId) {
            pumpError = new Error(String(msg.error || "sdk-worker error"));
          }
          if (type === "closed") break;
          continue;
        }
      }
    } catch (e) {
      pumpError =
        e instanceof Error ? e : new Error(String(e ?? "sdk-worker pump end"));
      for (const w of waiters.values()) w.reject(pumpError);
      waiters.clear();
      for (const w of runDone.values()) w.reject(pumpError);
      runDone.clear();
    }
  })();

  const request = (obj: Json, timeoutMs = 120_000): Promise<Json> => {
    if (pumpError) return Promise.reject(pumpError);
    const reqId = `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
    return new Promise<Json>((resolve, reject) => {
      const t = setTimeout(() => {
        waiters.delete(reqId);
        reject(new Error(`sdk-worker request timeout (${obj.type})`));
      }, timeoutMs);
      waiters.set(reqId, {
        resolve: (m) => {
          clearTimeout(t);
          resolve(m);
        },
        reject: (e) => {
          clearTimeout(t);
          reject(e);
        },
      });
      session.send({ ...obj, reqId });
    });
  };

  const created = await request({
    type: "create",
    apiKey: opts.apiKey,
    cwd: opts.cwd,
    model: opts.model,
    mode: opts.mode,
    agentId: opts.agentId || null,
    tools: toolMeta,
  });

  const agentId =
    created.agentId != null ? String(created.agentId) : undefined;

  const agent: AgentHandleLike = {
    agentId,
    send: async (message, options) => {
      const runId = `run${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
      if (options?.onDelta) {
        runDeltas.set(runId, (update) => options.onDelta!({ update }));
      }
      const donePromise = new Promise<{
        status?: string;
        result?: string;
        error?: { message?: string; code?: string };
      }>((resolve, reject) => {
        runDone.set(runId, { resolve, reject });
      });
      const started = await request({
        type: "send",
        runId,
        message,
        mode: options?.mode,
      });
      const run: AgentRunLike = {
        id: started.id != null ? String(started.id) : runId,
        stream: async function* () {
          /* deltas delivered via onDelta */
        },
        wait: () => donePromise,
        cancel: async () => {
          session.send({ type: "cancel", runId });
        },
      };
      return run;
    },
    close: async () => {
      await session.kill();
      await pump.catch(() => undefined);
    },
  };

  return {
    agent,
    childUid: session.ready.uid,
    childGid: session.ready.gid,
  };
}
