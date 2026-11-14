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
  /** Number shown next to the bar (matches the dashboard copy when present). */
  percent: number | null;
  /** Bar width 0–100 from the raw ratio. */
  width: number;
  detail: string | null;
};

export type CursorSpending = {
  ok: boolean;
  error: string | null;
  email: string | null;
  planName: string | null;
  price: string | null;
  cycleKind: "weekly" | "monthly" | "unknown";
  cycleEndMs: number | null;
  daysRemaining: number | null;
  included: SpendingMeter;
  includedUsedCents: number | null;
  includedLimitCents: number | null;
  cursorModels: SpendingMeter;
  otherModels: SpendingMeter;
  onDemandEnabled: boolean | null;
  onDemandUsedCents: number | null;
  onDemandLimitCents: number | null;
  dashboardUrl: string;
};

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
    included: emptyMeter("Included"),
    includedUsedCents: null,
    includedLimitCents: null,
    cursorModels: emptyMeter("Cursor Models"),
    otherModels: emptyMeter("Other Models"),
    onDemandEnabled: null,
    onDemandUsedCents: null,
    onDemandLimitCents: null,
    dashboardUrl: DASHBOARD,
  };
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

function percentFromMessage(msg: unknown): number | null {
  const m = String(msg || "").match(/(\d+(?:\.\d+)?)\s*%/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function clampWidth(v: number | null): number {
  if (v == null || !Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(100, v));
}

function moneyDetail(used: number | null, limit: number | null): string | null {
  if (used == null && limit == null) return null;
  const fmt = (cents: number) =>
    `$${(cents / 100).toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  if (used != null && limit != null) return `${fmt(used)} / ${fmt(limit)}`;
  if (used != null) return fmt(used);
  return null;
}

export function mapCursorSpending(input: {
  period?: unknown;
  plan?: unknown;
  summary?: unknown;
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

  const used = num(planUsage.totalSpend ?? planUsage.includedSpend ?? summaryPlan.used);
  const limit = num(planUsage.limit ?? summaryPlan.limit);
  const remaining = num(planUsage.remaining ?? summaryPlan.remaining);
  const autoRaw = num(planUsage.autoPercentUsed ?? summaryPlan.autoPercentUsed);
  const apiRaw = num(planUsage.apiPercentUsed ?? summaryPlan.apiPercentUsed);
  const headlineRaw =
    used != null && limit != null && limit > 0
      ? (used / limit) * 100
      : num(planUsage.totalPercentUsed ?? summaryPlan.totalPercentUsed);

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

  const daysRemaining =
    cycleEndMs != null ? Math.max(0, Math.floor((cycleEndMs - now) / 86_400_000)) : null;

  const planName = String(planInfo.planName || "").trim() || null;
  const price = String(planInfo.price || "").trim() || null;
  const hasNumbers = used != null || autoRaw != null || apiRaw != null || headlineRaw != null;

  const includedPercent =
    percentFromMessage(period.displayMessage) ??
    (headlineRaw != null ? Math.round(headlineRaw) : null);
  const cursorPercent =
    percentFromMessage(period.autoModelSelectedDisplayMessage || summary.autoModelSelectedDisplayMessage) ??
    (autoRaw != null ? Math.round(autoRaw) : null);
  const otherPercent =
    percentFromMessage(period.namedModelSelectedDisplayMessage || summary.namedModelSelectedDisplayMessage) ??
    (apiRaw != null ? Math.round(apiRaw) : null);

  return {
    ok: Boolean(hasNumbers || planName),
    error: hasNumbers || planName ? null : "Cursor did not return spending.",
    email: input.email || null,
    planName,
    price,
    cycleKind,
    cycleEndMs,
    daysRemaining,
    included: {
      label: "Included",
      percent: includedPercent,
      width: clampWidth(headlineRaw),
      detail: moneyDetail(used, limit ?? (remaining != null && used != null ? used + remaining : null)),
    },
    includedUsedCents: used,
    includedLimitCents: limit,
    cursorModels: {
      label: "Cursor Models",
      percent: cursorPercent,
      width: clampWidth(autoRaw),
      detail: null,
    },
    otherModels: {
      label: "Other Models",
      percent: otherPercent,
      width: clampWidth(apiRaw),
      detail: null,
    },
    onDemandEnabled: typeof onDemand.enabled === "boolean" ? onDemand.enabled : null,
    onDemandUsedCents: num(onDemand.used),
    onDemandLimitCents: num(onDemand.limit),
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
    if (!json || typeof json !== "object") {
      return { ok: false, status: res.status, json, error: "Cursor returned an empty spending response." };
    }
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

  const [me, period, plan, summary] = await Promise.all([
    cursorJson(cookie, "GET", "/api/auth/me"),
    cursorJson(cookie, "POST", "/api/dashboard/get-current-period-usage", {}),
    cursorJson(cookie, "POST", "/api/dashboard/get-plan-info", {}),
    cursorJson(cookie, "GET", "/api/usage-summary"),
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
    email,
  });
  if (!data.ok && (period.error || summary.error)) {
    data.error = period.error || summary.error || data.error;
  }
  cache = { at: Date.now(), fingerprint, data };
  return data;
}
