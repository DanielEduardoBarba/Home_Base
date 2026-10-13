import { useEffect, useMemo, useState } from 'react'
import { api } from '../lib/api'
import { useSceneRefresh } from '../lib/sceneRefresh'
import type { ActionDef, Project } from '../lib/types'
import { useServerIdentity } from '../lib/serverIdentity'
import { AddProjectWizard, type AddProjectResult } from './AddProjectWizard'
import { BrandTitle } from './BrandTitle'
import { HoldButton } from './HoldButton'
import { IconBtn } from './IconBtn'
import { ProjectSelect } from './ProjectSelect'

function Dot({ up }: { up?: boolean }) {
  return (
    <span
      className={`inline-block w-2 h-2 rounded-full ${
        up ? 'bg-ok' : 'bg-line border border-mute/35'
      }`}
    />
  )
}

function portUp(p: { up?: boolean; listening?: boolean }): boolean {
  return Boolean(p.up ?? p.listening)
}

function isRunning(project: Project): boolean {
  const ports = project.portsStatus || []
  if (ports.some((p) => portUp(p as { up?: boolean; listening?: boolean }))) {
    return true
  }
  return (project.sessions || []).some(
    (s) => s.alive && (s.kind === 'run' || s.kind === 'expo'),
  )
}

function groupBy(actions: ActionDef[]): [string, ActionDef[]][] {
  const groups = new Map<string, ActionDef[]>()
  for (const a of actions) {
    const g = groups.get(a.group) || []
    g.push(a)
    groups.set(a.group, g)
  }
  return [...groups.entries()]
}

export function AppsTab({
  projects,
  selectedId,
  onSelect,
  onRefresh,
  onOpenShell,
  onAskAiWire,
  embedded = false,
}: {
  projects: Project[]
  selectedId: string
  onSelect: (id: string) => void
  onRefresh: () => void | Promise<void>
  onOpenShell: (sessionIds?: string | string[]) => void
  /** After Add app with Chat wiring — open Work dock / Cursor. */
  onAskAiWire?: (projectId: string) => void
  /** When true (Work tab), skip brand header — Work chrome owns project. */
  embedded?: boolean
}) {
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState('')
  const [hotkeysOpen, setHotkeysOpen] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const { displayName } = useServerIdentity()
  const project = projects.find((p) => p.id === selectedId) || projects[0]

  useSceneRefresh(onRefresh)

  const runActions = useMemo(() => {
    if (!project) return []
    return project.actions.filter(
      (a) =>
        (a.group === 'main' || !a.group) &&
        a.type !== 'stop' &&
        (a.kind === 'run' ||
          a.kind === 'expo' ||
          a.type === 'compose' ||
          a.type === 'script' ||
          a.type === 'restart'),
    )
  }, [project])

  const ship = project?.actions.filter((a) => a.group === 'ship') || []
  const hotkeys = project?.actions.filter((a) => a.group === 'hotkey') || []
  const other =
    project?.actions.filter(
      (a) => !['main', 'ship', 'hotkey', ''].includes(a.group) && a.group,
    ) || []

  const [runId, setRunId] = useState('')
  const [shipId, setShipId] = useState('')
  useEffect(() => {
    // Prefer Run + Expo (run_all) over plain Run when available.
    const prefer =
      runActions.find(
        (a) =>
          a.id === 'run_all' ||
          a.id === 'run-all' ||
          /run\s*\+\s*expo|run\s*and\s*expo|run\s*all/i.test(a.label),
      ) || runActions[0]
    setRunId(prefer?.id || '')
    setShipId(ship[0]?.id || '')
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset when project changes
  }, [project?.id])

  const selectedRun =
    runActions.find((a) => a.id === runId) ||
    runActions.find(
      (a) =>
        a.id === 'run_all' ||
        a.id === 'run-all' ||
        /run\s*\+\s*expo|run\s*and\s*expo|run\s*all/i.test(a.label),
    ) ||
    runActions[0] ||
    null
  const selectedShip = ship.find((a) => a.id === shipId) || ship[0] || null

  async function doStop() {
    if (!project) return
    setBusy('Stop')
    setMsg('')
    try {
      await api.stop(project.id)
      setMsg('Stopped')
      await onRefresh()
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy('')
    }
  }

  async function doRemove() {
    if (!project) return
    if (project.id === 'homebase') {
      setMsg('Home Base app cannot be removed')
      return
    }
    setBusy('Remove')
    setMsg('')
    try {
      await api.deleteProject(project.id)
      const next = projects.find((p) => p.id !== project.id)
      if (next) onSelect(next.id)
      setMsg('Removed from Home Base')
      await onRefresh()
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy('')
    }
  }

  async function handleAdded(result: AddProjectResult) {
    onSelect(result.projectId)
    await onRefresh()
    if (result.askAi) onAskAiWire?.(result.projectId)
  }

  async function doRun(action: ActionDef) {
    if (!project) return
    setBusy(action.label)
    setMsg('')
    try {
      const result = await api.action(project.id, action.id)
      const multi = result?.sessions?.map((s) => s.id).filter(Boolean) || []
      if (multi.length >= 2) {
        setMsg(`${action.label} started (split)`)
        onOpenShell(multi)
      } else if (result?.session?.id) {
        setMsg(`${action.label} started`)
        onOpenShell(result.session.id)
      } else if (multi.length === 1) {
        setMsg(`${action.label} started`)
        onOpenShell(multi[0])
      } else {
        setMsg(`${action.label} done`)
      }
      await onRefresh()
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy('')
    }
  }

  async function toggleRun() {
    if (!project || !selectedRun) return
    if (isRunning(project)) await doStop()
    else await doRun(selectedRun)
  }

  if (!projects.length) {
    return (
      <div className={`hb-page space-y-4 hb-enter ${embedded ? '!pt-3' : ''}`}>
        {!embedded && (
          <header>
            <div className="hb-brand-rule" />
            <h1 className="font-display text-2xl md:text-3xl font-extrabold tracking-tight">
              <BrandTitle name={displayName} />
            </h1>
          </header>
        )}
        <section className="hb-surface p-4 space-y-3">
          <p className="text-sm text-mute">No apps yet. Add your first project.</p>
          <button
            type="button"
            className="hb-btn hb-btn-primary w-full !min-h-11"
            onClick={() => setAddOpen(true)}
          >
            Add app
          </button>
        </section>
        <AddProjectWizard
          open={addOpen}
          onClose={() => setAddOpen(false)}
          onAdded={(result) => {
            void handleAdded(result)
          }}
        />
      </div>
    )
  }

  if (!project) return null
  const running = isRunning(project)
  const portCount = project.ports.length

  return (
    <div className={`hb-page space-y-4 hb-enter ${embedded ? '!pt-3' : ''}`}>
      {!embedded && (
        <header>
          <div className="hb-brand-rule" />
          <h1 className="font-display text-2xl md:text-3xl font-extrabold tracking-tight">
            <BrandTitle name={displayName} />
          </h1>
        </header>
      )}

      <section className="hb-surface p-3.5 sm:p-4 space-y-3">
        {!embedded && (
          <div className="space-y-1">
            <div className="flex items-center justify-between gap-2">
              <span className="hb-label">App</span>
              <div className="flex items-center gap-1.5">
                {project.id !== 'homebase' && (
                  <HoldButton
                    label={busy === 'Remove' ? '…' : 'Remove'}
                    holdLabel="Hold…"
                    holdMs={1200}
                    tone="danger"
                    disabled={!!busy}
                    className="!min-h-9 !px-3 text-xs shrink-0"
                    title="Hold to remove app from Home Base (keeps files on disk)"
                    onConfirm={() => void doRemove()}
                  />
                )}
                <IconBtn label="Add app" onClick={() => setAddOpen(true)} className="!w-9 !h-9" />
              </div>
            </div>
            <ProjectSelect
              projects={projects}
              selectedId={project.id}
              onSelect={onSelect}
              className="w-full !min-h-10 !py-2 text-sm"
            />
          </div>
        )}
        {embedded && (
          <div className="flex items-center justify-end gap-1.5">
            {project.id !== 'homebase' && (
              <HoldButton
                label={busy === 'Remove' ? '…' : 'Remove'}
                holdLabel="Hold…"
                holdMs={1200}
                tone="danger"
                disabled={!!busy}
                className="!min-h-9 !px-3 text-xs shrink-0"
                title="Hold to remove app from Home Base (keeps files on disk)"
                onConfirm={() => void doRemove()}
              />
            )}
            <IconBtn label="Add app" onClick={() => setAddOpen(true)} className="!w-9 !h-9" />
          </div>
        )}

        {!!portCount && (
          <div
            className={`grid gap-1.5 ${
              portCount === 1 ? 'grid-cols-1 max-w-[9rem]' : portCount === 2 ? 'grid-cols-2' : 'grid-cols-3'
            }`}
          >
            {(
              project.portsStatus ||
              project.ports.map((p) => ({
                id: p.id,
                label: p.label,
                port: p.port,
                up: false,
              }))
            ).map((ps) => {
              // Same host the SPA was loaded from (VPN/LAN), not localhost
              const href = `${location.protocol}//${location.hostname}:${ps.port}/`
              return (
                <a
                  key={ps.id}
                  href={href}
                  target="_blank"
                  rel="noreferrer"
                  title={href}
                  className="hb-port !py-1.5 block no-underline"
                  data-up={portUp(ps) ? '1' : '0'}
                >
                  <div className="flex items-center justify-center gap-1">
                    <Dot up={portUp(ps)} />
                    <span>:{ps.port}</span>
                  </div>
                  <div className="mt-0.5 truncate text-[10px] opacity-90">
                    {ps.label || ps.id}
                  </div>
                </a>
              )
            })}
          </div>
        )}

        {runActions.length > 0 && (
          <div className="space-y-1.5 pt-0.5">
            <span className="hb-label">Run</span>
            <div className="flex gap-2">
              <select
                value={selectedRun?.id || ''}
                onChange={(e) => setRunId(e.target.value)}
                disabled={!!busy || running}
                className="hb-select flex-1 !min-h-10 !py-2 text-sm"
              >
                {runActions.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.label}
                  </option>
                ))}
              </select>
              {running ? (
                <HoldButton
                  label={busy ? '…' : 'Stop'}
                  holdLabel="Hold…"
                  holdMs={1200}
                  tone="danger"
                  disabled={!!busy}
                  className="!min-h-10 !px-4 text-sm shrink-0"
                  title="Hold to stop project"
                  onConfirm={() => void toggleRun()}
                />
              ) : (
                <button
                  type="button"
                  disabled={!!busy || !selectedRun}
                  onClick={() => void toggleRun()}
                  className="hb-btn hb-btn-primary !min-h-10 !px-4 text-sm shrink-0"
                >
                  {busy ? '…' : 'Start'}
                </button>
              )}
            </div>
          </div>
        )}

        {ship.length > 0 && (
          <div className="space-y-1.5 pt-1 border-t border-line/60">
            <span className="hb-label">Ship</span>
            <div className="flex gap-2">
              <select
                value={selectedShip?.id || ''}
                onChange={(e) => setShipId(e.target.value)}
                disabled={!!busy}
                className="hb-select flex-1 !min-h-10 !py-2 text-sm"
              >
                {ship.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.label}
                  </option>
                ))}
              </select>
              <HoldButton
                label={busy ? '…' : 'Ship'}
                holdLabel="Hold…"
                tone="ship"
                disabled={!!busy || !selectedShip}
                className="!min-h-10 !px-4 text-sm shrink-0"
                title={selectedShip?.hint || selectedShip?.label}
                onConfirm={async () => {
                  if (!selectedShip) return
                  await doRun(selectedShip)
                }}
              />
            </div>
            <p className="text-[11px] text-mute">Hold Ship to confirm</p>
          </div>
        )}
      </section>

      {hotkeys.length > 0 && (
        <section className="hb-surface p-3.5 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <h2 className="hb-label mb-0">Shortcuts</h2>
            <button
              type="button"
              disabled={!!busy}
              onClick={() => setHotkeysOpen(true)}
              className="hb-btn hb-btn-ghost !min-h-9 !px-3 text-xs"
            >
              Actions
            </button>
          </div>
          <p className="text-[11px] text-mute leading-relaxed">
            Deploy, restart, and other one-tap commands — open Actions to run them.
          </p>
        </section>
      )}

      {hotkeysOpen && (
        <div
          className="fixed inset-0 z-50 hb-overlay backdrop-blur-sm flex items-end sm:items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-label="App shortcuts"
          onClick={() => setHotkeysOpen(false)}
        >
          <div
            className="hb-surface w-full max-w-sm p-4 space-y-3 shadow-xl max-h-[80vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-2">
              <h2 className="font-semibold text-sm">Shortcuts</h2>
              <button
                type="button"
                className="text-mute text-sm px-2 py-1"
                onClick={() => setHotkeysOpen(false)}
              >
                Close
              </button>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {hotkeys.map((a) =>
                a.type === 'stop' || /restart/i.test(a.label) ? (
                  <HoldButton
                    key={a.id}
                    label={a.label}
                    holdLabel="Hold…"
                    holdMs={1200}
                    tone={a.type === 'stop' ? 'danger' : 'warn'}
                    disabled={!!busy}
                    className="!min-h-11 text-sm"
                    title={a.hint || `Hold to ${a.label}`}
                    onConfirm={() => {
                      setHotkeysOpen(false)
                      void (a.type === 'stop' ? doStop() : doRun(a))
                    }}
                  />
                ) : (
                  <button
                    key={a.id}
                    type="button"
                    disabled={!!busy}
                    title={a.hint || a.label}
                    onClick={() => {
                      setHotkeysOpen(false)
                      void doRun(a)
                    }}
                    className="hb-btn hb-btn-ghost !min-h-11 text-sm"
                  >
                    {a.label}
                  </button>
                ),
              )}
            </div>
          </div>
        </div>
      )}

      {[...groupBy(other)].map(([name, actions]) => (
        <section key={name} className="hb-surface p-3.5 space-y-2">
          <h2 className="hb-label capitalize">{name}</h2>
          <div className="grid grid-cols-2 gap-1.5">
            {actions.map((a) =>
              a.kind === 'ship' ? (
                <HoldButton
                  key={a.id}
                  label={a.label}
                  disabled={!!busy}
                  className="hb-btn hb-btn-ship !min-h-10 text-sm"
                  onConfirm={() => doRun(a)}
                />
              ) : (
                <button
                  key={a.id}
                  type="button"
                  disabled={!!busy}
                  onClick={() => void doRun(a)}
                  className="hb-btn hb-btn-ghost !min-h-10 text-sm"
                >
                  {a.label}
                </button>
              ),
            )}
          </div>
        </section>
      ))}

      {(busy || msg) && <p className="text-xs text-mute px-1">{busy ? `Working… ${busy}` : msg}</p>}

      <AddProjectWizard
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onAdded={(result) => {
          void handleAdded(result)
        }}
      />
    </div>
  )
}
