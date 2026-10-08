import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/api'
import type { Project, Session } from '../lib/types'
import { HoldButton } from './HoldButton'
import { ProjectSelect } from './ProjectSelect'
import { TerminalView } from './Terminal'

/**
 * Shell = interactive PTY + managed sessions (formerly Mon).
 * One place for New shell, Attach, Kill.
 */
export function ShellTab({
  projects,
  selectedId,
  onSelect,
  attachSessionId,
  onClearAttach,
}: {
  projects: Project[]
  selectedId: string
  onSelect: (id: string) => void
  attachSessionId?: string | null
  onClearAttach?: () => void
}) {
  const project = projects.find((p) => p.id === selectedId) || projects[0]
  const [sessions, setSessions] = useState<Session[]>([])
  const [attach, setAttach] = useState<string | null>(attachSessionId || null)
  const [interactive, setInteractive] = useState(false)
  const [nonce, setNonce] = useState(0)
  const [error, setError] = useState('')

  useEffect(() => {
    if (attachSessionId) {
      setAttach(attachSessionId)
      setInteractive(false)
      setError('')
    }
  }, [attachSessionId])

  const refresh = useCallback(async () => {
    if (!project) return
    try {
      const s = await api.sessions(project.id)
      setSessions(s.sessions)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [project?.id])

  useEffect(() => {
    refresh().catch(() => undefined)
    const t = setInterval(() => refresh().catch(() => undefined), 4000)
    return () => clearInterval(t)
  }, [refresh])

  function leaveTerminal() {
    setAttach(null)
    setInteractive(false)
    onClearAttach?.()
    refresh()
  }

  async function killSession(id: string) {
    setError('')
    try {
      await api.killSession(id)
      if (attach === id) leaveTerminal()
      else {
        onClearAttach?.()
        await refresh()
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  if (!projects.length) {
    return <p className="p-6 text-mute text-sm">Add a workspace to open a shell.</p>
  }
  if (!project) return null

  const ports = project.portsStatus || []
  const inTerminal = interactive || !!attach

  return (
    <div className="h-full flex flex-col min-h-0 pb-16">
      <div className="shrink-0 px-3 pt-3 pb-2 border-b border-line bg-panel/80 backdrop-blur-md space-y-2">
        <div className="flex gap-2 items-center max-w-5xl mx-auto w-full">
          <ProjectSelect
            projects={projects}
            selectedId={project.id}
            onSelect={(id) => {
              onSelect(id)
              setAttach(null)
              setInteractive(false)
              onClearAttach?.()
            }}
            className="flex-1"
          />
          {!inTerminal ? (
            <>
              <button
                type="button"
                onClick={() => {
                  setAttach(null)
                  onClearAttach?.()
                  setInteractive(true)
                  setNonce((n) => n + 1)
                }}
                className="hb-btn hb-btn-primary text-sm px-3 py-2.5"
              >
                New
              </button>
              <button
                type="button"
                onClick={() => refresh()}
                className="hb-btn hb-btn-ghost text-xs px-3 py-2.5"
              >
                Refresh
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={leaveTerminal}
              className="hb-btn hb-btn-ghost text-sm px-3 py-2.5"
            >
              Back
            </button>
          )}
        </div>
        {!!ports.length && !inTerminal && (
          <div className="grid grid-cols-3 gap-2 text-[11px] font-mono max-w-5xl mx-auto w-full">
            {ports.map((ps) => (
              <div
                key={ps.id}
                className={`rounded-lg border px-2 py-1.5 text-center ${
                  ps.up ? 'border-ok/45 bg-ok/10' : 'border-line bg-panel-2 text-mute'
                }`}
              >
                <span className={ps.up ? 'text-ok' : 'text-mute'}>{ps.up ? '●' : '○'}</span>{' '}
                {ps.label || ps.id} :{ps.port}
              </div>
            ))}
          </div>
        )}
        {error && <p className="text-danger text-xs max-w-5xl mx-auto w-full">{error}</p>}
      </div>

      {interactive ? (
        <TerminalView
          key={`${project.id}-${nonce}`}
          path={`/ws/pty?project=${project.id}&cols=100&rows=36`}
          className="flex-1 min-h-0"
        />
      ) : attach ? (
        <div className="flex-1 min-h-0 flex flex-col">
          <div className="px-3 py-2 flex items-center justify-between text-xs font-mono text-mute border-b border-line gap-2">
            <span className="truncate">attached {attach}</span>
            <div className="flex items-center gap-2 shrink-0">
              <HoldButton
                label="Kill"
                holdLabel="hold…"
                holdMs={1000}
                className="hb-btn hb-btn-danger text-xs px-2.5 py-1.5"
                onConfirm={() => killSession(attach)}
              />
              <button type="button" className="text-accent px-2 py-1" onClick={leaveTerminal}>
                detach
              </button>
            </div>
          </div>
          <TerminalView sessionId={attach} path="" className="flex-1 min-h-0" />
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto px-3 py-3 space-y-3 max-w-5xl mx-auto w-full">
          <h2 className="text-sm font-semibold text-text">Sessions</h2>
          {sessions.length === 0 && (
            <p className="text-mute text-sm">
              No active PTY sessions. Start a stack from Apps, or tap New for an interactive shell.
            </p>
          )}
          <ul className="space-y-2">
            {sessions.map((s) => (
              <li key={s.id} className="hb-surface p-3 flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate">{s.label}</div>
                  <div className="text-[11px] font-mono text-mute">
                    {s.kind} · pid {s.pid ?? '—'} ·{' '}
                    <span className={s.alive ? 'text-ok' : 'text-danger'}>
                      {s.alive ? 'alive' : 'dead'}
                    </span>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setError('')
                    setAttach(s.id)
                  }}
                  disabled={!s.alive}
                  className="hb-btn hb-btn-ghost text-xs px-2.5 py-1.5 disabled:opacity-40"
                >
                  Attach
                </button>
                <HoldButton
                  label="Kill"
                  holdLabel="hold…"
                  holdMs={1000}
                  className="hb-btn hb-btn-danger text-xs px-2.5 py-1.5"
                  onConfirm={() => killSession(s.id)}
                />
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
