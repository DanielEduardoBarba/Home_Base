'use client'

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'

const SWIPE_DELETE_WIDTH = 88
/** Horizontal travel before a touch is a swipe instead of a tap. */
const SWIPE_ARM_PX = 18

type Props = {
  children: ReactNode
  /** Shown on the in-row confirm step */
  confirmLabel?: string
  disabled?: boolean
  deleting?: boolean
  /** Called after the user confirms delete */
  onDelete: () => void | Promise<void>
  className?: string
}

const PHONE_MQ = '(max-width: 640px)'

/**
 * Phone: swipe left to reveal Delete, then confirm.
 * Wider than a phone: a small top-right × opens the same confirm step.
 * A click on the row still opens the chat.
 */
export function SwipeDeleteRow({
  children,
  confirmLabel,
  disabled,
  deleting,
  onDelete,
  className = '',
}: Props) {
  const [dx, setDx] = useState(0)
  const [confirming, setConfirming] = useState(false)
  const [phone, setPhone] = useState(false)
  const dxRef = useRef(0)
  const startX = useRef(0)
  const startY = useRef(0)
  const baseDx = useRef(0)
  const axis = useRef<'x' | 'y' | null>(null)
  const dragging = useRef(false)
  const didSwipe = useRef(false)
  const captured = useRef(false)
  const frontRef = useRef<HTMLDivElement | null>(null)
  const revealing = !confirming && dx < -6

  const setOffset = useCallback((next: number) => {
    dxRef.current = next
    setDx(next)
  }, [])

  const closeSwipe = useCallback(() => {
    setOffset(0)
    baseDx.current = 0
  }, [setOffset])

  useEffect(() => {
    const mq = window.matchMedia(PHONE_MQ)
    const apply = () => setPhone(mq.matches)
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [])

  useEffect(() => {
    if (!phone) closeSwipe()
    if (disabled || deleting) return
    if (!confirming) closeSwipe()
  }, [phone, disabled, deleting, confirming, closeSwipe])

  function requestDelete() {
    closeSwipe()
    setConfirming(true)
  }

  function cancelConfirm() {
    if (deleting) return
    setConfirming(false)
    closeSwipe()
  }

  async function confirmDelete() {
    if (deleting || disabled) return
    try {
      await onDelete()
    } finally {
      setConfirming(false)
      closeSwipe()
    }
  }

  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (disabled || deleting || confirming || !phone) return
    // Mouse clicks must hit the row. Pointer capture on pointerdown would
    // swallow the click so the chat never opens.
    if (e.pointerType === 'mouse') return
    if (e.button !== 0) return
    const target = e.target
    if (target instanceof Element && target.closest('button.hb-swipe-delete-btn')) return
    dragging.current = true
    didSwipe.current = false
    captured.current = false
    startX.current = e.clientX
    startY.current = e.clientY
    baseDx.current = dxRef.current
    axis.current = null
  }

  function onPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    if (!dragging.current || disabled || deleting || confirming) return
    const mx = e.clientX - startX.current
    const my = e.clientY - startY.current
    if (!axis.current) {
      if (Math.abs(mx) < 8 && Math.abs(my) < 8) return
      axis.current = Math.abs(mx) > Math.abs(my) ? 'x' : 'y'
      if (axis.current === 'y') {
        dragging.current = false
        return
      }
    }
    if (axis.current !== 'x') return
    // A short horizontal wobble is still a tap.
    if (!captured.current && Math.abs(mx) < SWIPE_ARM_PX) return
    if (!captured.current) {
      captured.current = true
      didSwipe.current = true
      try {
        frontRef.current?.setPointerCapture(e.pointerId)
      } catch {
        /* ignore */
      }
    }
    e.preventDefault()
    const next = Math.min(0, Math.max(-SWIPE_DELETE_WIDTH, baseDx.current + mx))
    setOffset(next)
  }

  function endPointer(e: ReactPointerEvent<HTMLDivElement>) {
    if (!dragging.current) return
    dragging.current = false
    try {
      frontRef.current?.releasePointerCapture(e.pointerId)
    } catch {
      /* ignore */
    }
    if (axis.current === 'x') {
      const cur = dxRef.current
      const snap = cur <= -SWIPE_DELETE_WIDTH * 0.45 ? -SWIPE_DELETE_WIDTH : 0
      setOffset(snap)
      baseDx.current = snap
    }
    axis.current = null
  }

  function onClickCapture(e: React.MouseEvent) {
    const target = e.target
    if (target instanceof Element && target.closest('button.hb-swipe-x, button.hb-swipe-delete')) {
      return
    }
    // An open swipe should close on tap, not open the chat.
    if (dxRef.current < -6) {
      e.preventDefault()
      e.stopPropagation()
      closeSwipe()
      didSwipe.current = false
      return
    }
    if (didSwipe.current) {
      e.preventDefault()
      e.stopPropagation()
      didSwipe.current = false
    }
  }

  return (
    <div
      className={`hb-swipe-row${revealing ? ' hb-swipe-row--open' : ''}${
        className ? ` ${className}` : ''
      }`}
    >
      <div className="hb-swipe-actions" aria-hidden={!revealing}>
        <button
          type="button"
          className="hb-swipe-delete"
          disabled={disabled || deleting}
          onClick={requestDelete}
        >
          Delete
        </button>
      </div>
      <div
        ref={frontRef}
        className="hb-swipe-front"
        style={{ transform: confirming ? undefined : `translateX(${dx}px)` }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPointer}
        onPointerCancel={endPointer}
        onClickCapture={onClickCapture}
      >
        {confirming ? (
          <div className="hb-agent-row hb-agent-row--confirm">
            <span className="hb-agent-row-label truncate">Are you sure?</span>
            {confirmLabel ? (
              <span className="hb-agent-row-meta truncate">{confirmLabel}</span>
            ) : null}
            <div className="hb-agent-row-confirm-actions">
              <button
                type="button"
                className="hb-btn hb-btn-ghost text-xs"
                disabled={deleting}
                onClick={cancelConfirm}
              >
                Cancel
              </button>
              <button
                type="button"
                className="hb-btn text-xs hb-agent-delete-confirm"
                disabled={deleting || disabled}
                onClick={() => void confirmDelete()}
              >
                {deleting ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        ) : (
          <>
            {children}
            <button
              type="button"
              className="hb-swipe-x"
              aria-label="Delete chat"
              disabled={disabled || deleting}
              onPointerDown={(ev) => ev.stopPropagation()}
              onClick={(ev) => {
                ev.preventDefault()
                ev.stopPropagation()
                requestDelete()
              }}
            >
              ×
            </button>
          </>
        )}
      </div>
    </div>
  )
}
