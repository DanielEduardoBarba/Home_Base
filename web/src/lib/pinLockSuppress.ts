/**
 * One-shot suppress so intentional external opens (port tiles → window.open)
 * do not trip App PIN lock via the immediate pagehide / visibilitychange.
 * After the first hide is consumed, a delayed lock still fires if the page
 * stays hidden longer than the armed window (normal lock path).
 */

let armed = false
let delayedLockMs = 3000
/** After consuming the one-shot, ignore twin hide events until visible again. */
let ignoreHideUntilVisible = false

export function suppressPinLockFor(ms: number): void {
  const n = Number(ms)
  if (!Number.isFinite(n) || n <= 0) return
  armed = true
  delayedLockMs = n
  ignoreHideUntilVisible = false
}

export type HideSuppressResult =
  | { skip: true; scheduleMs: number }
  | { skip: true; scheduleMs: null }
  | { skip: false }

/**
 * Handle a hide event (pagehide / visibility=hidden).
 * - First hide after arm: skip lock + return scheduleMs for delayed lock if still hidden.
 * - Twin hide during grace: skip lock, no new schedule.
 * - Otherwise: do not skip (caller locks as normal).
 */
export function takePinLockHideSuppress(): HideSuppressResult {
  if (armed) {
    armed = false
    ignoreHideUntilVisible = true
    return { skip: true, scheduleMs: delayedLockMs }
  }
  if (ignoreHideUntilVisible) {
    return { skip: true, scheduleMs: null }
  }
  return { skip: false }
}

/** True while a one-shot is armed (before first hide) or twin-hide grace is active. */
export function isPinLockSuppressed(): boolean {
  return armed || ignoreHideUntilVisible
}

/** Call when the document becomes visible again — clears twin-hide grace. */
export function clearPinLockHideGrace(): void {
  ignoreHideUntilVisible = false
}

/** Test helper — clear any active suppress / grace. */
export function resetPinLockSuppress(): void {
  armed = false
  ignoreHideUntilVisible = false
  delayedLockMs = 3000
}
