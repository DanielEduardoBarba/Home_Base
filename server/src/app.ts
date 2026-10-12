import { Hono } from "hono";
import { z } from "zod";
import {
  appPinStatus,
  clearAppPin,
  importAppPin,
  lockAppPin,
  setAppPin,
  setAppPinIdleMs,
  unlockAppPin,
} from "./app_pin";
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
import {
  bindPort,
  deleteProject,
  isBackupBinary,
  listPresets,
  loadProjects,
  readVersion,
  upsertProjectFromInput,
} from "./config";
import {
  clearCloudflareTunnel,
  cloudflareStatus,
  configureCloudflareToken,
  installCloudflared,
  startCloudflareTunnel,
  stopCloudflareTunnel,
  updateCloudflareHostname,
} from "./cloudflare_tunnel";
import {
  loadOnboarding,
  resetOnboardingForReplay,
  saveOnboarding,
} from "./onboarding_state";
import {
  clearCursorApiKey,
  cursorApiKeyConfigured,
  setCursorApiKey,
} from "./secrets_vault";
import {
  identityPublic,
  saveIdentity,
} from "./server_identity";
import { hardReset, softReset } from "./system_reset";
import { accessHosts } from "./network";
import {
  createChat,
  cursorConfigured,
  deleteChat,
  getWorkspace,
  handleCursorMessage,
  listChatSummaries,
  listModels,
  subscribeCursor,
} from "./cursor";
import { listDir, readFile, writeFile } from "./files";
import { logInfo } from "./console_log";
import { formatGeo, geoCached, warmGeo } from "./geo";
import {
  deleteAccessWidget,
  getAccessWidget,
  invokeAccessWidget,
  listAccessWidgets,
  upsertAccessWidget,
} from "./home_access";
import { clientIp, jsonError, readJson, requireAuth } from "./http";
import { readDailyLogs } from "./logging";
import { clearRead, listNotifications, markRead } from "./notifications";
import { projectPublic, runAction, stopProject, tailLogs } from "./process";
import {
  interruptSession,
  killSession,
  listSessions,
} from "./pty";
import { requestLogMiddleware } from "./request_log";
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
import {
  allowSudoUse,
  clearPersistentSudo,
  clearSudo,
  denySudoUse,
  releaseSudoPassword,
  requestSudoPrompt,
  setPersistentSudo,
  setSudo,
  sudoStatus,
} from "./sudo";
import { noteSuspiciousRequest } from "./security";
import {
  journalLines,
  restartHomebased,
  restartWireguard,
  systemStatus,
} from "./system";
import { appendTrace, listTrace } from "./trace";
import { viewStatusAsync } from "./view";
import {
  addWireguardClient,
  adoptWireguard,
  getWireguardClientConfig,
  installWireguardPackages,
  removeWireguardClient,
  restartWireguardIface,
  setupWireguard,
  startWireguard,
  stopWireguard,
  uninstallWireguard,
  updateWireguardEndpoint,
  wireguardHealthSummary,
  wireguardStatus,
} from "./wireguard";

export const app = new Hono();

app.onError((err, c) => jsonError(c, err));
app.use("*", requestLogMiddleware);

app.get("/api/health", (c) => {
  const access = accessHosts(bindPort());
  const identity = identityPublic();
  return c.json({
    ok: true,
    cursorConfigured: cursorConfigured(),
    passwordSet: passwordIsSet(),
    model: (process.env.CURSOR_MODEL || "").trim() || null,
    jwtTtlSec: JWT_TTL_SEC,
    version: readVersion(),
    backup: isBackupBinary(),
    runtime: "bun",
    displayName: identity.displayName,
    wireguard: wireguardHealthSummary(),
    ...access,
  });
});

app.get("/api/server/identity", async (c) => {
  // Public enough for Login branding; POST still requires auth.
  return c.json(identityPublic());
});

app.post("/api/server/identity", async (c) => {
  await requireAuth(c);
  const body = z.object({ displayName: z.string().min(1).max(64) }).parse(await readJson(c));
  try {
    return c.json({ ok: true, ...saveIdentity(body.displayName), ...identityPublic() });
  } catch (e) {
    throw new HttpError(400, e instanceof Error ? e.message : String(e));
  }
});

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

app.get("/api/wireguard/status", async (c) => {
  await requireAuth(c);
  return c.json(await wireguardStatus());
});

app.post("/api/wireguard/install", async (c) => {
  await requireAuth(c);
  return c.json(installWireguardPackages());
});

app.post("/api/wireguard/setup", async (c) => {
  await requireAuth(c);
  const body = z
    .object({
      endpoint: z.string().optional(),
      listenPort: z.number().int().min(1024).max(65535).optional(),
      iface: z.string().optional(),
      clientName: z.string().optional(),
      vpnCidr: z.string().optional(),
      force: z.boolean().optional(),
    })
    .parse(await readJson(c));
  return c.json(await setupWireguard(body));
});

app.post("/api/wireguard/adopt", async (c) => {
  await requireAuth(c);
  const body = z
    .object({
      iface: z.string().optional(),
      endpoint: z.string().optional(),
    })
    .parse(await readJson(c));
  return c.json(await adoptWireguard(body));
});

app.post("/api/wireguard/start", async (c) => {
  await requireAuth(c);
  const body = z
    .object({ iface: z.string().optional() })
    .parse(await readJson(c));
  return c.json(startWireguard(body.iface));
});

app.post("/api/wireguard/stop", async (c) => {
  await requireAuth(c);
  const body = z
    .object({ iface: z.string().optional() })
    .parse(await readJson(c));
  return c.json(stopWireguard(body.iface));
});

app.post("/api/wireguard/restart", async (c) => {
  await requireAuth(c);
  const body = z
    .object({ iface: z.string().optional() })
    .parse(await readJson(c));
  return c.json(restartWireguardIface(body.iface));
});

app.post("/api/wireguard/clients", async (c) => {
  await requireAuth(c);
  const body = z
    .object({
      name: z.string().optional(),
      rotateId: z.string().optional(),
    })
    .parse(await readJson(c));
  return c.json(addWireguardClient(body));
});

app.get("/api/wireguard/clients/:id/config", async (c) => {
  await requireAuth(c);
  return c.json(getWireguardClientConfig(c.req.param("id")));
});

app.delete("/api/wireguard/clients/:id", async (c) => {
  await requireAuth(c);
  return c.json(removeWireguardClient(c.req.param("id")));
});

app.post("/api/wireguard/endpoint", async (c) => {
  await requireAuth(c);
  const body = z.object({ endpoint: z.string() }).parse(await readJson(c));
  return c.json(updateWireguardEndpoint(body.endpoint));
});

app.post("/api/wireguard/uninstall", async (c) => {
  await requireAuth(c);
  const body = z
    .object({
      confirm: z.literal(true),
      removePackages: z.boolean().optional(),
      iface: z.string().optional(),
    })
    .parse(await readJson(c));
  return c.json(
    uninstallWireguard({
      removePackages: body.removePackages,
      iface: body.iface,
    }),
  );
});

app.get("/api/auth/status", (c) => {
  const local = isLocalhostBrowser(c.req.raw.headers);
  return c.json(authStatusPayload(local));
});

app.post("/api/login", async (c) => {
  const body = z.object({ password: z.string() }).parse(await readJson(c));
  const ip = clientIp(c);
  warmGeo(ip);
  const session = await loginWithPassword(body.password, ip);
  logInfo("login ok", {
    source: "auth",
    fields: { ip, geo: formatGeo(geoCached(ip)), ttlSec: JWT_TTL_SEC },
  });
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

app.get("/api/app-pin/status", async (c) => {
  await requireAuth(c, { allowPinLocked: true });
  return c.json(appPinStatus());
});

app.post("/api/app-pin/lock", async (c) => {
  await requireAuth(c, { allowPinLocked: true });
  return c.json({ ok: true, ...lockAppPin() });
});

app.post("/api/app-pin/unlock", async (c) => {
  await requireAuth(c, { allowPinLocked: true });
  const body = z.object({ pin: z.string() }).parse(await readJson(c));
  return c.json({ ok: true, ...unlockAppPin(body.pin) });
});

app.post("/api/app-pin/set", async (c) => {
  await requireAuth(c);
  const body = z
    .object({
      pin: z.string(),
      currentPin: z.string().optional(),
    })
    .parse(await readJson(c));
  return c.json({ ok: true, ...setAppPin(body.pin, body.currentPin) });
});

app.post("/api/app-pin/clear", async (c) => {
  await requireAuth(c);
  const body = z.object({ currentPin: z.string() }).parse(await readJson(c));
  return c.json({ ok: true, ...clearAppPin(body.currentPin) });
});

app.post("/api/app-pin/idle", async (c) => {
  await requireAuth(c);
  const body = z.object({ idleMs: z.number() }).parse(await readJson(c));
  return c.json({ ok: true, ...setAppPinIdleMs(body.idleMs) });
});

app.post("/api/app-pin/import", async (c) => {
  await requireAuth(c, { allowPinLocked: true });
  const body = z
    .object({
      salt: z.string(),
      hash: z.string(),
      idleMs: z.number().optional(),
    })
    .parse(await readJson(c));
  return c.json({ ok: true, ...importAppPin(body) });
});

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
  const projects = await Promise.all(
    [...loadProjects().values()].map((p) => projectPublic(p)),
  );
  return c.json({ projects });
});

app.get("/api/presets", async (c) => {
  await requireAuth(c);
  return c.json({ presets: listPresets() });
});

app.post("/api/projects", async (c) => {
  await requireAuth(c);
  const body = z
    .object({
      path: z.string().min(1),
      preset: z.string().optional(),
      id: z.string().optional(),
      name: z.string().optional(),
      ports: z.array(z.unknown()).optional(),
      actions: z.array(z.unknown()).optional(),
    })
    .parse(await readJson(c));
  try {
    const project = upsertProjectFromInput(body);
    return c.json({ ok: true, project: await projectPublic(project) });
  } catch (e) {
    throw new HttpError(400, e instanceof Error ? e.message : String(e));
  }
});

app.patch("/api/projects/:projectId", async (c) => {
  await requireAuth(c);
  const id = c.req.param("projectId");
  const existing = loadProjects().get(id);
  if (!existing) throw new HttpError(404, "Project not found");
  const body = z
    .object({
      path: z.string().optional(),
      name: z.string().optional(),
      ports: z.array(z.unknown()).optional(),
      actions: z.array(z.unknown()).optional(),
      preset: z.string().optional(),
    })
    .parse(await readJson(c));
  try {
    const project = upsertProjectFromInput({
      path: body.path || existing.path,
      id,
      name: body.name || existing.name,
      preset: body.preset,
      ports: body.ports,
      actions: body.actions,
    });
    return c.json({ ok: true, project: await projectPublic(project) });
  } catch (e) {
    throw new HttpError(400, e instanceof Error ? e.message : String(e));
  }
});

app.delete("/api/projects/:projectId", async (c) => {
  await requireAuth(c);
  const id = c.req.param("projectId");
  if (!deleteProject(id)) throw new HttpError(404, "Project not found");
  return c.json({ ok: true, id });
});

app.get("/api/cursor/credentials", async (c) => {
  await requireAuth(c);
  return c.json({ configured: cursorApiKeyConfigured() || cursorConfigured() });
});

app.post("/api/cursor/credentials", async (c) => {
  await requireAuth(c);
  const body = z.object({ apiKey: z.string().min(1) }).parse(await readJson(c));
  return c.json(setCursorApiKey(body.apiKey));
});

app.delete("/api/cursor/credentials", async (c) => {
  await requireAuth(c);
  return c.json(clearCursorApiKey());
});

app.get("/api/onboarding", async (c) => {
  await requireAuth(c);
  return c.json(loadOnboarding());
});

app.post("/api/onboarding", async (c) => {
  await requireAuth(c);
  const body = z
    .object({
      complete: z.boolean().optional(),
      skippedRemote: z.boolean().optional(),
      remoteMode: z
        .enum(["wireguard", "cloudflare"])
        .nullable()
        .optional(),
      replay: z.boolean().optional(),
    })
    .parse(await readJson(c));
  if (body.replay) return c.json(resetOnboardingForReplay());
  const { replay: _r, ...patch } = body;
  return c.json(saveOnboarding(patch));
});

app.post("/api/system/reset", async (c) => {
  await requireAuth(c);
  const body = z
    .object({
      mode: z.enum(["soft", "hard"]),
      confirm: z.string().optional(),
    })
    .parse(await readJson(c));
  if (body.mode === "hard") {
    requireLocalhostBrowser(c.req.raw.headers);
    if ((body.confirm || "").trim().toUpperCase() !== "ERASE") {
      throw new HttpError(400, 'Type ERASE to confirm full erase');
    }
    return c.json(hardReset());
  }
  return c.json(softReset());
});

app.get("/api/cloudflare/status", async (c) => {
  await requireAuth(c);
  return c.json(cloudflareStatus());
});

app.post("/api/cloudflare/install", async (c) => {
  await requireAuth(c);
  return c.json(installCloudflared());
});

app.post("/api/cloudflare/configure", async (c) => {
  await requireAuth(c);
  const body = z
    .object({
      token: z.string().min(1),
      hostname: z.string().optional(),
      tunnelName: z.string().optional(),
    })
    .parse(await readJson(c));
  return c.json(configureCloudflareToken(body));
});

app.post("/api/cloudflare/hostname", async (c) => {
  await requireAuth(c);
  const body = z.object({ hostname: z.string().min(1) }).parse(await readJson(c));
  return c.json(updateCloudflareHostname(body.hostname));
});

app.post("/api/cloudflare/start", async (c) => {
  await requireAuth(c);
  return c.json(startCloudflareTunnel());
});

app.post("/api/cloudflare/stop", async (c) => {
  await requireAuth(c);
  return c.json(stopCloudflareTunnel());
});

app.post("/api/cloudflare/clear", async (c) => {
  await requireAuth(c);
  return c.json(clearCloudflareTunnel());
});

app.get("/api/projects/:projectId", async (c) => {
  await requireAuth(c);
  const p = loadProjects().get(c.req.param("projectId"));
  if (!p) throw new HttpError(404, "Project not found");
  return c.json(await projectPublic(p));
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
  return c.json(await runAction(p, body.actionId, body.extraArgs || []));
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

/** SUDO_ASKPASS helper notifies Chat that a password is needed for a command. */
app.post("/api/internal/sudo-prompt", async (c) => {
  const host = (c.req.header("host") || "").split(":")[0];
  const peer = clientIp(c);
  const loopback =
    peer === "127.0.0.1" ||
    peer === "::1" ||
    peer === "localhost" ||
    host === "127.0.0.1" ||
    host === "localhost";
  if (!loopback) {
    noteSuspiciousRequest({
      ip: peer,
      path: "/api/internal/sudo-prompt",
      reason: "non-loopback sudo-prompt",
    });
    throw new HttpError(403, "localhost only");
  }
  const body = await readJson<{
    secret?: string;
    command?: string;
    prompt?: string;
    id?: string;
    chatId?: string;
    sessionId?: string;
    callId?: string;
  }>(c);
  if (!verifySecret(String(body.secret || ""))) {
    noteSuspiciousRequest({
      ip: peer,
      path: "/api/internal/sudo-prompt",
      reason: "bad hook secret",
    });
    throw new HttpError(403, "bad secret");
  }
  const pending = await requestSudoPrompt({
    command: body.command,
    prompt: body.prompt,
    id: body.id,
    chatId: body.chatId,
    sessionId: body.sessionId,
    callId: body.callId,
  });
  return c.json({ ok: true, pending });
});

/** Askpass polls until Chat Allow / typed password / Deny. */
app.post("/api/internal/sudo-release", async (c) => {
  const host = (c.req.header("host") || "").split(":")[0];
  const peer = clientIp(c);
  const loopback =
    peer === "127.0.0.1" ||
    peer === "::1" ||
    peer === "localhost" ||
    host === "127.0.0.1" ||
    host === "localhost";
  if (!loopback) {
    noteSuspiciousRequest({
      ip: peer,
      path: "/api/internal/sudo-release",
      reason: "non-loopback sudo-release",
    });
    throw new HttpError(403, "localhost only");
  }
  const body = await readJson<{ secret?: string; id?: string }>(c);
  if (!verifySecret(String(body.secret || ""))) {
    noteSuspiciousRequest({
      ip: peer,
      path: "/api/internal/sudo-release",
      reason: "bad hook secret",
    });
    throw new HttpError(403, "bad secret");
  }
  return c.json(releaseSudoPassword({ id: body.id }));
});

app.get("/api/cursor/:projectId/chats", async (c) => {
  await requireAuth(c);
  return c.json(listChatSummaries(c.req.param("projectId")));
});

app.post("/api/cursor/:projectId/chats", async (c) => {
  await requireAuth(c);
  const body = z
    .object({
      title: z.string().max(200).optional(),
      cwd: z.string().max(500).optional(),
    })
    .parse(await readJson(c).catch(() => ({})));
  const tab = createChat(c.req.param("projectId"), {
    title: body.title,
    cwd: body.cwd,
  });
  return c.json({ ok: true, chat: tab });
});

app.delete("/api/cursor/:projectId/chats/:chatId", async (c) => {
  await requireAuth(c);
  const result = deleteChat(c.req.param("projectId"), c.req.param("chatId"));
  if (!result.ok) throw new HttpError(400, "invalid chat id");
  return c.json(result);
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
  const body = z
    .object({
      password: z.string().min(1),
      ttlSec: z.number().int().positive().optional(),
      persistent: z.boolean().optional(),
    })
    .parse(await readJson(c));
  if (body.persistent) return c.json(setPersistentSudo(body.password));
  return c.json(setSudo(body.password, body.ttlSec));
});

app.post("/api/sudo/allow", async (c) => {
  await requireAuth(c);
  const body = z.object({ id: z.string().optional() }).parse(await readJson(c));
  return c.json(allowSudoUse(body.id));
});

app.post("/api/sudo/deny", async (c) => {
  await requireAuth(c);
  const body = z.object({ id: z.string().optional() }).parse(await readJson(c));
  return c.json(denySudoUse(body.id));
});

app.delete("/api/sudo", async (c) => {
  await requireAuth(c);
  return c.json(clearSudo());
});

app.delete("/api/sudo/persistent", async (c) => {
  await requireAuth(c);
  clearPersistentSudo();
  return c.json({ ok: true, ...sudoStatus() });
});

app.get("/api/view/status", async (c) => {
  await requireAuth(c);
  return c.json(await viewStatusAsync());
});

app.get("/api/home-access", async (c) => {
  await requireAuth(c);
  return c.json({ widgets: listAccessWidgets() });
});

app.post("/api/home-access/widgets", async (c) => {
  await requireAuth(c);
  const body = (await readJson(c)) as Record<string, unknown>;
  return c.json({ widget: upsertAccessWidget(body) });
});

app.put("/api/home-access/widgets/:id", async (c) => {
  await requireAuth(c);
  const id = c.req.param("id");
  const body = (await readJson(c)) as Record<string, unknown>;
  const existing = getAccessWidget(id);
  if (!existing) throw new HttpError(404, "widget not found");
  return c.json({ widget: upsertAccessWidget({ ...body, id }) });
});

app.delete("/api/home-access/widgets/:id", async (c) => {
  await requireAuth(c);
  const id = c.req.param("id");
  if (!deleteAccessWidget(id)) throw new HttpError(404, "widget not found");
  return c.json({ ok: true });
});

app.post("/api/home-access/widgets/:id/invoke", async (c) => {
  await requireAuth(c);
  const id = c.req.param("id");
  const body = (await readJson(c).catch(() => ({}))) as { value?: unknown };
  return c.json({ widget: await invokeAccessWidget(id, { value: body.value }) });
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
    // PIN lock does not drop auth — sockets may stay up so server work continues;
    // message handlers refuse client commands until unlock (see entry.ts).
    return true;
  } catch {
    return false;
  }
}

export { handleCursorMessage, subscribeCursor };
