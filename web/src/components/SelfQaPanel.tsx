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

type TestersChoice = number | 'any'

type Draft = {
  goal: string
  cycles: number
  maxMinutes: number
  testers: TestersChoice
  dryRun: boolean
}

function draftKey(projectId: string) {
  return `hb_selfqa_draft:${projectId}`
}

function loadDraft(projectId: string): Draft | null {
  if (typeof window === 'undefined' || !projectId) return null
  try {
    const raw = localStorage.getItem(draftKey(projectId))
    if (!raw) return null
    const o = JSON.parse(raw) as Partial<Draft>
    const testers: TestersChoice =
      o.testers === 'any'
        ? 'any'
        : typeof o.testers === 'number' && o.testers >= 1 && o.testers <= 6
          ? Math.floor(o.testers)
          : 3
    return {
      goal: typeof o.goal === 'string' ? o.goal : '',
      cycles:
        typeof o.cycles === 'number' && o.cycles >= 1 && o.cycles <= 20
          ? Math.floor(o.cycles)
          : 3,
      maxMinutes:
        typeof o.maxMinutes === 'number' && o.maxMinutes >= 1 && o.maxMinutes <= 1440
          ? Math.floor(o.maxMinutes)
          : 90,
      testers,
      dryRun: Boolean(o.dryRun),
    }
  } catch {
    return null
  }
}

function saveDraft(projectId: string, draft: Draft) {
  if (typeof window === 'undefined' || !projectId) return
  try {
    localStorage.setItem(draftKey(projectId), JSON.stringify(draft))
  } catch {
    /* ignore quota */
  }
}

function clearDraft(projectId: string) {
  if (typeof window === 'undefined' || !projectId) return
  try {
    localStorage.removeItem(draftKey(projectId))
  } catch {
    /* ignore */
  }
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
  const [testers, setTesters] = useState<TestersChoice>(3)
  const [dryRun, setDryRun] = useState(false)
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState('')
  const [error, setError] = useState('')
  const [branch, setBranch] = useState<string | null>(null)
  const [branchError, setBranchError] = useState('')
  const [draftReady, setDraftReady] = useState(false)

  // Hydrate draft once per project
  useEffect(() => {
    const d = loadDraft(projectId)
    if (d) {
      setGoal(d.goal)
      setCycles(d.cycles)
      setMaxMinutes(d.maxMinutes)
      setTesters(d.testers)
      setDryRun(d.dryRun)
    } else {
      setGoal('')
      setCycles(3)
      setMaxMinutes(90)
      setTesters(3)
      setDryRun(false)
    }
    setDraftReady(true)
  }, [projectId])

  // Persist draft until successful submit
  useEffect(() => {
    if (!draftReady || !projectId) return
    saveDraft(projectId, { goal, cycles, maxMinutes, testers, dryRun })
  }, [projectId, goal, cycles, maxMinutes, testers, dryRun, draftReady])

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

  const loadBranch = useCallback(async () => {
    if (!projectId) return
    try {
      const g = await api.gitStatus(projectId)
      const b = String((g as { branch?: string }).branch || '').trim()
      setBranch(b || null)
      if (!b || b === 'HEAD') {
        setBranchError('Detached HEAD — check out a named branch (not main).')
      } else if (b === 'main' || b === 'master') {
        setBranchError(`Self-QA refuses branch '${b}'. Switch to any other branch.`)
      } else {
        setBranchError('')
      }
    } catch (e) {
      setBranch(null)
      setBranchError(e instanceof Error ? e.message : String(e))
    }
  }, [projectId])

  useSceneRefresh(() => {
    void load()
    void loadBranch()
  })

  useEffect(() => {
    void load()
    void loadBranch()
  }, [load, loadBranch])

  // Poll live output while a sprint is running
  useEffect(() => {
    if (!status?.active || status.active.status !== 'running') return
    const t = setInterval(() => void load(), 2500)
    return () => clearInterval(t)
  }, [status?.active, load])

  const running = Boolean(status?.active && status.active.status === 'running')
  const unsupported = status && !status.supported.ok
  const blockedBranch = Boolean(branchError)

  async function start() {
    if (blockedBranch) {
      setError(branchError)
      return
    }
    const name = branch || 'current branch'
    if (
      !window.confirm(
        `Run Self-QA on branch "${name}"?\n\nCommits and pushes stay on this branch (never main).`,
      )
    ) {
      return
    }
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
      clearDraft(projectId)
      if (sessionId) onOpenShell?.(sessionId)
      await load()
      await onRefresh?.()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy('')
    }
  }

  async function cancel() {
    setBusy('Cancel')
    setMsg('')
    setError('')
    try {
      await api.selfqaStop(projectId)
      setMsg('Self-QA cancelled')
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
            Any branch except main.
          </p>
          {branch && (
            <p className="text-[11px] text-mute mt-1">
              Current branch:{' '}
              <span className={blockedBranch ? 'text-warn' : 'text-fg'}>{branch}</span>
            </p>
          )}
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
              <select
                value={testers === 'any' ? 'any' : String(testers)}
                disabled={!!busy || running}
                onChange={(e) => {
                  const v = e.target.value
                  setTesters(v === 'any' ? 'any' : Math.min(6, Math.max(1, Number(v) || 1)))
                }}
                className="w-full rounded-[var(--radius-control)] bg-panel-2 border border-line px-3 py-2 text-sm !min-h-10"
              >
                <option value="any">Any (AI picks)</option>
                {[1, 2, 3, 4, 5, 6].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
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

          {branchError && (
            <p className="text-xs text-warn leading-relaxed">{branchError}</p>
          )}

          <div className="flex gap-2">
            {running ? (
              <HoldButton
                label={busy ? '…' : 'Cancel'}
                holdLabel="Hold…"
                holdMs={1000}
                tone="danger"
                disabled={!!busy}
                className="!min-h-10 !px-4 text-sm"
                onConfirm={() => void cancel()}
              />
            ) : (
              <button
                type="button"
                disabled={!!busy || blockedBranch}
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
