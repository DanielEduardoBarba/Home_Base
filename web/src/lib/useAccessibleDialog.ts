'use client'

import { useEffect, useRef, type RefObject } from 'react'
import {
  dialogDomProps,
  initialFocusTarget,
  resolveInitialFocusMode,
  trapTabKey,
  type DialogFocusMode,
} from './accessibleDialog'

export type UseAccessibleDialogOptions = {
  open: boolean
  onClose?: () => void
  confirm?: boolean
  initialFocus?: DialogFocusMode
  labelledBy?: string
  label?: string
  /** Re-run initial focus when this changes while open (e.g. wizard step). */
  focusKey?: string | number
}

/**
 * Attach `ref` to the dialog root (the element that should be aria-modal).
 * Spreads `dialogProps` on that same node.
 */
export function useAccessibleDialog<T extends HTMLElement = HTMLDivElement>(
  opts: UseAccessibleDialogOptions,
): {
  ref: RefObject<T | null>
  dialogProps: ReturnType<typeof dialogDomProps>
} {
  const ref = useRef<T | null>(null)
  const onCloseRef = useRef(opts.onClose)
  onCloseRef.current = opts.onClose
  const openerRef = useRef<HTMLElement | null>(null)
  const mode = resolveInitialFocusMode(opts)

  useEffect(() => {
    if (!opts.open) return
    const panel = ref.current
    if (!panel) return
    const prev = document.activeElement
    openerRef.current = prev instanceof HTMLElement ? prev : null

    const focusIn = () => {
      const node = ref.current
      if (!node) return
      const target = initialFocusTarget(node, mode)
      if (target === node && node.tabIndex < 0) node.tabIndex = -1
      target.focus()
    }
    const raf = window.requestAnimationFrame(focusIn)

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onCloseRef.current?.()
        return
      }
      if (event.key === 'Tab') {
        const node = ref.current
        if (!node) return
        trapTabKey(event, node)
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => {
      window.cancelAnimationFrame(raf)
      document.removeEventListener('keydown', onKey, true)
      const opener = openerRef.current
      if (opener && typeof opener.focus === 'function' && document.contains(opener)) {
        opener.focus()
      }
    }
    // mode + focusKey: re-bind when the confirm/step changes; open gates setup.
  }, [opts.open, opts.focusKey, mode])

  return {
    ref,
    dialogProps: dialogDomProps({
      open: opts.open,
      labelledBy: opts.labelledBy,
      label: opts.label,
    }),
  }
}
