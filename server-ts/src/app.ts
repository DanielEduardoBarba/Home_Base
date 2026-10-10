import { Hono } from "hono";
import { z } from "zod";
import {
  HttpError,
  JWT_TTL_SEC,
  authStatusPayload,
  bearerFromHeader,
  bootstrapPassword,
  changePassword,
  issueJwt,
  lockoutStatus,
  loginWithPassword,
  passwordIsSet,
  verifyAccessToken,
} from "./auth";
import {
  getPolicy,
  listPending,
  requestApproval,
  setPolicy,
  verifySecret,
} from "./approvals";
import { isBackupBinary, loadProjects, readVersion } from "./config";
import {
  cursorConfigured,
  getWorkspace,
  handleCursorMessage,
  listModels,
} from "./cursor";
import { listDir, readFile, writeFile } from "./files";
import { clientIp, jsonError, readJson, requireAuth } from "./http";
import { readDailyLogs } from "./logging";
import { clearRead, listNotifications, markRead } from "./notifications";
import { projectPublic, runAction, stopProject, tailLogs } from "./process";
import {
  interruptSession,
  killSession,
  listSessions,
} from "./pty";
import {
  isLocalhostBrowser,
  mdnsHostname,
  requireLocalhostBrowser,
  shareHide,
  shareRedeem,
  shareReveal,
  shareStatus,
} from "./share";
import { tryServeStatic } from "./static";
import { clearSudo, setSudo, sudoStatus } from "./sudo";
import {
  journalLines,
  restartHomebased,
  restartWireguard,
  systemStatus,
} from "./system";
import { appendTrace, listTrace } from "./trace";
import { viewStatus } from "./view";

export const app = new Hono();

app.onError((err, c) => jsonError(c, err));

app.get("/api/health", (c) =>
  c.json({
    ok: true,
    cursorConfigured: cursorConfigured(),
    passwordSet: passwordIsSet(),
    model: (process.env.CURSOR_MODEL || "").trim() || null,
    jwtTtlSec: JWT_TTL_SEC,
    version: readVersion(),
    backup: isBackupBinary(),
    runtime: "bun",
  }),
);

app.get("/api/version", (c) =>
  c.json({ version: readVersion(), backup: isBackupBinary() }),
);

app.get("/api/system/status", async (c) => {
  await requireAuth(c);
  return c.json(systemStatus());
});

app.post("/api/system/restart/homebased", async (c) => {
  await requireAuth(c);
  return c.json(restartHomebased());
});

app.post("/api/system/restart/wireguard", async (c) => {
  await requireAuth(c);
  const body = z
    .object({ iface: z.string().nullable().optional() })
    .parse(await readJson(c));
  return c.json(restartWireguard(body.iface ?? null));
});

app.get("/api/auth/status", (c) => {
  const local = isLocalhostBrowser(c.req.raw.headers);
  return c.json(authStatusPayload(local));
});

app.post("/api/login", async (c) => {
  const body = z.object({ password: z.string() }).parse(await readJson(c));
  const session = await loginWithPassword(body.password, clientIp(c));
  return c.json({ ok: true, ...session });
});

app.post("/api/auth/bootstrap", async (c) => {
  requireLocalhostBrowser(c.req.raw.headers);
  const body = z.object({ password: z.string() }).parse(await readJson(c));
  bootstrapPassword(body.password);
  const session = await issueJwt({ kind: "session" });
  return c.json({ ok: true, ...session });
});

app.post("/api/auth/password", async (c) => {
  await requireAuth(c);
  requireLocalhostBrowser(c.req.raw.headers);
  const body = z
    .object({ password: z.string(), currentPassword: z.string() })
    .parse(await readJson(c));
  changePassword(body.password, body.currentPassword);
  const session = await issueJwt({ kind: "session" });
  return c.json({ ok: true, ...session });
});

app.get("/api/lockout", (c) => c.json(lockoutStatus()));

app.get("/api/share/status", async (c) => {
  await requireAuth(c);
  requireLocalhostBrowser(c.req.raw.headers);
  return c.json(shareStatus());
});

app.post("/api/share/reveal", async (c) => {
  await requireAuth(c);
  requireLocalhostBrowser(c.req.raw.headers);
  const body = z
    .object({ port: z.number(), protocol: z.string() })
    .parse(await readJson(c));
  return c.json(shareReveal(body.port, body.protocol));
});

app.post("/api/share/hide", async (c) => {
  await requireAuth(c);
  requireLocalhostBrowser(c.req.raw.headers);
  return c.json(shareHide());
});

app.post("/api/share/redeem", async (c) => {
  const body = z.object({ shareId: z.string() }).parse(await readJson(c));
  return c.json(await shareRedeem(body.shareId));
});

app.get("/api/share/hostname", async (c) => {
  await requireAuth(c);
  requireLocalhostBrowser(c.req.raw.headers);
  return c.json({ hostname: mdnsHostname() });
});

app.get("/api/projects", async (c) => {
  await requireAuth(c);
  return c.json({ projects: [...loadProjects().values()].map(projectPublic) });
});

app.get("/api/projects/:projectId", async (c) => {
  await requireAuth(c);
  const p = loadProjects().get(c.req.param("projectId"));
  if (!p) throw new HttpError(404, "Project not found");
  return c.json(projectPublic(p));
});

app.post("/api/projects/:projectId/action", async (c) => {
  await requireAuth(c);
  const p = loadProjects().get(c.req.param("projectId"));
  if (!p) throw new HttpError(404, "Project not found");
  const body = z
    .object({
      actionId: z.string(),
      extraArgs: z.array(z.string()).optional(),
    })
    .parse(await readJson(c));
  return c.json(runAction(p, body.actionId, body.extraArgs || []));
});

app.post("/api/projects/:projectId/stop", async (c) => {
  await requireAuth(c);
  const p = loadProjects().get(c.req.param("projectId"));
  if (!p) throw new HttpError(404, "Project not found");
  return c.json({ killedSessions: stopProject(p) });
});

app.get("/api/projects/:projectId/logs", async (c) => {
  await requireAuth(c);
  const p = loadProjects().get(c.req.param("projectId"));
  if (!p) throw new HttpError(404, "Project not found");
  return c.json({ lines: tailLogs(p, Number(c.req.query("limit") || 80)) });
});

app.get("/api/projects/:projectId/fs", async (c) => {
  await requireAuth(c);
  const p = loadProjects().get(c.req.param("projectId"));
  if (!p) throw new HttpError(404, "Project not found");
  try {
    return c.json(listDir(p, c.req.query("path") || "", c.req.query("all") === "1"));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === "not_found") throw new HttpError(404, "Not found");
    if (msg.includes("escapes")) throw new HttpError(403, msg);
    throw new HttpError(400, msg);
  }
});

app.get("/api/projects/:projectId/fs/read", async (c) => {
  await requireAuth(c);
  const p = loadProjects().get(c.req.param("projectId"));
  if (!p) throw new HttpError(404, "Project not found");
  try {
    return c.json(readFile(p, c.req.query("path") || ""));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === "not_found") throw new HttpError(404, "Not found");
    throw new HttpError(400, msg);
  }
});

app.put("/api/projects/:projectId/fs/write", async (c) => {
  await requireAuth(c);
  const p = loadProjects().get(c.req.param("projectId"));
  if (!p) throw new HttpError(404, "Project not found");
  const body = z
    .object({ path: z.string(), content: z.string() })
    .parse(await readJson(c));
  try {
    return c.json(writeFile(p, body.path, body.content));
  } catch (e) {
    throw new HttpError(400, e instanceof Error ? e.message : String(e));
  }
});

app.get("/api/sessions", async (c) => {
  await requireAuth(c);
  return c.json({ sessions: listSessions(c.req.query("project") || undefined) });
});

app.delete("/api/sessions/:sessionId", async (c) => {
  await requireAuth(c);
  return c.json({ ok: killSession(c.req.param("sessionId")) });
});

app.post("/api/sessions/:sessionId/interrupt", async (c) => {
  await requireAuth(c);
  return c.json({ ok: interruptSession(c.req.param("sessionId")) });
});

app.get("/api/cursor/models", async (c) => {
  await requireAuth(c);
  return c.json(await listModels());
});

app.get("/api/cursor/approvals", async (c) => {
  await requireAuth(c);
  return c.json({ policy: getPolicy(), pending: listPending() });
});

app.post("/api/cursor/approvals/policy", async (c) => {
  await requireAuth(c);
  const body = z.object({ policy: z.string() }).parse(await readJson(c));
  return c.json({ policy: setPolicy(body.policy) });
});

app.post("/api/internal/hook-approve", async (c) => {
  const host = (c.req.header("host") || "").split(":")[0];
  const peer = clientIp(c);
  const loopback =
    peer === "127.0.0.1" ||
    peer === "::1" ||
    peer === "localhost" ||
    host === "127.0.0.1" ||
    host === "localhost";
  if (!loopback) throw new HttpError(403, "localhost only");
  const body = await readJson<{
    secret?: string;
    event?: string;
    payload?: Record<string, unknown>;
  }>(c);
  if (!verifySecret(String(body.secret || ""))) throw new HttpError(403, "bad secret");
  const payload = body.payload || {};
  const event = String(body.event || "");
  const tool = String(
    payload.tool_name ||
      payload.toolName ||
      payload.tool ||
      (event.toLowerCase().includes("shell") ? "Shell" : "tool"),
  );
  const command = String(payload.command || "");
  return c.json(
    await requestApproval({
      kind: event.toLowerCase().includes("shell") ? "shell" : "tool",
      tool,
      detail: command || tool,
      command,
      cwd: String(payload.cwd || ""),
      agentId: String(payload.agent_id || payload.agentId || ""),
    }),
  );
});

app.get("/api/cursor/:projectId", async (c) => {
  await requireAuth(c);
  return c.json({
    configured: cursorConfigured(),
    workspace: getWorkspace(c.req.param("projectId")),
  });
});

app.post("/api/cursor/:projectId/reset", async (c) => {
  await requireAuth(c);
  return c.json({ ok: true });
});

app.get("/api/notifications", async (c) => {
  await requireAuth(c);
  return c.json(
    listNotifications({
      offset: Number(c.req.query("offset") || 0),
      limit: Number(c.req.query("limit") || 30),
      unreadOnly: c.req.query("unreadOnly") === "true",
      history: c.req.query("history") === "true",
    }),
  );
});

app.post("/api/notifications/read", async (c) => {
  await requireAuth(c);
  const body = z
    .object({ ids: z.array(z.string()).optional(), all: z.boolean().optional() })
    .parse(await readJson(c));
  return c.json({ marked: markRead(body.ids || null, Boolean(body.all)) });
});

app.delete("/api/notifications/read", async (c) => {
  await requireAuth(c);
  return c.json({ removed: clearRead() });
});

app.get("/api/logs/daily", async (c) => {
  await requireAuth(c);
  return c.json({ items: readDailyLogs(Number(c.req.query("limit") || 200)) });
});

app.get("/api/trace", async (c) => {
  await requireAuth(c);
  return c.json(
    listTrace(
      Number(c.req.query("limit") || 100),
      Number(c.req.query("afterId") || 0),
    ),
  );
});

app.post("/api/trace/client", async (c) => {
  await requireAuth(c);
  const body = z
    .object({
      lines: z.array(z.object({ level: z.string(), message: z.string() })),
    })
    .parse(await readJson(c));
  for (const line of body.lines) appendTrace(line.level, line.message, "client");
  return c.json({ ok: true });
});

app.get("/api/trace/journal", async (c) => {
  await requireAuth(c);
  const unit = c.req.query("unit") || "homebased.service";
  const result = journalLines(unit, Number(c.req.query("limit") || 100));
  return c.json({
    items: result.items,
    lastId: result.items.length,
    max: 300,
    unit,
    error: result.error || null,
  });
});

app.get("/api/sudo/status", async (c) => {
  await requireAuth(c);
  return c.json(sudoStatus());
});

app.post("/api/sudo", async (c) => {
  await requireAuth(c);
  const body = z.object({ password: z.string() }).parse(await readJson(c));
  return c.json(setSudo(body.password));
});

app.delete("/api/sudo", async (c) => {
  await requireAuth(c);
  return c.json(clearSudo());
});

app.get("/api/view/status", async (c) => {
  await requireAuth(c);
  return c.json(viewStatus());
});

app.get("*", async (c) => {
  const path = new URL(c.req.url).pathname;
  if (path.startsWith("/api/") || path.startsWith("/ws/")) {
    return c.json({ detail: "Not found" }, 404);
  }
  const res = tryServeStatic(path, c.req.header("accept-encoding") || "");
  if (res) return res;
  return c.text("Home Base Bun backend — build web/dist for SPA", 200);
});

export async function authenticateWsToken(
  url: URL,
  headers: Headers,
): Promise<boolean> {
  let token = url.searchParams.get("token") || undefined;
  if (!token) token = bearerFromHeader(headers.get("authorization"));
  try {
    await verifyAccessToken(token);
    return true;
  } catch {
    return false;
  }
}

export { handleCursorMessage };
