import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import { useSceneRefresh } from '../lib/sceneRefresh'
import {
  clearShellAttach,
  readShellAttach,
  writeShellAttach,
} from '../lib/shellAttach'
import type { Project, Session } from '../lib/types'
import { useVisibleInterval } from '../lib/visibility'
import { HoldButton } from './HoldButton'
import { IconBtn } from './IconBtn'
import { ProjectSelect } from './ProjectSelect'
import { TerminalView } from './Terminal'

/**
 * Shell = interactive PTY + managed sessions.
 * Multiple attached shells use a clean tab strip (one terminal at a time).
 * Leaving the terminal only detaches the WS — PTY stays alive until Exit/Kill.
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
  const [activeTab, setActiveTab] = useState(0)
  // Honor startShellKey on first mount (Work chat "+ Shell" mounts us with key > 0)
  const [interactive, setInteractive] = useState(() => startShellKey > 0)
  const [nonce, setNonce] = useState(() => (startShellKey > 0 ? startShellKey : 0))
  const [interactiveId, setInteractiveId] = useState('')
  const [error, setError] = useState('')
  const lastStartKey = useRef(startShellKey)

  const attachKey = attachSessionIds?.join(',') || ''
  useEffect(() => {
    if (!attachKey) return
    const ids = attachKey.split(',').filter(Boolean)
    setAttach(ids)
    setActiveTab(0)
    setInteractive(false)
    setInteractiveId('')
    setError('')
    if (project?.id) writeShellAttach(project.id, ids)
  }, [attachKey, project?.id])

  // Reattach after reload if PTYs are still alive on the server.
  useEffect(() => {
    if (attachKey || !project?.id) return
    const saved = readShellAttach(project.id)
    if (!saved?.length) return
    let cancelled = false
    void (async () => {
      try {
        const { sessions: live } = await api.sessions(project.id)
        const alive = new Set(live.filter((s) => s.alive).map((s) => s.id))
        const ids = saved.filter((id) => alive.has(id))
        if (cancelled) return
        if (ids.length) {
          setAttach(ids)
          setActiveTab(0)
          setInteractive(false)
          writeShellAttach(project.id, ids)
        } else {
          clearShellAttach()
        }
      } catch {
        /* ignore */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [project?.id, attachKey])

  useEffect(() => {
    if (!startShellKey || startShellKey === lastStartKey.current) return
    lastStartKey.current = startShellKey
    setAttach([])
    setInteractive(true)
    setInteractiveId('')
    setNonce((n) => n + 1)
    setError('')
  }, [startShellKey])

  useEffect(() => {
    if (activeTab >= attach.length) setActiveTab(Math.max(0, attach.length - 1))
  }, [attach.length, activeTab])

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

  useVisibleInterval(() => {
    void refresh().catch(() => undefined)
  }, 8_000)

  /** Detach UI only — does not kill or interrupt the PTY. */
  function leaveTerminal() {
    setAttach([])
    setInteractive(false)
    setInteractiveId('')
    clearShellAttach()
    onClearAttach?.()
    void refresh()
  }

  async function killSession(id: string) {
    setError('')
    try {
      await api.killSession(id)
      if (attach.includes(id) || interactiveId === id) {
        const next = attach.filter((x) => x !== id)
        if (!next.length || interactiveId === id) leaveTerminal()
        else {
          setAttach(next)
          setActiveTab(0)
        }
      } else {
        onClearAttach?.()
        await refresh()
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function exitSession(id: string) {
    setError('')
    try {
      await api.interruptSession(id)
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

  function paneLabel(sid: string): string {
    const s = sessions.find((x) => x.id === sid)
    if (!s) return sid.slice(0, 8)
    if (s.kind === 'expo') return 'Expo'
    if (s.kind === 'run') return 'Run'
    return s.label || s.kind
  }

  const activeId = attach[activeTab] || attach[0]
  const exitTargetId = interactive ? interactiveId : activeId

  function renderExitKill(sessionId: string, opts?: { killAll?: boolean }) {
    if (!sessionId && !opts?.killAll) return null
    return (
      <div className="flex items-center gap-1.5 shrink-0">
        {opts?.killAll && attach.length > 1 && (
          <HoldButton
            label="Kill all"
            holdLabel="…"
            holdMs={2000}
            className="hb-btn hb-btn-danger text-[11px] !min-h-8 !px-2.5"
            onConfirm={() => void killAttached()}
          />
        )}
        {sessionId && (
          <HoldButton
            label="Exit"
            holdLabel="…"
            holdMs={1000}
            title="Hold 1s — send Ctrl+C twice"
            className="hb-btn hb-btn-ghost text-[11px] !min-h-8 !px-2.5"
            onConfirm={() => void exitSession(sessionId)}
          />
        )}
        {sessionId && (
          <HoldButton
            label="Kill"
            holdLabel="…"
            holdMs={2000}
            title="Hold 2s — kill process"
            className="hb-btn hb-btn-danger text-[11px] !min-h-8 !px-2.5"
            onConfirm={() => void killSession(sessionId)}
          />
        )}
      </div>
    )
  }

  return (
    <div className={`h-full flex flex-col min-h-0 ${embedded ? '' : 'hb-with-nav'}`}>
      <div className="hb-chrome shrink-0">
        <div className="hb-chrome-inner space-y-2">
          <div className="flex gap-2 items-center min-w-0">
            {!embedded && (
              <ProjectSelect
                projects={projects}
                selectedId={project.id}
                onSelect={(id) => {
                  onSelect(id)
                  setAttach([])
                  setInteractive(false)
                  setInteractiveId('')
                  onClearAttach?.()
                }}
                className="min-w-0 flex-1"
              />
            )}
            {!inTerminal && !!ports.length && (
              <div className="hb-shell-ports">
                {ports.map((ps) => (
                  <div key={ps.id} className="hb-port hb-port-inline" data-up={ps.up}>
                    <span className={ps.up ? 'text-ok' : 'text-mute'}>{ps.up ? '●' : '○'}</span>
                    <span className="truncate">{ps.label || ps.id}</span>
                    <span className="opacity-80">:{ps.port}</span>
                  </div>
                ))}
              </div>
            )}
            {!inTerminal ? (
              <IconBtn
                label="New shell"
                className="shrink-0 ml-auto"
                onClick={() => {
                  setAttach([])
                  onClearAttach?.()
                  setInteractive(true)
                  setInteractiveId('')
                  setNonce((n) => n + 1)
                }}
              />
            ) : (
              <button
                type="button"
                onClick={leaveTerminal}
                className="hb-shell-back shrink-0 ml-auto"
                aria-label="Back to sessions"
              >
                <svg viewBox="0 0 24 24" className="hb-shell-back-icon" aria-hidden>
                  <path
                    d="M15 6 9 12l6 6"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                <span>Sessions</span>
              </button>
            )}
          </div>
          {error && <p className="text-danger text-xs">{error}</p>}
        </div>
      </div>

      {interactive ? (
        <div className="flex-1 min-h-0 flex flex-col">
          {interactiveId && (
            <div className="hb-shell-pane-bar">
              <span className="truncate font-mono text-[11px] text-mute">
                shell · {interactiveId.slice(0, 8)}
              </span>
              {renderExitKill(interactiveId)}
            </div>
          )}
          <TerminalView
            key={`${project.id}-${nonce}`}
            path={`/ws/pty?project=${project.id}&cols=100&rows=36`}
            className="flex-1 min-h-0"
            onSession={(id) => {
              setInteractiveId(id)
              void refresh()
            }}
          />
        </div>
      ) : attach.length > 0 && activeId ? (
        <div className="flex-1 min-h-0 flex flex-col">
          {attach.length > 1 && (
            <div className="hb-shell-tabs" role="tablist" aria-label="Shell sessions">
              {attach.map((sid, i) => (
                <button
                  key={sid}
                  type="button"
                  role="tab"
                  aria-selected={i === activeTab}
                  data-active={i === activeTab}
                  className="hb-shell-tab"
                  onClick={() => setActiveTab(i)}
                >
                  {paneLabel(sid)}
                </button>
              ))}
            </div>
          )}
          <div className="hb-shell-pane-bar">
            <span className="truncate font-mono text-[11px] text-mute">
              {paneLabel(activeId)}
              {attach.length === 1 ? ` · ${activeId.slice(0, 8)}` : ''}
            </span>
            {renderExitKill(exitTargetId, { killAll: true })}
          </div>
          <TerminalView
            key={activeId}
            sessionId={activeId}
            path=""
            className="flex-1 min-h-0"
          />
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto px-3 py-4 sm:px-5 space-y-3 max-w-[56rem] mx-auto w-full">
          <h2 className="hb-label">Sessions</h2>
          {sessions.length === 0 && (
            <p className="text-mute text-sm leading-relaxed">
              No PTY sessions. Start a stack from Apps, or tap + for an interactive shell.
              Tap a session to open it. Dead sessions get an X to dismiss.
            </p>
          )}
          <ul className="space-y-2.5">
            {sessions.map((s) => (
              <li
                key={s.id}
                className="hb-surface p-3.5 flex flex-wrap sm:flex-nowrap items-center gap-2.5"
              >
                <button
                  type="button"
                  disabled={!s.alive}
                  onClick={() => {
                    if (!s.alive) return
                    setError('')
                    setActiveTab(0)
                    setInteractive(false)
                    setInteractiveId('')
                    setAttach([s.id])
                    if (project.id) writeShellAttach(project.id, [s.id])
                  }}
                  className="flex-1 min-w-0 text-left rounded-md -m-1 p-1 disabled:opacity-70 disabled:cursor-default enabled:active:bg-black/5 dark:enabled:active:bg-white/5"
                  title={s.alive ? 'Open session' : 'Session exited'}
                >
                  <div className="text-sm font-medium truncate">{s.label}</div>
                  <div className="text-[11px] font-mono text-mute mt-0.5">
                    {s.kind} · pid {s.pid ?? '—'} ·{' '}
                    <span className={s.alive ? 'text-ok' : 'text-danger'}>
                      {s.alive ? 'alive' : 'dead'}
                    </span>
                  </div>
                </button>
                {s.alive ? (
                  <>
                    <HoldButton
                      label="Exit"
                      holdLabel="…"
                      holdMs={1000}
                      title="Hold 1s — send Ctrl+C twice"
                      className="hb-btn hb-btn-ghost text-xs !min-h-9 px-3"
                      onConfirm={() => void exitSession(s.id)}
                    />
                    <HoldButton
                      label="Kill"
                      holdLabel="…"
                      holdMs={2000}
                      title="Hold 2s — kill process"
                      className="hb-btn hb-btn-danger text-xs !min-h-9 px-3"
                      onConfirm={() => void killSession(s.id)}
                    />
                  </>
                ) : (
                  <IconBtn
                    label="Remove"
                    variant="ghost"
                    className="shrink-0"
                    onClick={() => void killSession(s.id)}
                  >
                    <svg viewBox="0 0 24 24" className="hb-icon-btn-glyph" aria-hidden>
                      <path
                        d="M6 6l12 12M18 6 6 18"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                      />
                    </svg>
                  </IconBtn>
                )}
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
                setActiveTab(0)
                setAttach(pair)
              }}
            >
              Open Run + Expo
            </button>
          )}
        </div>
      )}
    </div>
  )
}
