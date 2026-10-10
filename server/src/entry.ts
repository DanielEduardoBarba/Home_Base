import { app, authenticateWsToken, handleCursorMessage } from "./app";
import {
  bindHost,
  bindPort,
  ensureRuntimeDirs,
  loadProjects,
  readVersion,
} from "./config";
import { subscribeCursor } from "./cursor";
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
    console.log(`homebase self-test ok version=${v} runtime=bun`);
    return 0;
  } catch (e) {
    console.error("homebase self-test failed", e);
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

const server = Bun.serve<WsData>({
  hostname,
  port,
  fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/ws/")) {
      const upgraded = srv.upgrade(req, {
        data: { url, headers: req.headers },
      });
      if (upgraded) return undefined as unknown as Response;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }
    return app.fetch(req);
  },
  websocket: {
    async open(ws) {
      const data = ws.data;
      const url = data.url;
      const ok = await authenticateWsToken(url, data.headers);
      if (!ok) {
        ws.close(4401, "missing_token:Unauthorized");
        return;
      }

      if (url.pathname === "/ws/pty") {
        const project = url.searchParams.get("project");
        if (!project) {
          ws.close(4400, "project required");
          return;
        }
        const proj = loadProjects().get(project);
        const cwd =
          url.searchParams.get("cwd") || proj?.path || process.cwd();
        const cols = Number(url.searchParams.get("cols") || 100);
        const rows = Number(url.searchParams.get("rows") || 36);
        const info = spawnShell({
          projectId: project,
          cwd,
          cols,
          rows,
          kind: "shell",
        });
        data.sessionId = info.id;
        data.kind = "pty";
        const sub = {
          send: (payload: string | Buffer) => {
            ws.send(payload);
          },
        };
        data.sub = sub;
        attachSubscriber(info.id, sub);
        return;
      }

      if (url.pathname.startsWith("/ws/session/")) {
        const sessionId = url.pathname.slice("/ws/session/".length);
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
          ws.send(JSON.stringify({ type: "error", error: "session not found" }));
          ws.close(4404, "session not found");
        }
        return;
      }

      if (url.pathname === "/ws/view") {
        data.kind = "view";
        const clientWs = {
          send: (payload: string | Buffer | Uint8Array) => {
            ws.send(payload);
          },
        };
        (data as { viewWs?: typeof clientWs }).viewWs = clientWs;
        await viewHub.connect(clientWs);
        return;
      }

      if (url.pathname === "/ws/cursor") {
        const project = url.searchParams.get("project");
        if (!project) {
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
        return;
      }

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
    },
  },
});

appendTrace("info", `Home Base Bun listening on ${hostname}:${port}`, "boot");
console.log(`Home Base Bun · http://${hostname}:${port} · v${readVersion()}`);
void server;
