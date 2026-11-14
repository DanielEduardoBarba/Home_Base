'use client'

import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/api'
import { useSceneRefresh } from '../lib/sceneRefresh'
import { HoldButton } from './HoldButton'

type JobRow = {
  id: string
  projectId: string
  chatId: string
  status: string
  prompt: string
  startedAt: number
  finishedAt?: number
  summary?: string
  error?: string
}

export function CursorJobsPanel({
  projectId,
  onRefresh,
}: {
  projectId: string
  onRefresh?: () => void | Promise<void>
}) {
  const [jobs, setJobs] = useState<JobRow[]>([])
  const [busyId, setBusyId] = useState('')
  const [error, setError] = useState('')
  const [msg, setMsg] = useState('')

  const load = useCallback(async () => {
    if (!projectId) return
    try {
      const res = await api.cursorJobs(projectId)
      setJobs(res.jobs || [])
      setError('')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [projectId])

  useSceneRefresh(load)

  useEffect(() => {
    void load()
  }, [load])

  const active = jobs.filter((j) => j.status === 'queued' || j.status === 'running')

  useEffect(() => {
    if (!active.length) return
    const t = setInterval(() => void load(), 3000)
    return () => clearInterval(t)
  }, [active.length, load])

  async function cancel(jobId: string) {
    setBusyId(jobId)
    setMsg('')
    setError('')
    try {
      await api.cancelCursorJob(projectId, jobId)
      setMsg(`Cancelled job ${jobId}`)
      await load()
      await onRefresh?.()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusyId('')
    }
  }

  if (!active.length && !msg && !error) return null

  return (
    <section className="hb-surface p-3.5 sm:p-4 space-y-3">
      <div>
        <h2 className="hb-label mb-0">Cursor jobs</h2>
        <p className="text-[11px] text-mute mt-1 leading-relaxed">
          MCP / handoff jobs for this project. Cancel kills the agent run and releases the lock.
        </p>
      </div>

      {active.length === 0 ? (
        <p className="text-xs text-mute">No running jobs.</p>
      ) : (
        <ul className="space-y-2">
          {active.map((j) => (
            <li
              key={j.id}
              className="flex items-start justify-between gap-2 border border-line/60 rounded-[var(--radius-control)] p-2.5"
            >
              <div className="min-w-0 space-y-1">
                <div className="flex items-center gap-2 text-xs">
                  <span className="hb-apps-run-pill" data-running="1">
                    {j.status}
                  </span>
                  <span className="font-mono text-mute truncate">{j.id}</span>
                </div>
                <p className="text-sm text-fg line-clamp-2 break-words">
                  {j.prompt || '(no prompt)'}
                </p>
              </div>
              <HoldButton
                label={busyId === j.id ? '…' : 'Cancel'}
                holdLabel="Hold…"
                holdMs={1000}
                tone="danger"
                disabled={!!busyId}
                className="!min-h-9 !px-3 text-xs shrink-0"
                onConfirm={() => void cancel(j.id)}
              />
            </li>
          ))}
        </ul>
      )}

      {(msg || error) && (
        <p className={`text-xs ${error ? 'text-danger' : 'text-mute'}`}>{error || msg}</p>
      )}
    </section>
  )
}
