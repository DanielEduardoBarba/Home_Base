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
import { HttpError, recordFailure } from "./auth";
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

export type McpServerState = {
  enabled: boolean;
  features: McpFeatures;
  updatedAt?: number;
};

type McpTokenRecord = {
  id: string;
  prefix: string;
  hash: string;
  label: string;
  createdAt: number;
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
      updatedAt: Number(raw.updatedAt) || undefined,
    };
  } catch {
    return emptyState();
  }
}

export function saveMcpServer(
  patch: Partial<{ enabled: boolean; features: Partial<McpFeatures> }>,
): McpServerState {
  const cur = loadMcpServer();
  const next: McpServerState = {
    enabled:
      typeof patch.enabled === "boolean" ? patch.enabled : cur.enabled,
    features: patch.features
      ? normalizeMcpFeatures({ ...cur.features, ...patch.features })
      : cur.features,
    updatedAt: Date.now(),
  };
  writeJsonAtomic(STATE_PATH, next);
  return next;
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
          Boolean(t && t.id && t.hash && t.prefix),
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
}[] {
  return loadTokensFile().tokens.map((t) => ({
    id: t.id,
    prefix: t.prefix,
    label: t.label,
    createdAt: t.createdAt,
  }));
}

export function mintMcpToken(label = ""): {
  id: string;
  token: string;
  prefix: string;
  label: string;
  createdAt: number;
} {
  const id = randomBytes(8).toString("hex");
  const secret = randomBytes(24).toString("base64url");
  const token = `${TOKEN_PREFIX}${secret}`;
  const prefix = token.slice(0, 14) + "…";
  const createdAt = Date.now();
  const cleanLabel = String(label || "").trim().slice(0, 64) || "MCP client";
  const file = loadTokensFile();
  file.tokens.push({
    id,
    prefix,
    hash: hashToken(token),
    label: cleanLabel,
    createdAt,
  });
  saveTokensFile(file);
  return { id, token, prefix, label: cleanLabel, createdAt };
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
): { id: string; label: string } {
  if (!token || !token.startsWith(TOKEN_PREFIX)) {
    recordFailure(ip, "invalid_mcp_token");
    throw new HttpError(401, {
      message: "Missing or invalid MCP token",
      code: "invalid_mcp_token",
    });
  }
  const digest = hashToken(token);
  const match = loadTokensFile().tokens.find((t) => hashesEqual(t.hash, digest));
  if (!match) {
    recordFailure(ip, "invalid_mcp_token");
    throw new HttpError(401, {
      message: "Invalid MCP token",
      code: "invalid_mcp_token",
    });
  }
  return { id: match.id, label: match.label };
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
    "- Copy the `hb_mcp_…` secret once. Session login JWTs are rejected on /mcp.",
    "",
    "## 4. Point the bot at Streamable HTTP MCP",
    `- URL: ${endpoint}`,
    "- Header: Authorization: Bearer <token>",
    "- Transport: Streamable HTTP (JSON). Re-list tools after you change feature toggles.",
    "",
    "## 5. Operating rules for bots",
    "- Paste docs/GROK_MCP.md Bot brief; fill URL/token.",
    "- Prefer homebase_cursor_job handoff: whole job → Cursor on laptop → short summary + git tip (saves Grok tokens).",
    "- Use homebase_* tools for control-plane work; do not ask for VPN/auth/restart — those stay human-only in Settings.",
    "- Call homebase_presence_express when you arrive and as you work so the operator desktop window shows your character.",
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
