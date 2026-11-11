/**
 * Optional email alerts (Resend or SMTP) — human Settings only.
 * Sends ONLY for:
 *   1) Suspicious auth (3+ failed logins / PIN attempts, or lockout)
 *   2) AI Home Base / LAN access while the seat user is away
 * Anti-spam: long dedupe windows + one AI email per “away episode”.
 */
import {
  chmodSync,
  existsSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { FAIL_THRESHOLD } from "./auth";
import { RUNTIME_DIR, ensureRuntimeDirs } from "./config";
import { smtpSend } from "./email_smtp";
import { formatGeo, geoCached } from "./geo";
import {
  decryptFromFile,
  encryptToFile,
  secretDisplayHint,
} from "./secrets_vault";
import { getSeatAwayStatus, type SeatAwayStatus } from "./seat_away";
import { appendTrace } from "./trace";

const CONFIG_PATH = join(RUNTIME_DIR, "email_alerts.json");
const SECRETS_PATH = join(RUNTIME_DIR, "email_alerts.secrets.enc");

const AUTH_DEDUPE_MS = 30 * 60_000;
const AI_EPISODE_COOLDOWN_MS = 45 * 60_000;
const SUSPICIOUS_FAIL_FLOOR = 3;

export type EmailProvider = "resend" | "smtp";

type EmailAlertsFile = {
  enabled: boolean;
  provider: EmailProvider;
  to: string;
  from: string;
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpSecure: boolean;
  updatedAt?: number;
};

type EmailSecrets = {
  resendApiKey?: string;
  smtpPass?: string;
};

export type EmailAlertsPublic = {
  enabled: boolean;
  provider: EmailProvider;
  to: string;
  from: string;
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpSecure: boolean;
  resendConfigured: boolean;
  resendHint: string | null;
  smtpPassConfigured: boolean;
  ready: boolean;
  updatedAt?: number;
  /** What we email about — fixed product policy, not toggles. */
  scopes: {
    suspiciousAuth: true;
    aiAwayAccess: true;
  };
};

const lastAuthEmail = new Map<string, number>();
let aiEpisodeActive = false;
let aiEmailedThisEpisode = false;
let lastAiEmailAt = 0;
let lastSeatWasAway: boolean | null = null;

function chmodPrivate(path: string): void {
  try {
    chmodSync(path, 0o600);
  } catch {
    /* ignore */
  }
}

function emptyConfig(): EmailAlertsFile {
  return {
    enabled: false,
    provider: "resend",
    to: "",
    from: "",
    smtpHost: "",
    smtpPort: 587,
    smtpUser: "",
    smtpSecure: false,
  };
}

function loadConfig(): EmailAlertsFile {
  if (!existsSync(CONFIG_PATH)) return emptyConfig();
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<EmailAlertsFile>;
    const port = Number(raw.smtpPort);
    return {
      enabled: !!raw.enabled,
      provider: raw.provider === "smtp" ? "smtp" : "resend",
      to: String(raw.to || "").trim(),
      from: String(raw.from || "").trim(),
      smtpHost: String(raw.smtpHost || "").trim(),
      smtpPort: Number.isFinite(port) && port > 0 ? Math.min(port, 65535) : 587,
      smtpUser: String(raw.smtpUser || "").trim(),
      smtpSecure: !!raw.smtpSecure,
      updatedAt: Number(raw.updatedAt) || undefined,
    };
  } catch {
    return emptyConfig();
  }
}

function saveConfig(cfg: EmailAlertsFile): void {
  ensureRuntimeDirs();
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  chmodPrivate(CONFIG_PATH);
}

function loadSecrets(): EmailSecrets {
  const raw = decryptFromFile(SECRETS_PATH);
  if (!raw) return {};
  try {
    const o = JSON.parse(raw) as EmailSecrets;
    return {
      resendApiKey: o.resendApiKey ? String(o.resendApiKey) : undefined,
      smtpPass: o.smtpPass ? String(o.smtpPass) : undefined,
    };
  } catch {
    return {};
  }
}

function saveSecrets(next: EmailSecrets): void {
  const cleaned: EmailSecrets = {};
  if (next.resendApiKey) cleaned.resendApiKey = next.resendApiKey;
  if (next.smtpPass) cleaned.smtpPass = next.smtpPass;
  if (!cleaned.resendApiKey && !cleaned.smtpPass) {
    try {
      if (existsSync(SECRETS_PATH)) unlinkSync(SECRETS_PATH);
    } catch {
      /* ignore */
    }
    return;
  }
  encryptToFile(SECRETS_PATH, JSON.stringify(cleaned));
}

function isReady(cfg: EmailAlertsFile, secrets: EmailSecrets): boolean {
  if (!cfg.enabled || !cfg.to) return false;
  if (cfg.provider === "resend") {
    return !!(secrets.resendApiKey && (cfg.from || "Home Base <onboarding@resend.dev>"));
  }
  return !!(cfg.smtpHost && cfg.from && (cfg.smtpUser ? secrets.smtpPass : true));
}

export function emailAlertsPublic(): EmailAlertsPublic {
  const cfg = loadConfig();
  const secrets = loadSecrets();
  return {
    enabled: cfg.enabled,
    provider: cfg.provider,
    to: cfg.to,
    from: cfg.from,
    smtpHost: cfg.smtpHost,
    smtpPort: cfg.smtpPort,
    smtpUser: cfg.smtpUser,
    smtpSecure: cfg.smtpSecure,
    resendConfigured: !!secrets.resendApiKey,
    resendHint: secrets.resendApiKey ? secretDisplayHint(secrets.resendApiKey) : null,
    smtpPassConfigured: !!secrets.smtpPass,
    ready: isReady(cfg, secrets),
    updatedAt: cfg.updatedAt,
    scopes: { suspiciousAuth: true, aiAwayAccess: true },
  };
}

export type EmailAlertsSaveInput = {
  enabled?: boolean;
  provider?: EmailProvider;
  to?: string;
  from?: string;
  smtpHost?: string;
  smtpPort?: number;
  smtpUser?: string;
  smtpSecure?: boolean;
  /** Set or replace; omit to keep; empty string clears. */
  resendApiKey?: string;
  smtpPass?: string;
};

export function saveEmailAlerts(input: EmailAlertsSaveInput): EmailAlertsPublic {
  const cfg = loadConfig();
  const secrets = loadSecrets();

  if (input.enabled != null) cfg.enabled = !!input.enabled;
  if (input.provider === "resend" || input.provider === "smtp") {
    cfg.provider = input.provider;
  }
  if (input.to != null) cfg.to = String(input.to).trim();
  if (input.from != null) cfg.from = String(input.from).trim();
  if (input.smtpHost != null) cfg.smtpHost = String(input.smtpHost).trim();
  if (input.smtpPort != null) {
    const p = Number(input.smtpPort);
    if (Number.isFinite(p) && p > 0) cfg.smtpPort = Math.min(Math.floor(p), 65535);
  }
  if (input.smtpUser != null) cfg.smtpUser = String(input.smtpUser).trim();
  if (input.smtpSecure != null) cfg.smtpSecure = !!input.smtpSecure;

  if (input.resendApiKey !== undefined) {
    const v = String(input.resendApiKey).trim();
    if (!v) delete secrets.resendApiKey;
    else secrets.resendApiKey = v;
  }
  if (input.smtpPass !== undefined) {
    const v = String(input.smtpPass);
    if (!v) delete secrets.smtpPass;
    else secrets.smtpPass = v;
  }

  if (cfg.to && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cfg.to)) {
    throw new Error("Invalid destination email");
  }

  cfg.updatedAt = Date.now();
  saveConfig(cfg);
  saveSecrets(secrets);
  return emailAlertsPublic();
}

export function clearEmailAlertSecrets(): EmailAlertsPublic {
  saveSecrets({});
  return emailAlertsPublic();
}

async function sendResend(opts: {
  apiKey: string;
  from: string;
  to: string;
  subject: string;
  text: string;
}): Promise<void> {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from: opts.from || "Home Base <onboarding@resend.dev>",
      to: [opts.to],
      subject: opts.subject,
      text: opts.text,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Resend ${res.status}: ${body.slice(0, 200)}`);
  }
}

async function deliver(subject: string, text: string): Promise<{ ok: boolean; error?: string }> {
  const cfg = loadConfig();
  const secrets = loadSecrets();
  if (!isReady(cfg, secrets)) {
    return { ok: false, error: "Email alerts not configured or disabled" };
  }
  try {
    if (cfg.provider === "resend") {
      await sendResend({
        apiKey: secrets.resendApiKey!,
        from: cfg.from || "Home Base <onboarding@resend.dev>",
        to: cfg.to,
        subject,
        text,
      });
    } else {
      await smtpSend({
        host: cfg.smtpHost,
        port: cfg.smtpPort,
        secure: cfg.smtpSecure || cfg.smtpPort === 465,
        user: cfg.smtpUser,
        pass: secrets.smtpPass || "",
        from: cfg.from,
        to: cfg.to,
        subject,
        text,
      });
    }
    appendTrace("info", `email alert sent: ${subject.slice(0, 80)}`, "email");
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    appendTrace("warn", `email alert failed: ${msg}`, "email");
    return { ok: false, error: msg };
  }
}

export async function sendEmailAlertTest(): Promise<{ ok: boolean; error?: string }> {
  const seat = getSeatAwayStatus({ force: true });
  return deliver(
    "Home Base · test alert",
    [
      "This is a test from Home Base email alerts.",
      "",
      "You will only receive real mail for:",
      "  • Suspicious activity (repeated failed logins / PIN attempts)",
      "  • AI access while you are away from this laptop",
      "",
      `Seat right now: ${seat.away ? `away (${seat.reason})` : "present"}`,
      seat.detail ? `Detail: ${seat.detail}` : "",
      "",
      "— Home Base",
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

function authDedupeOk(key: string, now: number): boolean {
  const last = lastAuthEmail.get(key) || 0;
  if (now - last < AUTH_DEDUPE_MS) return false;
  lastAuthEmail.set(key, now);
  if (lastAuthEmail.size > 40) {
    for (const [k, t] of lastAuthEmail) {
      if (now - t > AUTH_DEDUPE_MS * 2) lastAuthEmail.delete(k);
    }
  }
  return true;
}

/**
 * Called from recordFailure after desktop/inbox notify.
 * Emails at 3+ failures and again at lockout (deduped per IP · reason class).
 */
export function maybeEmailSuspiciousAuth(opts: {
  ip: string;
  reason: string;
  failCount: number;
  retryAfter?: number;
}): void {
  const cfg = loadConfig();
  if (!cfg.enabled || !isReady(cfg, loadSecrets())) return;
  if (opts.failCount < SUSPICIOUS_FAIL_FLOOR) return;

  const locked = opts.failCount >= FAIL_THRESHOLD;
  const kind = locked ? "lockout" : "repeated";
  const now = Date.now();
  // Allow lockout mail even if a "repeated" mail went recently — separate keys.
  const dedupeKey = `auth:${kind}:${opts.ip}`;
  if (!authDedupeOk(dedupeKey, now)) return;

  const geo = formatGeo(geoCached(opts.ip));
  const pin = /pin/i.test(opts.reason);
  const subject = locked
    ? "Home Base · auth lockout"
    : pin
      ? "Home Base · repeated PIN failures"
      : "Home Base · repeated login failures";

  const text = [
    locked
      ? "Home Base locked out further attempts after repeated failures."
      : "Home Base saw multiple failed authentication attempts.",
    "",
    `Reason: ${opts.reason}`,
    `Failures: ${opts.failCount} (lockout at ${FAIL_THRESHOLD})`,
    `IP: ${opts.ip}${geo ? ` (${geo})` : ""}`,
    locked && opts.retryAfter
      ? `Lockout remaining: ~${Math.max(1, Math.round(opts.retryAfter))}s`
      : "",
    "",
    "If this was you, you can ignore this. If not, change your password from a localhost browser and revoke MCP tokens in Settings.",
    "",
    "— Home Base",
  ]
    .filter(Boolean)
    .join("\n");

  void deliver(subject, text);
}

function refreshAwayEpisode(seat: SeatAwayStatus): void {
  if (lastSeatWasAway === null) {
    lastSeatWasAway = seat.away;
    aiEpisodeActive = seat.away;
    return;
  }
  if (seat.away && !lastSeatWasAway) {
    // Newly away — fresh episode; allow one AI mail again.
    aiEpisodeActive = true;
    aiEmailedThisEpisode = false;
  } else if (!seat.away && lastSeatWasAway) {
    aiEpisodeActive = false;
    aiEmailedThisEpisode = false;
  }
  lastSeatWasAway = seat.away;
}

/**
 * AI touched Home Base (MCP connect / tool) while seat user is away.
 * One informative email per away episode (resets when you return).
 */
export function maybeEmailAiAwayAccess(opts: {
  actorLabel: string;
  actorId?: string;
  peerIp?: string;
  action?: string;
}): void {
  const cfg = loadConfig();
  if (!cfg.enabled || !isReady(cfg, loadSecrets())) return;

  const seat = getSeatAwayStatus();
  refreshAwayEpisode(seat);
  if (!seat.away) return;

  const now = Date.now();
  if (aiEmailedThisEpisode) return;
  if (now - lastAiEmailAt < AI_EPISODE_COOLDOWN_MS && aiEpisodeActive) {
    // Extra safety if episode tracking glitches.
    aiEmailedThisEpisode = true;
    return;
  }

  aiEmailedThisEpisode = true;
  lastAiEmailAt = now;
  aiEpisodeActive = true;

  const awayWhy =
    seat.reason === "locked"
      ? "screen locked"
      : seat.reason === "idle"
        ? `idle ${seat.idleMs != null ? `${Math.round(seat.idleMs / 60_000)}+ min` : "10+ min"}`
        : "desktop session not available";

  const subject = "Home Base · AI active while you are away";
  const text = [
    "An AI client used Home Base while this laptop looks unattended.",
    "",
    `Actor: ${opts.actorLabel || "MCP AI"}`,
    opts.actorId ? `Token / id: ${opts.actorId}` : "",
    opts.peerIp ? `Peer: ${opts.peerIp}` : "",
    opts.action ? `Activity: ${opts.action}` : "Activity: connected via MCP",
    `Away because: ${awayWhy}`,
    seat.detail ? `Seat: ${seat.detail}` : "",
    "",
    "Further AI activity in this away period will not send another email.",
    "You will get another only after you return (unlock / use the computer) and leave again — or after a long cooldown.",
    "",
    "Revoke MCP tokens in Settings → MCP Server if this is unexpected.",
    "",
    "— Home Base",
  ]
    .filter(Boolean)
    .join("\n");

  void deliver(subject, text);
}
