/**
 * HB-OWN-02: Cursor SDK job child — runs as the checkout owner via setpriv.
 * Length-prefixed JSON IPC on stdin/stdout (same framing as view-worker).
 *
 * Probe mode (`HOMEBASE_SDK_PROBE=1`): print ready+uid and exit — for harness tests.
 */
import { appendFileSync } from "node:fs";
import {
  FramedWriter,
  readFrame,
  type Json,
} from "./ipc_framing";

const out = new FramedWriter(Bun.stdout);

function send(obj: Json): void {
  out.sendFire(obj);
}

function currentUid(): number {
  return typeof process.getuid === "function" ? process.getuid() : -1;
}

function currentGid(): number {
  return typeof process.getgid === "function" ? process.getgid() : -1;
}

type PendingTool = {
  resolve: (v: string) => void;
  reject: (e: Error) => void;
};

export async function runCursorSdkWorker(): Promise<number> {
  const uid = currentUid();
  const gid = currentGid();
  send({
    type: "ready",
    uid,
    gid,
    pid: process.pid,
  });

  if (
    process.env.HOMEBASE_SDK_PROBE === "1" ||
    process.argv.includes("--probe")
  ) {
    // Harness-only: prove real privilege drop, then exit.
    return 0;
  }

  const stdin = Bun.stdin.stream().getReader();
  const buf = { cur: new Uint8Array(0) };
  const pendingTools = new Map<string, PendingTool>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let agent: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const liveRuns = new Map<string, any>();

  const toolProxy = (name: string, description?: string, inputSchema?: Json) => ({
    description: description || name,
    inputSchema: inputSchema || { type: "object", properties: {} },
    execute: async (args: Record<string, unknown>) => {
      const callId = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      const result = await new Promise<string>((resolve, reject) => {
        pendingTools.set(callId, { resolve, reject });
        send({
          type: "tool_req",
          callId,
          name,
          args: args || {},
        });
        setTimeout(() => {
          if (pendingTools.has(callId)) {
            pendingTools.delete(callId);
            reject(new Error(`tool ${name} timed out`));
          }
        }, 600_000);
      });
      return result;
    },
  });

  try {
    for (;;) {
      let msg: Json;
      try {
        msg = await readFrame(stdin, buf);
      } catch {
        break;
      }
      const type = String(msg.type || "");

      if (type === "tool_res") {
        const callId = String(msg.callId || "");
        const p = pendingTools.get(callId);
        if (p) {
          pendingTools.delete(callId);
          if (msg.error) p.reject(new Error(String(msg.error)));
          else p.resolve(String(msg.result ?? ""));
        }
        continue;
      }

      if (type === "create") {
        const reqId = String(msg.reqId || "");
        try {
          const { Agent } = await import("@cursor/sdk");
          const apiKey = String(msg.apiKey || "");
          const cwd = String(msg.cwd || process.cwd());
          const model = String(msg.model || "composer-2");
          const mode = String(msg.mode || "agent");
          const agentId = msg.agentId ? String(msg.agentId) : null;
          const toolDefs = (msg.tools || {}) as Record<
            string,
            { description?: string; inputSchema?: Json }
          >;
          const customTools: Record<string, ReturnType<typeof toolProxy>> = {};
          for (const [name, t] of Object.entries(toolDefs)) {
            customTools[name] = toolProxy(
              name,
              t.description,
              t.inputSchema as Json | undefined,
            );
          }
          const local = { cwd, customTools };
          const modelSel = { id: model };
          const sdkMode = mode === "plan" ? "plan" : "agent";
          const createOpts = {
            apiKey,
            model: modelSel,
            local,
            mode: sdkMode,
          };
          if (agentId) {
            try {
              agent = await Agent.resume(agentId, {
                apiKey,
                model: modelSel,
                local,
                mode: sdkMode,
              } as never);
            } catch {
              agent = await Agent.create(createOpts as never);
            }
          } else {
            agent = await Agent.create(createOpts as never);
          }
          const id =
            (agent as { agentId?: string }).agentId ||
            (agent as { agent_id?: string }).agent_id ||
            agentId ||
            undefined;
          send({
            type: "created",
            reqId,
            agentId: id || null,
            uid: currentUid(),
            gid: currentGid(),
          });
        } catch (e) {
          send({
            type: "error",
            reqId,
            error: e instanceof Error ? e.message : String(e),
          });
        }
        continue;
      }

      if (type === "send") {
        const reqId = String(msg.reqId || "");
        const runId = String(msg.runId || reqId);
        if (!agent) {
          send({ type: "error", reqId, error: "no agent" });
          continue;
        }
        try {
          const message = msg.message as
            | string
            | {
                text: string;
                images?: Array<{
                  data: string;
                  mimeType: string;
                  dimension?: { width: number; height: number };
                }>;
              };
          const mode = msg.mode ? String(msg.mode) : undefined;
          const run = await agent.send(message, {
            ...(mode ? { mode } : {}),
            onDelta: async ({ update }: { update: Record<string, unknown> }) => {
              // Await the framed write so rapid deltas stay ordered and atomic.
              await out.send({ type: "delta", runId, update });
            },
          });
          liveRuns.set(runId, run);
          send({
            type: "send_started",
            reqId,
            runId,
            id: (run as { id?: string }).id || null,
          });
          void (async () => {
            try {
              const result = await run.wait();
              send({
                type: "send_done",
                runId,
                result: {
                  status: result?.status,
                  result: result?.result,
                  error: result?.error,
                },
              });
            } catch (e) {
              send({
                type: "send_done",
                runId,
                result: {
                  status: "error",
                  error: {
                    message: e instanceof Error ? e.message : String(e),
                  },
                },
              });
            } finally {
              liveRuns.delete(runId);
            }
          })();
        } catch (e) {
          send({
            type: "error",
            reqId,
            error: e instanceof Error ? e.message : String(e),
          });
        }
        continue;
      }

      if (type === "cancel") {
        const runId = String(msg.runId || "");
        const run = liveRuns.get(runId);
        try {
          await run?.cancel?.();
        } catch {
          /* ignore */
        }
        send({ type: "cancelled", runId });
        continue;
      }

      if (type === "close") {
        try {
          await agent?.close?.();
        } catch {
          /* ignore */
        }
        send({ type: "closed" });
        break;
      }

      if (type === "ping") {
        send({
          type: "pong",
          uid: currentUid(),
          gid: currentGid(),
        });
        continue;
      }
    }
  } catch (e) {
    try {
      appendFileSync(
        "/tmp/homebase-sdk-worker-err.log",
        `worker crash: ${e instanceof Error ? e.message : String(e)}\n`,
      );
    } catch {
      /* ignore */
    }
    send({
      type: "error",
      error: e instanceof Error ? e.message : String(e),
    });
    return 1;
  }
  return 0;
}

if (import.meta.main) {
  process.exit(await runCursorSdkWorker());
}
