import { app, authenticateWsToken, handleCursorMessage } from "./app";
import {
  bindHost,
  bindPort,
  ensureRuntimeDirs,
  loadProjects,
  readVersion,
} from "./config";
import { logError, logInfo, logWarn } from "./console_log";
import { subscribeCursor } from "./cursor";
import { formatGeo, geoCached, normalizeIp, warmGeo } from "./geo";
import { PEER_IP_HEADER } from "./http";
import {
  attachSubscriber,
  detachSubscriber,
  resize,
  spawnShell,
  writeInput,
} from "./pty";
import { appendTrace } from "./trace";
import { viewHub } from "./view";

type WsData = {
  url: URL;
  headers: Headers;
  peerIp?: string;
  sessionId?: string;
  kind?: string;
  projectId?: string;
  sub?: { send: (payload: string | Buffer) => void };
  unsubCursor?: () => void;
};

ensureRuntimeDirs();

function selfTest(): number {
  try {
    const v = readVersion();
    loadProjects();
    logInfo(`self-test ok version=${v} runtime=bun`, "boot");
    return 0;
  } catch (e) {
    logError(`self-test failed: ${e instanceof Error ? e.message : String(e)}`, {
      source: "boot",
    });
    return 1;
  }
}

if (
  process.env.HOMEBASE_SELF_TEST === "1" ||
  process.argv.includes("--self-test")
) {
  process.exit(selfTest());
}

if (process.argv.includes("--view-worker")) {
  const { runViewWorker } = await import("./view_worker");
  process.exit(await runViewWorker());
}

const hostname = bindHost();
const port = bindPort();

/** Strip client-spoofed peer header; inject Bun's real remote address. */
function withPeerIp(req: Request, peer: string | undefined): Request {
  const headers = new Headers(req.headers);
  headers.delete(PEER_IP_HEADER);
  if (peer) headers.set(PEER_IP_HEADER, peer);
  return new Request(req, { headers });
}

function peerFromServer(
  srv: { requestIP?: (req: Request) => { address: string } | null },
  req: Request,
): string {
  try {
    const addr = srv.requestIP?.(req)?.address;
    return normalizeIp(addr || undefined);
  } catch {
    return "unknown";
  }
}

function wsFields(data: WsData, extra?: Record<string, unknown>): Record<string, unknown> {
  const ip = data.peerIp || "unknown";
  warmGeo(ip);
  return {
    ip,
    geo: formatGeo(geoCached(ip)),
    path: data.url.pathname,
    kind: data.kind,
    project: data.projectId || data.url.searchParams.get("project") || undefined,
    session: data.sessionId,
    ...extra,
  };
}

const server = Bun.serve<WsData>({
  hostname,
  port,
  fetch(req, srv) {
    const peer = peerFromServer(srv, req);
    const url = new URL(req.url);
    if (url.pathname.startsWith("/ws/")) {
      const upgraded = srv.upgrade(req, {
        data: { url, headers: req.headers, peerIp: peer },
      });
      if (upgraded) return undefined as unknown as Response;
      logWarn("websocket upgrade failed", {
        source: "ws",
        fields: { ip: peer, path: url.pathname },
      });
      return new Response("WebSocket upgrade failed", { status: 400 });
    }
    return app.fetch(withPeerIp(req, peer === "unknown" ? undefined : peer));
  },
  websocket: {
    async open(ws) {
      const data = ws.data;
      const ok = await authenticateWsToken(data.url, data.headers);
      if (!ok) {
        logWarn("websocket auth rejected", {
          source: "ws",
          fields: wsFields(data, { reason: "unauthorized" }),
        });
        ws.close(4401, "missing_token:Unauthorized");
        return;
      }

      if (data.url.pathname === "/ws/pty") {
        const project = data.url.searchParams.get("project");
        if (!project) {
          logWarn("websocket pty missing project", {
            source: "ws",
            fields: wsFields(data),
          });
          ws.close(4400, "project required");
          return;
        }
        const proj = loadProjects().get(project);
        const cwd =
          data.url.searchParams.get("cwd") || proj?.path || process.cwd();
        const cols = Number(data.url.searchParams.get("cols") || 100);
        const rows = Number(data.url.searchParams.get("rows") || 36);
        const info = spawnShell({
          projectId: project,
          cwd,
          cols,
          rows,
          kind: "shell",
        });
        data.sessionId = info.id;
        data.kind = "pty";
        data.projectId = project;
        const sub = {
          send: (payload: string | Buffer) => {
            ws.send(payload);
          },
        };
        data.sub = sub;
        attachSubscriber(info.id, sub);
        logInfo("websocket open", {
          source: "ws",
          fields: wsFields(data, { cwd }),
        });
        return;
      }

      if (data.url.pathname.startsWith("/ws/session/")) {
        const sessionId = data.url.pathname.slice("/ws/session/".length);
        data.sessionId = sessionId;
        data.kind = "session";
        const sub = {
          send: (payload: string | Buffer) => {
            ws.send(payload);
          },
        };
        data.sub = sub;
        const info = attachSubscriber(sessionId, sub);
        if (!info) {
          logWarn("websocket session not found", {
            source: "ws",
            fields: wsFields(data),
          });
          ws.send(JSON.stringify({ type: "error", error: "session not found" }));
          ws.close(4404, "session not found");
          return;
        }
        data.projectId = info.projectId;
        logInfo("websocket open", { source: "ws", fields: wsFields(data) });
        return;
      }

      if (data.url.pathname === "/ws/view") {
        data.kind = "view";
        const clientWs = {
          send: (payload: string | Buffer | Uint8Array) => {
            ws.send(payload);
          },
        };
        (data as { viewWs?: typeof clientWs }).viewWs = clientWs;
        await viewHub.connect(clientWs);
        logInfo("websocket open", { source: "ws", fields: wsFields(data) });
        return;
      }

      if (data.url.pathname === "/ws/cursor") {
        const project = data.url.searchParams.get("project");
        if (!project) {
          logWarn("websocket cursor missing project", {
            source: "ws",
            fields: wsFields(data),
          });
          ws.close(4400, "project required");
          return;
        }
        data.kind = "cursor";
        data.projectId = project;
        data.unsubCursor = subscribeCursor(project, (msg) =>
          ws.send(JSON.stringify(msg)),
        );
        handleCursorMessage(project, { type: "workspace" }, (msg) =>
          ws.send(JSON.stringify(msg)),
        );
        logInfo("websocket open", { source: "ws", fields: wsFields(data) });
        return;
      }

      logWarn("websocket unknown path", {
        source: "ws",
        fields: wsFields(data),
      });
      ws.close(4404, "unknown ws path");
    },
    async message(ws, message) {
      const data = ws.data;
      const text =
        typeof message === "string"
          ? message
          : new TextDecoder().decode(message);
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(text) as Record<string, unknown>;
      } catch {
        logWarn("websocket bad json", {
          source: "ws",
          fields: wsFields(data, { bytes: text.length }),
        });
        return;
      }

      if (data.kind === "pty" || data.kind === "session") {
        const sid = data.sessionId;
        if (!sid) return;
        if (msg.type === "input") writeInput(sid, String(msg.data || ""));
        if (msg.type === "resize") {
          resize(sid, Number(msg.cols || 80), Number(msg.rows || 24));
        }
        return;
      }

      if (data.kind === "view") {
        const viewWs = (data as { viewWs?: { send: (d: string | Buffer | Uint8Array) => void } }).viewWs;
        if (viewWs) await viewHub.handleMessage(viewWs, msg);
        return;
      }

      if (data.kind === "cursor" && data.projectId) {
        const t = String(msg.type || "");
        if (
          t === "prompt" ||
          t === "abort" ||
          t === "reset" ||
          t === "approve" ||
          t === "deny" ||
          t === "set_model"
        ) {
          logInfo(`cursor ${t}`, {
            source: "ws",
            fields: wsFields(data, { type: t }),
          });
        }
        handleCursorMessage(data.projectId, msg, (out) =>
          ws.send(JSON.stringify(out)),
        );
      }
    },
    async close(ws) {
      const data = ws.data;
      if (
        (data.kind === "pty" || data.kind === "session") &&
        data.sessionId &&
        data.sub
      ) {
        detachSubscriber(data.sessionId, data.sub);
      }
      if (data.kind === "view") {
        const viewWs = (data as { viewWs?: { send: (d: string | Buffer | Uint8Array) => void } }).viewWs;
        if (viewWs) await viewHub.disconnect(viewWs);
      }
      if (data.kind === "cursor") data.unsubCursor?.();
      if (data.kind) {
        logInfo("websocket close", { source: "ws", fields: wsFields(data) });
      }
    },
  },
});

// View IPC used to surface unhandledRejections ("worker closed") that exited
// the process and bounced systemd — keep the API up even if a subsystem faults.
process.on("unhandledRejection", (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  appendTrace("error", `unhandledRejection: ${msg}`, "boot");
});
process.on("uncaughtException", (err) => {
  appendTrace("error", `uncaughtException: ${err.message}`, "boot");
});

appendTrace(
  "info",
  `Home Base Bun listening on ${hostname}:${port} v${readVersion()}`,
  "boot",
);
void server;
