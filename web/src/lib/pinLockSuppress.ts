/**
 * Brief suppress window so intentional external opens (port tiles → window.open)
 * do not trip App PIN lock via pagehide / visibilitychange on mobile Safari / PWA.
 */
let suppressUntil = 0

export function suppressPinLockFor(ms: number): void {
  const n = Number(ms)
  if (!Number.isFinite(n) || n <= 0) return
  suppressUntil = Math.max(suppressUntil, Date.now() + n)
}

export function isPinLockSuppressed(now = Date.now()): boolean {
  return now < suppressUntil
}

/** Test helper — clear any active suppress window. */
export function resetPinLockSuppress(): void {
  suppressUntil = 0
}
