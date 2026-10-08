import { useState } from 'react'
import type { Project } from '../lib/types'
import { TerminalView } from './Terminal'

export function ShellTab({
  projects,
  selectedId,
  onSelect,
}: {
  projects: Project[]
  selectedId: string
  onSelect: (id: string) => void
}) {
  const [nonce, setNonce] = useState(0)
  const project = projects.find((p) => p.id === selectedId) || projects[0]

  if (!projects.length) {
    return <p className="p-6 text-mute text-sm">Add a workspace to open a shell.</p>
  }

  return (
    <div className="h-full flex flex-col min-h-0 pb-16">
      <div className="shrink-0 px-3 pt-3 pb-2 flex items-center gap-2 border-b border-line/80 bg-panel/50 backdrop-blur-md">
        <select
          value={project?.id || ''}
          onChange={(e) => {
            onSelect(e.target.value)
            setNonce((n) => n + 1)
          }}
          className="hb-select flex-1"
        >
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => setNonce((n) => n + 1)}
          className="rounded-xl border border-line bg-panel-2 px-3 py-2.5 text-sm text-accent hover:border-accent/40"
        >
          New
        </button>
      </div>
      {project && (
        <TerminalView
          key={`${project.id}-${nonce}`}
          path={`/ws/pty?project=${project.id}&cols=100&rows=36`}
          className="flex-1 min-h-0"
        />
      )}
    </div>
  )
}
