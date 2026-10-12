'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../lib/api'
import type { AccessHook, AccessHookType, AccessWidget, AccessWidgetKind, Project } from '../lib/types'
import { ChatPanel, readDockOpen, writeDockOpen } from './ChatPanel'

const KINDS: { id: AccessWidgetKind; label: string }[] = [
  { id: 'button', label: 'Button' },
  { id: 'toggle', label: 'Toggle' },
  { id: 'slider', label: 'Slider' },
  { id: 'gauge', label: 'Gauge' },
]

const HOOKS: { id: AccessHookType; label: string }[] = [
  { id: 'script', label: 'Script' },
  { id: 'http', label: 'HTTP' },
  { id: 'websocket', label: 'WebSocket' },
  { id: 'static', label: 'Static' },
]

type Draft = {
  id?: string
  kind: AccessWidgetKind
  label: string
  description: string
  group: string
  min: string
  max: string
  step: string
  unit: string
  hookType: AccessHookType
  command: string
  cwd: string
  url: string
  method: string
  bodyTemplate: string
  wsUrl: string
  wsMessage: string
  valuePath: string
  detailPath: string
  pollMs: string
}

function emptyDraft(kind: AccessWidgetKind = 'button'): Draft {
  return {
    kind,
    label: '',
    description: '',
    group: '',
    min: '0',
    max: '100',
    step: '1',
    unit: '',
    hookType: 'script',
    command: '',
    cwd: '',
    url: '',
    method: 'POST',
    bodyTemplate: '{"value":{{json}}}',
    wsUrl: '',
    wsMessage: '{{json}}',
    valuePath: '',
    detailPath: '',
    pollMs: '',
  }
}

function draftFromWidget(w: AccessWidget): Draft {
  return {
    id: w.id,
    kind: w.kind,
    label: w.label,
    description: w.description || '',
    group: w.group || '',
    min: String(w.min ?? 0),
    max: String(w.max ?? 100),
    step: String(w.step ?? 1),
    unit: w.unit || '',
    hookType: w.hook.type,
    command: w.hook.command || '',
    cwd: w.hook.cwd || '',
    url: w.hook.url || '',
    method: w.hook.method || 'POST',
    bodyTemplate: w.hook.bodyTemplate ?? '{"value":{{json}}}',
    wsUrl: w.hook.wsUrl || '',
    wsMessage: w.hook.wsMessage ?? '{{json}}',
    valuePath: w.hook.valuePath || '',
    detailPath: w.hook.detailPath || '',
    pollMs: w.hook.pollMs != null ? String(w.hook.pollMs) : '',
  }
}

function hookFromDraft(d: Draft): AccessHook {
  const hook: AccessHook = { type: d.hookType }
  if (d.hookType === 'script') {
    hook.command = d.command
    if (d.cwd.trim()) hook.cwd = d.cwd.trim()
  } else if (d.hookType === 'http') {
    hook.url = d.url
    hook.method = d.method || 'POST'
    if (d.bodyTemplate.trim()) hook.bodyTemplate = d.bodyTemplate
  } else if (d.hookType === 'websocket') {
    hook.wsUrl = d.wsUrl
    hook.wsMessage = d.wsMessage
  }
  if (d.valuePath.trim()) hook.valuePath = d.valuePath.trim()
  if (d.detailPath.trim()) hook.detailPath = d.detailPath.trim()
  if (d.pollMs.trim()) hook.pollMs = Number(d.pollMs) || 0
  return hook
}

function GaugeFace({
  value,
  min,
  max,
  unit,
}: {
  value: number
  min: number
  max: number
  unit?: string
}) {
  const pct = max > min ? Math.min(1, Math.max(0, (value - min) / (max - min))) : 0
  const angle = -120 + pct * 240
  return (
    <div className="hb-access-gauge" aria-hidden>
      <svg viewBox="0 0 120 90" className="hb-access-gauge-svg">
        <path
          d="M16 78 A44 44 0 1 1 104 78"
          fill="none"
          stroke="var(--hb-line)"
          strokeWidth="8"
          strokeLinecap="round"
        />
        <path
          d="M16 78 A44 44 0 1 1 104 78"
          fill="none"
          stroke="var(--hb-accent)"
          strokeWidth="8"
          strokeLinecap="round"
          strokeDasharray={`${pct * 184} 184`}
        />
        <line
          x1="60"
          y1="70"
          x2="60"
          y2="32"
          stroke="var(--hb-text)"
          strokeWidth="2.5"
          strokeLinecap="round"
          transform={`rotate(${angle} 60 70)`}
        />
        <circle cx="60" cy="70" r="4" fill="var(--hb-text)" />
      </svg>
      <div className="hb-access-gauge-readout">
        {Number.isFinite(value) ? value.toFixed(value % 1 ? 1 : 0) : '—'}
        {unit ? <span className="text-mute"> {unit}</span> : null}
      </div>
    </div>
  )
}

export function HomeAccessTab({
  projects,
  selectedId,
  onSelect,
  onHome,
}: {
  projects: Project[]
  selectedId: string
  onSelect: (id: string) => void
  onHome: () => void
}) {
  const [widgets, setWidgets] = useState<AccessWidget[]>([])
  const [error, setError] = useState('')
  const [busyId, setBusyId] = useState('')
  const [editorOpen, setEditorOpen] = useState(false)
  const [draft, setDraft] = useState<Draft>(() => emptyDraft())
  const [dockOpen, setDockOpenState] = useState(false)

  useEffect(() => {
    setDockOpenState(readDockOpen())
  }, [])

  function setDockOpen(open: boolean) {
    writeDockOpen(open)
    setDockOpenState(open)
  }

  const load = useCallback(async () => {
    try {
      const data = await api.homeAccess()
      setWidgets(data.widgets)
      setError('')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const gaugePollKey = useMemo(
    () =>
      widgets
        .filter((w) => w.kind === 'gauge' && (w.hook.pollMs || 0) > 0)
        .map((w) => `${w.id}:${w.hook.pollMs}`)
        .sort()
        .join('|'),
    [widgets],
  )

  // Auto-poll gauges that declare pollMs (key ignores value churn from prior polls)
  useEffect(() => {
    if (!gaugePollKey) return
    const gauges = gaugePollKey.split('|').map((row) => {
      const [id, ms] = row.split(':')
      return { id: id!, pollMs: Number(ms) || 10_000 }
    })
    const timers = gauges.map((g) =>
      window.setInterval(() => {
        void api
          .homeAccessInvoke(g.id)
          .then((r) => {
            setWidgets((prev) => prev.map((x) => (x.id === r.widget.id ? r.widget : x)))
          })
          .catch(() => {
            /* ignore poll errors */
          })
      }, Math.max(2000, g.pollMs)),
    )
    return () => {
      for (const t of timers) clearInterval(t)
    }
  }, [gaugePollKey])

  const sorted = useMemo(() => {
    const groupRank = (g?: string) => {
      const key = String(g || '').toLowerCase()
      if (key === 'network') return 0
      if (key === 'iot') return 1
      if (key === 'people') return 2
      if (key === 'meta') return 3
      if (!key) return 9
      return 5
    }
    return [...widgets].sort(
      (a, b) =>
        groupRank(a.group) - groupRank(b.group) ||
        String(a.group || '').localeCompare(String(b.group || '')) ||
        a.order - b.order ||
        a.label.localeCompare(b.label),
    )
  }, [widgets])

  async function invoke(id: string, value?: unknown) {
    setBusyId(id)
    try {
      const { widget } = await api.homeAccessInvoke(id, value)
      setWidgets((prev) => prev.map((w) => (w.id === widget.id ? widget : w)))
      setError('')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusyId('')
    }
  }

  async function saveDraft() {
    const label = draft.label.trim()
    if (!label) {
      setError('Label required')
      return
    }
    const payload = {
      id: draft.id,
      kind: draft.kind,
      label,
      description: draft.description.trim() || undefined,
      group: draft.group.trim() || undefined,
      min: Number(draft.min),
      max: Number(draft.max),
      step: Number(draft.step),
      unit: draft.unit.trim() || undefined,
      hook: hookFromDraft(draft),
    }
    try {
      const { widget } = draft.id
        ? await api.homeAccessUpdate(draft.id, payload)
        : await api.homeAccessUpsert(payload)
      setWidgets((prev) => {
        const rest = prev.filter((w) => w.id !== widget.id)
        return [...rest, widget]
      })
      setEditorOpen(false)
      setDraft(emptyDraft())
      setError('')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function remove(id: string) {
    if (!confirm('Delete this control?')) return
    try {
      await api.homeAccessDelete(id)
      setWidgets((prev) => prev.filter((w) => w.id !== id))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className="hb-access h-full flex flex-col min-h-0">
      <div className="hb-chrome shrink-0">
        <div className="hb-chrome-inner hb-access-chrome">
          <button type="button" className="hb-btn hb-btn-ghost text-sm" onClick={onHome}>
            ← Home
          </button>
          <div className="min-w-0 flex-1">
            <h1 className="hb-access-title truncate">Access</h1>
            <p className="text-mute text-xs truncate">House controls · durable on the server</p>
          </div>
          <button
            type="button"
            className="hb-btn hb-btn-primary hb-access-add"
            onClick={() => {
              setDraft(emptyDraft())
              setEditorOpen(true)
            }}
            aria-label="Add control"
            title="Add control"
          >
            +
          </button>
        </div>
      </div>

      <div className="hb-access-body flex-1 min-h-0 relative">
        <div className="hb-access-panel h-full overflow-y-auto">
          {error && <p className="hb-page pt-3 text-sm text-danger">{error}</p>}
          {!sorted.length && !error && (
            <div className="hb-access-empty">
              <p className="text-mute text-sm">
                No controls yet. Tap <strong>+</strong> to add a button, toggle, slider, or gauge —
                or ask Chat (bottom-right) to wire one with <code>homebase_access_*</code>.
              </p>
            </div>
          )}
          <div className="hb-access-grid">
            {sorted.map((w, i) => {
              const busy = busyId === w.id
              const prevGroup = i > 0 ? sorted[i - 1]?.group || '' : null
              const showGroup = w.group && w.group !== prevGroup
              return (
                <div key={w.id} className="contents">
                {showGroup ? <div className="hb-access-group">{w.group}</div> : null}
                <div className="hb-access-tile" data-kind={w.kind}>
                  <div className="hb-access-tile-head">
                    <span className="hb-access-tile-label">{w.label}</span>
                    <span className="hb-access-tile-kind">{w.kind}</span>
                  </div>
                  {w.description ? (
                    <p className="hb-access-tile-desc">{w.description}</p>
                  ) : null}

                  {w.kind === 'button' && (
                    <button
                      type="button"
                      className="hb-btn hb-btn-primary w-full"
                      disabled={busy}
                      onClick={() => void invoke(w.id)}
                    >
                      {busy ? 'Running…' : 'Run'}
                    </button>
                  )}

                  {w.kind === 'toggle' && (
                    <label className="hb-access-toggle">
                      <input
                        type="checkbox"
                        checked={!!w.value}
                        disabled={busy}
                        onChange={(e) => void invoke(w.id, e.target.checked)}
                      />
                      <span>{w.value ? 'On' : 'Off'}</span>
                    </label>
                  )}

                  {w.kind === 'slider' && (
                    <div className="hb-access-slider">
                      <input
                        type="range"
                        min={w.min ?? 0}
                        max={w.max ?? 100}
                        step={w.step ?? 1}
                        value={Number(w.value) || 0}
                        disabled={busy}
                        onChange={(e) => {
                          const v = Number(e.target.value)
                          setWidgets((prev) =>
                            prev.map((x) => (x.id === w.id ? { ...x, value: v } : x)),
                          )
                        }}
                        onPointerUp={(e) => {
                          const v = Number((e.target as HTMLInputElement).value)
                          void invoke(w.id, v)
                        }}
                      />
                      <span className="hb-access-slider-val">
                        {Number(w.value) || 0}
                        {w.unit ? ` ${w.unit}` : ''}
                      </span>
                    </div>
                  )}

                  {w.kind === 'gauge' && (
                    <button
                      type="button"
                      className="hb-access-gauge-btn"
                      disabled={busy}
                      onClick={() => void invoke(w.id)}
                      title="Refresh gauge"
                    >
                      <GaugeFace
                        value={Number(w.value) || 0}
                        min={w.min ?? 0}
                        max={w.max ?? 100}
                        unit={w.unit}
                      />
                      {w.detail ? (
                        <p className="hb-access-tile-detail">{w.detail}</p>
                      ) : null}
                    </button>
                  )}

                  {w.lastResult && (
                    <p
                      className={`hb-access-result ${w.lastResult.ok ? 'text-ok' : 'text-danger'}`}
                      title={w.lastResult.stdout || w.lastResult.error || ''}
                    >
                      {w.lastResult.ok
                        ? w.lastResult.stdout?.trim()?.slice(0, 80) || 'ok'
                        : w.lastResult.error || 'failed'}
                    </p>
                  )}

                  <div className="hb-access-tile-actions">
                    <button
                      type="button"
                      className="hb-btn hb-btn-ghost text-xs"
                      onClick={() => {
                        setDraft(draftFromWidget(w))
                        setEditorOpen(true)
                      }}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className="hb-btn hb-btn-ghost text-xs text-danger"
                      onClick={() => void remove(w.id)}
                    >
                      Delete
                    </button>
                  </div>
                </div>
                </div>
              )
            })}
          </div>
        </div>

        <ChatPanel
          projects={projects}
          selectedId={selectedId}
          onSelect={onSelect}
          variant="dock"
          dockOpen={dockOpen}
          onDockOpenChange={setDockOpen}
        />
      </div>

      {editorOpen && (
        <div className="hb-access-scrim" role="presentation" onClick={() => setEditorOpen(false)}>
          <div
            className="hb-access-editor"
            role="dialog"
            aria-label="Add control"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-base font-medium mb-2">{draft.id ? 'Edit control' : 'Add control'}</h2>
            <label className="hb-access-field">
              <span>Kind</span>
              <select
                className="hb-select w-full"
                value={draft.kind}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, kind: e.target.value as AccessWidgetKind }))
                }
              >
                {KINDS.map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="hb-access-field">
              <span>Label</span>
              <input
                className="w-full rounded-[var(--radius-control)] bg-panel-2 border border-line px-3 py-2.5 text-text"
                value={draft.label}
                onChange={(e) => setDraft((d) => ({ ...d, label: e.target.value }))}
                placeholder="Living room lights"
              />
            </label>
            <label className="hb-access-field">
              <span>Description</span>
              <input
                className="w-full rounded-[var(--radius-control)] bg-panel-2 border border-line px-3 py-2.5 text-text"
                value={draft.description}
                onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
              />
            </label>
            <label className="hb-access-field">
              <span>Group</span>
              <input
                className="w-full rounded-[var(--radius-control)] bg-panel-2 border border-line px-3 py-2.5 text-text"
                value={draft.group}
                onChange={(e) => setDraft((d) => ({ ...d, group: e.target.value }))}
                placeholder="IoT · People · Network"
              />
            </label>
            {(draft.kind === 'slider' || draft.kind === 'gauge') && (
              <div className="hb-access-editor-row">
                <label className="hb-access-field">
                  <span>Min</span>
                  <input
                    className="w-full rounded-[var(--radius-control)] bg-panel-2 border border-line px-3 py-2.5 text-text"
                    value={draft.min}
                    onChange={(e) => setDraft((d) => ({ ...d, min: e.target.value }))}
                  />
                </label>
                <label className="hb-access-field">
                  <span>Max</span>
                  <input
                    className="w-full rounded-[var(--radius-control)] bg-panel-2 border border-line px-3 py-2.5 text-text"
                    value={draft.max}
                    onChange={(e) => setDraft((d) => ({ ...d, max: e.target.value }))}
                  />
                </label>
                <label className="hb-access-field">
                  <span>Unit</span>
                  <input
                    className="w-full rounded-[var(--radius-control)] bg-panel-2 border border-line px-3 py-2.5 text-text"
                    value={draft.unit}
                    onChange={(e) => setDraft((d) => ({ ...d, unit: e.target.value }))}
                  />
                </label>
              </div>
            )}
            <label className="hb-access-field">
              <span>Hook</span>
              <select
                className="hb-select w-full"
                value={draft.hookType}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, hookType: e.target.value as AccessHookType }))
                }
              >
                {HOOKS.map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.label}
                  </option>
                ))}
              </select>
            </label>
            {draft.hookType === 'script' && (
              <>
                <label className="hb-access-field">
                  <span>Command (bash) — use {'{{value}}'} / {'{{on}}'}</span>
                  <textarea
                    className="w-full rounded-[var(--radius-control)] bg-panel-2 border border-line px-3 py-2.5 text-text font-mono text-xs"
                    rows={3}
                    value={draft.command}
                    onChange={(e) => setDraft((d) => ({ ...d, command: e.target.value }))}
                    placeholder='curl -X POST http://127.0.0.1:8123/api/services/light/toggle -d "{}"'
                  />
                </label>
                <label className="hb-access-field">
                  <span>cwd (optional)</span>
                  <input
                    className="w-full rounded-[var(--radius-control)] bg-panel-2 border border-line px-3 py-2.5 text-text"
                    value={draft.cwd}
                    onChange={(e) => setDraft((d) => ({ ...d, cwd: e.target.value }))}
                  />
                </label>
              </>
            )}
            {draft.hookType === 'http' && (
              <>
                <label className="hb-access-field">
                  <span>URL</span>
                  <input
                    className="w-full rounded-[var(--radius-control)] bg-panel-2 border border-line px-3 py-2.5 text-text"
                    value={draft.url}
                    onChange={(e) => setDraft((d) => ({ ...d, url: e.target.value }))}
                    placeholder="http://127.0.0.1:8123/api/..."
                  />
                </label>
                <label className="hb-access-field">
                  <span>Method</span>
                  <input
                    className="w-full rounded-[var(--radius-control)] bg-panel-2 border border-line px-3 py-2.5 text-text"
                    value={draft.method}
                    onChange={(e) => setDraft((d) => ({ ...d, method: e.target.value }))}
                  />
                </label>
                <label className="hb-access-field">
                  <span>Body template</span>
                  <textarea
                    className="w-full rounded-[var(--radius-control)] bg-panel-2 border border-line px-3 py-2.5 text-text font-mono text-xs"
                    rows={2}
                    value={draft.bodyTemplate}
                    onChange={(e) => setDraft((d) => ({ ...d, bodyTemplate: e.target.value }))}
                  />
                </label>
              </>
            )}
            {draft.hookType === 'websocket' && (
              <>
                <label className="hb-access-field">
                  <span>WebSocket URL</span>
                  <input
                    className="w-full rounded-[var(--radius-control)] bg-panel-2 border border-line px-3 py-2.5 text-text"
                    value={draft.wsUrl}
                    onChange={(e) => setDraft((d) => ({ ...d, wsUrl: e.target.value }))}
                  />
                </label>
                <label className="hb-access-field">
                  <span>Message template</span>
                  <textarea
                    className="w-full rounded-[var(--radius-control)] bg-panel-2 border border-line px-3 py-2.5 text-text font-mono text-xs"
                    rows={2}
                    value={draft.wsMessage}
                    onChange={(e) => setDraft((d) => ({ ...d, wsMessage: e.target.value }))}
                  />
                </label>
              </>
            )}
            {draft.kind === 'gauge' && (
              <>
                <div className="hb-access-editor-row">
                  <label className="hb-access-field">
                    <span>valuePath</span>
                    <input
                      className="w-full rounded-[var(--radius-control)] bg-panel-2 border border-line px-3 py-2.5 text-text"
                      value={draft.valuePath}
                      onChange={(e) => setDraft((d) => ({ ...d, valuePath: e.target.value }))}
                      placeholder="up"
                    />
                  </label>
                  <label className="hb-access-field">
                    <span>detailPath</span>
                    <input
                      className="w-full rounded-[var(--radius-control)] bg-panel-2 border border-line px-3 py-2.5 text-text"
                      value={draft.detailPath}
                      onChange={(e) => setDraft((d) => ({ ...d, detailPath: e.target.value }))}
                      placeholder="detail"
                    />
                  </label>
                  <label className="hb-access-field">
                    <span>pollMs</span>
                    <input
                      className="w-full rounded-[var(--radius-control)] bg-panel-2 border border-line px-3 py-2.5 text-text"
                      value={draft.pollMs}
                      onChange={(e) => setDraft((d) => ({ ...d, pollMs: e.target.value }))}
                      placeholder="15000"
                    />
                  </label>
                </div>
              </>
            )}
            <div className="hb-access-editor-actions">
              <button type="button" className="hb-btn hb-btn-ghost" onClick={() => setEditorOpen(false)}>
                Cancel
              </button>
              <button type="button" className="hb-btn hb-btn-primary" onClick={() => void saveDraft()}>
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
