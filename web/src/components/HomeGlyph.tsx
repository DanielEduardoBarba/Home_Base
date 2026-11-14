'use client'

/** House icon matching the Work top-bar Home control. */
export function HomeGlyph({ className = 'hb-nav-icon' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden>
      <path d="M4 11.5 12 5l8 6.5" />
      <path d="M6.5 10v9.5h11V10" />
      <path d="M10 19.5v-5h4v5" />
    </svg>
  )
}

export function HomeIconButton({
  onClick,
  className = 'hb-topbar-home shrink-0',
}: {
  onClick: () => void
  className?: string
}) {
  return (
    <button
      type="button"
      className={className}
      onClick={onClick}
      aria-label="Home dashboard"
      title="Home"
    >
      <HomeGlyph />
    </button>
  )
}
