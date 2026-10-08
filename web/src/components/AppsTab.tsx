import { useEffect, useMemo, useState } from 'react'
import { api } from '../lib/api'
import type { ActionDef, Project } from '../lib/types'
import { HoldButton } from './HoldButton'
import { ProjectSelect } from './ProjectSelect'

function Dot({ up }: { up?: boolean }) {
  return (
    <span
      className={`inline-block w-2.5 h-2.5 rounded-full ${
        up ? 'bg-ok shadow-[0_0_12px_rgba(74,222,128,0.65)]' : 'bg-line border border-mute/40'
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
      <div className="px-4 pt-8 pb-28 max-w-3xl mx-auto space-y-5 hb-enter">
        <div>
          <div className="mb-4 h-px w-12 bg-gradient-to-r from-accent to-transparent" />
          <h1 className="font-display text-3xl md:text-4xl font-extrabold tracking-tight">
            Home<span className="text-accent"> Base</span>
          </h1>
          <p className="text-mute text-sm leading-relaxed mt-3">
            Nothing configured yet. Add a workspace on the host, then refresh.
          </p>
        </div>
        <pre className="text-xs font-mono rounded-xl border border-line bg-panel p-4 text-mute whitespace-pre-wrap leading-relaxed">
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

  return (
    <div className="px-4 pt-5 pb-28 max-w-3xl mx-auto space-y-5 hb-enter">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="mb-3 h-px w-12 bg-gradient-to-r from-accent to-transparent" />
          <h1 className="font-display text-3xl md:text-4xl font-extrabold tracking-tight">
            Home<span className="text-accent"> Base</span>
          </h1>
          <p className="text-mute text-sm mt-1.5">Workspace actions</p>
        </div>
        <button type="button" onClick={onRefresh} className="hb-btn hb-btn-ghost text-xs">
          Refresh
        </button>
      </header>

      <section className="hb-surface p-4 space-y-4">
        <label className="block space-y-1.5">
          <span className="hb-label">Workspace</span>
          <ProjectSelect
            projects={projects}
            selectedId={project.id}
            onSelect={onSelect}
            className="w-full"
          />
        </label>

        <p className="text-[11px] font-mono text-mute break-all leading-relaxed">{project.path}</p>

        {!!project.ports.length && (
          <div className="grid grid-cols-3 gap-2 text-center text-xs font-mono">
            {(
              project.portsStatus ||
              project.ports.map((p) => ({
                id: p.id,
                label: p.label,
                port: p.port,
                up: false,
              }))
            ).map((ps) => (
              <div
                key={ps.id}
                className={`rounded-lg border py-2.5 px-1 ${
                  ps.up
                    ? 'border-ok/50 bg-ok/10 text-text'
                    : 'border-line bg-panel-2 text-mute'
                }`}
              >
                <Dot up={ps.up} /> :{ps.port}
                <div className="mt-1 truncate text-[11px]">{ps.label || ps.id}</div>
              </div>
            ))}
          </div>
        )}

        {runActions.length > 0 && (
          <div className="space-y-2 pt-1">
            <span className="hb-label">Stack</span>
            <div className="flex gap-2">
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
                className={`hb-btn min-w-[6.5rem] ${
                  running ? 'hb-btn-danger' : 'hb-btn-primary'
                }`}
                title={running ? 'Stop stack (ports + sessions)' : selectedRun?.hint || ''}
              >
                {busy ? '…' : running ? 'Stop' : 'Start'}
              </button>
            </div>
            <p className="text-[11px] font-mono text-mute">
              {running
                ? 'Running — Start becomes Stop. Stop also frees configured ports.'
                : 'Pick Run / Run + Expo / Expo, then Start.'}
            </p>
          </div>
        )}
      </section>

      {ship.length > 0 && (
        <section className="hb-surface p-4 space-y-3">
          <h2 className="hb-label">Ship — hold to confirm</h2>
          <div className="grid grid-cols-2 gap-2">
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
        <section className="hb-surface p-4 space-y-3">
          <h2 className="hb-label">Shortcuts</h2>
          <div className="grid grid-cols-4 gap-2">
            {hotkeys.map((a) => (
              <button
                key={a.id}
                type="button"
                disabled={!!busy}
                onClick={() => void (a.type === 'stop' ? doStop() : doRun(a))}
                className="rounded-lg border border-line bg-ink/50 py-3 hover:border-accent/50"
                title={a.hint || `${a.script} ${a.args.join(' ')}`}
              >
                <div className="font-mono text-accent text-lg font-bold">{a.label}</div>
                {a.hint && (
                  <div className="text-[10px] text-mute mt-0.5 leading-tight px-1">{a.hint}</div>
                )}
              </button>
            ))}
          </div>
        </section>
      )}

      {[...groupBy(other)].map(([name, actions]) => (
        <section key={name} className="hb-surface p-4 space-y-3">
          <h2 className="hb-label capitalize">{name}</h2>
          <div className="grid grid-cols-2 gap-2">
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
