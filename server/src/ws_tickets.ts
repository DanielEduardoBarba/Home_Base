import { createHash, randomBytes } from "node:crypto";
import { authEpoch } from "./auth";

/** Production ticket lifetime. Tests may mint a shorter TTL via opts. */
export const WS_TICKET_TTL_SEC = 30;

type TicketRec = {
  exp: number;
  ae: number;
  sub: string;
  jti: string;
};

const store = new Map<string, TicketRec>();

function hashTicket(ticket: string): string {
  return createHash("sha256").update(ticket, "utf8").digest("hex");
}

function sweep(nowSec: number): void {
  if (store.size < 64) {
    for (const [k, rec] of store) {
      if (rec.exp <= nowSec) store.delete(k);
    }
    return;
  }
  for (const [k, rec] of store) {
    if (rec.exp <= nowSec) store.delete(k);
  }
}

/**
 * Mint a single-use WebSocket ticket bound to the current session.
 * The raw ticket is returned once and must never be logged.
 */
export function mintWsTicket(
  claims: Record<string, unknown>,
  opts?: { ttlMs?: number; nowMs?: number },
): { ticket: string; expiresAt: number; expiresIn: number } {
  const nowMs = opts?.nowMs ?? Date.now();
  const ttlMs = Math.max(1, Math.min(WS_TICKET_TTL_SEC * 1000, opts?.ttlMs ?? WS_TICKET_TTL_SEC * 1000));
  const nowSec = Math.floor(nowMs / 1000);
  const expiresAt = Math.floor((nowMs + ttlMs) / 1000) || nowSec + 1;
  // Keep sub-second TTLs for tests: store exp in ms internally via a side field?
  // Redeem compares rec.expMs. Use expMs for precision.
  sweep(nowSec);
  const ticket = randomBytes(32).toString("base64url");
  store.set(hashTicket(ticket), {
    exp: nowMs + ttlMs,
    ae: Number(claims.ae ?? authEpoch()) || 0,
    sub: String(claims.sub ?? "homebase"),
    jti: String(claims.jti ?? ""),
  });
  return {
    ticket,
    expiresAt: Math.ceil((nowMs + ttlMs) / 1000),
    expiresIn: Math.max(1, Math.ceil(ttlMs / 1000)),
  };
}

/**
 * Redeem a ticket exactly once. Returns the bound session record, or null
 * if missing, expired, already used, or the session epoch no longer matches.
 * The caller must not log `ticket`.
 */
export function redeemWsTicket(
  ticket: string,
  opts?: { nowMs?: number },
): TicketRec | null {
  if (!ticket || ticket.length < 16 || ticket.length > 256) return null;
  const key = hashTicket(ticket);
  const rec = store.get(key);
  store.delete(key);
  if (!rec) return null;
  const nowMs = opts?.nowMs ?? Date.now();
  if (rec.exp <= nowMs) return null;
  if (rec.ae !== authEpoch()) return null;
  return rec;
}

/** Test-only: drop the in-memory ticket table. */
export function resetWsTicketsForTest(): void {
  store.clear();
}
