import { useEffect, useRef, useState } from 'react'

/** Soft pull — refresh in-app data (projects, scene, notifications). */
const SOFT_THRESHOLD = 64
/** Deeper pull — full `window.location.reload()`. */
const HARD_THRESHOLD = 130
const MAX_PULL = HARD_THRESHOLD * 1.2
/** Engage drag after this many px of downward movement. */
const ENGAGE = 8

function overlaysBlocking(): boolean {
  return !!(
    document.querySelector(
      '[data-open="true"].hb-inbox-panel, [data-open="true"].hb-drawer, .hb-chat-dock-scrim, .hb-overlay',
    )
  )
}

/** View canvas (and similar) must own vertical gestures — skip pull-to-refresh. */
function noPullTarget(target: EventTarget | null): boolean {
  let el: HTMLElement | null =
    target instanceof HTMLElement
      ? target
      : target instanceof Node
        ? (target.parentElement as HTMLElement | null)
        : null
  while (el) {
    if (el.dataset?.hbNoPtr === '1') return true
    el = el.parentElement
  }
  return false
}

/** Walk from the event target — works better on iOS than elementFromPoint mid-gesture. */
function atScrollTopFromTarget(target: EventTarget | null): boolean {
  if (window.scrollY > 2 || document.documentElement.scrollTop > 2 || document.body.scrollTop > 2) {
    return false
  }
  let el: HTMLElement | null =
    target instanceof HTMLElement
      ? target
      : target instanceof Node
        ? (target.parentElement as HTMLElement | null)
        : null
  while (el && el !== document.documentElement) {
    const style = getComputedStyle(el)
    const oy = style.overflowY
    if (
      (oy === 'auto' || oy === 'scroll' || oy === 'overlay') &&
      el.scrollHeight > el.clientHeight + 1
    ) {
      if (el.scrollTop > 2) return false
    }
    el = el.parentElement
  }
  return true
}

function cueLabel(offset: number): string {
  if (offset >= HARD_THRESHOLD) return 'release to reload page'
  if (offset >= SOFT_THRESHOLD) return 'release to refresh'
  if (offset >= SOFT_THRESHOLD * 0.5) return 'keep pulling to reload…'
  return 'pull to refresh'
}

/**
 * Global drag-down refresh — phone-first (touch + pointer).
 * Part-way → soft scene/data refresh. Further → hard window reload.
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
  const onRefreshRef = useRef(onRefresh)
  onRefreshRef.current = onRefresh

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
      document.documentElement.classList.remove('hb-pulling')
    }

    function begin(clientX: number, clientY: number, target: EventTarget | null, id: number | null) {
      if (busyRef.current) return false
      if (overlaysBlocking()) return false
      if (noPullTarget(target)) return false
      if (!atScrollTopFromTarget(target)) return false
      startY.current = clientY
      startX.current = clientX
      active.current = true
      dragging.current = false
      pointerId.current = id
      return true
    }

    function move(clientX: number, clientY: number, target: EventTarget | null, ev?: Event) {
      if (!active.current || busyRef.current) return
      const dy = clientY - startY.current
      const dx = clientX - startX.current

      if (!dragging.current && Math.abs(dx) > 14 && Math.abs(dx) > Math.abs(dy)) {
        reset()
        return
      }

      if (dy <= 0) {
        if (dragging.current) setOffset(0)
        return
      }

      if (!atScrollTopFromTarget(target)) {
        reset()
        return
      }

      if (!dragging.current) {
        if (dy < ENGAGE) return
        dragging.current = true
        document.documentElement.classList.add('hb-pulling')
      }

      const raw = dy * 0.42
      const pulled = Math.min(raw, MAX_PULL)
      setOffset(pulled)
      if (ev && ev.cancelable) ev.preventDefault()
    }

    async function finish() {
      if (!active.current) return
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
          await onRefreshRef.current()
        } finally {
          setBusy(false)
        }
      }
    }

    /* ── Pointer (desktop + modern iOS) ── */
    function onPointerDown(e: PointerEvent) {
      if (e.pointerType === 'touch') return // touch handlers own phones
      if (e.button !== 0) return
      begin(e.clientX, e.clientY, e.target, e.pointerId)
    }
    function onPointerMove(e: PointerEvent) {
      if (e.pointerType === 'touch') return
      if (!active.current) return
      if (pointerId.current != null && e.pointerId !== pointerId.current) return
      move(e.clientX, e.clientY, e.target, e)
    }
    function onPointerUp(e: PointerEvent) {
      if (e.pointerType === 'touch') return
      if (pointerId.current != null && e.pointerId !== pointerId.current) return
      void finish()
    }

    /* ── Touch (iPhone Safari — reliable overscroll control) ── */
    function onTouchStart(e: TouchEvent) {
      if (e.touches.length !== 1) return
      const t = e.touches[0]
      begin(t.clientX, t.clientY, e.target, null)
    }
    function onTouchMove(e: TouchEvent) {
      if (!active.current || e.touches.length !== 1) return
      const t = e.touches[0]
      move(t.clientX, t.clientY, e.target, e)
    }
    function onTouchEnd() {
      void finish()
    }

    window.addEventListener('pointerdown', onPointerDown, { capture: true })
    window.addEventListener('pointermove', onPointerMove, { capture: true, passive: false })
    window.addEventListener('pointerup', onPointerUp, { capture: true })
    window.addEventListener('pointercancel', onPointerUp, { capture: true })
    window.addEventListener('touchstart', onTouchStart, { capture: true, passive: true })
    window.addEventListener('touchmove', onTouchMove, { capture: true, passive: false })
    window.addEventListener('touchend', onTouchEnd, { capture: true })
    window.addEventListener('touchcancel', onTouchEnd, { capture: true })
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('pointermove', onPointerMove, true)
      window.removeEventListener('pointerup', onPointerUp, true)
      window.removeEventListener('pointercancel', onPointerUp, true)
      window.removeEventListener('touchstart', onTouchStart, true)
      window.removeEventListener('touchmove', onTouchMove, true)
      window.removeEventListener('touchend', onTouchEnd, true)
      window.removeEventListener('touchcancel', onTouchEnd, true)
      document.documentElement.classList.remove('hb-pulling')
    }
  }, [])

  const show = offset > 6 && !busy
  const hard = offset >= HARD_THRESHOLD
  const soft = offset >= SOFT_THRESHOLD

  return (
    <div
      className="pointer-events-none fixed inset-x-0 top-0 z-[60] flex justify-center"
      style={{
        paddingTop: 'max(0.75rem, env(safe-area-inset-top, 0px))',
        opacity: show ? 1 : 0,
        transform: `translateY(${Math.max(offset * 0.3, 0)}px)`,
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
        {busy ? 'refreshing…' : cueLabel(offset)}
      </span>
    </div>
  )
}
