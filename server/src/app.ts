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
  isBackupBinary,
  listPresets,
  loadProjects,
  readVersion,
  upsertProjectFromInput,
  statHostPath,
} from "./config";
import { removeRegisteredProject } from "./project_remove";
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
  acceptLegal,
  legalPublic,
  requireLegalAccepted,
} from "./legal_state";
import {
  loadOnboarding,
  resetOnboardingForReplay,
  saveOnboarding,
} from "./onboarding_state";
import {
  clearCallbackAuth,
  clearCursorApiKey,
  getCallbackAuthMeta,
  getCursorCredentialsMeta,
  setCallbackAuth,
  setCursorApiKey,
  callbackAuthEnvSet,
} from "./secrets_vault";
import {
  identityPublic,
  saveIdentity,
} from "./server_identity";
import { hardReset, softReset } from "./system_reset";
import { accessHosts } from "./network";
import {
  clientWorkspace,
  createChat,
  cursorConfigured,
  deleteChat,
  handleCursorMessage,
  listChatSummaries,
  listModels,
  subscribeCursor,
} from "./cursor";
import { listDir, readFile, writeFile } from "./files";
import { logInfo } from "./console_log";
import { formatGeo, geoCached, normalizeIp, warmGeo } from "./geo";
import { evaluateLocalSeatPasswordBypass } from "./local_seat";
import {
  deleteAccessWidget,
  getAccessWidget,
  invokeAccessWidget,
  listAccessWidgets,
  upsertAccessWidget,
} from "./home_access";
import {
  armVision,
  disarmVision,
  visionArmStatus,
  visionStatus,
} from "./vision";
import {
  PEER_IP_HEADER,
  assertSameOrigin,
  clientIp,
  clientUserAgent,
  cookieSecure,
  jsonError,
  readJson,
  requireAuth,
} from "./http";
import {
  applySessionCookies,
  assertCsrf,
  clearSessionCookies,
  csrfRequired,
  ensureCsrfCookie,
} from "./session_cookie";
import { mintWsTicket, redeemWsTicket } from "./ws_tickets";
import { readDailyLogs } from "./logging";
import { clearRead, listNotifications, markRead } from "./notifications";
import { projectPublic, runAction, stopProject, tailLogs } from "./process";
import { usageOverview, writePlanOverride } from "./usage_stats";
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
import { seatToolHealth } from "./shell_env";
import {
  journalLines,
  restartHomebased,
  restartWireguard,
  systemStatus,
} from "./system";
import { appendTrace, listTrace } from "./trace";
import { discoverX11Env, viewStatusAsync, x11AuthorityKind } from "./view";
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

/** Set session cookies and include csrfToken in the JSON body (token kept for CLI). */
function sessionResponse(
  c: import("hono").Context,
  session: Record<string, unknown> & { token: string; expiresAt: number },
) {
  const { csrfToken } = applySessionCookies(
    c,
    session.token,
    session.expiresAt,
    cookieSecure(c),
  );
  return c.json({ ok: true, ...session, csrfToken });
}

app.onError((err, c) => jsonError(c, err));
app.use("*", requestLogMiddleware);

/** MCP Bearer tokens must not call the human Web GUI API. */
app.use("/api/*", async (c, next) => {
  const auth = c.req.header("authorization") || "";
  const q = c.req.query("token") || "";
  const looksMcp =
    /bearer\s+hb_mcp_/i.test(auth) || q.startsWith("hb_mcp_");
  if (looksMcp) {
    const { recordMcpFailure } = await import("./auth");
    const { recordActivity } = await import("./activity_audit");
    const { desktopNotify } = await import("./desktop_notify");
    const { pushNotification } = await import("./notifications");
    const ip = clientIp(c);
    recordMcpFailure(ip, "mcp_token_on_web_api", {
      userAgent: clientUserAgent(c),
      path: c.req.path,
      result: "invalid",
      status: 403,
    });
    recordActivity({
      source: "auth",
      kind: "mcp_blocked_from_web",
      summary: `MCP token rejected on Web API ${c.req.method} ${c.req.path}`,
      peerIp: ip,
    });
    pushNotification(
      "MCP token blocked from Web GUI",
      `An MCP Bearer tried to call ${c.req.path} from ${ip}. Web GUI is for humans only.`,
      { level: "error", category: "security", meta: { ip, path: c.req.path } },
    );
    desktopNotify(
      "MCP blocked from Web GUI",
      `Token used on ${c.req.path} from ${ip}`,
      {
        urgency: "normal",
        replaceKey: `mcp-web:${ip}`,
        dedupeKey: `mcp-web:${ip}`,
        dedupeMs: 60_000,
        expireMs: 5_000,
      },
    );
    throw new HttpError(403, {
      code: "mcp_not_for_web",
      message:
        "MCP tokens cannot access the Web GUI API. Use /mcp only. Password/PIN gate the human UI.",
    });
  }
  await next();
});

/** Double-submit CSRF for cookie-authenticated state changes. Bearer clients skip. */
app.use("/api/*", async (c, next) => {
  const hasBearer = Boolean(bearerFromHeader(c.req.header("authorization")));
  if (csrfRequired(c, hasBearer)) assertCsrf(c);
  await next();
});

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
    tools: seatToolHealth(),
    x11Auth: x11AuthorityKind(discoverX11Env().xauthority),
    /** Boolean only: HOMEBASE_CALLBACK_AUTH is still set in the environment. */
    callbackAuthEnvSet: callbackAuthEnvSet(),
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
  const socketIp = normalizeIp(c.req.header(PEER_IP_HEADER) || "");
  const payload = authStatusPayload(local);
  const locked = Boolean((payload.lockout as { locked?: boolean })?.locked);
  const localSeatRecovery =
    locked &&
    evaluateLocalSeatPasswordBypass({
      socketIp,
      headers: c.req.raw.headers,
    }).ok;
  return c.json({
    ...payload,
    lockout: { ...(payload.lockout as object), localSeatRecovery },
    legal: legalPublic(),
  });
});

/** Public — Terms / Privacy acceptance status for this install. */
app.get("/api/legal", (c) => c.json(legalPublic()));

/** Record acceptance of current doc version (no auth — install-level gate). */
app.post("/api/legal/accept", async (c) => {
  const body = z
    .object({ version: z.string().min(1).max(32) })
    .parse(await readJson(c));
  return c.json(acceptLegal(body.version));
});

app.post("/api/login", async (c) => {
  assertSameOrigin(c);
  const body = z.object({ password: z.string() }).parse(await readJson(c));
  const ip = clientIp(c);
  const socketIp = normalizeIp(c.req.header(PEER_IP_HEADER) || "");
  const localSeat = evaluateLocalSeatPasswordBypass({
    socketIp,
    headers: c.req.raw.headers,
  }).ok;
  warmGeo(ip);
  const session = await loginWithPassword(body.password, ip, {
    userAgent: clientUserAgent(c),
    path: "/api/login",
    localSeat,
    socketIp,
  });
  logInfo("login ok", {
    source: "auth",
    fields: { ip, geo: formatGeo(geoCached(ip)), ttlSec: JWT_TTL_SEC },
  });
  try {
    const { recordActivity } = await import("./activity_audit");
    const { upsertPresence } = await import("./presence");
    const { desktopNotify } = await import("./desktop_notify");
    recordActivity({
      source: "auth",
      kind: "login_ok",
      summary: `Web GUI login from ${ip}`,
      peerIp: ip,
    });
    const { isLocalPeerIp } = await import("./presence");
    const local = isLocalPeerIp(ip);
    // Seat-local human (loopback OR this host's LAN/VPN self-IP) is tracked quietly.
    // Presence window only opens for true remotes.
    upsertPresence({
      id: `web:${ip}`,
      kind: "human",
      name: local ? "You" : "Person",
      label: local ? "Signed in · this device" : "Signed in · remote",
      peerIp: ip === "unknown" ? undefined : ip,
      mood: "listening",
      bubble: local
        ? "Using Home Base in the browser"
        : "Using Home Base remotely",
      announce: !local,
    });
    // Remote login: one quiet toast (presence join may also fire; long dedupe collapses it).
    if (!local) {
      desktopNotify("Remote sign-in", ip, {
        urgency: "low",
        replaceKey: `login:${ip}`,
        dedupeKey: `login:${ip}`,
        dedupeMs: 180_000,
        expireMs: 4_000,
      });
    }
  } catch {
    /* ignore */
  }
  return sessionResponse(c, session);
});

app.post("/api/auth/bootstrap", async (c) => {
  assertSameOrigin(c);
  requireLocalhostBrowser(c.req.raw.headers);
  requireLegalAccepted();
  const body = z.object({ password: z.string() }).parse(await readJson(c));
  bootstrapPassword(body.password);
  const session = await issueJwt({ kind: "session" });
  return sessionResponse(c, session);
});

app.post("/api/auth/password", async (c) => {
  assertSameOrigin(c);
  await requireAuth(c);
  requireLocalhostBrowser(c.req.raw.headers);
  const body = z
    .object({ password: z.string(), currentPassword: z.string() })
    .parse(await readJson(c));
  changePassword(body.password, body.currentPassword);
  const { revokeAllMcpTokens } = await import("./mcp_server");
  revokeAllMcpTokens();
  const session = await issueJwt({ kind: "session" });
  return sessionResponse(c, session);
});

app.get("/api/auth/session", async (c) => {
  try {
    const claims = await requireAuth(c, { allowPinLocked: true });
    const exp = Number(claims.exp) || 0;
    const csrfToken = ensureCsrfCookie(c, exp, cookieSecure(c));
    return c.json({
      authenticated: true,
      expiresAt: exp,
      expiresIn: Math.max(0, exp - Math.floor(Date.now() / 1000)),
      csrfToken,
    });
  } catch {
    return c.json({ authenticated: false });
  }
});

app.post("/api/logout", async (c) => {
  // Cookie clients need a valid CSRF header (middleware). Bearer may logout too.
  try {
    const claims = await requireAuth(c, { allowPinLocked: true });
    const { revokeSessionJti } = await import("./session_revoke");
    const jti = typeof claims.jti === "string" ? claims.jti : "";
    const exp = Number(claims.exp) || 0;
    revokeSessionJti(jti, exp);
  } catch {
    /* still clear cookies so a stale browser session is dropped */
  }
  clearSessionCookies(c);
  return c.json({ ok: true });
});

app.post("/api/ws-ticket", async (c) => {
  const claims = await requireAuth(c, { allowPinLocked: true });
  const minted = mintWsTicket(claims);
  return c.json({
    ticket: minted.ticket,
    expiresAt: minted.expiresAt,
    expiresIn: minted.expiresIn,
  });
});

app.get("/api/lockout", (c) => {
  const st = lockoutStatus({
    ip: clientIp(c),
    userAgent: clientUserAgent(c),
    path: "/api/lockout",
  });
  const socketIp = normalizeIp(c.req.header(PEER_IP_HEADER) || "");
  const localSeatRecovery =
    st.locked &&
    evaluateLocalSeatPasswordBypass({
      socketIp,
      headers: c.req.raw.headers,
    }).ok;
  return c.json({ ...st, localSeatRecovery });
});

app.get("/api/app-pin/status", async (c) => {
  await requireAuth(c, { allowPinLocked: true });
  return c.json(appPinStatus());
});

app.post("/api/app-pin/lock", async (c) => {
  await requireAuth(c, { allowPinLocked: true });
  return c.json({ ok: true, ...lockAppPin() });
});

app.post("/api/app-pin/unlock", async (c) => {
  assertSameOrigin(c);
  await requireAuth(c, { allowPinLocked: true });
  const body = z.object({ pin: z.string() }).parse(await readJson(c));
  return c.json({
    ok: true,
    ...unlockAppPin(body.pin, clientIp(c), {
      userAgent: clientUserAgent(c),
      path: "/api/app-pin/unlock",
    }),
  });
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
  const session = await shareRedeem(body.shareId);
  return sessionResponse(c, session);
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

app.get("/api/fs/host-stat", async (c) => {
  await requireAuth(c);
  const path = String(c.req.query("path") || "");
  return c.json(statHostPath(path));
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

app.post("/api/workspaces/create", async (c) => {
  await requireAuth(c);
  const body = z
    .object({
      parentPath: z.string().min(1),
      folderName: z.string().min(1),
      displayName: z.string().optional(),
    })
    .parse(await readJson(c));
  const { createHumanWorkspace } = await import("./workspace");
  try {
    const project = createHumanWorkspace(body);
    return c.json({ ok: true, project: await projectPublic(project) });
  } catch (e) {
    throw new HttpError(400, e instanceof Error ? e.message : String(e));
  }
});

app.get("/api/github/status", async (c) => {
  await requireAuth(c);
  const { githubAuthStatus } = await import("./github");
  return c.json(githubAuthStatus());
});

app.get("/api/git-github", async (c) => {
  await requireAuth(c);
  const {
    gitEnvCheck,
    loadOperatorGitSettings,
  } = await import("./operator_git_env");
  const { githubAuthStatus } = await import("./github");
  const env = gitEnvCheck();
  const settings = loadOperatorGitSettings();
  const auth = githubAuthStatus();
  return c.json({
    ok: true,
    settings,
    env,
    auth: auth.data || null,
  });
});

app.post("/api/git-github/settings", async (c) => {
  await requireAuth(c);
  const body = z
    .object({ useOperatorLoginEnv: z.boolean() })
    .parse(await readJson(c));
  const { saveOperatorGitSettings, gitEnvCheck } = await import(
    "./operator_git_env"
  );
  const settings = saveOperatorGitSettings({
    useOperatorLoginEnv: body.useOperatorLoginEnv,
  });
  return c.json({ ok: true, settings, env: gitEnvCheck() });
});

app.post("/api/git-github/setup-git", async (c) => {
  await requireAuth(c);
  const { runGhAuthSetupGit } = await import("./operator_git_env");
  const result = runGhAuthSetupGit();
  if (!result.ok) throw new HttpError(400, result.error || "setup-git failed");
  return c.json(result);
});

app.post("/api/git-github/test", async (c) => {
  await requireAuth(c);
  const body = z
    .object({ projectId: z.string().optional() })
    .parse((await readJson(c).catch(() => ({}))) || {});
  const { testGitGithubConnection } = await import("./operator_git_env");
  return c.json(testGitGithubConnection(body));
});

app.post("/api/git-github/signin", async (c) => {
  await requireAuth(c);
  const body = z
    .object({ projectId: z.string().optional() })
    .parse((await readJson(c).catch(() => ({}))) || {});
  const { openGuidedGitShell } = await import("./operator_git_env");
  const result = await openGuidedGitShell({
    kind: "signin",
    projectId: body.projectId,
  });
  if (!result.ok) throw new HttpError(400, result.error || "signin failed");
  return c.json(result);
});

app.post("/api/git-github/install", async (c) => {
  await requireAuth(c);
  const body = z
    .object({
      projectId: z.string().optional(),
      confirm: z.boolean(),
    })
    .parse(await readJson(c));
  const { openGuidedGitShell, gitEnvCheck } = await import("./operator_git_env");
  if (!body.confirm) {
    const env = gitEnvCheck();
    return c.json({
      ok: false,
      error: "confirm: true required (never silent sudo)",
      install: env.install,
      hint: env.install?.hint || env.hint,
    });
  }
  const result = await openGuidedGitShell({
    kind: "install",
    projectId: body.projectId,
    confirmInstall: true,
  });
  if (!result.ok) throw new HttpError(400, result.error || "install failed");
  return c.json(result);
});

app.get("/api/github/repos", async (c) => {
  await requireAuth(c);
  const { listGithubRepos } = await import("./github");
  const search = c.req.query("search") || undefined;
  const limit = Number(c.req.query("limit") || 30);
  const result = listGithubRepos({ search, limit, surface: "gui" });
  if (!result.ok) throw new HttpError(400, result.error || "list repos failed");
  return c.json({ ok: true, ...result.data });
});

app.post("/api/workspaces/clone-github", async (c) => {
  await requireAuth(c);
  const body = z
    .object({
      repo: z.string().min(1),
      workspaceName: z.string().optional(),
      branch: z.string().optional(),
    })
    .parse(await readJson(c));
  const { cloneGithubWorkspace } = await import("./github");
  const result = cloneGithubWorkspace({ ...body, surface: "gui" });
  if (!result.ok) throw new HttpError(400, result.error || "clone failed");
  const project = result.data?.project as import("./config").Project | undefined;
  return c.json({
    ok: true,
    ...result.data,
    project: project ? await projectPublic(project) : undefined,
  });
});

app.post("/api/projects/:projectId/github/connect", async (c) => {
  await requireAuth(c);
  const projectId = c.req.param("projectId");
  const body = z
    .object({
      repo: z.string().min(1),
      setUpstream: z.boolean().optional(),
    })
    .parse(await readJson(c));
  const { connectWorkspaceToGithub } = await import("./github");
  const result = connectWorkspaceToGithub({
    projectId,
    repo: body.repo,
    setUpstream: body.setUpstream === true,
    surface: "gui",
  });
  if (!result.ok) throw new HttpError(400, result.error || "connect failed");
  return c.json({ ok: true, ...result.data });
});

app.post("/api/projects/:projectId/github/create-repo", async (c) => {
  await requireAuth(c);
  const projectId = c.req.param("projectId");
  const body = z
    .object({
      name: z.string().optional(),
      visibility: z.enum(["private", "public"]).optional(),
      confirm: z.boolean(),
    })
    .parse(await readJson(c));
  const { createGithubRepoFromWorkspace } = await import("./github");
  const result = createGithubRepoFromWorkspace({
    projectId,
    name: body.name,
    visibility: body.visibility || "private",
    confirm: body.confirm === true,
    surface: "gui",
  });
  if (!result.ok) throw new HttpError(400, result.error || "create repo failed");
  return c.json({ ok: true, ...result.data });
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
  const result = removeRegisteredProject(c.req.param("projectId"));
  if (!result.ok) {
    const status = result.error === "cannot remove the Home Base project" ? 400 : 404;
    throw new HttpError(status, result.error || "Project not found");
  }
  return c.json(result);
});

app.get("/api/cursor/credentials", async (c) => {
  await requireAuth(c);
  // hint is a first/last-4 placeholder only — never the decrypted key
  const meta = getCursorCredentialsMeta();
  return c.json({
    configured: meta.configured || cursorConfigured(),
    hint: meta.hint,
  });
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

app.get("/api/callback-auth", async (c) => {
  await requireAuth(c);
  return c.json(getCallbackAuthMeta());
});

app.post("/api/callback-auth", async (c) => {
  await requireAuth(c);
  const body = z.object({ value: z.string().min(1) }).parse(await readJson(c));
  return c.json(setCallbackAuth(body.value));
});

app.delete("/api/callback-auth", async (c) => {
  await requireAuth(c);
  return c.json(clearCallbackAuth());
});

app.get("/api/usage", async (c) => {
  await requireAuth(c);
  const force = c.req.query("refresh") === "1";
  return c.json(await usageOverview({ force }));
});

app.put("/api/usage/plan", async (c) => {
  await requireAuth(c);
  const body = z
    .object({
      family: z
        .enum([
          "auto",
          "x_subscription",
          "legacy_cursor",
          "request_based",
          "unknown",
        ])
        .default("auto"),
      tier: z
        .enum([
          "free",
          "plus",
          "premium",
          "super",
          "ultra",
          "hobby",
          "start",
          "pro",
          "pro_plus",
          "teams",
          "teams_standard",
          "teams_premium",
          "enterprise",
          "unknown",
        ])
        .nullable()
        .optional(),
    })
    .parse(await c.req.json());
  writePlanOverride({
    family: body.family,
    tier: body.family === "auto" ? null : body.tier ?? null,
  });
  return c.json(await usageOverview({ force: true }));
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
      callbackUrl: z.string().optional(),
      callbackAuth: z.string().optional(),
      goal: z.string().optional(),
      cycles: z.number().optional(),
      maxMinutes: z.number().optional(),
      testers: z.number().optional(),
      dryRun: z.boolean().optional(),
    })
    .parse(await readJson(c));
  return c.json(
    await runAction(p, body.actionId, {
      extraArgs: body.extraArgs || [],
      callbackUrl: body.callbackUrl,
      callbackAuth: body.callbackAuth,
      selfqa: {
        goal: body.goal,
        cycles: body.cycles,
        maxMinutes: body.maxMinutes,
        testers: body.testers,
        dryRun: body.dryRun,
      },
    }),
  );
});

app.get("/api/projects/:projectId/selfqa", async (c) => {
  await requireAuth(c);
  const p = loadProjects().get(c.req.param("projectId"));
  if (!p) throw new HttpError(404, "Project not found");
  const { getSelfQa } = await import("./selfqa");
  return c.json(getSelfQa(p.id));
});

app.post("/api/projects/:projectId/selfqa", async (c) => {
  await requireAuth(c);
  const p = loadProjects().get(c.req.param("projectId"));
  if (!p) throw new HttpError(404, "Project not found");
  const body = z
    .object({
      goal: z.string().optional(),
      cycles: z.number().optional(),
      maxMinutes: z.number().optional(),
      testers: z.number().optional(),
      dryRun: z.boolean().optional(),
      callbackUrl: z.string().optional(),
      callbackAuth: z.string().optional(),
    })
    .parse(await readJson(c).catch(() => ({})));
  const { startSelfQa, getSelfQa } = await import("./selfqa");
  try {
    const started = await startSelfQa({
      projectId: p.id,
      goal: body.goal,
      cycles: body.cycles,
      maxMinutes: body.maxMinutes,
      testers: body.testers,
      dryRun: body.dryRun,
      callbackUrl: body.callbackUrl,
      callbackAuth: body.callbackAuth,
      source: "web",
    });
    return c.json({ ok: true, selfqa: started, status: getSelfQa(p.id) });
  } catch (e) {
    throw new HttpError(400, e instanceof Error ? e.message : String(e));
  }
});

app.post("/api/projects/:projectId/selfqa/stop", async (c) => {
  await requireAuth(c);
  const p = loadProjects().get(c.req.param("projectId"));
  if (!p) throw new HttpError(404, "Project not found");
  const { cancelSelfQa, getSelfQa } = await import("./selfqa");
  const stopped = cancelSelfQa(p.id);
  return c.json({
    ok: true,
    killed: stopped.killed,
    selfqa: stopped.selfqa,
    status: getSelfQa(p.id),
  });
});

app.get("/api/projects/:projectId/cursor-jobs", async (c) => {
  await requireAuth(c);
  const p = loadProjects().get(c.req.param("projectId"));
  if (!p) throw new HttpError(404, "Project not found");
  const { listCursorJobs } = await import("./cursor_jobs");
  const jobs = listCursorJobs(50).filter((j) => j.projectId === p.id);
  return c.json({ jobs });
});

app.post("/api/projects/:projectId/cursor-jobs/:jobId/cancel", async (c) => {
  await requireAuth(c);
  const p = loadProjects().get(c.req.param("projectId"));
  if (!p) throw new HttpError(404, "Project not found");
  const jobId = c.req.param("jobId");
  const { cancelCursorJob } = await import("./cursor_jobs");
  try {
    const job = await cancelCursorJob({ projectId: p.id, jobId });
    return c.json({ ok: true, job });
  } catch (e) {
    throw new HttpError(400, e instanceof Error ? e.message : String(e));
  }
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

app.get("/api/projects/:projectId/git", async (c) => {
  await requireAuth(c);
  const p = loadProjects().get(c.req.param("projectId"));
  if (!p) throw new HttpError(404, "Project not found");
  const { runGitAction } = await import("./git");
  const result = runGitAction(p, { action: "status" }, { surface: "gui" });
  if (!result.ok) throw new HttpError(400, result.error || "git status failed");
  return c.json({ ok: true, ...result.data });
});

app.get("/api/projects/:projectId/git/branches", async (c) => {
  await requireAuth(c);
  const p = loadProjects().get(c.req.param("projectId"));
  if (!p) throw new HttpError(404, "Project not found");
  const { runGitAction } = await import("./git");
  const result = runGitAction(p, { action: "branches" }, { surface: "gui" });
  if (!result.ok) throw new HttpError(400, result.error || "git branches failed");
  return c.json({ ok: true, ...result.data });
});

app.post("/api/projects/:projectId/git", async (c) => {
  await requireAuth(c);
  const p = loadProjects().get(c.req.param("projectId"));
  if (!p) throw new HttpError(404, "Project not found");
  const body = z
    .object({
      action: z.enum([
        "fetch",
        "pull",
        "checkout",
        "create_branch",
        "merge",
        "stage",
        "commit",
        "push",
        "stash",
        "log",
        "diff",
        "remotes",
        "status",
      ]),
      branch: z.string().optional(),
      name: z.string().optional(),
      base: z.string().optional(),
      checkout: z.boolean().optional(),
      noFf: z.boolean().optional(),
      abortOnConflict: z.boolean().optional(),
      message: z.string().optional(),
      stageAll: z.boolean().optional(),
      paths: z.array(z.string()).optional(),
      mode: z.enum(["push", "list", "pop"]).optional(),
      limit: z.number().optional(),
      staged: z.boolean().optional(),
      path: z.string().optional(),
    })
    .parse(await readJson(c));
  const { runGitAction } = await import("./git");
  let action:
    | import("./git").GitAction
    | null = null;
  switch (body.action) {
    case "status":
      action = { action: "status" };
      break;
    case "log":
      action = { action: "log", limit: body.limit };
      break;
    case "diff":
      action = { action: "diff", staged: body.staged, path: body.path };
      break;
    case "remotes":
      action = { action: "remotes" };
      break;
    case "fetch":
      action = { action: "fetch" };
      break;
    case "pull":
      action = { action: "pull" };
      break;
    case "checkout":
      action = { action: "checkout", branch: String(body.branch || "") };
      break;
    case "create_branch":
      action = {
        action: "create_branch",
        name: String(body.name || ""),
        base: body.base,
        checkout: body.checkout,
      };
      break;
    case "merge":
      action = {
        action: "merge",
        branch: String(body.branch || ""),
        noFf: body.noFf,
        abortOnConflict: body.abortOnConflict,
      };
      break;
    case "stage":
      action = { action: "stage", paths: body.paths };
      break;
    case "commit":
      action = {
        action: "commit",
        message: String(body.message || ""),
        stageAll: body.stageAll,
      };
      break;
    case "push":
      action = { action: "push" };
      break;
    case "stash":
      action = {
        action: "stash",
        mode: body.mode || "list",
        message: body.message,
      };
      break;
    default:
      throw new HttpError(400, "Unknown git action");
  }
  const result = runGitAction(p, action, { surface: "gui" });
  if (!result.ok) throw new HttpError(400, result.error || "git action failed");
  return c.json({
    ok: true,
    ...result.data,
    stdout: result.stdout,
    stderr: result.stderr,
  });
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
    if (msg.includes("escapes") || msg.startsWith("Permission denied")) throw new HttpError(403, msg);
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
    workspace: clientWorkspace(c.req.param("projectId")),
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

app.get("/api/vision/status", async (c) => {
  await requireAuth(c);
  return c.json(await visionStatus());
});

app.get("/api/vision/arm", async (c) => {
  await requireAuth(c);
  return c.json(visionArmStatus());
});

app.post("/api/vision/arm", async (c) => {
  await requireAuth(c);
  const body = (await readJson(c).catch(() => ({}))) as Record<string, unknown>;
  const ttlSec = body.ttlSec != null ? Number(body.ttlSec) : undefined;
  return c.json(armVision(ttlSec));
});

app.post("/api/vision/disarm", async (c) => {
  await requireAuth(c);
  return c.json(disarmVision("api"));
});

app.get("/api/mcp-server", async (c) => {
  await requireAuth(c);
  const { mcpServerPublic } = await import("./mcp_server");
  return c.json(mcpServerPublic());
});

app.post("/api/mcp-server", async (c) => {
  await requireAuth(c);
  const featureBool = z.boolean().optional();
  const body = z
    .object({
      enabled: z.boolean().optional(),
      allowMcpWorkspaceCreate: z.boolean().optional(),
      allowMcpGitWrite: z.boolean().optional(),
      allowMcpGithubRepos: z.boolean().optional(),
      features: z
        .object({
          projects: featureBool,
          notifications: featureBool,
          status: featureBool,
          homeAccess: featureBool,
          vision: featureBool,
          presence: featureBool,
        })
        .optional(),
    })
    .parse(await readJson(c));
  if (
    body.enabled === undefined &&
    !body.features &&
    body.allowMcpWorkspaceCreate === undefined &&
    body.allowMcpGitWrite === undefined &&
    body.allowMcpGithubRepos === undefined
  ) {
    throw new HttpError(
      400,
      "enabled, features, allowMcpWorkspaceCreate, allowMcpGitWrite, or allowMcpGithubRepos required",
    );
  }
  const { saveMcpServer, mcpServerPublic } = await import("./mcp_server");
  saveMcpServer({
    ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
    ...(body.features ? { features: body.features } : {}),
    ...(body.allowMcpWorkspaceCreate !== undefined
      ? { allowMcpWorkspaceCreate: body.allowMcpWorkspaceCreate }
      : {}),
    ...(body.allowMcpGitWrite !== undefined
      ? { allowMcpGitWrite: body.allowMcpGitWrite }
      : {}),
    ...(body.allowMcpGithubRepos !== undefined
      ? { allowMcpGithubRepos: body.allowMcpGithubRepos }
      : {}),
  });
  return c.json({ ok: true, ...mcpServerPublic() });
});

app.post("/api/mcp-server/tokens", async (c) => {
  await requireAuth(c);
  const body = z
    .object({ label: z.string().optional() })
    .parse(await readJson(c).catch(() => ({})));
  const { mintMcpToken, mcpServerPublic } = await import("./mcp_server");
  const minted = mintMcpToken(body.label);
  return c.json({ ok: true, ...minted, ...mcpServerPublic() });
});

app.delete("/api/mcp-server/tokens/:id", async (c) => {
  await requireAuth(c);
  const id = c.req.param("id");
  const { revokeMcpToken, mcpServerPublic } = await import("./mcp_server");
  if (!revokeMcpToken(id)) throw new HttpError(404, "token not found");
  return c.json({ ok: true, ...mcpServerPublic() });
});

app.post("/api/mcp-server/tokens/revoke-all", async (c) => {
  await requireAuth(c);
  const { revokeAllMcpTokens, mcpServerPublic } = await import("./mcp_server");
  const revoked = revokeAllMcpTokens();
  return c.json({ ok: true, revoked, ...mcpServerPublic() });
});

app.post("/api/mcp-server/tokens/:id/rotate", async (c) => {
  await requireAuth(c);
  const id = c.req.param("id");
  const { rotateMcpConnector, mcpServerPublic } = await import("./mcp_server");
  const minted = rotateMcpConnector(id);
  return c.json({ ok: true, ...minted, ...mcpServerPublic() });
});

app.get("/api/security/events", async (c) => {
  await requireAuth(c);
  const { querySecurityLog } = await import("./security_log");
  const q = {
    source: c.req.query("source") || undefined,
    event: c.req.query("event") || undefined,
    ip: c.req.query("ip") || undefined,
    result: c.req.query("result") || undefined,
    class: c.req.query("class") || undefined,
    q: c.req.query("q") || undefined,
    from: c.req.query("from") || undefined,
    to: c.req.query("to") || undefined,
    offset: Number(c.req.query("offset") || 0),
    limit: Number(c.req.query("limit") || 50),
  };
  return c.json(querySecurityLog(q));
});

app.get("/api/security/export", async (c) => {
  await requireAuth(c);
  const { exportSecurityLog } = await import("./security_log");
  const format = c.req.query("format") === "csv" ? "csv" : "json";
  const out = exportSecurityLog(
    {
      source: c.req.query("source") || undefined,
      event: c.req.query("event") || undefined,
      ip: c.req.query("ip") || undefined,
      result: c.req.query("result") || undefined,
      class: c.req.query("class") || undefined,
      q: c.req.query("q") || undefined,
      from: c.req.query("from") || undefined,
      to: c.req.query("to") || undefined,
    },
    format,
  );
  return new Response(out.body, {
    status: 200,
    headers: {
      "content-type": out.contentType,
      "content-disposition": `attachment; filename="${out.filename}"`,
      "cache-control": "no-store",
    },
  });
});

app.get("/api/security/status", async (c) => {
  await requireAuth(c);
  const { lockoutStatus, mcpLockoutStatus } = await import("./auth");
  const { listDevices } = await import("./devices");
  const { securityLogStats } = await import("./security_log");
  const ip = clientIp(c);
  return c.json({
    lockout: lockoutStatus(),
    mcpLockout: mcpLockoutStatus(ip),
    devices: listDevices(),
    stats: securityLogStats(),
  });
});

app.get("/api/security/devices", async (c) => {
  await requireAuth(c);
  const { listDevices } = await import("./devices");
  return c.json({ devices: listDevices() });
});

app.post("/api/security/devices/:id", async (c) => {
  await requireAuth(c);
  const id = c.req.param("id");
  const body = z
    .object({ name: z.string().optional(), trusted: z.boolean().optional() })
    .parse(await readJson(c));
  const { updateDevice } = await import("./devices");
  const device = updateDevice(id, body);
  if (!device) throw new HttpError(404, "device not found");
  return c.json({ ok: true, device });
});

/** Refresh rotating MCP tokens. Authenticated by the refresh token, not a public mint. */
app.post("/mcp/token", async (c) => {
  const { refreshMcpTokens } = await import("./mcp_server");
  const { bearerFromHeader } = await import("./auth");
  let refresh = bearerFromHeader(c.req.header("authorization")) || "";
  if (!refresh || !refresh.startsWith("hb_mcp_rt_")) {
    try {
      const body = await readJson<{ refreshToken?: string; refresh_token?: string }>(c);
      refresh = String(body.refreshToken || body.refresh_token || refresh);
    } catch {
      /* ignore */
    }
  }
  const ip = clientIp(c);
  const result = refreshMcpTokens(refresh, ip, {
    ip,
    userAgent: clientUserAgent(c),
    path: "/mcp/token",
  });
  return c.json({
    ok: true,
    token: result.accessToken,
    accessToken: result.accessToken,
    refreshToken: result.refreshToken,
    accessExpiresAt: result.accessExpiresAt,
    accessExpiresIn: result.accessExpiresIn,
    refreshExpiresAt: result.refreshExpiresAt,
    tokenType: "Bearer",
  });
});

/** Human Settings only — never exposed as MCP tools. */
app.get("/api/email-alerts", async (c) => {
  await requireAuth(c);
  const { emailAlertsPublic } = await import("./email_alerts");
  const { getSeatAwayStatus } = await import("./seat_away");
  return c.json({
    ...emailAlertsPublic(),
    seat: getSeatAwayStatus({ force: true }),
  });
});

app.post("/api/email-alerts", async (c) => {
  await requireAuth(c);
  const body = z
    .object({
      enabled: z.boolean().optional(),
      provider: z.enum(["resend", "smtp"]).optional(),
      to: z.string().optional(),
      from: z.string().optional(),
      smtpHost: z.string().optional(),
      smtpPort: z.number().optional(),
      smtpUser: z.string().optional(),
      smtpSecure: z.boolean().optional(),
      resendApiKey: z.string().optional(),
      smtpPass: z.string().optional(),
    })
    .parse(await readJson(c));
  const { saveEmailAlerts } = await import("./email_alerts");
  try {
    return c.json({ ok: true, ...saveEmailAlerts(body) });
  } catch (e) {
    throw new HttpError(400, e instanceof Error ? e.message : String(e));
  }
});

app.post("/api/email-alerts/test", async (c) => {
  await requireAuth(c);
  const { sendEmailAlertTest } = await import("./email_alerts");
  const result = await sendEmailAlertTest();
  if (!result.ok) throw new HttpError(400, result.error || "send failed");
  return c.json({ ok: true });
});

app.delete("/api/email-alerts/secrets", async (c) => {
  await requireAuth(c);
  const { clearEmailAlertSecrets } = await import("./email_alerts");
  return c.json({ ok: true, ...clearEmailAlertSecrets() });
});

app.all("/mcp", async (c) => {
  const { handleMcpHttp } = await import("./mcp_http");
  return handleMcpHttp(c);
});

app.get("/presence", async (c) => {
  const { verifyPresenceUiToken } = await import("./presence");
  const { presencePageHtml } = await import("./presence_page");
  const k = c.req.query("k") || "";
  if (!verifyPresenceUiToken(k)) {
    return c.text("Unauthorized", 401);
  }
  return c.html(presencePageHtml());
});

app.get("/api/presence/ui", async (c) => {
  const { verifyPresenceUiToken, presencePublic } = await import("./presence");
  if (!verifyPresenceUiToken(c.req.query("k"))) {
    throw new HttpError(401, "invalid presence token");
  }
  return c.json(presencePublic());
});

app.post("/api/presence/ui/chat", async (c) => {
  const { verifyPresenceUiToken, pushPresenceChat } = await import("./presence");
  const { recordActivity } = await import("./activity_audit");
  if (!verifyPresenceUiToken(c.req.query("k"))) {
    throw new HttpError(401, "invalid presence token");
  }
  const body = z.object({ text: z.string().min(1).max(500) }).parse(await readJson(c));
  const msg = pushPresenceChat({ from: "operator", text: body.text });
  recordActivity({
    source: "web",
    kind: "presence_chat",
    summary: `Operator → AI: ${body.text.slice(0, 120)}`,
    detail: { messageId: msg.id },
  });
  return c.json({ ok: true, message: msg });
});

app.post("/api/presence/heartbeat", async (c) => {
  await requireAuth(c, { allowPinLocked: true });
  const { upsertPresence, isLocalPeerIp } = await import("./presence");
  const ip = clientIp(c);
  const body = z
    .object({
      area: z.string().optional(),
      tab: z.string().optional(),
      label: z.string().optional(),
    })
    .parse(await readJson(c).catch(() => ({})));
  const local = isLocalPeerIp(ip);
  const areaBit =
    body.area || body.tab
      ? `${body.area || "Home"}${body.tab ? ` · ${body.tab}` : ""}`
      : null;
  const actor = upsertPresence({
    id: `web:${ip}`,
    kind: "human",
    name: body.label || (local ? "You" : "Person"),
    label: local
      ? areaBit
        ? `This browser · ${areaBit}`
        : "Signed in · this device"
      : areaBit
        ? `Remote · ${areaBit}`
        : "Signed in · remote",
    peerIp: ip === "unknown" ? undefined : ip,
    mood: "listening",
    bubble: local
      ? areaBit
        ? `Looking at ${areaBit}`
        : "Using Home Base in the browser"
      : areaBit
        ? `Looking at ${areaBit}`
        : "Using Home Base remotely",
    // Seat-local heartbeat must not announce / drive the desktop popup alone.
    announce: !local,
  });
  return c.json({ ok: true, actor });
});

app.post("/api/activity", async (c) => {
  await requireAuth(c);
  const { recordActivity } = await import("./activity_audit");
  const body = z
    .object({
      kind: z.string().min(1).max(64),
      summary: z.string().min(1).max(400),
      detail: z.record(z.unknown()).optional(),
    })
    .parse(await readJson(c));
  recordActivity({
    source: "web",
    kind: body.kind,
    summary: body.summary,
    detail: body.detail,
    peerIp: clientIp(c),
  });
  return c.json({ ok: true });
});

app.get("/api/activity", async (c) => {
  await requireAuth(c);
  const { listActivity } = await import("./activity_audit");
  const day = c.req.query("day") || undefined;
  const source = (c.req.query("source") || "all") as
    | "all"
    | "web"
    | "mcp"
    | "system"
    | "auth";
  const limit = Number(c.req.query("limit") || 100);
  const offset = Number(c.req.query("offset") || 0);
  return c.json(listActivity({ day, source, limit, offset }));
});

app.delete("/api/activity", async (c) => {
  await requireAuth(c);
  const { clearActivityDay } = await import("./activity_audit");
  const body = z.object({ day: z.string() }).parse(await readJson(c));
  return c.json(clearActivityDay(body.day));
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
  if (
    path.startsWith("/api/") ||
    path.startsWith("/ws/") ||
    path === "/mcp" ||
    path === "/presence"
  ) {
    return c.json({ detail: "Not found" }, 404);
  }
  const res = tryServeStatic(path, c.req.header("accept-encoding") || "");
  if (res) return res;
  return c.text("Home Base Bun backend — build web/dist for SPA", 200);
});

app.notFound((c) => {
  const path = new URL(c.req.url).pathname;
  if (
    path.startsWith("/api/") ||
    path.startsWith("/ws/") ||
    path === "/mcp" ||
    path === "/presence"
  ) {
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
  // Prefer a short-lived single-use ticket (?ticket=). Do not log the value.
  // Long-lived JWTs are no longer accepted in the query string.
  const ticket = url.searchParams.get("ticket") || "";
  if (ticket) {
    const rec = redeemWsTicket(ticket);
    // PIN lock does not drop auth — sockets may stay up so server work continues;
    // message handlers refuse client commands until unlock (see entry.ts).
    return Boolean(rec);
  }
  const token = bearerFromHeader(headers.get("authorization"));
  if (!token) return false;
  try {
    await verifyAccessToken(token);
    return true;
  } catch {
    return false;
  }
}

export { handleCursorMessage, subscribeCursor };
