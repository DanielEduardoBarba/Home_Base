/** Nuclear Contingency FX — Web Audio only (no assets). Call unlock from a tap. */

import { unlockNotifyAudio } from './notifyAudio'

let ctx: AudioContext | null = null
let unlocked = false
let sirenStop: (() => void) | null = null

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

export async function unlockContingencyAudio(): Promise<void> {
  await unlockNotifyAudio()
  const c = getCtx()
  if (!c) return
  try {
    if (c.state === 'suspended') await c.resume()
    unlocked = true
  } catch {
    /* ignore */
  }
}

function beep(
  freq: number,
  dur: number,
  type: OscillatorType = 'square',
  gain = 0.11,
  when = 0,
): void {
  const c = getCtx()
  if (!c || !unlocked) return
  void c.resume().catch(() => {})
  const now = c.currentTime + when
  const osc = c.createOscillator()
  const g = c.createGain()
  osc.type = type
  osc.frequency.setValueAtTime(freq, now)
  g.gain.setValueAtTime(0.0001, now)
  g.gain.exponentialRampToValueAtTime(gain, now + 0.012)
  g.gain.exponentialRampToValueAtTime(0.0001, now + dur)
  osc.connect(g)
  g.connect(c.destination)
  osc.start(now)
  osc.stop(now + dur + 0.02)
}

export function playKeyClick(): void {
  beep(880, 0.04, 'triangle', 0.06)
}

export function playPinOk(): void {
  beep(520, 0.08, 'square', 0.1, 0)
  beep(780, 0.12, 'square', 0.1, 0.09)
  beep(1040, 0.16, 'square', 0.09, 0.2)
}

export function playPinFail(): void {
  beep(180, 0.22, 'sawtooth', 0.12)
  beep(120, 0.28, 'sawtooth', 0.1, 0.18)
}

export function playPress(): void {
  beep(220, 0.1, 'square', 0.09)
}

export function playSpinTick(): void {
  beep(640 + Math.random() * 80, 0.03, 'triangle', 0.045)
}

export function playArmed(): void {
  beep(440, 0.07, 'square', 0.1, 0)
  beep(660, 0.07, 'square', 0.1, 0.08)
  beep(880, 0.07, 'square', 0.1, 0.16)
  beep(1320, 0.18, 'square', 0.12, 0.28)
}

export function playLaunch(): void {
  const c = getCtx()
  if (!c || !unlocked) return
  void c.resume().catch(() => {})
  const now = c.currentTime
  const osc = c.createOscillator()
  const g = c.createGain()
  osc.type = 'sawtooth'
  osc.frequency.setValueAtTime(90, now)
  osc.frequency.exponentialRampToValueAtTime(40, now + 1.4)
  g.gain.setValueAtTime(0.0001, now)
  g.gain.exponentialRampToValueAtTime(0.18, now + 0.05)
  g.gain.exponentialRampToValueAtTime(0.0001, now + 1.5)
  osc.connect(g)
  g.connect(c.destination)
  osc.start(now)
  osc.stop(now + 1.55)
  beep(1800, 0.05, 'square', 0.08, 0.05)
  beep(1400, 0.05, 'square', 0.08, 0.12)
  beep(1000, 0.08, 'square', 0.1, 0.2)
}

/** Soft looping two-tone while waiting on the armed button. */
export function startSiren(): void {
  stopSiren()
  const c = getCtx()
  if (!c || !unlocked) return
  void c.resume().catch(() => {})
  const osc = c.createOscillator()
  const g = c.createGain()
  osc.type = 'triangle'
  osc.frequency.setValueAtTime(480, c.currentTime)
  g.gain.setValueAtTime(0.035, c.currentTime)
  osc.connect(g)
  g.connect(c.destination)
  osc.start()
  let up = true
  const iv = window.setInterval(() => {
    if (!ctx) return
    const t = ctx.currentTime
    osc.frequency.cancelScheduledValues(t)
    osc.frequency.linearRampToValueAtTime(up ? 720 : 420, t + 0.55)
    up = !up
  }, 560)
  sirenStop = () => {
    window.clearInterval(iv)
    try {
      g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + 0.08)
      osc.stop(c.currentTime + 0.1)
    } catch {
      /* ignore */
    }
    sirenStop = null
  }
}

export function stopSiren(): void {
  if (sirenStop) sirenStop()
}
