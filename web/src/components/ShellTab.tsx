import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
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
  minimal = false,
  replayCommand = null,
  replayOutput = null,
}: {
  projects: Project[]
  selectedId: string
  onSelect: (id: string) => void
  attachSessionIds?: string[] | null
  onClearAttach?: () => void
  startShellKey?: number
  /** When true (Work tab), skip project picker — Work chrome owns it. */
  embedded?: boolean
  /** Home Agent: command replay only. */
  minimal?: boolean
  replayCommand?: string | null
  replayOutput?: string | null
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
  const [sudoOpen, setSudoOpen] = useState(false)
  const [sudoPassword, setSudoPassword] = useState('')
  const [sudoRemember, setSudoRemember] = useState(true)
  const [sudoBusy, setSudoBusy] = useState(false)
  const [sudoCached, setSudoCached] = useState(false)
  const [sudoWaiting, setSudoWaiting] = useState(false)
  const [sudoCommand, setSudoCommand] = useState('')
  const [sudoId, setSudoId] = useState('')
  const [sudoMsg, setSudoMsg] = useState('')
  const lastStartKey = useRef(startShellKey)

  const refreshSudo = useCallback(async () => {
    try {
      const s = await api.sudoStatus()
      setSudoCached(Boolean(s.cached || s.persistent || s.sessionCached))
      setSudoWaiting(Boolean(s.askpassWaiting))
      if (s.pending) {
        setSudoId(String(s.pending.id || ''))
        setSudoCommand(String(s.pending.command || ''))
      }
    } catch {
      /* ignore */
    }
  }, [])

  useEffect(() => {
    void refreshSudo()
  }, [refreshSudo])

  useVisibleInterval(() => {
    void refreshSudo()
  }, 6_000)

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
            tone="danger"
            className="text-[11px] !min-h-8 !px-2.5"
            onConfirm={() => void killAttached()}
          />
        )}
        {sessionId && (
          <HoldButton
            label="Exit"
            holdLabel="…"
            holdMs={1000}
            tone="warn"
            title="Hold 1s — send Ctrl+C twice"
            className="text-[11px] !min-h-8 !px-2.5"
            onConfirm={() => void exitSession(sessionId)}
          />
        )}
        {sessionId && (
          <HoldButton
            label="Kill"
            holdLabel="…"
            holdMs={2000}
            tone="danger"
            title="Hold 2s — kill process"
            className="text-[11px] !min-h-8 !px-2.5"
            onConfirm={() => void killSession(sessionId)}
          />
        )}
      </div>
    )
  }

  if (minimal && (replayCommand || replayOutput)) {
    const liveId = attach[0] || interactiveId
    return (
      <div className="h-full flex flex-col min-h-0 hb-shell-minimal">
        <div className="hb-shell-minimal-bar shrink-0">
          <span className="text-[10px] uppercase tracking-wide text-mute font-semibold">
            Command
          </span>
          {liveId && (
            <span className="text-[10px] text-mute ml-auto font-mono">
              session {liveId.slice(0, 8)}
            </span>
          )}
        </div>
        <div className="hb-shell-replay flex-1 min-h-0 overflow-auto">
          {replayCommand && (
            <pre className="hb-shell-replay-cmd">
              <span className="text-mute select-none">$ </span>
              {replayCommand}
            </pre>
          )}
          <pre className="hb-shell-replay-out">
            {replayOutput || '(no output captured)'}
          </pre>
        </div>
      </div>
    )
  }

  if (minimal && (attach.length > 0 || interactive)) {
    const liveId = attach[activeTab] || interactiveId
    return (
      <div className="h-full flex flex-col min-h-0 hb-shell-minimal">
        <div className="hb-shell-minimal-bar shrink-0">
          <span className="text-[10px] uppercase tracking-wide text-mute font-semibold">
            Shell
          </span>
          {liveId && (
            <span className="text-[10px] text-mute ml-auto font-mono">
              {liveId.slice(0, 8)}
            </span>
          )}
        </div>
        {interactive ? (
          <TerminalView
            key={`${project.id}-${nonce}`}
            path={`/ws/pty?project=${project.id}&cols=100&rows=36`}
            className="flex-1 min-h-0"
            onSession={(id) => {
              setInteractiveId(id)
              void refresh()
            }}
          />
        ) : liveId ? (
          <TerminalView sessionId={liveId} path="" className="flex-1 min-h-0" />
        ) : null}
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
            <button
              type="button"
              className="hb-shell-sudo-btn shrink-0"
              data-cached={sudoCached ? '1' : '0'}
              title={
                sudoWaiting
                  ? 'Sudo waiting for permission'
                  : sudoCached
                    ? 'Encrypted sudo vault ready — tap to manage'
                    : 'Set encrypted sudo password for shell'
              }
              onClick={() => {
                setSudoMsg('')
                setSudoOpen(true)
                void refreshSudo()
              }}
            >
              {sudoWaiting ? 'Sudo!' : sudoCached ? 'Sudo ✓' : 'Sudo'}
            </button>
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
                      tone="warn"
                      title="Hold 1s — send Ctrl+C twice"
                      className="text-xs !min-h-9 px-3"
                      onConfirm={() => void exitSession(s.id)}
                    />
                    <HoldButton
                      label="Kill"
                      holdLabel="…"
                      holdMs={2000}
                      tone="danger"
                      title="Hold 2s — kill process"
                      className="text-xs !min-h-9 px-3"
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

      {sudoOpen && (
        <div className="fixed inset-0 z-40 hb-overlay backdrop-blur-sm flex items-end sm:items-center justify-center p-4">
          <form
            className="w-full max-w-sm hb-surface p-4 space-y-3"
            onSubmit={(e: FormEvent) => {
              e.preventDefault()
              if (!sudoPassword) return
              setSudoBusy(true)
              setSudoMsg('')
              void api
                .setSudo(sudoPassword, { persistent: sudoRemember })
                .then(() => {
                  setSudoPassword('')
                  setSudoMsg(
                    sudoRemember
                      ? 'Encrypted password saved — still requires Allow each use'
                      : 'Session vault ready',
                  )
                  setSudoCached(true)
                  void refreshSudo()
                })
                .catch((err) =>
                  setSudoMsg(err instanceof Error ? err.message : String(err)),
                )
                .finally(() => setSudoBusy(false))
            }}
          >
            <div className="flex items-start justify-between gap-2">
              <div>
                <h2 className="font-semibold text-sm">Sudo vault</h2>
                <p className="text-[11px] text-mute mt-0.5">
                  AES-encrypted at rest · never auto-used without Allow
                </p>
              </div>
              <button
                type="button"
                className="text-mute text-sm px-2 py-1"
                onClick={() => setSudoOpen(false)}
              >
                Close
              </button>
            </div>
            {sudoWaiting && (
              <div className="rounded-lg border border-amber/40 bg-amber/10 px-3 py-2 space-y-2">
                <p className="text-xs text-mute">
                  Waiting for permission
                  {sudoCommand ? `: ${sudoCommand.slice(0, 120)}` : ''}
                </p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    disabled={sudoBusy || !sudoCached}
                    className="hb-btn hb-btn-primary flex-1 text-xs !min-h-9 disabled:opacity-40"
                    onClick={() => {
                      setSudoBusy(true)
                      void api
                        .allowSudo(sudoId || undefined)
                        .then((r) => {
                          if (r.ok === false) setSudoMsg(r.error || 'No saved password')
                          else {
                            setSudoMsg('Allowed')
                            setSudoWaiting(false)
                          }
                          void refreshSudo()
                        })
                        .finally(() => setSudoBusy(false))
                    }}
                  >
                    Allow saved
                  </button>
                  <button
                    type="button"
                    className="hb-btn hb-btn-ghost text-xs !min-h-9 text-danger"
                    onClick={() => {
                      void api.denySudo(sudoId || undefined).then(() => {
                        setSudoWaiting(false)
                        setSudoMsg('Denied')
                        void refreshSudo()
                      })
                    }}
                  >
                    Deny
                  </button>
                </div>
              </div>
            )}
            <input
              type="password"
              value={sudoPassword}
              onChange={(e) => setSudoPassword(e.target.value)}
              autoComplete="current-password"
              placeholder="sudo password"
              className="w-full rounded-lg bg-panel-2 border border-line px-3 py-2 text-sm outline-none focus:border-accent"
            />
            <label className="flex items-center gap-2 text-[11px] text-mute cursor-pointer select-none">
              <input
                type="checkbox"
                checked={sudoRemember}
                onChange={(e) => setSudoRemember(e.target.checked)}
              />
              Save encrypted on this host
            </label>
            <div className="flex gap-2">
              <button
                type="submit"
                disabled={sudoBusy || !sudoPassword}
                className="hb-btn hb-btn-primary flex-1 text-sm !min-h-10 disabled:opacity-40"
              >
                {sudoBusy ? 'Saving…' : sudoRemember ? 'Save & ready' : 'Use this session'}
              </button>
              {sudoCached && (
                <button
                  type="button"
                  className="hb-btn hb-btn-ghost text-sm !min-h-10"
                  onClick={() => {
                    void Promise.all([api.clearSudo(), api.clearPersistentSudo()]).then(() => {
                      setSudoCached(false)
                      setSudoMsg('Vault cleared')
                      void refreshSudo()
                    })
                  }}
                >
                  Clear
                </button>
              )}
            </div>
            {sudoMsg && <p className="text-xs text-sky">{sudoMsg}</p>}
          </form>
        </div>
      )}
    </div>
  )
}
