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

/**
 * Shared swipe-left → Delete card (touch + mouse/pointer). Reveals a rounded
 * Delete action, then an in-row confirm step before calling `onDelete`.
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
  const dxRef = useRef(0)
  const startX = useRef(0)
  const startY = useRef(0)
  const baseDx = useRef(0)
  const axis = useRef<'x' | 'y' | null>(null)
  const dragging = useRef(false)
  const didSwipe = useRef(false)
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
    if (disabled || deleting) return
    if (!confirming) closeSwipe()
  }, [disabled, deleting, confirming, closeSwipe])

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
    if (disabled || deleting || confirming) return
    // Left mouse / primary touch / pen only
    if (e.pointerType === 'mouse' && e.button !== 0) return
    dragging.current = true
    didSwipe.current = false
    startX.current = e.clientX
    startY.current = e.clientY
    baseDx.current = dxRef.current
    axis.current = null
    frontRef.current?.setPointerCapture(e.pointerId)
  }

  function onPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    if (!dragging.current || disabled || deleting || confirming) return
    const mx = e.clientX - startX.current
    const my = e.clientY - startY.current
    if (!axis.current) {
      if (Math.abs(mx) < 6 && Math.abs(my) < 6) return
      axis.current = Math.abs(mx) > Math.abs(my) ? 'x' : 'y'
      if (axis.current === 'y') {
        // Vertical scroll — release capture so the list can scroll
        dragging.current = false
        try {
          frontRef.current?.releasePointerCapture(e.pointerId)
        } catch {
          /* ignore */
        }
        return
      }
    }
    if (axis.current !== 'x') return
    e.preventDefault()
    didSwipe.current = true
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
    // After a horizontal drag, don't open the chat row
    if (didSwipe.current || dxRef.current < -6) {
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
            <span className="hb-agent-row-label truncate">Delete this chat?</span>
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
          children
        )}
      </div>
    </div>
  )
}
