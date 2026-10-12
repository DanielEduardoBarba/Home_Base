'use client'

/** Split "Daniel's Home Base" so "Base" (or last word) can take the accent. */
export function BrandTitle({
  name,
  className = '',
}: {
  name: string
  className?: string
}) {
  const text = (name || 'Home Base').trim() || 'Home Base'
  const parts = text.split(/\s+/)
  if (parts.length === 1) {
    return <span className={className}>{text}</span>
  }
  const last = parts[parts.length - 1]!
  const head = parts.slice(0, -1).join(' ')
  return (
    <span className={className}>
      {head} <span className="text-accent">{last}</span>
    </span>
  )
}
