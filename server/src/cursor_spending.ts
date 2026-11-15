/**
 * Cursor Spending (cursor.com/dashboard/spending).
 * A user API key cannot read this. The dashboard uses the local Cursor
 * login session already stored by the IDE on this laptop.
 * The session token never leaves this process and is not returned to the client.
 */
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { detectSeatUser } from "./shell_env";

export type SpendingMeter = {
  label: string;
  /** Integer shown as "N% used", rounded the way the Spending page does. */
  percent: number | null;
  /** Bar width 0–100 from the raw ratio. */
  width: number;
  detail: string | null;
};

export type GrokBotUsage = {
  /** "Included in Ultra" when the Cursor plan name is known. */
  includedLabel: string | null;
  percent: number | null;
  width: number;
  resetMs: number | null;
  daysRemaining: number | null;
};

export type CursorSpending = {
  ok: boolean;
  error: string | null;
  email: string | null;
  planName: string | null;
  price: string | null;
  cycleKind: "weekly" | "monthly" | "unknown";
  cycleEndMs: number | null;
  /** Calendar days until the plan limit resets (Spending's "N days left"). */
  daysRemaining: number | null;
  cursorModels: SpendingMeter;
  otherModels: SpendingMeter;
  grokBot: GrokBotUsage | null;
  /** Spending monthly-limit menu: Disabled, Fixed, or Unlimited. */
  onDemandMode: "disabled" | "fixed" | "unlimited" | null;
  /** Dollar cap when mode is fixed. */
  onDemandLimitDollars: number | null;
  dashboardUrl: string;
};

/** Cursor's own sentinel for the Spending "Unlimited" monthly limit. */
export const ON_DEMAND_UNLIMITED = 2_147_483_647;

export const CURSOR_PLAN_CHOICES = [
  { tier: "pro", name: "Pro", price: "$20/mo", rank: 1 },
  { tier: "pro_plus", name: "Pro+", price: "$60/mo", rank: 2 },
  { tier: "ultra", name: "Ultra", price: "$200/mo", rank: 3 },
] as const;

export type CursorPlanTier = (typeof CURSOR_PLAN_CHOICES)[number]["tier"];

const DASHBOARD = "https://cursor.com/dashboard/spending";
const CACHE_MS = 60_000;

let cache: { at: number; fingerprint: string; data: CursorSpending } | null = null;

function emptyMeter(label: string): SpendingMeter {
  return { label, percent: null, width: 0, detail: null };
}

export function emptySpending(error: string | null): CursorSpending {
  return {
    ok: false,
    error,
    email: null,
    planName: null,
    price: null,
    cycleKind: "unknown",
    cycleEndMs: null,
    daysRemaining: null,
    cursorModels: emptyMeter("Cursor Models"),
    otherModels: emptyMeter("Other Models"),
    grokBot: null,
    onDemandMode: null,
    onDemandLimitDollars: null,
    dashboardUrl: DASHBOARD,
  };
}

export function onDemandFromHardLimit(hard: Record<string, unknown>): {
  mode: CursorSpending["onDemandMode"];
  dollars: number | null;
} {
  if (hard.noUsageBasedAllowed === true || hard.no_usage_based_allowed === true) {
    return { mode: "disabled", dollars: null };
  }
  const limit = num(hard.hardLimit ?? hard.hard_limit);
  if (limit == null) return { mode: null, dollars: null };
  if (limit >= ON_DEMAND_UNLIMITED) return { mode: "unlimited", dollars: null };
  if (limit <= 0) return { mode: "disabled", dollars: null };
  return { mode: "fixed", dollars: Math.round(limit) };
}

/** Body the Cursor client sends to set the Spending monthly limit. */
export function onDemandWriteBody(
  mode: "disabled" | "fixed" | "unlimited",
  dollars?: number,
): { hardLimit: number; noUsageBasedAllowed: boolean } {
  if (mode === "disabled") return { hardLimit: 0, noUsageBasedAllowed: true };
  if (mode === "unlimited") return { hardLimit: ON_DEMAND_UNLIMITED, noUsageBasedAllowed: false };
  const amount = Math.round(Number(dollars));
  if (!Number.isFinite(amount) || amount < 1 || amount > 100_000) {
    throw new Error("Monthly limit must be between $1 and $100,000.");
  }
  return { hardLimit: amount, noUsageBasedAllowed: false };
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function epochMs(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v < 1e12 ? v * 1000 : v;
  if (typeof v === "string") {
    const s = v.trim();
    if (/^\d+$/.test(s)) {
      const n = Number(s);
      return n < 1e12 ? n * 1000 : n;
    }
    const t = Date.parse(s);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

function clampWidth(v: number | null): number {
  if (v == null || !Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(100, v));
}

/** Spending labels are rounded percents: 4.3 → 4, 98.7 → 99. */
function shownPercent(raw: number | null): number | null {
  if (raw == null || !Number.isFinite(raw)) return null;
  return Math.round(Math.max(0, Math.min(100, raw)));
}

/** Whole calendar days from today to the reset date, in local time. */
export function calendarDaysUntil(endMs: number, now = Date.now()): number {
  const end = new Date(endMs);
  const cur = new Date(now);
  const endDay = Date.UTC(end.getFullYear(), end.getMonth(), end.getDate());
  const nowDay = Date.UTC(cur.getFullYear(), cur.getMonth(), cur.getDate());
  return Math.max(0, Math.round((endDay - nowDay) / 86_400_000));
}

function mapGrokBot(sand: Record<string, unknown>, planName: string | null, now: number): GrokBotUsage | null {
  const raw = num(sand.usagePercent ?? sand.usage_percent);
  const resetMs = epochMs(sand.nextResetTimestampUtc ?? sand.next_reset_timestamp_utc);
  const hasLimit = sand.hasNonZeroIncludedLimit === true || sand.has_non_zero_included_limit === true;
  if (raw == null && !hasLimit && resetMs == null) return null;
  const linked = String(sand.cursorPlanName || planName || "").trim();
  return {
    includedLabel: linked ? `Included in ${linked}` : null,
    percent: shownPercent(raw),
    width: clampWidth(raw),
    resetMs,
    daysRemaining: resetMs != null ? calendarDaysUntil(resetMs, now) : null,
  };
}

export function mapCursorSpending(input: {
  period?: unknown;
  plan?: unknown;
  summary?: unknown;
  sand?: unknown;
  hard?: unknown;
  email?: string | null;
  now?: number;
}): CursorSpending {
  const now = input.now ?? Date.now();
  const period = asRecord(input.period);
  const planWrap = asRecord(input.plan);
  const planInfo = asRecord(planWrap.planInfo);
  const summary = asRecord(input.summary);
  const individual = asRecord(summary.individualUsage);
  const summaryPlan = asRecord(individual.plan);
  const planUsage = asRecord(period.planUsage);
  const onDemand = asRecord(individual.onDemand);
  const hard = asRecord(input.hard);

  const autoRaw = num(planUsage.autoPercentUsed ?? summaryPlan.autoPercentUsed);
  const apiRaw = num(planUsage.apiPercentUsed ?? summaryPlan.apiPercentUsed);

  const periodName = String(planInfo.includedUsagePeriod || "");
  const cycleKind: CursorSpending["cycleKind"] = /WEEKLY/i.test(periodName)
    ? "weekly"
    : periodName
      ? "monthly"
      : "unknown";

  const cycleEndMs =
    epochMs(period.billingCycleEnd) ||
    epochMs(summary.billingCycleEnd) ||
    epochMs(planInfo.renewsAt) ||
    epochMs(planInfo.billingCycleEnd);

  const planName = String(planInfo.planName || "").trim() || null;
  const price = String(planInfo.price || "").trim() || null;
  const grokBot = mapGrokBot(asRecord(input.sand), planName, now);
  const hasNumbers = autoRaw != null || apiRaw != null || grokBot != null;

  const fromHard = onDemandFromHardLimit(hard);
  let onDemandMode = fromHard.mode;
  let onDemandLimitDollars = fromHard.dollars;
  if (onDemandMode == null && onDemand.enabled === false) {
    onDemandMode = "disabled";
    onDemandLimitDollars = null;
  }

  return {
    ok: Boolean(hasNumbers || planName),
    error: hasNumbers || planName ? null : "Cursor did not return spending.",
    email: input.email || null,
    planName,
    price,
    cycleKind,
    cycleEndMs,
    daysRemaining: cycleEndMs != null ? calendarDaysUntil(cycleEndMs, now) : null,
    cursorModels: {
      label: "Cursor Models",
      percent: shownPercent(autoRaw),
      width: clampWidth(autoRaw),
      detail: "Additional usage beyond limits consumes Other Models quota or on-demand spend.",
    },
    otherModels: {
      label: "Other Models",
      percent: shownPercent(apiRaw),
      width: clampWidth(apiRaw),
      detail: "Additional usage beyond limits consumes on-demand spend.",
    },
    grokBot,
    onDemandMode,
    onDemandLimitDollars,
    dashboardUrl: DASHBOARD,
  };
}

function stateDbPaths(): string[] {
  const homes = new Set<string>();
  try {
    const home = detectSeatUser().home;
    if (home) homes.add(home);
  } catch {
    /* ignore */
  }
  if (process.env.HOME) homes.add(process.env.HOME);
  homes.add(homedir());
  return [...homes].map((home) =>
    join(home, ".config", "Cursor", "User", "globalStorage", "state.vscdb"),
  );
}

function readAccessToken(): string | null {
  for (const path of stateDbPaths()) {
    if (!existsSync(path)) continue;
    try {
      const db = new Database(path, { readonly: true });
      const row = db
        .query("SELECT value FROM ItemTable WHERE key = ?")
        .get("cursorAuth/accessToken") as { value?: string } | null;
      db.close();
      const token = String(row?.value || "").trim();
      if (token.split(".").length >= 3) return token;
    } catch {
      /* locked or unreadable */
    }
  }
  return null;
}

function jwtSub(token: string): string | null {
  try {
    const part = token.split(".")[1] || "";
    const payload = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as {
      sub?: string;
    };
    const sub = String(payload.sub || "").trim();
    return sub || null;
  } catch {
    return null;
  }
}

async function cursorJson(
  cookie: string,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<{ ok: boolean; status: number; json: unknown; error?: string }> {
  try {
    const res = await fetch(`https://cursor.com${path}`, {
      method,
      headers: {
        Accept: "application/json",
        Cookie: cookie,
        ...(method === "POST"
          ? {
              "Content-Type": "application/json",
              Origin: "https://cursor.com",
              Referer: DASHBOARD,
            }
          : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(12_000),
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!res.ok) {
      const msg =
        (json as { error?: string; message?: string } | null)?.error ||
        (json as { message?: string } | null)?.message ||
        `HTTP ${res.status}`;
      return { ok: false, status: res.status, json, error: String(msg) };
    }
    if (!json || typeof json !== "object") json = {};
    return { ok: true, status: res.status, json };
  } catch (e) {
    return {
      ok: false,
      status: 0,
      json: null,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/** Live Spending snapshot for the Cursor account signed in on this laptop. */
export async function fetchCursorSpending(opts?: { force?: boolean }): Promise<CursorSpending> {
  const token = readAccessToken();
  if (!token) return emptySpending("Sign in to Cursor on this laptop.");
  const fingerprint = token.slice(-12);
  if (!opts?.force && cache && cache.fingerprint === fingerprint && Date.now() - cache.at < CACHE_MS) {
    return cache.data;
  }

  const sub = jwtSub(token);
  if (!sub) return emptySpending("Cursor login on this laptop could not be read.");
  const cookie = `WorkosCursorSessionToken=${sub}%3A%3A${token}`;

  const [me, period, plan, summary, sand, hard] = await Promise.all([
    cursorJson(cookie, "GET", "/api/auth/me"),
    cursorJson(cookie, "POST", "/api/dashboard/get-current-period-usage", {}),
    cursorJson(cookie, "POST", "/api/dashboard/get-plan-info", {}),
    cursorJson(cookie, "GET", "/api/usage-summary"),
    cursorJson(cookie, "POST", "/api/dashboard/get-sand-usage-status", {}),
    cursorJson(cookie, "POST", "/api/dashboard/get-hard-limit", {}),
  ]);

  if (!period.ok && !summary.ok) {
    const unauthorized = [period.status, summary.status].includes(401);
    return emptySpending(
      unauthorized
        ? "Cursor session expired. Open Cursor and sign in again."
        : period.error || summary.error || "Could not load Spending.",
    );
  }

  const email = me.ok ? String(asRecord(me.json).email || "") || null : null;
  const data = mapCursorSpending({
    period: period.json,
    plan: plan.json,
    summary: summary.json,
    sand: sand.ok ? sand.json : null,
    hard: hard.ok ? hard.json : null,
    email,
  });
  if (!data.ok && (period.error || summary.error)) {
    data.error = period.error || summary.error || data.error;
  }
  cache = { at: Date.now(), fingerprint, data };
  return data;
}

function sessionCookie(): { cookie: string; fingerprint: string } | null {
  const token = readAccessToken();
  if (!token) return null;
  const sub = jwtSub(token);
  if (!sub) return null;
  return {
    cookie: `WorkosCursorSessionToken=${sub}%3A%3A${token}`,
    fingerprint: token.slice(-12),
  };
}

/** Save the Spending monthly limit. Disabled sends hardLimit 0; Unlimited uses Cursor's sentinel. */
export async function setCursorOnDemand(input: {
  mode: "disabled" | "fixed" | "unlimited";
  dollars?: number;
}): Promise<CursorSpending> {
  const session = sessionCookie();
  if (!session) throw new Error("Sign in to Cursor on this laptop.");
  const body = onDemandWriteBody(input.mode, input.dollars);
  const res = await cursorJson(session.cookie, "POST", "/api/dashboard/set-hard-limit", body);
  if (!res.ok) throw new Error(res.error || "Could not save the on-demand limit.");
  cache = null;
  return fetchCursorSpending({ force: true });
}

/**
 * Start the same plan checkout the Spending "Adjust Plan" button uses.
 * Returns the https URL (usually Stripe) for the browser to open. Does not complete payment.
 */
export async function startCursorPlanCheckout(tier: CursorPlanTier): Promise<{ url: string }> {
  const session = sessionCookie();
  if (!session) throw new Error("Sign in to Cursor on this laptop.");
  let current = `https://cursor.com/api/auth/checkoutDeepControl?tier=${encodeURIComponent(tier)}&allowTrial=false`;
  for (let hop = 0; hop < 8; hop++) {
    const res = await fetch(current, {
      redirect: "manual",
      headers: {
        Cookie: session.cookie,
        Accept: "text/html,application/json",
        Origin: "https://cursor.com",
        Referer: DASHBOARD,
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) throw new Error("Checkout did not return a redirect.");
      const next = new URL(loc, current);
      if (next.protocol !== "https:") throw new Error("Checkout redirect was not https.");
      current = next.toString();
      if (next.hostname === "checkout.stripe.com" || next.hostname.endsWith(".stripe.com")) {
        return { url: current };
      }
      continue;
    }
    if (res.ok) return { url: current };
    throw new Error(`Checkout failed (HTTP ${res.status}).`);
  }
  throw new Error("Checkout redirect did not finish.");
}
