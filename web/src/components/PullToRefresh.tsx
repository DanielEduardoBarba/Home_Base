import { useEffect, useRef, useState } from 'react'

const THRESHOLD = 72

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

/**
 * Global drag-down refresh — does not wrap layout.
 * Fires when the scrollable under the pointer is at the top (or none).
 * Full-app spinner is owned by App; this only shows the pull cue.
 */
export function PullToRefresh({ onRefresh }: { onRefresh: () => void | Promise<void> }) {
  const startY = useRef(0)
  const active = useRef(false)
  const [offset, setOffset] = useState(0)
  const [busy, setBusy] = useState(false)
  const offsetRef = useRef(0)

  useEffect(() => {
    offsetRef.current = offset
  }, [offset])

  useEffect(() => {
    function onDown(e: PointerEvent) {
      if (busy || e.button !== 0) return
      const scroller = scrollParentAt(e.clientX, e.clientY)
      if (scroller && scroller.scrollTop > 2) return
      if (document.documentElement.scrollTop > 2 || document.body.scrollTop > 2) return
      startY.current = e.clientY
      active.current = true
    }

    function onMove(e: PointerEvent) {
      if (!active.current || busy) return
      const dy = e.clientY - startY.current
      if (dy <= 0) {
        setOffset(0)
        return
      }
      const scroller = scrollParentAt(e.clientX, e.clientY)
      if (scroller && scroller.scrollTop > 2) {
        active.current = false
        setOffset(0)
        return
      }
      setOffset(Math.min(dy * 0.4, THRESHOLD * 1.2))
      if (dy > 12) e.preventDefault()
    }

    async function onUp() {
      if (!active.current) return
      active.current = false
      const should = offsetRef.current >= THRESHOLD
      if (should && !busy) {
        setBusy(true)
        setOffset(0)
        try {
          await onRefresh()
        } finally {
          setBusy(false)
        }
        return
      }
      setOffset(0)
    }

    window.addEventListener('pointerdown', onDown)
    window.addEventListener('pointermove', onMove, { passive: false })
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      window.removeEventListener('pointerdown', onDown)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
  }, [busy, onRefresh])

  const show = offset > 6 && !busy

  return (
    <div
      className="pointer-events-none fixed inset-x-0 top-0 z-30 flex justify-center pt-3 transition-opacity"
      style={{
        opacity: show ? 1 : 0,
        transform: `translateY(${Math.max(offset * 0.35, 0)}px)`,
      }}
      aria-hidden
    >
      <span className="rounded-full border border-accent/40 bg-ink/90 px-3 py-1.5 text-[11px] font-mono text-accent shadow-lg">
        {offset >= THRESHOLD ? 'release to refresh' : 'pull to refresh'}
      </span>
    </div>
  )
}
