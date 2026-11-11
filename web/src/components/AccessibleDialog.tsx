'use client'

import type { CSSProperties, ReactNode } from 'react'
import { useAccessibleDialog, type UseAccessibleDialogOptions } from '../lib/useAccessibleDialog'

const DEFAULT_OVERLAY =
  'fixed inset-0 z-40 hb-overlay backdrop-blur-sm flex items-end sm:items-center justify-center p-4'
const DEFAULT_PANEL = 'w-full max-w-sm hb-surface p-4 space-y-3 shadow-xl'

type Props = UseAccessibleDialogOptions & {
  children: ReactNode
  title?: string
  titleId?: string
  overlayClassName?: string
  panelClassName?: string
  overlayStyle?: CSSProperties
  panelStyle?: CSSProperties
  /** When false, do not close on overlay click. Default true. */
  closeOnOverlay?: boolean
}

/**
 * Overlay + panel dialog with the shared a11y behavior.
 * Renders nothing when `open` is false.
 */
export function AccessibleDialog({
  open,
  onClose,
  confirm,
  initialFocus,
  focusKey,
  children,
  title,
  titleId = 'hb-dialog-title',
  label,
  labelledBy,
  overlayClassName = DEFAULT_OVERLAY,
  panelClassName = DEFAULT_PANEL,
  overlayStyle,
  panelStyle,
  closeOnOverlay = true,
}: Props) {
  const resolvedLabelledBy = labelledBy || (title ? titleId : undefined)
  const { ref, dialogProps } = useAccessibleDialog<HTMLDivElement>({
    open,
    onClose,
    confirm,
    initialFocus,
    focusKey,
    labelledBy: resolvedLabelledBy,
    label: title ? undefined : label,
  })

  if (!open) return null

  return (
    <div
      className={overlayClassName}
      style={overlayStyle}
      role="presentation"
      onClick={closeOnOverlay ? onClose : undefined}
    >
      <div
        ref={ref}
        className={panelClassName}
        style={panelStyle}
        {...dialogProps}
        onClick={(e) => e.stopPropagation()}
      >
        {title ? (
          <h2 id={titleId} className="font-semibold text-sm">
            {title}
          </h2>
        ) : null}
        {children}
      </div>
    </div>
  )
}
