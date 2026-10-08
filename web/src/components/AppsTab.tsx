import { useEffect, useMemo, useState } from 'react'
import { api } from '../lib/api'
import type { ActionDef, Project } from '../lib/types'
import { HoldButton } from './HoldButton'
import { ProjectSelect } from './ProjectSelect'

function Dot({ up }: { up?: boolean }) {
  return (
    <span
      className={`inline-block w-2 h-2 rounded-full ${
        up ? 'bg-ok shadow-[0_0_10px_rgba(74,222,128,0.55)]' : 'bg-line border border-mute/35'
      }`}
    />
  )
}

function isRunning(project: Project): boolean {
  const ports = project.portsStatus || []
  if (ports.some((p) => p.up)) return true
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
}: {
  projects: Project[]
  selectedId: string
  onSelect: (id: string) => void
  onRefresh: () => void
  onOpenShell: (sessionId?: string) => void
}) {
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState('')
  const project = projects.find((p) => p.id === selectedId) || projects[0]

  const runActions = useMemo(() => {
    if (!project) return []
    return project.actions.filter(
      (a) =>
        (a.group === 'main' || !a.group) &&
        a.type !== 'stop' &&
        (a.kind === 'run' || a.kind === 'expo' || a.type === 'script' || a.type === 'restart'),
    )
  }, [project])

  const [runId, setRunId] = useState('')
  useEffect(() => {
    setRunId(runActions[0]?.id || '')
  }, [project?.id])
  const selectedRun =
    runActions.find((a) => a.id === runId) || runActions[0] || null

  const ship = project?.actions.filter((a) => a.group === 'ship') || []
  const hotkeys = project?.actions.filter((a) => a.group === 'hotkey') || []
  const other =
    project?.actions.filter(
      (a) => !['main', 'ship', 'hotkey', ''].includes(a.group) && a.group,
    ) || []

  async function doStop() {
    if (!project) return
    setBusy('Stop')
    setMsg('')
    try {
      await api.stop(project.id)
      setMsg('Stopped')
      onRefresh()
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy('')
    }
  }

  async function doRun(action: ActionDef) {
    if (!project) return
    setBusy(action.label)
    setMsg('')
    try {
      const result = await api.action(project.id, action.id)
      if (result?.session?.id) {
        setMsg(`${action.label} → ${result.session.id}`)
        onOpenShell(result.session.id)
      } else {
        setMsg(`${action.label} ok`)
      }
      onRefresh()
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
      <div className="hb-page space-y-5 hb-enter">
        <header>
          <div className="hb-brand-rule" />
          <h1 className="font-display text-3xl md:text-[2.75rem] font-extrabold tracking-tight">
            Home<span className="text-accent"> Base</span>
          </h1>
          <p className="text-mute text-sm leading-relaxed mt-3 max-w-md">
            Nothing configured yet. Add a workspace on the host, then refresh.
          </p>
        </header>
        <pre className="text-xs font-mono rounded-[var(--radius-surface)] border border-line bg-panel p-4 text-mute whitespace-pre-wrap leading-relaxed">
{`./build.sh --add-project --path /path/to/repo --id myapp
./build.sh --add-project --preset <name> --path /path/to/repo`}
        </pre>
        <button type="button" onClick={onRefresh} className="hb-btn hb-btn-primary">
          Refresh
        </button>
      </div>
    )
  }

  if (!project) return null
  const running = isRunning(project)
  const portCount = project.ports.length

  return (
    <div className="hb-page space-y-5 hb-enter">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="hb-brand-rule" />
          <h1 className="font-display text-3xl md:text-[2.75rem] font-extrabold tracking-tight">
            Home<span className="text-accent"> Base</span>
          </h1>
          <p className="text-mute text-sm mt-1.5">Workspace actions</p>
        </div>
        <button type="button" onClick={onRefresh} className="hb-btn hb-btn-ghost text-xs !min-h-10">
          Refresh
        </button>
      </header>

      <div className="grid gap-4 md:grid-cols-2 md:gap-5 md:items-start">
        <section className="hb-surface p-4 sm:p-5 space-y-4 md:col-span-2 lg:col-span-1">
          <label className="block space-y-1.5">
            <span className="hb-label">Workspace</span>
            <ProjectSelect
              projects={projects}
              selectedId={project.id}
              onSelect={onSelect}
              className="w-full"
            />
          </label>

          <p className="text-[11px] font-mono text-mute break-all leading-relaxed">
            {project.path}
          </p>

          {!!portCount && (
            <div
              className={`grid gap-2 ${
                portCount === 1
                  ? 'grid-cols-1 max-w-[10rem]'
                  : portCount === 2
                    ? 'grid-cols-2'
                    : 'grid-cols-3'
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
              ).map((ps) => (
                <div key={ps.id} className="hb-port" data-up={ps.up}>
                  <div className="flex items-center justify-center gap-1.5">
                    <Dot up={ps.up} />
                    <span>:{ps.port}</span>
                  </div>
                  <div className="mt-1 truncate text-[11px] opacity-90">
                    {ps.label || ps.id}
                  </div>
                </div>
              ))}
            </div>
          )}

          {runActions.length > 0 && (
            <div className="space-y-2 pt-1">
              <span className="hb-label">Stack</span>
              <div className="flex flex-col gap-2 sm:flex-row">
                <select
                  value={selectedRun?.id || ''}
                  onChange={(e) => setRunId(e.target.value)}
                  disabled={!!busy || running}
                  className="hb-select flex-1"
                >
                  {runActions.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.label}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  disabled={!!busy || (!running && !selectedRun)}
                  onClick={() => void toggleRun()}
                  className={`hb-btn min-w-[7rem] shrink-0 ${
                    running ? 'hb-btn-danger' : 'hb-btn-primary'
                  }`}
                  title={running ? 'Stop stack (ports + sessions)' : selectedRun?.hint || ''}
                >
                  {busy ? '…' : running ? 'Stop' : 'Start'}
                </button>
              </div>
              <p className="text-[11px] font-mono text-mute leading-relaxed">
                {running
                  ? 'Running — Start becomes Stop. Stop also frees configured ports.'
                  : 'Pick Run / Run + Expo / Expo, then Start.'}
              </p>
            </div>
          )}
        </section>

        <div className="space-y-4 md:col-span-2 lg:col-span-1 lg:space-y-5">
          {ship.length > 0 && (
            <section className="hb-surface p-4 sm:p-5 space-y-3">
              <h2 className="hb-label">Ship — hold to confirm</h2>
              <div className="grid grid-cols-2 gap-2 sm:gap-2.5">
                {ship.map((a) => (
                  <HoldButton
                    key={a.id}
                    label={a.label}
                    holdLabel={`hold ${a.label}…`}
                    disabled={!!busy}
                    className="hb-btn hb-btn-ship py-3.5"
                    title={`${a.script} ${a.args.join(' ')}`}
                    onConfirm={async () => {
                      setBusy(a.label)
                      setMsg('')
                      try {
                        const result = await api.action(project.id, a.id)
                        if (result?.session?.id) {
                          setMsg(`${a.label} → ${result.session.id}`)
                          onOpenShell(result.session.id)
                        } else setMsg(`${a.label} ok`)
                        onRefresh()
                      } catch (e) {
                        setMsg(e instanceof Error ? e.message : String(e))
                      } finally {
                        setBusy('')
                      }
                    }}
                  />
                ))}
              </div>
            </section>
          )}

          {hotkeys.length > 0 && (
            <section className="hb-surface p-4 sm:p-5 space-y-3">
              <h2 className="hb-label">Shortcuts</h2>
              <div
                className={`grid gap-2 ${
                  hotkeys.length <= 2
                    ? 'grid-cols-2'
                    : hotkeys.length === 3
                      ? 'grid-cols-3'
                      : 'grid-cols-4'
                }`}
              >
                {hotkeys.map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    disabled={!!busy}
                    onClick={() => void (a.type === 'stop' ? doStop() : doRun(a))}
                    className="rounded-[var(--radius-control)] border border-line bg-ink/40 py-3 hover:border-accent/45 hover:bg-panel-2"
                    title={a.hint || `${a.script} ${a.args.join(' ')}`}
                  >
                    <div className="font-mono text-accent text-lg font-bold">{a.label}</div>
                    {a.hint && (
                      <div className="text-[10px] text-mute mt-0.5 leading-tight px-1">
                        {a.hint}
                      </div>
                    )}
                  </button>
                ))}
              </div>
            </section>
          )}
        </div>
      </div>

      {[...groupBy(other)].map(([name, actions]) => (
        <section key={name} className="hb-surface p-4 sm:p-5 space-y-3">
          <h2 className="hb-label capitalize">{name}</h2>
          <div className="grid grid-cols-2 gap-2 sm:gap-2.5 md:grid-cols-3">
            {actions.map((a) =>
              a.kind === 'ship' ? (
                <HoldButton
                  key={a.id}
                  label={a.label}
                  disabled={!!busy}
                  className="hb-btn hb-btn-ship py-3"
                  onConfirm={() => doRun(a)}
                />
              ) : (
                <button
                  key={a.id}
                  type="button"
                  disabled={!!busy}
                  onClick={() => void doRun(a)}
                  className="hb-btn hb-btn-ghost py-3"
                >
                  {a.label}
                </button>
              ),
            )}
          </div>
        </section>
      ))}

      {(busy || msg) && (
        <p className="text-sm font-mono text-mute px-1">{busy ? `… ${busy}` : msg}</p>
      )}
    </div>
  )
}
