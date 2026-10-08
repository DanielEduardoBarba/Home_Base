import { useState } from 'react'
import { api } from '../lib/api'
import type { ActionDef, Project } from '../lib/types'

function Dot({ up }: { up?: boolean }) {
  return (
    <span
      className={`inline-block w-2 h-2 rounded-full ${
        up ? 'bg-ok shadow-[0_0_8px_#34d399]' : 'bg-line'
      }`}
    />
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

function btnClass(variant: string): string {
  if (variant === 'primary')
    return 'rounded-xl bg-accent text-ink font-semibold py-3.5 shadow-[0_6px_20px_rgba(45,212,191,0.16)]'
  if (variant === 'accent') return 'rounded-xl bg-accent-dim text-ink font-semibold py-3.5'
  if (variant === 'danger')
    return 'rounded-xl border border-danger/40 text-danger bg-danger/10 py-3 font-semibold'
  return 'rounded-xl border border-line bg-panel-2 py-3 text-sm hover:border-mute/40'
}

export function AppsTab({
  projects,
  selectedId,
  onSelect,
  onRefresh,
  onOpenMonitor,
}: {
  projects: Project[]
  selectedId: string
  onSelect: (id: string) => void
  onRefresh: () => void
  onOpenMonitor: (sessionId?: string) => void
}) {
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState('')
  const project = projects.find((p) => p.id === selectedId) || projects[0]

  async function runAction(action: ActionDef) {
    if (!project) return
    setBusy(action.label)
    setMsg('')
    try {
      if (action.type === 'stop') {
        await api.stop(project.id)
        setMsg('Stopped')
      } else {
        const result = await api.action(project.id, action.id)
        if (result?.session?.id) {
          setMsg(`${action.label} → ${result.session.id}`)
          onOpenMonitor(result.session.id)
        } else {
          setMsg(`${action.label} ok`)
        }
      }
      onRefresh()
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy('')
    }
  }

  if (!projects.length) {
    return (
      <div className="px-4 pt-8 pb-28 max-w-lg mx-auto space-y-5 hb-enter">
        <div>
          <div className="mb-4 h-px w-12 bg-gradient-to-r from-accent to-transparent" />
          <h1 className="font-display text-3xl font-extrabold tracking-tight">
            Home<span className="text-accent"> Base</span>
          </h1>
          <p className="text-mute text-sm leading-relaxed mt-3">
            Nothing configured yet. Add a workspace on the host, then refresh.
          </p>
        </div>
        <pre className="text-xs font-mono rounded-2xl border border-line bg-panel/90 p-4 text-mute whitespace-pre-wrap leading-relaxed">
{`./build.sh --add-project --path /path/to/repo --id myapp
# optional preset for a common action set:
./build.sh --add-project --preset <name> --path /path/to/repo`}
        </pre>
        <p className="text-mute text-xs leading-relaxed">
          Map buttons → scripts in{' '}
          <span className="text-text font-mono">config/projects.json</span>.
        </p>
        <button
          type="button"
          onClick={onRefresh}
          className="rounded-xl bg-accent text-ink font-semibold px-5 py-3 shadow-[0_6px_20px_rgba(45,212,191,0.16)]"
        >
          Refresh
        </button>
      </div>
    )
  }

  if (!project) return null

  const main = project.actions.filter((a) => a.group === 'main' || !a.group)
  const ship = project.actions.filter((a) => a.group === 'ship')
  const hotkeys = project.actions.filter((a) => a.group === 'hotkey')
  const other = project.actions.filter(
    (a) => !['main', 'ship', 'hotkey', ''].includes(a.group) && a.group,
  )

  return (
    <div className="px-4 pt-5 pb-28 max-w-lg mx-auto space-y-5 hb-enter">
      <header>
        <div className="mb-3 h-px w-12 bg-gradient-to-r from-accent to-transparent" />
        <h1 className="font-display text-3xl font-extrabold tracking-tight">
          Home<span className="text-accent"> Base</span>
        </h1>
        <p className="text-mute text-sm mt-1.5">Run actions for the selected workspace</p>
      </header>

      <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1">
        {projects.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => onSelect(p.id)}
            className={`min-w-[9rem] flex-1 hb-chip px-3 py-3 text-left ${
              p.id === project.id ? 'hb-chip-active' : ''
            }`}
          >
            <div className="font-semibold text-sm truncate">{p.name}</div>
            <div className="mt-2 flex flex-wrap gap-2 text-[11px] font-mono text-mute">
              {(p.portsStatus || []).map((ps) => (
                <span key={ps.id} className="inline-flex items-center gap-1">
                  <Dot up={ps.up} /> {ps.id}
                </span>
              ))}
            </div>
          </button>
        ))}
      </div>

      <section className="hb-surface p-4 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="font-semibold truncate">{project.name}</h2>
          <button
            type="button"
            onClick={onRefresh}
            className="text-xs text-accent font-mono shrink-0 hover:text-text"
          >
            refresh
          </button>
        </div>
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
                className="rounded-xl bg-panel-2/80 border border-line/80 py-2.5 px-1"
              >
                <Dot up={ps.up} /> :{ps.port}
                <div className="text-mute mt-1 truncate">{ps.label || ps.id}</div>
              </div>
            ))}
          </div>
        )}

        {main.length > 0 && (
          <div className="grid grid-cols-2 gap-2 pt-1">
            {main.map((a) => (
              <button
                key={a.id}
                type="button"
                disabled={!!busy}
                onClick={() => runAction(a)}
                className={btnClass(a.variant)}
                title={a.hint || `${a.script} ${a.args.join(' ')}`}
              >
                {a.label}
              </button>
            ))}
          </div>
        )}
      </section>

      {ship.length > 0 && (
        <section className="hb-surface p-4 space-y-3">
          <h2 className="text-sm font-semibold text-mute tracking-wide uppercase text-[11px]">
            Ship
          </h2>
          <div className="grid grid-cols-2 gap-2">
            {ship.map((a) => (
              <button
                key={a.id}
                type="button"
                disabled={!!busy}
                onClick={() => runAction(a)}
                className={btnClass(a.variant)}
                title={`${a.script} ${a.args.join(' ')}`}
              >
                {a.label}
              </button>
            ))}
          </div>
        </section>
      )}

      {hotkeys.length > 0 && (
        <section className="hb-surface p-4 space-y-3">
          <h2 className="text-sm font-semibold text-mute tracking-wide uppercase text-[11px]">
            Shortcuts
          </h2>
          <div className="grid grid-cols-4 gap-2">
            {hotkeys.map((a) => (
              <button
                key={a.id}
                type="button"
                disabled={!!busy}
                onClick={() => runAction(a)}
                className="rounded-xl border border-line bg-ink/40 py-3 hover:border-accent/30"
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
          <h2 className="text-sm font-semibold text-mute tracking-wide uppercase text-[11px] capitalize">
            {name}
          </h2>
          <div className="grid grid-cols-2 gap-2">
            {actions.map((a) => (
              <button
                key={a.id}
                type="button"
                disabled={!!busy}
                onClick={() => runAction(a)}
                className={btnClass(a.variant)}
              >
                {a.label}
              </button>
            ))}
          </div>
        </section>
      ))}

      {(busy || msg) && (
        <p className="text-sm font-mono text-mute px-1">{busy ? `… ${busy}` : msg}</p>
      )}
    </div>
  )
}
