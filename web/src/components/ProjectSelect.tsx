import type { Project } from '../lib/types'

/**
 * Shared workspace picker — styled pill over a transparent native `<select>`
 * so phones still get the OS picker wheel/sheet.
 */
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
  const current = projects.find((p) => p.id === selectedId) || projects[0]
  const value = current?.id || ''
  return (
    <label className={`hb-ws-picker ${className}`} title={current?.path || 'Workspace'}>
      <svg viewBox="0 0 24 24" className="hb-ws-picker-icon" aria-hidden>
        <path d="M4.5 6.5h5l2 2h8v10.5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 3.5 19V8a1.5 1.5 0 0 1 1-1.5z" />
      </svg>
      <span className="hb-ws-picker-name">{current?.name || 'No workspace'}</span>
      <svg viewBox="0 0 24 24" className="hb-ws-picker-chev" aria-hidden>
        <path d="m7 10 5 5 5-5" />
      </svg>
      <select
        value={value}
        onChange={(e) => onSelect(e.target.value)}
        className="hb-ws-picker-select"
        aria-label="Workspace"
        disabled={!projects.length}
      >
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
    </label>
  )
}
