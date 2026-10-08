import type { Project } from '../lib/types'

/** Shared workspace dropdown — used on every tab that needs a project. */
export function ProjectSelect({
  projects,
  selectedId,
  onSelect,
  className = '',
}: {
  projects: Project[]
  selectedId: string
  onSelect: (id: string) => void
  className?: string
}) {
  const value = projects.find((p) => p.id === selectedId)?.id || projects[0]?.id || ''
  return (
    <select
      value={value}
      onChange={(e) => onSelect(e.target.value)}
      className={`hb-select ${className}`}
      aria-label="App"
    >
      {projects.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}
        </option>
      ))}
    </select>
  )
}
