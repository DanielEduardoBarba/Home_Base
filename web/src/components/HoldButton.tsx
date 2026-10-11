import { useRef, useState } from 'react'

const DEFAULT_HOLD_MS = 850

export type HoldTone = 'default' | 'danger' | 'warn' | 'ship'

const TONE_BTN: Record<HoldTone, string> = {
  default: 'hb-btn-ghost',
  danger: 'hb-btn-danger',
  warn: 'hb-btn-warn',
  ship: 'hb-btn-ship',
}

const TONE_FILL: Record<HoldTone, string> = {
  default: 'hb-hold-fill',
  danger: 'hb-hold-fill-danger',
  warn: 'hb-hold-fill-warn',
  ship: 'hb-hold-fill-warn',
}

function resolveTone(tone: HoldTone, className: string): HoldTone {
  if (tone !== 'default') return tone
  if (className.includes('hb-btn-danger')) return 'danger'
  if (className.includes('hb-btn-warn') || className.includes('hb-btn-ship')) return 'warn'
  return 'default'
}

/** Press-and-hold to confirm destructive / ship actions. */
export function HoldButton({
  label,
  holdLabel = 'hold…',
  disabled,
  className = '',
  title,
  holdMs = DEFAULT_HOLD_MS,
  tone = 'default',
  onConfirm,
}: {
  label: string
  holdLabel?: string
  disabled?: boolean
  className?: string
  title?: string
  /** Hold duration in ms (default 850). */
  holdMs?: number
  /** Visual intent — colors the button + fill progress. */
  tone?: HoldTone
  onConfirm: () => void | Promise<void>
}) {
  const [progress, setProgress] = useState(0)
  const [busy, setBusy] = useState(false)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)
  const started = useRef(0)
  const duration = Math.max(200, holdMs)
  const resolved = resolveTone(tone, className)
  const hasBtnVariant = /hb-btn-(ghost|danger|warn|ship|primary)/.test(className)
  const btnTone = hasBtnVariant ? '' : TONE_BTN[resolved]
  const baseBtn = className.includes('hb-btn') ? '' : 'hb-btn'

  function clear() {
    if (timer.current) clearInterval(timer.current)
    timer.current = null
    started.current = 0
    setProgress(0)
  }

  function start() {
    if (disabled || busy) return
    started.current = Date.now()
    timer.current = setInterval(() => {
      const p = Math.min(1, (Date.now() - started.current) / duration)
      setProgress(p)
      if (p >= 1) {
        clear()
        setBusy(true)
        Promise.resolve(onConfirm()).finally(() => setBusy(false))
      }
    }, 32)
  }

  return (
    <button
      type="button"
      disabled={disabled || busy}
      title={title || `Hold to ${label}`}
      className={`hb-hold-btn relative overflow-hidden select-none ${baseBtn} ${btnTone} ${className}`.trim()}
      onPointerDown={(e) => {
        e.preventDefault()
        try {
          e.currentTarget.setPointerCapture(e.pointerId)
        } catch {
          /* ignore */
        }
        start()
      }}
      onPointerUp={clear}
      onPointerLeave={clear}
      onPointerCancel={clear}
      onLostPointerCapture={clear}
      onContextMenu={(e) => e.preventDefault()}
    >
      <span
        className={`absolute inset-0 origin-left transition-[transform] duration-75 ${TONE_FILL[resolved]}`}
        style={{ transform: `scaleX(${progress})` }}
        aria-hidden
      />
      <span className="relative z-1">
        {busy ? '…' : progress > 0 ? holdLabel : label}
      </span>
    </button>
  )
}
