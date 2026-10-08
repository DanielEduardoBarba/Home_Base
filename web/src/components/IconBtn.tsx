import type { ButtonHTMLAttributes, ReactNode } from 'react'

type Variant = 'primary' | 'ghost' | 'danger'

/** Compact square control — used for + / icon actions. */
export function IconBtn({
  label,
  variant = 'primary',
  children,
  className = '',
  ...rest
}: {
  label: string
  variant?: Variant
  children?: ReactNode
  className?: string
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={`hb-icon-btn hb-icon-btn-${variant} ${className}`}
      {...rest}
    >
      {children ?? (
        <svg viewBox="0 0 24 24" className="hb-icon-btn-glyph" aria-hidden>
          <path d="M12 5v14M5 12h14" />
        </svg>
      )}
    </button>
  )
}
