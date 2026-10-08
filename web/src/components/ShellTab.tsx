import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import { useSceneRefresh } from '../lib/sceneRefresh'
import type { Project, Session } from '../lib/types'
import { HoldButton } from './HoldButton'
import { IconBtn } from './IconBtn'
import { ProjectSelect } from './ProjectSelect'
import { TerminalView } from './Terminal'

/**
 * Shell = interactive PTY + managed sessions (formerly Mon).
 * One place for New shell, Attach, Kill. Split view for Run + Expo.
 */
export function ShellTab({
  projects,
  selectedId,
  onSelect,
  attachSessionIds,
  onClearAttach,
  /** Increment to open a fresh interactive PTY once. */
  startShellKey = 0,
  embedded = false,
}: {
  projects: Project[]
  selectedId: string
  onSelect: (id: string) => void
  attachSessionIds?: string[] | null
  onClearAttach?: () => void
  startShellKey?: number
  /** When true (Work tab), skip project picker — Work chrome owns it. */
  embedded?: boolean
}) {
  const project = projects.find((p) => p.id === selectedId) || projects[0]
  const [sessions, setSessions] = useState<Session[]>([])
  const [attach, setAttach] = useState<string[]>(attachSessionIds || [])
  // Honor startShellKey on first mount (Work chat "+ Shell" mounts us with key > 0)
  const [interactive, setInteractive] = useState(() => startShellKey > 0)
  const [nonce, setNonce] = useState(() => (startShellKey > 0 ? startShellKey : 0))
  const [error, setError] = useState('')
  const lastStartKey = useRef(startShellKey)

  useEffect(() => {
    if (attachSessionIds?.length) {
      setAttach(attachSessionIds)
      setInteractive(false)
      setError('')
    }
  }, [attachSessionIds])

  useEffect(() => {
    if (!startShellKey || startShellKey === lastStartKey.current) return
    lastStartKey.current = startShellKey
    setAttach([])
    setInteractive(true)
    setNonce((n) => n + 1)
    setError('')
  }, [startShellKey])

  const refresh = useCallback(async () => {
    if (!project) return
    try {
      const s = await api.sessions(project.id)
      setSessions(s.sessions)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [project?.id])

  useSceneRefresh(refresh)

  useEffect(() => {
    refresh().catch(() => undefined)
    const t = setInterval(() => refresh().catch(() => undefined), 4000)
    return () => clearInterval(t)
  }, [refresh])

  function leaveTerminal() {
    setAttach([])
    setInteractive(false)
    onClearAttach?.()
    void refresh()
  }

  async function killSession(id: string) {
    setError('')
    try {
      await api.killSession(id)
      if (attach.includes(id)) {
        const next = attach.filter((x) => x !== id)
        if (!next.length) leaveTerminal()
        else setAttach(next)
      } else {
        onClearAttach?.()
        await refresh()
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function killAttached() {
    for (const id of attach) {
      try {
        await api.killSession(id)
      } catch {
        /* continue */
      }
    }
    leaveTerminal()
  }

  if (!projects.length) {
    return <p className="hb-page text-mute text-sm">Add a workspace to open a shell.</p>
  }
  if (!project) return null

  const ports = project.portsStatus || []
  const inTerminal = interactive || attach.length > 0
  const split = attach.length >= 2

  function paneLabel(sid: string): string {
    const s = sessions.find((x) => x.id === sid)
    if (!s) return sid.slice(0, 8)
    if (s.kind === 'expo') return 'Expo'
    if (s.kind === 'run') return 'Run'
    return s.label || s.kind
  }

  return (
    <div className={`h-full flex flex-col min-h-0 ${embedded ? '' : 'hb-with-nav'}`}>
      <div className="hb-chrome shrink-0">
        <div className="hb-chrome-inner space-y-2">
          <div className="flex gap-2 items-center">
            {!embedded && (
              <ProjectSelect
                projects={projects}
                selectedId={project.id}
                onSelect={(id) => {
                  onSelect(id)
                  setAttach([])
                  setInteractive(false)
                  onClearAttach?.()
                }}
                className="flex-1"
              />
            )}
            {!inTerminal ? (
              <IconBtn
                label="New shell"
                className={embedded ? 'ml-auto' : undefined}
                onClick={() => {
                  setAttach([])
                  onClearAttach?.()
                  setInteractive(true)
                  setNonce((n) => n + 1)
                }}
              />
            ) : (
              <button
                type="button"
                onClick={leaveTerminal}
                className={`hb-btn hb-btn-ghost text-sm !min-h-10 px-3 ${embedded ? 'ml-auto' : ''}`}
              >
                Back
              </button>
            )}
          </div>
          {!!ports.length && !inTerminal && (
            <div
              className={`grid gap-2 ${
                ports.length === 1
                  ? 'grid-cols-1 max-w-[12rem]'
                  : ports.length === 2
                    ? 'grid-cols-2'
                    : 'grid-cols-3'
              }`}
            >
              {ports.map((ps) => (
                <div key={ps.id} className="hb-port !py-1.5" data-up={ps.up}>
                  <span className={ps.up ? 'text-ok' : 'text-mute'}>{ps.up ? '●' : '○'}</span>{' '}
                  {ps.label || ps.id} :{ps.port}
                </div>
              ))}
            </div>
          )}
          {error && <p className="text-danger text-xs">{error}</p>}
        </div>
      </div>

      {interactive ? (
        <TerminalView
          key={`${project.id}-${nonce}`}
          path={`/ws/pty?project=${project.id}&cols=100&rows=36`}
          className="flex-1 min-h-0"
        />
      ) : attach.length === 1 ? (
        <div className="flex-1 min-h-0 flex flex-col">
          <div className="px-3 py-2 flex items-center justify-between text-xs font-mono text-mute border-b border-line gap-2">
            <span className="truncate">{paneLabel(attach[0])} · {attach[0]}</span>
            <div className="flex items-center gap-2 shrink-0">
              <HoldButton
                label="Kill"
                holdLabel="hold…"
                holdMs={1000}
                className="hb-btn hb-btn-danger text-xs px-2.5 py-1.5"
                onConfirm={() => killSession(attach[0])}
              />
              <button type="button" className="text-accent px-2 py-1" onClick={leaveTerminal}>
                detach
              </button>
            </div>
          </div>
          <TerminalView sessionId={attach[0]} path="" className="flex-1 min-h-0" />
        </div>
      ) : split ? (
        <div className="flex-1 min-h-0 flex flex-col">
          <div className="px-3 py-2 flex items-center justify-between text-xs font-mono text-mute border-b border-line gap-2">
            <span className="truncate">split · {attach.map(paneLabel).join(' + ')}</span>
            <div className="flex items-center gap-2 shrink-0">
              <HoldButton
                label="Kill all"
                holdLabel="hold…"
                holdMs={1000}
                className="hb-btn hb-btn-danger text-xs px-2.5 py-1.5"
                onConfirm={() => void killAttached()}
              />
              <button type="button" className="text-accent px-2 py-1" onClick={leaveTerminal}>
                detach
              </button>
            </div>
          </div>
          <div className="flex-1 min-h-0 flex flex-col md:flex-row">
            {attach.map((sid) => (
              <div
                key={sid}
                className="flex-1 min-h-0 min-w-0 flex flex-col border-b md:border-b-0 md:border-r border-line last:border-0"
              >
                <div className="px-2 py-1 text-[10px] font-mono text-mute flex items-center justify-between gap-2 bg-panel/80">
                  <span className="truncate">{paneLabel(sid)}</span>
                  <HoldButton
                    label="Kill"
                    holdLabel="…"
                    holdMs={800}
                    className="text-danger text-[10px] px-1.5 py-0.5"
                    onConfirm={() => void killSession(sid)}
                  />
                </div>
                <TerminalView sessionId={sid} path="" className="flex-1 min-h-0" />
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto px-3 py-4 sm:px-5 space-y-3 max-w-[56rem] mx-auto w-full">
          <h2 className="hb-label">Sessions</h2>
          {sessions.length === 0 && (
            <p className="text-mute text-sm leading-relaxed">
              No active PTY sessions. Start a stack from Apps, or tap + for an interactive shell.
            </p>
          )}
          <ul className="space-y-2.5">
            {sessions.map((s) => (
              <li
                key={s.id}
                className="hb-surface p-3.5 flex flex-wrap sm:flex-nowrap items-center gap-2.5"
              >
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate">{s.label}</div>
                  <div className="text-[11px] font-mono text-mute mt-0.5">
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
                    setAttach([s.id])
                  }}
                  disabled={!s.alive}
                  className="hb-btn hb-btn-ghost text-xs !min-h-9 px-3 disabled:opacity-40"
                >
                  Attach
                </button>
                <HoldButton
                  label="Kill"
                  holdLabel="hold…"
                  holdMs={1000}
                  className="hb-btn hb-btn-danger text-xs !min-h-9 px-3"
                  onConfirm={() => killSession(s.id)}
                />
              </li>
            ))}
          </ul>
          {sessions.filter((s) => s.alive && (s.kind === 'run' || s.kind === 'expo')).length >=
            2 && (
            <button
              type="button"
              className="hb-btn hb-btn-primary text-sm"
              onClick={() => {
                const pair = sessions
                  .filter((s) => s.alive && (s.kind === 'run' || s.kind === 'expo'))
                  .slice(0, 2)
                  .map((s) => s.id)
                setAttach(pair)
              }}
            >
              Open Run + Expo split
            </button>
          )}
        </div>
      )}
    </div>
  )
}
