import { useRef, useState } from 'react'

const DEFAULT_HOLD_MS = 850

/** Press-and-hold to confirm destructive / ship actions. */
export function HoldButton({
  label,
  holdLabel = 'hold…',
  disabled,
  className = '',
  title,
  holdMs = DEFAULT_HOLD_MS,
  onConfirm,
}: {
  label: string
  holdLabel?: string
  disabled?: boolean
  className?: string
  title?: string
  /** Hold duration in ms (default 850). */
  holdMs?: number
  onConfirm: () => void | Promise<void>
}) {
  const [progress, setProgress] = useState(0)
  const [busy, setBusy] = useState(false)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)
  const started = useRef(0)
  const duration = Math.max(200, holdMs)

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
      className={`relative overflow-hidden select-none ${className}`}
      onPointerDown={(e) => {
        e.preventDefault()
        start()
      }}
      onPointerUp={clear}
      onPointerLeave={clear}
      onPointerCancel={clear}
      onContextMenu={(e) => e.preventDefault()}
    >
      <span
        className="absolute inset-0 bg-accent/25 origin-left transition-[transform] duration-75"
        style={{ transform: `scaleX(${progress})` }}
      />
      <span className="relative z-1">{busy ? '…' : progress > 0 ? holdLabel : label}</span>
    </button>
  )
}
