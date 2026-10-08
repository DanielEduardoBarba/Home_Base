import { useEffect, useRef, useState } from 'react'

/** Soft pull — refresh in-app data (projects, scene, notifications). */
const SOFT_THRESHOLD = 72
/** Deeper pull — full `window.location.reload()`. */
const HARD_THRESHOLD = 140
const MAX_PULL = HARD_THRESHOLD * 1.15

function scrollParentAt(x: number, y: number): HTMLElement | null {
  let el = document.elementFromPoint(x, y) as HTMLElement | null
  while (el) {
    const style = getComputedStyle(el)
    const oy = style.overflowY
    if (
      (oy === 'auto' || oy === 'scroll' || oy === 'overlay') &&
      el.scrollHeight > el.clientHeight + 1
    ) {
      return el
    }
    el = el.parentElement
  }
  return null
}

function atScrollTop(x: number, y: number): boolean {
  if (document.documentElement.scrollTop > 2 || document.body.scrollTop > 2) return false
  const scroller = scrollParentAt(x, y)
  if (scroller && scroller.scrollTop > 2) return false
  return true
}

function cueLabel(offset: number): string {
  if (offset >= HARD_THRESHOLD) return 'release to reload page'
  if (offset >= SOFT_THRESHOLD) return 'release to refresh'
  if (offset >= SOFT_THRESHOLD * 0.55) return 'pull further to reload'
  return 'pull to refresh'
}

/**
 * Global drag-down refresh — does not wrap layout.
 * Part-way → soft data refresh. Further → hard window reload.
 * Full-app spinner is owned by App; this only shows the pull cue.
 */
export function PullToRefresh({ onRefresh }: { onRefresh: () => void | Promise<void> }) {
  const startY = useRef(0)
  const startX = useRef(0)
  const active = useRef(false)
  const dragging = useRef(false)
  const pointerId = useRef<number | null>(null)
  const [offset, setOffset] = useState(0)
  const [busy, setBusy] = useState(false)
  const offsetRef = useRef(0)
  const busyRef = useRef(false)

  useEffect(() => {
    offsetRef.current = offset
  }, [offset])

  useEffect(() => {
    busyRef.current = busy
  }, [busy])

  useEffect(() => {
    function reset() {
      active.current = false
      dragging.current = false
      pointerId.current = null
      setOffset(0)
    }

    function onDown(e: PointerEvent) {
      if (busyRef.current || e.button !== 0) return
      // Ignore while overlays / drawers are open
      if (document.querySelector('[data-open="true"].hb-inbox-panel, [data-open="true"].hb-drawer')) {
        return
      }
      if (!atScrollTop(e.clientX, e.clientY)) return
      startY.current = e.clientY
      startX.current = e.clientX
      active.current = true
      dragging.current = false
      pointerId.current = e.pointerId
    }

    function onMove(e: PointerEvent) {
      if (!active.current || busyRef.current) return
      if (pointerId.current != null && e.pointerId !== pointerId.current) return

      const dy = e.clientY - startY.current
      const dx = e.clientX - startX.current

      // Horizontal swipe — let the page handle it
      if (!dragging.current && Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy)) {
        reset()
        return
      }

      if (dy <= 0) {
        if (dragging.current) setOffset(0)
        return
      }

      if (!atScrollTop(e.clientX, e.clientY)) {
        reset()
        return
      }

      // Engage after a small intentional pull so taps/scrolls stay clean
      if (!dragging.current) {
        if (dy < 10) return
        dragging.current = true
        try {
          ;(e.target as Element | null)?.setPointerCapture?.(e.pointerId)
        } catch {
          /* ignore */
        }
      }

      // Rubber-band: easier at first, then resists toward hard reload
      const raw = dy * 0.45
      const pulled = Math.min(raw, MAX_PULL)
      setOffset(pulled)
      e.preventDefault()
    }

    async function onUp(e: PointerEvent) {
      if (!active.current) return
      if (pointerId.current != null && e.pointerId !== pointerId.current) return

      const pulled = offsetRef.current
      const wasDragging = dragging.current
      reset()

      if (!wasDragging || busyRef.current) return

      if (pulled >= HARD_THRESHOLD) {
        setBusy(true)
        window.location.reload()
        return
      }

      if (pulled >= SOFT_THRESHOLD) {
        setBusy(true)
        try {
          await onRefresh()
        } finally {
          setBusy(false)
        }
      }
    }

    window.addEventListener('pointerdown', onDown, { capture: true })
    window.addEventListener('pointermove', onMove, { capture: true, passive: false })
    window.addEventListener('pointerup', onUp, { capture: true })
    window.addEventListener('pointercancel', onUp, { capture: true })
    return () => {
      window.removeEventListener('pointerdown', onDown, { capture: true })
      window.removeEventListener('pointermove', onMove, { capture: true })
      window.removeEventListener('pointerup', onUp, { capture: true })
      window.removeEventListener('pointercancel', onUp, { capture: true })
    }
  }, [onRefresh])

  const show = offset > 6 && !busy
  const hard = offset >= HARD_THRESHOLD
  const soft = offset >= SOFT_THRESHOLD

  return (
    <div
      className="pointer-events-none fixed inset-x-0 top-0 z-50 flex justify-center pt-3"
      style={{
        opacity: show ? 1 : 0,
        transform: `translateY(${Math.max(offset * 0.28, 0)}px)`,
        transition: show ? 'none' : 'opacity 160ms ease',
      }}
      aria-hidden
    >
      <span
        className={`rounded-full border px-3 py-1.5 text-[11px] font-mono shadow-lg ${
          hard
            ? 'border-warn/50 bg-ink/95 text-warn'
            : soft
              ? 'border-accent/40 bg-ink/90 text-accent'
              : 'border-line bg-ink/90 text-mute'
        }`}
      >
        {cueLabel(offset)}
      </span>
    </div>
  )
}
