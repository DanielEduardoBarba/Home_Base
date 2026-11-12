'use client'

import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/api'
import { useSceneRefresh } from '../lib/sceneRefresh'
import type { Project } from '../lib/types'
import { AccessibleDialog } from './AccessibleDialog'

type GitFile = { path: string; index: string; worktree: string; status: string }
type GitCommit = {
  hash: string
  short: string
  subject: string
  author: string
  date: string
}
type GitStatus = {
  branch: string
  ahead: number
  behind: number
  dirty: boolean
  files: GitFile[]
  commits: GitCommit[]
  remotes: string[]
}

export function GitTab({
  projects,
  selectedId,
  embedded = false,
}: {
  projects: Project[]
  selectedId: string
  onSelect?: (id: string) => void
  embedded?: boolean
}) {
  const project = projects.find((p) => p.id === selectedId) || projects[0]
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [branches, setBranches] = useState<{
    local: string[]
    remote: string[]
    current: string
  } | null>(null)
  const [error, setError] = useState('')
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState('')
  const [switchTo, setSwitchTo] = useState('')
  const [newBranch, setNewBranch] = useState('')
  const [newBase, setNewBase] = useState('')
  const [mergeFrom, setMergeFrom] = useState('')
  const [commitMsg, setCommitMsg] = useState('')
  const [mergeOpen, setMergeOpen] = useState(false)

  const load = useCallback(async () => {
    if (!project) return
    try {
      const [s, b] = await Promise.all([
        api.gitStatus(project.id),
        api.gitBranches(project.id),
      ])
      setStatus(s)
      setBranches(b)
      setSwitchTo(b.current || s.branch || '')
      setError('')
    } catch (e) {
      setStatus(null)
      setBranches(null)
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [project])

  useSceneRefresh(load)

  useEffect(() => {
    void load()
  }, [load])

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key)
    setMsg('')
    setError('')
    try {
      await fn()
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy('')
    }
  }

  if (!project) {
    return (
      <div className="p-4 text-sm text-mute">
        Select a project to use Git.
      </div>
    )
  }

  const branchOptions = [
    ...new Set([
      ...(branches?.local || []),
      ...(branches?.remote || []).map((r) =>
        r.includes('/') ? r.split('/').slice(1).join('/') : r,
      ),
    ]),
  ].filter(Boolean)

  return (
    <div className={`h-full overflow-y-auto ${embedded ? 'p-3' : 'p-4'} space-y-3`}>
      {!embedded ? (
        <h1 className="text-sm font-semibold text-text">Git · {project.name}</h1>
      ) : null}

      {error ? (
        <p className="text-sm text-danger leading-snug" role="alert">
          {error}
        </p>
      ) : null}
      {msg ? <p className="text-sm text-ok leading-snug">{msg}</p> : null}

      <section className="hb-surface p-3.5 space-y-2">
        <div className="flex flex-wrap items-center gap-2 justify-between">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-text truncate">
              {status?.branch || '—'}
            </p>
            <p className="text-xs text-mute">
              {status
                ? `${status.ahead} ahead · ${status.behind} behind${
                    status.dirty ? ' · uncommitted changes' : ' · clean'
                  }`
                : 'Loading…'}
            </p>
          </div>
          <button
            type="button"
            className="hb-btn hb-btn-ghost text-xs !min-h-9"
            disabled={Boolean(busy)}
            onClick={() =>
              void run('refresh', async () => {
                await load()
                setMsg('Status refreshed')
              })
            }
          >
            Refresh status
          </button>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="hb-btn text-xs !min-h-9"
            disabled={Boolean(busy)}
            onClick={() =>
              void run('fetch', async () => {
                await api.gitAction(project.id, { action: 'fetch' })
                setMsg('Fetch complete')
              })
            }
          >
            Fetch
          </button>
          <button
            type="button"
            className="hb-btn text-xs !min-h-9"
            disabled={Boolean(busy)}
            onClick={() =>
              void run('pull', async () => {
                await api.gitAction(project.id, { action: 'pull' })
                setMsg('Pull complete')
              })
            }
          >
            Pull
          </button>
          <button
            type="button"
            className="hb-btn text-xs !min-h-9"
            disabled={Boolean(busy)}
            onClick={() =>
              void run('push', async () => {
                await api.gitAction(project.id, { action: 'push' })
                setMsg('Push complete')
              })
            }
          >
            Push
          </button>
          <button
            type="button"
            className="hb-btn hb-btn-ghost text-xs !min-h-9"
            disabled={Boolean(busy)}
            onClick={() =>
              void run('stash', async () => {
                await api.gitAction(project.id, { action: 'stash', mode: 'push' })
                setMsg('Stashed changes')
              })
            }
          >
            Stash
          </button>
          <button
            type="button"
            className="hb-btn hb-btn-ghost text-xs !min-h-9"
            disabled={Boolean(busy)}
            onClick={() =>
              void run('pop', async () => {
                await api.gitAction(project.id, { action: 'stash', mode: 'pop' })
                setMsg('Stash popped')
              })
            }
          >
            Pop
          </button>
        </div>
      </section>

      <section className="hb-surface p-3.5 space-y-2.5">
        <h2 className="text-sm font-semibold text-text">Switch branch</h2>
        <div className="flex flex-wrap gap-2">
          <select
            className="flex-1 min-w-[10rem] rounded-[var(--radius-control)] bg-panel-2 border border-line px-3 py-2 text-sm"
            value={switchTo}
            onChange={(e) => setSwitchTo(e.target.value)}
          >
            {branchOptions.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="hb-btn text-xs !min-h-9"
            disabled={Boolean(busy) || !switchTo || switchTo === status?.branch}
            onClick={() =>
              void run('checkout', async () => {
                await api.gitAction(project.id, {
                  action: 'checkout',
                  branch: switchTo,
                })
                setMsg(`Switched to ${switchTo}`)
              })
            }
          >
            Switch
          </button>
        </div>
      </section>

      <section className="hb-surface p-3.5 space-y-2.5">
        <h2 className="text-sm font-semibold text-text">New branch</h2>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            className="flex-1 rounded-[var(--radius-control)] bg-panel-2 border border-line px-3 py-2 text-sm"
            placeholder="Branch name"
            value={newBranch}
            onChange={(e) => setNewBranch(e.target.value)}
          />
          <input
            className="flex-1 rounded-[var(--radius-control)] bg-panel-2 border border-line px-3 py-2 text-sm"
            placeholder="Base (optional)"
            value={newBase}
            onChange={(e) => setNewBase(e.target.value)}
          />
          <button
            type="button"
            className="hb-btn text-xs !min-h-9 shrink-0"
            disabled={Boolean(busy) || !newBranch.trim()}
            onClick={() =>
              void run('create', async () => {
                await api.gitAction(project.id, {
                  action: 'create_branch',
                  name: newBranch.trim(),
                  base: newBase.trim() || undefined,
                })
                setMsg(`Created ${newBranch.trim()}`)
                setNewBranch('')
              })
            }
          >
            Create
          </button>
        </div>
      </section>

      <section className="hb-surface p-3.5 space-y-2.5">
        <h2 className="text-sm font-semibold text-text">Merge into current</h2>
        <div className="flex flex-wrap gap-2">
          <select
            className="flex-1 min-w-[10rem] rounded-[var(--radius-control)] bg-panel-2 border border-line px-3 py-2 text-sm"
            value={mergeFrom}
            onChange={(e) => setMergeFrom(e.target.value)}
          >
            <option value="">Select source…</option>
            {branchOptions
              .filter((b) => b !== status?.branch)
              .map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
          </select>
          <button
            type="button"
            className="hb-btn text-xs !min-h-9"
            disabled={Boolean(busy) || !mergeFrom}
            onClick={() => setMergeOpen(true)}
          >
            Merge…
          </button>
        </div>
      </section>

      <section className="hb-surface p-3.5 space-y-2.5">
        <h2 className="text-sm font-semibold text-text">Commit</h2>
        <textarea
          className="w-full rounded-[var(--radius-control)] bg-panel-2 border border-line px-3 py-2 text-sm min-h-[4.5rem]"
          placeholder="Commit message"
          value={commitMsg}
          onChange={(e) => setCommitMsg(e.target.value)}
        />
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="hb-btn hb-btn-ghost text-xs !min-h-9"
            disabled={Boolean(busy)}
            onClick={() =>
              void run('stage', async () => {
                await api.gitAction(project.id, { action: 'stage' })
                setMsg('Staged all changes')
              })
            }
          >
            Stage all
          </button>
          <button
            type="button"
            className="hb-btn text-xs !min-h-9"
            disabled={Boolean(busy) || !commitMsg.trim()}
            onClick={() =>
              void run('commit', async () => {
                await api.gitAction(project.id, {
                  action: 'commit',
                  message: commitMsg.trim(),
                  stageAll: true,
                })
                setMsg('Committed')
                setCommitMsg('')
              })
            }
          >
            Commit
          </button>
        </div>
      </section>

      <section className="hb-surface p-3.5 space-y-2">
        <h2 className="text-sm font-semibold text-text">Changed files</h2>
        {(status?.files || []).length === 0 ? (
          <p className="text-xs text-mute">No changes.</p>
        ) : (
          <ul className="space-y-1 max-h-40 overflow-y-auto">
            {status!.files.map((f) => (
              <li
                key={f.path}
                className="text-xs font-mono text-text flex gap-2"
              >
                <span className="text-mute w-6 shrink-0">{f.status}</span>
                <span className="truncate">{f.path}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="hb-surface p-3.5 space-y-2">
        <h2 className="text-sm font-semibold text-text">Recent commits</h2>
        {(status?.commits || []).length === 0 ? (
          <p className="text-xs text-mute">No commits.</p>
        ) : (
          <ul className="space-y-1.5 max-h-48 overflow-y-auto">
            {status!.commits.map((c) => (
              <li key={c.hash} className="text-xs leading-snug">
                <span className="font-mono text-mute">{c.short}</span>{' '}
                <span className="text-text">{c.subject}</span>
                <span className="block text-mute">
                  {c.author} · {c.date}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <AccessibleDialog
        open={mergeOpen}
        onClose={() => setMergeOpen(false)}
        title="Confirm merge"
        confirm
      >
        <p className="text-sm text-text leading-relaxed">
          Merge <strong className="font-semibold">{mergeFrom}</strong> into{' '}
          <strong className="font-semibold">{status?.branch || 'current'}</strong>?
          Conflicts abort automatically.
        </p>
        <div className="flex gap-2 justify-end">
          <button
            type="button"
            className="hb-btn hb-btn-ghost text-xs !min-h-9"
            data-dialog-cancel
            onClick={() => setMergeOpen(false)}
          >
            Cancel
          </button>
          <button
            type="button"
            className="hb-btn text-xs !min-h-9"
            data-dialog-confirm
            onClick={() => {
              const source = mergeFrom
              const target = status?.branch || 'current'
              setMergeOpen(false)
              void run('merge', async () => {
                await api.gitAction(project.id, {
                  action: 'merge',
                  branch: source,
                  abortOnConflict: true,
                })
                setMsg(`Merged ${source} into ${target}`)
              })
            }}
          >
            Merge
          </button>
        </div>
      </AccessibleDialog>
    </div>
  )
}
