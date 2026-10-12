'use client'

import {
  useCallback,
  useEffect,
  useRef,
  useState,
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
 * Shared swipe-left → Delete card. Reveals a rounded Delete action, then an
 * in-row confirm step before calling `onDelete`.
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
  const startX = useRef(0)
  const startY = useRef(0)
  const baseDx = useRef(0)
  const axis = useRef<'x' | 'y' | null>(null)
  const revealing = !confirming && dx < -6

  const closeSwipe = useCallback(() => {
    setDx(0)
    baseDx.current = 0
  }, [])

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
        className="hb-swipe-front"
        style={{ transform: confirming ? undefined : `translateX(${dx}px)` }}
        onTouchStart={(e) => {
          if (disabled || deleting || confirming) return
          const t = e.touches[0]
          if (!t) return
          startX.current = t.clientX
          startY.current = t.clientY
          baseDx.current = dx
          axis.current = null
        }}
        onTouchMove={(e) => {
          if (disabled || deleting || confirming) return
          const t = e.touches[0]
          if (!t) return
          const mx = t.clientX - startX.current
          const my = t.clientY - startY.current
          if (!axis.current) {
            if (Math.abs(mx) < 6 && Math.abs(my) < 6) return
            axis.current = Math.abs(mx) > Math.abs(my) ? 'x' : 'y'
          }
          if (axis.current !== 'x') return
          e.preventDefault()
          const next = Math.min(0, Math.max(-SWIPE_DELETE_WIDTH, baseDx.current + mx))
          setDx(next)
        }}
        onTouchEnd={() => {
          if (axis.current === 'x') {
            const snap = dx <= -SWIPE_DELETE_WIDTH * 0.45 ? -SWIPE_DELETE_WIDTH : 0
            setDx(snap)
            baseDx.current = snap
          }
          axis.current = null
        }}
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
