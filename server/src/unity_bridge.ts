/**
 * Coplay MCPForUnity bridge proxy (framed TCP on 127.0.0.1:<port>).
 * Remote bots reach Unity only via Home Base MCP — never the bridge directly.
 *
 * Framing (strict): handshake line contains FRAMING=1; then 8-byte BE uint64
 * length + payload. Heartbeat = zero-length frames (skipped).
 */
import { createConnection, createServer, type Socket } from "node:net";
import { loadProjects, type Project } from "./config";

export const UNITY_FRAMED_MAX = 64 * 1024 * 1024;
const DEFAULT_BRIDGE_PORT = 6400;

export type UnityBridgeCallResult = {
  ok: boolean;
  result?: unknown;
  error?: string;
  raw?: string;
};

export function encodeUnityFrame(payload: Buffer | string): Buffer {
  const body =
    typeof payload === "string" ? Buffer.from(payload, "utf8") : payload;
  const frame = Buffer.allocUnsafe(8 + body.length);
  frame.writeUInt32BE(Math.floor(body.length / 0x1_0000_0000), 0);
  frame.writeUInt32BE(body.length >>> 0, 4);
  body.copy(frame, 8);
  return frame;
}

export function decodeUnityFrameLength(header: Buffer): number {
  if (header.length < 8) throw new Error("unity frame header too short");
  const hi = header.readUInt32BE(0);
  const lo = header.readUInt32BE(4);
  if (hi !== 0) throw new Error("unity frame length exceeds 32-bit");
  return lo;
}

export function projectBridgePort(project: Project): number {
  const p = (project.ports || []).find((x) => x.id === "mcp-bridge");
  return Number(p?.port) || DEFAULT_BRIDGE_PORT;
}

class SocketBuffer {
  private buf = Buffer.alloc(0);
  private waiters: {
    n: number;
    resolve: (b: Buffer) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }[] = [];
  private closed = false;

  constructor(private sock: Socket) {
    sock.on("data", (chunk: Buffer | string) => {
      const piece = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      this.buf = Buffer.concat([this.buf, piece]);
      this.flush();
    });
    sock.on("error", (e) => this.failAll(e));
    sock.on("close", () => {
      this.closed = true;
      this.failAll(new Error("unity bridge closed"));
    });
  }

  private failAll(e: Error) {
    for (const w of this.waiters.splice(0)) {
      clearTimeout(w.timer);
      w.reject(e);
    }
  }

  private flush() {
    while (this.waiters.length && this.buf.length >= this.waiters[0]!.n) {
      const w = this.waiters.shift()!;
      clearTimeout(w.timer);
      const out = this.buf.subarray(0, w.n);
      this.buf = this.buf.subarray(w.n);
      w.resolve(out);
    }
  }

  readExact(n: number, timeoutMs: number): Promise<Buffer> {
    if (this.closed) return Promise.reject(new Error("unity bridge closed"));
    if (this.buf.length >= n) {
      const out = this.buf.subarray(0, n);
      this.buf = this.buf.subarray(n);
      return Promise.resolve(out);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.findIndex((w) => w.timer === timer);
        if (idx >= 0) this.waiters.splice(idx, 1);
        reject(new Error(`unity bridge read timeout (${n} bytes)`));
      }, timeoutMs);
      this.waiters.push({ n, resolve, reject, timer });
    });
  }

  /** Read until newline or max bytes (handshake). */
  async readLine(timeoutMs: number, max = 512): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    let acc = Buffer.alloc(0);
    while (Date.now() < deadline && acc.length < max) {
      const chunk = await this.readExact(1, Math.max(20, deadline - Date.now()));
      acc = Buffer.concat([acc, chunk]);
      if (chunk[0] === 0x0a) break;
    }
    return acc.toString("ascii");
  }

  async receiveFramed(timeoutMs: number): Promise<Buffer> {
    const deadline = Date.now() + timeoutMs;
    let heartbeats = 0;
    while (Date.now() < deadline) {
      const remain = Math.max(50, deadline - Date.now());
      const hdr = await this.readExact(8, remain);
      const len = decodeUnityFrameLength(hdr);
      if (len === 0) {
        heartbeats += 1;
        if (heartbeats > 32) throw new Error("unity bridge heartbeat storm");
        continue;
      }
      if (len > UNITY_FRAMED_MAX) throw new Error(`unity frame too large: ${len}`);
      return this.readExact(len, Math.max(50, deadline - Date.now()));
    }
    throw new Error("unity bridge response timeout");
  }
}

/**
 * One-shot framed call to a Unity bridge port.
 * tool "ping" sends raw `ping` bytes (Coplay convention).
 */
export async function callUnityBridge(opts: {
  port: number;
  host?: string;
  tool: string;
  args?: Record<string, unknown> | null;
  timeoutMs?: number;
}): Promise<UnityBridgeCallResult> {
  const host = opts.host || "127.0.0.1";
  const port = Number(opts.port) || DEFAULT_BRIDGE_PORT;
  const tool = String(opts.tool || "").trim();
  if (!tool) return { ok: false, error: "tool required" };
  const timeoutMs = Math.min(
    Math.max(Number(opts.timeoutMs) || 30_000, 1_000),
    120_000,
  );

  return new Promise((resolve) => {
    const sock = createConnection({ host, port });
    // Attach buffer before connect completes so we never miss the handshake.
    const io = new SocketBuffer(sock);
    let settled = false;
    const done = (r: UnityBridgeCallResult) => {
      if (settled) return;
      settled = true;
      try {
        sock.destroy();
      } catch {
        /* ignore */
      }
      resolve(r);
    };

    sock.setTimeout(timeoutMs);
    sock.once("timeout", () =>
      done({ ok: false, error: "unity bridge connect/timeout" }),
    );
    sock.once("error", (e) =>
      done({ ok: false, error: e instanceof Error ? e.message : String(e) }),
    );

    void (async () => {
      try {
        await new Promise<void>((res, rej) => {
          if (!sock.connecting && sock.readable) {
            res();
            return;
          }
          sock.once("connect", () => res());
          sock.once("error", rej);
        });
        const hello = await io.readLine(Math.min(5_000, timeoutMs));
        if (!hello.includes("FRAMING=1")) {
          done({
            ok: false,
            error: `MCP for Unity requires FRAMING=1, got: ${hello.slice(0, 120)}`,
          });
          return;
        }
        const payload =
          tool === "ping"
            ? Buffer.from("ping", "utf8")
            : Buffer.from(
                JSON.stringify({
                  type: tool,
                  params:
                    opts.args && typeof opts.args === "object" ? opts.args : {},
                }),
                "utf8",
              );
        sock.write(encodeUnityFrame(payload));
        const rawBuf = await io.receiveFramed(timeoutMs);
        const raw = rawBuf.toString("utf8");
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          done({ ok: false, error: "unity bridge returned non-JSON", raw });
          return;
        }
        const obj = parsed as Record<string, unknown>;
        if (tool === "ping") {
          const msg = (obj.result as { message?: string } | undefined)?.message;
          if (obj.status === "success" && msg === "pong") {
            done({ ok: true, result: { message: "pong" }, raw });
            return;
          }
          done({ ok: false, error: "Ping unsuccessful", raw });
          return;
        }
        if (obj.status === "error") {
          done({
            ok: false,
            error: String(obj.error || obj.message || "Unity error"),
            raw,
          });
          return;
        }
        done({
          ok: true,
          result: obj.result !== undefined ? obj.result : obj,
          raw,
        });
      } catch (e) {
        done({
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    })();
  });
}

export async function callProjectUnityBridge(opts: {
  projectId: string;
  tool: string;
  args?: Record<string, unknown> | null;
  timeoutMs?: number;
}): Promise<UnityBridgeCallResult & { port?: number; projectId?: string }> {
  const project = loadProjects().get(String(opts.projectId || "").trim());
  if (!project) return { ok: false, error: "project not found" };
  const port = projectBridgePort(project);
  const r = await callUnityBridge({
    port,
    tool: opts.tool,
    args: opts.args,
    timeoutMs: opts.timeoutMs,
  });
  return { ...r, port, projectId: project.id };
}

/** Known Coplay bridge tools (static catalog; live list via manage_tools). */
export const UNITY_BRIDGE_TOOL_CATALOG: {
  name: string;
  group: string;
  hint: string;
}[] = [
  { name: "ping", group: "core", hint: "Health check" },
  { name: "manage_tools", group: "core", hint: "List/activate tool groups" },
  { name: "manage_editor", group: "core", hint: "Play mode, tags, layers" },
  { name: "manage_scene", group: "core", hint: "Load/save/hierarchy" },
  { name: "manage_gameobject", group: "core", hint: "Create/find GameObjects" },
  { name: "manage_asset", group: "core", hint: "Search/import assets" },
  { name: "manage_script", group: "core", hint: "Create/edit C# scripts" },
  { name: "manage_material", group: "core", hint: "Materials" },
  { name: "manage_prefabs", group: "core", hint: "Prefabs" },
  { name: "manage_components", group: "core", hint: "Components" },
  { name: "read_console", group: "core", hint: "Editor console messages" },
  { name: "refresh_unity", group: "core", hint: "Asset database refresh" },
  { name: "execute_menu_item", group: "core", hint: "Run menu paths" },
  { name: "batch_execute", group: "core", hint: "Batch multiple tools" },
  { name: "manage_build", group: "core", hint: "Player builds (incl. WebGL)" },
  { name: "manage_camera", group: "core", hint: "Cameras + screenshot" },
  { name: "run_tests", group: "testing", hint: "Start EditMode/PlayMode tests" },
  { name: "get_test_job", group: "testing", hint: "Poll test job" },
];

/**
 * Test helper: start a fake framed Unity bridge (handshake + ping/echo).
 * Returns { port, close }.
 */
export function startFakeUnityBridge(
  handlers: {
    onCall?: (tool: string, params: Record<string, unknown>) => unknown;
  } = {},
): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve, reject) => {
    const server = createServer((sock) => {
      sock.write("WELCOME UNITY-MCP 1 FRAMING=1\n");
      let cur = Buffer.alloc(0);
      const pump = () => {
        while (cur.length >= 8) {
          const len = decodeUnityFrameLength(cur.subarray(0, 8));
          if (cur.length < 8 + len) return;
          const payload = cur.subarray(8, 8 + len);
          cur = cur.subarray(8 + len);
          const text = payload.toString("utf8");
          let response: Buffer;
          if (text === "ping") {
            response = Buffer.from(
              JSON.stringify({
                status: "success",
                result: { message: "pong" },
              }),
              "utf8",
            );
          } else {
            try {
              const msg = JSON.parse(text) as {
                type?: string;
                params?: Record<string, unknown>;
              };
              const tool = String(msg.type || "");
              const params =
                msg.params && typeof msg.params === "object" ? msg.params : {};
              const result = handlers.onCall
                ? handlers.onCall(tool, params)
                : { echo: tool, params };
              response = Buffer.from(
                JSON.stringify({ status: "success", result }),
                "utf8",
              );
            } catch (e) {
              response = Buffer.from(
                JSON.stringify({
                  status: "error",
                  error: e instanceof Error ? e.message : String(e),
                }),
                "utf8",
              );
            }
          }
          sock.write(encodeUnityFrame(response));
        }
      };
      sock.on("data", (chunk: Buffer | string) => {
        const piece = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
        cur = Buffer.concat([cur, piece]);
        pump();
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("fake bridge bind failed"));
        return;
      }
      resolve({
        port: addr.port,
        close: () => {
          try {
            server.close();
          } catch {
            /* ignore */
          }
        },
      });
    });
    server.on("error", reject);
  });
}
