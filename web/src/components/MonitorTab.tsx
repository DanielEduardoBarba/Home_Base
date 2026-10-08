import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import type { Project, Session } from '../lib/types'
import { TerminalView } from './Terminal'

export function MonitorTab({
  projects,
  selectedId,
  onSelect,
  attachSessionId,
}: {
  projects: Project[]
  selectedId: string
  onSelect: (id: string) => void
  attachSessionId?: string | null
}) {
  const project = projects.find((p) => p.id === selectedId) || projects[0]
  const [sessions, setSessions] = useState<Session[]>([])
  const [logs, setLogs] = useState('')
  const [attach, setAttach] = useState<string | null>(attachSessionId || null)

  useEffect(() => {
    if (attachSessionId) setAttach(attachSessionId)
  }, [attachSessionId])

  async function refresh() {
    if (!project) return
    const [s, l] = await Promise.all([
      api.sessions(project.id),
      api.logs(project.id, 300),
    ])
    setSessions(s.sessions)
    setLogs(l.text || (l.exists ? '' : '(no stack.log yet)'))
  }

  useEffect(() => {
    refresh().catch(() => undefined)
    const t = setInterval(() => refresh().catch(() => undefined), 4000)
    return () => clearInterval(t)
  }, [project?.id])

  if (!project) {
    return <p className="p-6 text-mute text-sm">No workspace selected.</p>
  }

  const ports = project.portsStatus || []

  return (
    <div className="h-full flex flex-col min-h-0 pb-16">
      <div className="shrink-0 px-3 pt-3 pb-2 border-b border-line/80 bg-panel/50 backdrop-blur-md space-y-2">
        <div className="flex gap-2">
          <select
            value={project.id}
            onChange={(e) => {
              onSelect(e.target.value)
              setAttach(null)
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
            onClick={() => refresh()}
            className="rounded-xl border border-line px-3 py-2 text-xs text-accent hover:border-accent/40"
          >
            Refresh
          </button>
        </div>
        {!!ports.length && (
          <div className="grid grid-cols-3 gap-2 text-[11px] font-mono">
            {ports.map((ps) => (
              <div
                key={ps.id}
                className="rounded-lg border border-line/80 bg-panel-2/80 px-2 py-1.5 text-center"
              >
                <span className={ps.up ? 'text-ok' : 'text-mute'}>{ps.up ? '●' : '○'}</span>{' '}
                {ps.label || ps.id} :{ps.port}
              </div>
            ))}
          </div>
        )}
      </div>

      {attach ? (
        <div className="flex-1 min-h-0 flex flex-col">
          <div className="px-3 py-2 flex items-center justify-between text-xs font-mono text-mute border-b border-line">
            <span>attached {attach}</span>
            <button type="button" className="text-accent" onClick={() => setAttach(null)}>
              detach
            </button>
          </div>
          <TerminalView sessionId={attach} path="" className="flex-1 min-h-0" />
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto px-3 py-3 space-y-4">
          <section>
            <h2 className="text-sm font-semibold mb-2">Sessions</h2>
            {sessions.length === 0 && (
              <p className="text-mute text-sm">No active PTY sessions.</p>
            )}
            <ul className="space-y-2">
              {sessions.map((s) => (
                <li
                  key={s.id}
                  className="hb-surface p-3 flex items-center gap-3"
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">{s.label}</div>
                    <div className="text-[11px] font-mono text-mute">
                      {s.kind} · pid {s.pid ?? '—'} · {s.alive ? 'alive' : 'dead'}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setAttach(s.id)}
                    className="text-xs text-accent border border-accent/40 rounded-lg px-2.5 py-1.5"
                  >
                    Attach
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      await api.killSession(s.id)
                      refresh()
                    }}
                    className="text-xs text-danger border border-danger/30 rounded-lg px-2.5 py-1.5"
                  >
                    Kill
                  </button>
                </li>
              ))}
            </ul>
          </section>
          <section>
            <h2 className="text-sm font-semibold mb-2">stack.log</h2>
            <pre className="text-[11px] font-mono whitespace-pre-wrap rounded-xl border border-line bg-ink/60 p-3 max-h-80 overflow-auto text-mute">
              {logs || '—'}
            </pre>
          </section>
        </div>
      )}
    </div>
  )
}
