/**
 * Network MCP toggle + fine-tunable features + revocable opaque Bearer tokens.
 * Default: master enabled; feature groups on except vision (off).
 * Tokens are hashed at rest (sha256); plaintext shown once on mint.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  existsSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { RUNTIME_DIR, ensureRuntimeDirs, readVersion } from "./config";
import {
  HttpError,
  assertMcpNotLocked,
  recordMcpFailure,
  recordMcpSuccess,
  type AuthEventCtx,
} from "./auth";
import {
  type McpFeatureId,
  type McpFeatures,
  MCP_FEATURE_DEFAULTS,
  MCP_FEATURE_META,
  mcpToolCatalog,
  normalizeMcpFeatures,
} from "./homebase_tools";
import { systemStatus } from "./system";

const STATE_PATH = join(RUNTIME_DIR, "mcp_server.json");
const TOKENS_PATH = join(RUNTIME_DIR, "mcp_tokens.json");

const TOKEN_PREFIX = "hb_mcp_";
const ACCESS_PREFIX = "hb_mcp_at_";
const REFRESH_PREFIX = "hb_mcp_rt_";
export const MCP_ACCESS_TTL_SEC = 60 * 60;
export const MCP_REFRESH_TTL_SEC = 90 * 24 * 60 * 60;

export type McpServerState = {
  enabled: boolean;
  features: McpFeatures;
  /** MCP bots may call homebase_create_mcp_workspace (default off). */
  allowMcpWorkspaceCreate?: boolean;
  /** MCP bots may run git write actions (fetch/pull/commit/push/…) (default off). */
  allowMcpGitWrite?: boolean;
  /** MCP bots may list/clone/connect/create GitHub repos via gh (default off). */
  allowMcpGithubRepos?: boolean;
  updatedAt?: number;
};

type McpTokenRecord = {
  id: string;
  prefix: string;
  /** Legacy long-lived static token hash (kind=static). */
  hash?: string;
  kind?: "static" | "connector";
  label: string;
  createdAt: number;
  lastUsedAt?: number;
  lastUsedIp?: string;
  accessHash?: string;
  accessExpiresAt?: number;
  refreshHash?: string;
  previousRefreshHash?: string;
  refreshExpiresAt?: number;
};

type McpTokensFile = {
  tokens: McpTokenRecord[];
  updatedAt?: number;
};

function chmodPrivate(path: string): void {
  try {
    chmodSync(path, 0o600);
  } catch {
    /* ignore */
  }
}

function writeJsonAtomic(path: string, data: unknown): void {
  ensureRuntimeDirs();
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  chmodPrivate(tmp);
  renameSync(tmp, path);
  chmodPrivate(path);
}

function emptyState(): McpServerState {
  return { enabled: true, features: { ...MCP_FEATURE_DEFAULTS } };
}

export function loadMcpServer(): McpServerState {
  if (!existsSync(STATE_PATH)) return emptyState();
  try {
    const raw = JSON.parse(readFileSync(STATE_PATH, "utf8")) as Partial<
      McpServerState & { features?: Partial<McpFeatures> }
    >;
    return {
      enabled: raw.enabled !== false,
      features: normalizeMcpFeatures(raw.features),
      allowMcpWorkspaceCreate: raw.allowMcpWorkspaceCreate === true,
      allowMcpGitWrite: raw.allowMcpGitWrite === true,
      allowMcpGithubRepos: raw.allowMcpGithubRepos === true,
      updatedAt: Number(raw.updatedAt) || undefined,
    };
  } catch {
    return emptyState();
  }
}

export function saveMcpServer(
  patch: Partial<{
    enabled: boolean;
    features: Partial<McpFeatures>;
    allowMcpWorkspaceCreate: boolean;
    allowMcpGitWrite: boolean;
    allowMcpGithubRepos: boolean;
  }>,
): McpServerState {
  const cur = loadMcpServer();
  const next: McpServerState = {
    enabled:
      typeof patch.enabled === "boolean" ? patch.enabled : cur.enabled,
    features: patch.features
      ? normalizeMcpFeatures({ ...cur.features, ...patch.features })
      : cur.features,
    allowMcpWorkspaceCreate:
      typeof patch.allowMcpWorkspaceCreate === "boolean"
        ? patch.allowMcpWorkspaceCreate
        : cur.allowMcpWorkspaceCreate === true,
    allowMcpGitWrite:
      typeof patch.allowMcpGitWrite === "boolean"
        ? patch.allowMcpGitWrite
        : cur.allowMcpGitWrite === true,
    allowMcpGithubRepos:
      typeof patch.allowMcpGithubRepos === "boolean"
        ? patch.allowMcpGithubRepos
        : cur.allowMcpGithubRepos === true,
    updatedAt: Date.now(),
  };
  writeJsonAtomic(STATE_PATH, next);
  return next;
}

/** Default off when unset (existing and new installs). */
export function mcpWorkspaceCreateAllowed(): boolean {
  return loadMcpServer().allowMcpWorkspaceCreate === true;
}

/** Default off when unset (existing and new installs). */
export function mcpGitWriteAllowed(): boolean {
  return loadMcpServer().allowMcpGitWrite === true;
}

/** Default off when unset (existing and new installs). */
export function mcpGithubReposAllowed(): boolean {
  return loadMcpServer().allowMcpGithubRepos === true;
}

export function mcpServerEnabled(): boolean {
  return loadMcpServer().enabled !== false;
}

export function mcpServerFeatures(): McpFeatures {
  return loadMcpServer().features;
}

function loadTokensFile(): McpTokensFile {
  if (!existsSync(TOKENS_PATH)) return { tokens: [] };
  try {
    const raw = JSON.parse(readFileSync(TOKENS_PATH, "utf8")) as Partial<McpTokensFile>;
    const tokens = Array.isArray(raw.tokens) ? raw.tokens : [];
    return {
      tokens: tokens.filter(
        (t): t is McpTokenRecord =>
          Boolean(t && t.id && t.prefix && (t.hash || t.accessHash || t.refreshHash)),
      ),
      updatedAt: Number(raw.updatedAt) || undefined,
    };
  } catch {
    return { tokens: [] };
  }
}

function saveTokensFile(data: McpTokensFile): void {
  writeJsonAtomic(TOKENS_PATH, {
    ...data,
    updatedAt: Date.now(),
  });
}

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function hashesEqual(a: string, b: string): boolean {
  try {
    const ba = Buffer.from(a, "hex");
    const bb = Buffer.from(b, "hex");
    if (ba.length !== bb.length || ba.length === 0) return false;
    return timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

export function listMcpTokens(): {
  id: string;
  prefix: string;
  label: string;
  createdAt: number;
  kind: "static" | "connector";
  lastUsedAt?: number;
  lastUsedIp?: string;
  accessExpiresAt?: number;
}[] {
  return loadTokensFile().tokens.map((t) => ({
    id: t.id,
    prefix: t.prefix,
    label: t.label,
    createdAt: t.createdAt,
    kind: t.kind === "connector" || t.accessHash ? "connector" : "static",
    lastUsedAt: t.lastUsedAt,
    lastUsedIp: t.lastUsedIp,
  }));
}

function publicPrefix(token: string): string {
  return token.slice(0, 16) + "…";
}

function issueAccessPair(id: string): {
  accessToken: string;
  refreshToken: string;
  accessHash: string;
  refreshHash: string;
  accessExpiresAt: number;
  refreshExpiresAt: number;
  accessExpiresIn: number;
} {
  const accessSecret = randomBytes(24).toString("base64url");
  const refreshSecret = randomBytes(32).toString("base64url");
  const accessToken = `${ACCESS_PREFIX}${id}_${accessSecret}`;
  const refreshToken = `${REFRESH_PREFIX}${id}_${refreshSecret}`;
  const now = Math.floor(Date.now() / 1000);
  return {
    accessToken,
    refreshToken,
    accessHash: hashToken(accessToken),
    refreshHash: hashToken(refreshToken),
    accessExpiresAt: now + MCP_ACCESS_TTL_SEC,
    refreshExpiresAt: now + MCP_REFRESH_TTL_SEC,
    accessExpiresIn: MCP_ACCESS_TTL_SEC,
  };
}

function touchToken(id: string, ip: string): void {
  const file = loadTokensFile();
  const rec = file.tokens.find((t) => t.id === id);
  if (!rec) return;
  rec.lastUsedAt = Date.now();
  rec.lastUsedIp = ip || rec.lastUsedIp;
  saveTokensFile(file);
}

export function mintMcpToken(label = ""): {
  id: string;
  token: string;
  accessToken: string;
  refreshToken: string;
  prefix: string;
  refreshPrefix: string;
  label: string;
  createdAt: number;
  kind: "connector";
  accessExpiresAt: number;
  accessExpiresIn: number;
  refreshExpiresAt: number;
} {
  const id = randomBytes(8).toString("hex");
  const createdAt = Date.now();
  const cleanLabel = String(label || "").trim().slice(0, 64) || "MCP client";
  const pair = issueAccessPair(id);
  const prefix = publicPrefix(pair.accessToken);
  const file = loadTokensFile();
  file.tokens.push({
    id,
    prefix,
    kind: "connector",
    label: cleanLabel,
    createdAt,
    accessHash: pair.accessHash,
    accessExpiresAt: pair.accessExpiresAt,
    refreshHash: pair.refreshHash,
    refreshExpiresAt: pair.refreshExpiresAt,
  });
  saveTokensFile(file);
  return {
    id,
    token: pair.accessToken,
    accessToken: pair.accessToken,
    refreshToken: pair.refreshToken,
    prefix,
    refreshPrefix: publicPrefix(pair.refreshToken),
    label: cleanLabel,
    createdAt,
    kind: "connector",
    accessExpiresAt: pair.accessExpiresAt,
    accessExpiresIn: pair.accessExpiresIn,
    refreshExpiresAt: pair.refreshExpiresAt,
  };
}

export function rotateMcpConnector(id: string): ReturnType<typeof mintMcpToken> {
  const file = loadTokensFile();
  const rec = file.tokens.find((t) => t.id === id);
  if (!rec) {
    throw new HttpError(404, { code: "not_found", message: "Unknown connector" });
  }
  const pair = issueAccessPair(rec.id);
  rec.kind = "connector";
  rec.hash = undefined;
  rec.accessHash = pair.accessHash;
  rec.accessExpiresAt = pair.accessExpiresAt;
  rec.previousRefreshHash = rec.refreshHash;
  rec.refreshHash = pair.refreshHash;
  rec.refreshExpiresAt = pair.refreshExpiresAt;
  rec.prefix = publicPrefix(pair.accessToken);
  saveTokensFile(file);
  return {
    id: rec.id,
    token: pair.accessToken,
    accessToken: pair.accessToken,
    refreshToken: pair.refreshToken,
    prefix: rec.prefix,
    refreshPrefix: publicPrefix(pair.refreshToken),
    label: rec.label,
    createdAt: rec.createdAt,
    kind: "connector",
    accessExpiresAt: pair.accessExpiresAt,
    accessExpiresIn: pair.accessExpiresIn,
    refreshExpiresAt: pair.refreshExpiresAt,
  };
}

export function refreshMcpTokens(
  refreshToken: string | undefined | null,
  ip = "unknown",
  ctx: AuthEventCtx = {},
): {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: number;
  accessExpiresIn: number;
  refreshExpiresAt: number;
  id: string;
  label: string;
} {
  assertMcpNotLocked(ip);
  const raw = String(refreshToken || "").trim();
  if (!raw.startsWith(REFRESH_PREFIX)) {
    recordMcpFailure(ip, "invalid_mcp_token", {
      ...ctx,
      result: "invalid",
      status: 401,
    });
    throw new HttpError(401, {
      code: "mcp_token_invalid",
      message: "Invalid refresh token",
    });
  }
  const digest = hashToken(raw);
  const file = loadTokensFile();
  let match: McpTokenRecord | undefined;
  let reuse = false;
  for (const t of file.tokens) {
    if (t.refreshHash && hashesEqual(t.refreshHash, digest)) {
      match = t;
      break;
    }
    if (t.previousRefreshHash && hashesEqual(t.previousRefreshHash, digest)) {
      match = t;
      reuse = true;
      break;
    }
  }
  if (!match) {
    recordMcpFailure(ip, "invalid_mcp_token", {
      ...ctx,
      result: "invalid",
      status: 401,
    });
    throw new HttpError(401, {
      code: "mcp_token_invalid",
      message: "Invalid refresh token",
    });
  }
  if (reuse) {
    const id = match.id;
    const label = match.label;
    file.tokens = file.tokens.filter((t) => t.id !== id);
    saveTokensFile(file);
    recordMcpFailure(ip, "mcp_refresh_reuse", {
      ...ctx,
      result: "revoked",
      status: 401,
      connectorId: id,
      connectorLabel: label,
    });
    throw new HttpError(401, {
      code: "mcp_token_revoked",
      message: "Refresh token reuse detected — connector revoked. Ask the owner to mint a new one.",
    });
  }
  const now = Math.floor(Date.now() / 1000);
  if (match.refreshExpiresAt && match.refreshExpiresAt <= now) {
    recordMcpFailure(ip, "mcp_refresh_expired", {
      ...ctx,
      result: "expired",
      status: 401,
      connectorId: match.id,
      connectorLabel: match.label,
    });
    throw new HttpError(401, {
      code: "mcp_token_expired",
      message: "Refresh token expired — ask the owner to mint a new one.",
    });
  }
  const pair = issueAccessPair(match.id);
  match.kind = "connector";
  match.previousRefreshHash = match.refreshHash;
  match.refreshHash = pair.refreshHash;
  match.refreshExpiresAt = pair.refreshExpiresAt;
  match.accessHash = pair.accessHash;
  match.accessExpiresAt = pair.accessExpiresAt;
  match.prefix = publicPrefix(pair.accessToken);
  match.lastUsedAt = Date.now();
  match.lastUsedIp = ip;
  saveTokensFile(file);
  recordMcpSuccess(ip);
  return {
    accessToken: pair.accessToken,
    refreshToken: pair.refreshToken,
    accessExpiresAt: pair.accessExpiresAt,
    accessExpiresIn: pair.accessExpiresIn,
    refreshExpiresAt: pair.refreshExpiresAt,
    id: match.id,
    label: match.label,
  };
}

export function revokeMcpToken(id: string): boolean {
  const file = loadTokensFile();
  const before = file.tokens.length;
  file.tokens = file.tokens.filter((t) => t.id !== id);
  if (file.tokens.length === before) return false;
  saveTokensFile(file);
  return true;
}

export function revokeAllMcpTokens(): number {
  const file = loadTokensFile();
  const n = file.tokens.length;
  saveTokensFile({ tokens: [] });
  return n;
}

export function verifyMcpBearerToken(
  token: string | undefined | null,
  ip = "unknown",
  ctx: AuthEventCtx = {},
): { id: string; label: string; kind: "static" | "connector" } {
  assertMcpNotLocked(ip);
  const raw = String(token || "").trim();
  const fail = (code: "mcp_token_invalid" | "mcp_token_expired", message: string, reason = "invalid_mcp_token"): never => {
    if (code !== "mcp_token_expired") {
      recordMcpFailure(ip, reason, {
        ...ctx,
        result: code === "mcp_token_invalid" ? "invalid" : "failure",
        status: 401,
      });
    }
    throw new HttpError(401, { message, code });
  };
  if (!raw || !raw.startsWith(TOKEN_PREFIX)) {
    fail("mcp_token_invalid", "Missing or invalid MCP token");
  }
  if (raw.startsWith(REFRESH_PREFIX)) {
    fail("mcp_token_invalid", "Invalid MCP token");
  }
  const digest = hashToken(raw);
  const file = loadTokensFile();
  const now = Math.floor(Date.now() / 1000);

  if (raw.startsWith(ACCESS_PREFIX)) {
    let rec: McpTokenRecord | undefined;
    for (const t of file.tokens) {
      if (t.accessHash && hashesEqual(t.accessHash, digest)) {
        rec = t;
        break;
      }
    }
    if (!rec) fail("mcp_token_invalid", "Invalid MCP token");
    if (rec!.accessExpiresAt && rec!.accessExpiresAt <= now) {
      throw new HttpError(401, {
        code: "mcp_token_expired",
        message: "Access token expired — refresh it, then retry once. Do not retry this request.",
      });
    }
    touchToken(rec!.id, ip);
    recordMcpSuccess(ip);
    return { id: rec!.id, label: rec!.label, kind: "connector" };
  }

  // Legacy long-lived static tokens (hb_mcp_<secret>).
  let rec: McpTokenRecord | undefined;
  for (const t of file.tokens) {
    if (t.hash && hashesEqual(t.hash, digest)) {
      rec = t;
      break;
    }
  }
  if (!rec) fail("mcp_token_invalid", "Invalid MCP token");
  touchToken(rec!.id, ip);
  recordMcpSuccess(ip);
  return { id: rec!.id, label: rec!.label, kind: "static" };
}

function preferredBaseUrl(): string {
  try {
    const st = systemStatus() as {
      urls?: { vpn?: string; lan?: string; local?: string };
    };
    const urls = st.urls || {};
    const pick = (urls.vpn || urls.lan || urls.local || "").replace(/\/+$/, "");
    if (pick) return pick;
  } catch {
    /* ignore */
  }
  return "";
}

function grokHookupGuide(url: string | null): string {
  const endpoint = url || "http://<homebase-vpn-ip>:<port>/mcp";
  return [
    "# Hook Grok bots into Home Base MCP",
    "",
    "Full copy-paste brief for bots: docs/GROK_MCP.md in the Home Base repo",
    "(Bot brief section + URL/token placeholders).",
    "",
    "Goal: Grok bots on your network (or VPN) drive Home Base ops tools — Cursor API key stays in Home Base Settings, not in the bot host.",
    "",
    "## 1. Network",
    "- Prefer WireGuard: add a peer for the machine that hosts Grok bots, connect that peer, confirm you can open the Home Base UI URL from that host.",
    "- Do not public-port-forward Home Base.",
    "",
    "## 2. Enable MCP + features",
    "- Settings → Remote access → MCP Server → master toggle On (default).",
    "- Feature toggles: Developer pilot = Projects + Notifications + Status + Presence On; Vision + Home Access Off.",
    "- Full toggles: Projects/Notifications/Status/Home Access/Presence default On; Vision defaults Off.",
    "",
    "## 3. Mint a token",
    "- MCP Server → Mint (label e.g. \"grok-developer\" — dedicated, not shared).",
    "- Copy the access token and refresh token once (shown only at mint). Session login JWTs are rejected on /mcp.",
    "- Access tokens expire (~1 hour). POST /mcp/token with the refresh token to rotate both. If a refresh token is reused, the connector is revoked.",
    "- On HTTP 401 (mcp_token_expired or mcp_token_invalid), stop retrying the same request. Refresh once, or ask the owner to mint a new connector.",
    "",
    "## 4. Point the bot at Streamable HTTP MCP",
    `- URL: ${endpoint}`,
    "- Header: Authorization: Bearer <token>",
    "- Transport: Streamable HTTP (JSON). Re-list tools after you change feature toggles.",
    "",
    "## 5. Operating rules for bots",
    "- Paste docs/GROK_MCP.md Bot brief; fill URL/token.",
    "- Prefer homebase_cursor_job handoff: whole job → Cursor on laptop → short summary + git tip (saves Grok tokens).",
    "- Use homebase_ping for liveness (never open a test chat). GitHub hookup: homebase_github_* / homebase_git_env_check (Settings → Git & GitHub login env).",
    "- Use homebase_* tools for control-plane work; do not ask for VPN/auth/restart — those stay human-only in Settings.",
    "- Presence (VPN/LAN only): call homebase_presence_express on arrive + state changes.",
    "  Desktop shows a Grok-style blob — set mood, form (pill|cloud|drop|circle|hex|diamond|soft|cluster),",
    "  color (#hex), energy (0..1), bubble (≤160), name. Prefer express over presence-chat dumps.",
    "  Window does not pop for localhost Web GUI on the laptop — remotes only.",
    "- If Vision tools are missing, Vision is Off or not Armed — ask the human, do not try to Arm yourself.",
    "- Web GUI is humans-only (password + optional PIN). MCP tokens are rejected on /api — use /mcp only.",
    "- Keep one token per bot (Developer separate); revoke in Settings if compromised.",
    "",
    "## 6. Cut access",
    "- Master MCP Off → /mcp returns 404.",
    "- Revoke token(s), or change the Home Base password (revokes all MCP tokens).",
  ].join("\n");
}

export function mcpServerPublic(): {
  enabled: boolean;
  features: McpFeatures;
  allowMcpWorkspaceCreate: boolean;
  allowMcpGitWrite: boolean;
  allowMcpGithubRepos: boolean;
  featureMeta: typeof MCP_FEATURE_META;
  updatedAt?: number;
  endpointPath: string;
  url: string | null;
  version: string;
  tokenCount: number;
  tokens: ReturnType<typeof listMcpTokens>;
  catalog: ReturnType<typeof mcpToolCatalog>;
  clientConfigs: {
    cursorMcpJson: string;
    genericUrl: string;
  };
  grokGuide: string;
} {
  const state = loadMcpServer();
  const base = preferredBaseUrl();
  const endpointPath = "/mcp";
  const url = base ? `${base}${endpointPath}` : null;
  const catalog = mcpToolCatalog(state.features);
  const cursorMcpJson = JSON.stringify(
    {
      mcpServers: {
        homebase: {
          url: url || `http://<homebase-vpn-host>${endpointPath}`,
          headers: {
            Authorization: "Bearer <paste-token-from-Settings>",
          },
        },
      },
    },
    null,
    2,
  );
  return {
    enabled: state.enabled !== false,
    features: state.features,
    allowMcpWorkspaceCreate: state.allowMcpWorkspaceCreate === true,
    allowMcpGitWrite: state.allowMcpGitWrite === true,
    allowMcpGithubRepos: state.allowMcpGithubRepos === true,
    featureMeta: MCP_FEATURE_META,
    updatedAt: state.updatedAt,
    endpointPath,
    url,
    version: readVersion(),
    tokenCount: listMcpTokens().length,
    tokens: listMcpTokens(),
    catalog,
    clientConfigs: {
      cursorMcpJson,
      genericUrl: url || `http://<homebase-vpn-host>${endpointPath}`,
    },
    grokGuide: grokHookupGuide(url),
  };
}

export type { McpFeatureId, McpFeatures };
