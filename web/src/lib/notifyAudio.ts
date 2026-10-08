/** Short “ping” via Web Audio — no asset; unlocks after a user gesture on iOS. */

let ctx: AudioContext | null = null
let unlocked = false

function getCtx(): AudioContext | null {
  const AC =
    typeof window !== 'undefined'
      ? window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      : undefined
  if (!AC) return null
  if (!ctx) ctx = new AC()
  return ctx
}

/** Call from a click/tap so iOS allows later programmatic beeps. */
export async function unlockNotifyAudio(): Promise<void> {
  const c = getCtx()
  if (!c) return
  try {
    if (c.state === 'suspended') await c.resume()
    unlocked = true
  } catch {
    /* ignore */
  }
}

export function playNotifyPing(level: string = 'info'): void {
  const c = getCtx()
  if (!c || !unlocked) return
  void c.resume().catch(() => {})

  const now = c.currentTime
  const osc = c.createOscillator()
  const gain = c.createGain()
  osc.connect(gain)
  gain.connect(c.destination)

  const high = level === 'error' ? 520 : level === 'warn' ? 660 : level === 'success' ? 880 : 740
  const low = level === 'error' ? 320 : 520
  osc.type = 'sine'
  osc.frequency.setValueAtTime(high, now)
  osc.frequency.exponentialRampToValueAtTime(Math.max(80, low), now + 0.14)

  gain.gain.setValueAtTime(0.0001, now)
  gain.gain.exponentialRampToValueAtTime(0.12, now + 0.02)
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.22)

  osc.start(now)
  osc.stop(now + 0.24)
}
