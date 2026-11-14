'use client'

import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/api'
import { useSceneRefresh } from '../lib/sceneRefresh'
import { HoldButton } from './HoldButton'

type SelfQaStatus = {
  supported: { ok: boolean; message?: string }
  active: Record<string, unknown> | null
  latest: Record<string, unknown> | null
  latestSummaryPath?: string
  latestSummaryTail?: string
  latestReportPath?: string
  sessionOutput?: string
}

export function SelfQaPanel({
  projectId,
  onOpenShell,
  onRefresh,
}: {
  projectId: string
  onOpenShell?: (sessionId: string) => void
  onRefresh?: () => void | Promise<void>
}) {
  const [status, setStatus] = useState<SelfQaStatus | null>(null)
  const [goal, setGoal] = useState('')
  const [cycles, setCycles] = useState(3)
  const [maxMinutes, setMaxMinutes] = useState(90)
  const [testers, setTesters] = useState(3)
  const [dryRun, setDryRun] = useState(false)
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState('')
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    if (!projectId) return
    try {
      const s = await api.selfqaStatus(projectId)
      setStatus(s)
      setError('')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [projectId])

  useSceneRefresh(load)

  useEffect(() => {
    void load()
  }, [load])

  // Poll live output while a sprint is running
  useEffect(() => {
    if (!status?.active || status.active.status !== 'running') return
    const t = setInterval(() => void load(), 2500)
    return () => clearInterval(t)
  }, [status?.active, load])

  const running = Boolean(status?.active && status.active.status === 'running')
  const unsupported = status && !status.supported.ok

  async function start() {
    setBusy('Start')
    setMsg('')
    setError('')
    try {
      const res = await api.selfqaStart(projectId, {
        goal: goal.trim() || undefined,
        cycles,
        maxMinutes,
        testers,
        dryRun,
      })
      const sessionId = (res.selfqa as { sessionId?: string } | undefined)?.sessionId
      setMsg(dryRun ? 'Dry-run started' : 'Self-QA started')
      if (sessionId) onOpenShell?.(sessionId)
      await load()
      await onRefresh?.()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy('')
    }
  }

  async function stop() {
    setBusy('Stop')
    setMsg('')
    setError('')
    try {
      await api.selfqaStop(projectId)
      setMsg('Self-QA stopped')
      await load()
      await onRefresh?.()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy('')
    }
  }

  return (
    <section className="hb-surface p-3.5 sm:p-4 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="hb-label mb-0">Self-QA sprint</h2>
          <p className="text-[11px] text-mute mt-1 leading-relaxed">
            Cyclic Dev + QA via Cursor agent CLI (model auto). One sprint per project.
          </p>
        </div>
        {running && (
          <span className="hb-apps-run-pill shrink-0" data-running="1">
            Running
          </span>
        )}
      </div>

      {unsupported && (
        <p className="text-sm text-warn leading-relaxed">
          {status?.supported.message ||
            'This project does not support --selfqa yet.'}
        </p>
      )}

      {!unsupported && (
        <>
          <label className="block space-y-1">
            <span className="hb-label">Goal</span>
            <textarea
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              disabled={!!busy || running}
              rows={3}
              placeholder="What should this sprint prove or fix?"
              className="w-full rounded-[var(--radius-control)] bg-panel-2 border border-line px-3 py-2 text-sm min-h-[4.5rem] resize-y"
            />
          </label>

          <div className="grid grid-cols-3 gap-2">
            <label className="block space-y-1">
              <span className="hb-label">Cycles</span>
              <input
                type="number"
                min={1}
                max={20}
                value={cycles}
                disabled={!!busy || running}
                onChange={(e) => setCycles(Number(e.target.value) || 1)}
                className="w-full rounded-[var(--radius-control)] bg-panel-2 border border-line px-3 py-2 text-sm !min-h-10"
              />
            </label>
            <label className="block space-y-1">
              <span className="hb-label">Minutes</span>
              <input
                type="number"
                min={1}
                max={1440}
                value={maxMinutes}
                disabled={!!busy || running}
                onChange={(e) => setMaxMinutes(Number(e.target.value) || 1)}
                className="w-full rounded-[var(--radius-control)] bg-panel-2 border border-line px-3 py-2 text-sm !min-h-10"
              />
            </label>
            <label className="block space-y-1">
              <span className="hb-label">Testers</span>
              <input
                type="number"
                min={1}
                max={6}
                value={testers}
                disabled={!!busy || running}
                onChange={(e) => setTesters(Number(e.target.value) || 1)}
                className="w-full rounded-[var(--radius-control)] bg-panel-2 border border-line px-3 py-2 text-sm !min-h-10"
              />
            </label>
          </div>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={dryRun}
              disabled={!!busy || running}
              onChange={(e) => setDryRun(e.target.checked)}
            />
            <span>Dry-run (print plan only)</span>
          </label>

          <div className="flex gap-2">
            {running ? (
              <HoldButton
                label={busy ? '…' : 'Stop'}
                holdLabel="Hold…"
                holdMs={1000}
                tone="danger"
                disabled={!!busy}
                className="!min-h-10 !px-4 text-sm"
                onConfirm={() => void stop()}
              />
            ) : (
              <button
                type="button"
                disabled={!!busy}
                onClick={() => void start()}
                className="hb-btn hb-btn-primary !min-h-10 !px-4 text-sm"
              >
                {busy ? '…' : 'Start'}
              </button>
            )}
            {running && status?.active && (
              <button
                type="button"
                className="hb-btn hb-btn-ghost !min-h-10 !px-3 text-sm"
                onClick={() => {
                  const sid = String(status.active?.sessionId || '')
                  if (sid) onOpenShell?.(sid)
                }}
              >
                Open session
              </button>
            )}
          </div>
        </>
      )}

      {(status?.latestReportPath || status?.latestSummaryPath) && (
        <div className="text-[11px] text-mute space-y-1 border-t border-line/60 pt-2">
          {status.latestReportPath && (
            <p>
              Latest cycle report:{' '}
              <span className="text-fg break-all">{status.latestReportPath}</span>
            </p>
          )}
          {status.latestSummaryPath && (
            <p>
              SUMMARY:{' '}
              <span className="text-fg break-all">{status.latestSummaryPath}</span>
            </p>
          )}
        </div>
      )}

      {status?.sessionOutput && (
        <pre className="hb-surface !p-2 text-[10px] leading-snug max-h-48 overflow-auto whitespace-pre-wrap break-words text-mute border border-line/50">
          {status.sessionOutput.slice(-8000)}
        </pre>
      )}

      {(busy || msg || error) && (
        <p className={`text-xs px-0.5 ${error ? 'text-danger' : 'text-mute'}`}>
          {error || (busy ? `Working… ${busy}` : msg)}
        </p>
      )}
    </section>
  )
}
