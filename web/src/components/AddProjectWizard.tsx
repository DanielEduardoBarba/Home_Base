'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../lib/api'
import { setPendingCompose } from '../lib/uiPrefs'
import { useAccessibleDialog } from '../lib/useAccessibleDialog'

export type AddProjectResult = {
  projectId: string
  askAi: boolean
  path: string
  name: string
  openGit?: boolean
}

type Props = {
  open: boolean
  onClose: () => void
  onAdded: (result: AddProjectResult) => void
}

function basenamePath(path: string): string {
  const parts = path.replace(/\/+$/, '').split('/').filter(Boolean)
  return parts[parts.length - 1] || ''
}

function wirePrompt(name: string, path: string): string {
  return [
    `I just added my own project "${name}" to Home Base as a blank app (no Run/Ship actions yet).`,
    `Path: ${path}`,
    '',
    'Please inspect the repo and wire it cleanly into Home Base:',
    '1. Detect how to run / build / ship (package.json, build.sh, compose, Makefile, etc.).',
    '2. Propose ports + actions (Run, Stop, Ship when relevant) with homebase_project_upsert — keep this project id and path; only fill ports/actions/stateDir.',
    '3. Prefer patterns from existing presets when they fit; do not delete project files.',
    '4. Summarize what you configured and how to Start it from Apps.',
  ].join('\n')
}

type FolderMode = 'create' | 'existing' | 'github'

type GhRepo = {
  name: string
  nameWithOwner: string
  url: string
  isPrivate: boolean
  defaultBranch: string
  description: string
}

export function AddProjectWizard({ open, onClose, onAdded }: Props) {
  const [step, setStep] = useState(0)
  const [folderMode, setFolderMode] = useState<FolderMode>('create')
  const [name, setName] = useState('')
  const [nameTouched, setNameTouched] = useState(false)
  const [path, setPath] = useState('')
  const [folderName, setFolderName] = useState('')
  const [preset, setPreset] = useState('')
  const [askAi, setAskAi] = useState(true)
  const [presets, setPresets] = useState<{ id: string; name: string }[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [ghUser, setGhUser] = useState<string | null>(null)
  const [ghHint, setGhHint] = useState('')
  const [ghRepos, setGhRepos] = useState<GhRepo[]>([])
  const [ghSearch, setGhSearch] = useState('')
  const [ghRepo, setGhRepo] = useState('')
  const [ghBranch, setGhBranch] = useState('')
  const pathRef = useRef<HTMLInputElement>(null)
  const nameRef = useRef<HTMLInputElement>(null)
  const { ref: panelRef, dialogProps } = useAccessibleDialog<HTMLDivElement>({
    open,
    onClose,
    labelledBy: 'hb-add-app-title',
    focusKey: step,
  })

  const selectablePresets = useMemo(
    () => presets.filter((p) => p.id !== 'homebase'),
    [presets],
  )

  useEffect(() => {
    if (!open) return
    setStep(0)
    setFolderMode('create')
    setName('')
    setNameTouched(false)
    setPath('')
    setFolderName('')
    setPreset('')
    setAskAi(true)
    setError('')
    setBusy(false)
    setGhUser(null)
    setGhHint('')
    setGhRepos([])
    setGhSearch('')
    setGhRepo('')
    setGhBranch('')
    void api
      .presets()
      .then((r) => setPresets(r.presets))
      .catch(() => setPresets([]))
  }, [open])

  useEffect(() => {
    if (!open || folderMode !== 'github') return
    let cancelled = false
    void (async () => {
      try {
        const st = await api.githubStatus()
        if (cancelled) return
        const loggedIn = st.data?.loggedIn === true
        setGhUser(loggedIn ? st.data?.user || null : null)
        setGhHint(
          loggedIn
            ? ''
            : st.data?.hint ||
                'Sign in to GitHub on this laptop: gh auth login -h github.com',
        )
        if (loggedIn) {
          const list = await api.githubRepos({ limit: 40 })
          if (!cancelled) setGhRepos(list.repos || [])
        } else {
          setGhRepos([])
        }
      } catch (e) {
        if (!cancelled) {
          setGhHint(e instanceof Error ? e.message : String(e))
          setGhRepos([])
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open, folderMode])


  /** Keep focused fields above the soft keyboard inside the vv panel. */
  useEffect(() => {
    if (!open) return
    const onFocusIn = (e: FocusEvent) => {
      const t = e.target
      if (!(t instanceof HTMLElement)) return
      if (t.tagName !== 'INPUT' && t.tagName !== 'TEXTAREA') return
      window.setTimeout(() => {
        t.scrollIntoView({ block: 'center', behavior: 'smooth' })
        panelRef.current?.scrollTo({
          top: Math.max(0, (panelRef.current.scrollTop || 0) - 8),
        })
      }, 120)
    }
    document.addEventListener('focusin', onFocusIn)
    return () => document.removeEventListener('focusin', onFocusIn)
  }, [open])

  if (!open) return null

  const pathOk = path.trim().startsWith('/')
  const folderNameOk = /^[A-Za-z0-9._-]+$/.test(folderName.trim()) && !folderName.trim().startsWith('.')
  const nameOk = Boolean(name.trim())
  const ghRepoOk = Boolean(ghRepo.trim())
  const ghNameOk =
    /^[A-Za-z0-9._-]+$/.test(folderName.trim()) && !folderName.trim().startsWith('.')
  const step0Ok =
    folderMode === 'existing'
      ? pathOk && nameOk
      : folderMode === 'github'
        ? ghRepoOk && ghNameOk
        : pathOk && folderNameOk && nameOk

  async function goNextFromFolder() {
    if (!step0Ok || busy) return
    setBusy(true)
    setError('')
    try {
      if (folderMode === 'github') {
        if (!nameTouched) setName(folderName.trim())
        setStep(1)
        return
      }
      const stat = await api.hostStat(path.trim())
      if (!stat.exists || !stat.isDirectory) {
        setError(stat.error || 'Parent folder not found — use an existing directory.')
        return
      }
      setPath(stat.path || path.trim())
      if (folderMode === 'create' && !nameTouched) {
        setName(folderName.trim())
      }
      setStep(1)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  const modeLabel = preset
    ? selectablePresets.find((p) => p.id === preset)?.name || preset
    : 'Own project (blank)'

  function onPathChange(next: string) {
    setPath(next)
    if (!nameTouched) {
      const base = basenamePath(next.trim())
      setName(base)
    }
  }

  async function submit() {
    setBusy(true)
    setError('')
    try {
      if (folderMode === 'github') {
        const label = name.trim() || folderName.trim()
        const r = await api.cloneGithubWorkspace({
          repo: ghRepo.trim(),
          workspaceName: folderName.trim(),
          branch: ghBranch.trim() || undefined,
        })
        const abs = r.project.path
        const wantAi = askAi && !preset
        if (wantAi) {
          setPendingCompose({
            projectId: r.project.id,
            text: wirePrompt(label, abs),
            autoSend: true,
            title: 'Wire app',
          })
        }
        onAdded({
          projectId: r.project.id,
          askAi: wantAi,
          path: abs,
          name: label,
          openGit: true,
        })
        onClose()
        return
      }
      const label = name.trim() || (folderMode === 'create' ? folderName.trim() : basenamePath(path.trim()))
      const r =
        folderMode === 'create'
          ? await api.createWorkspace({
              parentPath: path.trim(),
              folderName: folderName.trim(),
              displayName: label,
            })
          : await api.upsertProject({
              path: path.trim(),
              name: label,
              preset: preset || undefined,
            })
      const abs =
        folderMode === 'create'
          ? r.project.path
          : path.trim()
      const wantAi = askAi && !preset
      if (wantAi) {
        setPendingCompose({
          projectId: r.project.id,
          text: wirePrompt(label, abs),
          autoSend: true,
          title: 'Wire app',
        })
      }
      onAdded({
        projectId: r.project.id,
        askAi: wantAi,
        path: abs,
        name: label,
      })
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="hb-vv-overlay hb-overlay backdrop-blur-sm"
      role="presentation"
      onClick={onClose}
    >
      <div
        ref={panelRef}
        className="hb-vv-overlay-panel hb-surface p-5 space-y-4 hb-enter shadow-xl"
        {...dialogProps}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-2">
          <h2 id="hb-add-app-title" className="font-display text-xl font-extrabold tracking-tight">
            New workspace
          </h2>
          <button type="button" className="hb-btn hb-btn-ghost !min-h-9 text-sm" data-dialog-cancel onClick={onClose}>
            Close
          </button>
        </div>

        <div className="flex gap-1.5" aria-hidden>
          {[0, 1].map((i) => (
            <span
              key={i}
              className={`h-1 flex-1 rounded-full ${i <= step ? 'bg-accent' : 'bg-line'}`}
            />
          ))}
        </div>

        {step === 0 && (
          <div className="space-y-3">
            <div className="flex gap-1 p-1 rounded-[var(--radius-control)] bg-panel-2 border border-line">
              <button
                type="button"
                className={`flex-1 rounded-md px-1.5 py-2 text-xs sm:text-sm font-medium ${
                  folderMode === 'create' ? 'bg-accent text-white' : 'text-mute'
                }`}
                onClick={() => setFolderMode('create')}
              >
                Create folder
              </button>
              <button
                type="button"
                className={`flex-1 rounded-md px-1.5 py-2 text-xs sm:text-sm font-medium ${
                  folderMode === 'existing' ? 'bg-accent text-white' : 'text-mute'
                }`}
                onClick={() => setFolderMode('existing')}
              >
                Existing
              </button>
              <button
                type="button"
                className={`flex-1 rounded-md px-1.5 py-2 text-xs sm:text-sm font-medium ${
                  folderMode === 'github' ? 'bg-accent text-white' : 'text-mute'
                }`}
                onClick={() => setFolderMode('github')}
              >
                From GitHub
              </button>
            </div>

            {folderMode === 'github' ? (
              <div className="space-y-3">
                {ghHint ? (
                  <p className="text-sm text-danger leading-snug" role="alert">
                    {ghHint}
                  </p>
                ) : ghUser ? (
                  <p className="text-xs text-mute">Signed in as {ghUser}</p>
                ) : null}
                <div className="space-y-1.5">
                  <label htmlFor="hb-gh-search" className="hb-label">
                    Filter repos
                  </label>
                  <input
                    id="hb-gh-search"
                    data-dialog-initial
                    className="w-full rounded-[var(--radius-control)] bg-panel-2 border border-line px-3 py-3 text-sm"
                    placeholder="Search…"
                    value={ghSearch}
                    onChange={(e) => setGhSearch(e.target.value)}
                  />
                </div>
                <div className="max-h-40 overflow-y-auto rounded-[var(--radius-control)] border border-line divide-y divide-line">
                  {ghRepos
                    .filter((r) => {
                      const q = ghSearch.trim().toLowerCase()
                      if (!q) return true
                      return (
                        r.nameWithOwner.toLowerCase().includes(q) ||
                        (r.description || '').toLowerCase().includes(q)
                      )
                    })
                    .map((r) => (
                      <button
                        key={r.nameWithOwner}
                        type="button"
                        className={`w-full text-left px-3 py-2 text-sm ${
                          ghRepo === r.nameWithOwner
                            ? 'bg-accent/10 text-text'
                            : 'bg-panel-2 text-text'
                        }`}
                        onClick={() => {
                          setGhRepo(r.nameWithOwner)
                          setGhBranch(r.defaultBranch || '')
                          if (!folderName.trim()) {
                            setFolderName(r.name)
                            if (!nameTouched) setName(r.name)
                          }
                        }}
                      >
                        <span className="font-medium">{r.nameWithOwner}</span>
                        <span className="block text-xs text-mute">
                          {r.isPrivate ? 'Private' : 'Public'} · {r.defaultBranch}
                        </span>
                      </button>
                    ))}
                  {ghRepos.length === 0 && !ghHint ? (
                    <p className="px-3 py-2 text-xs text-mute">No repos listed.</p>
                  ) : null}
                </div>
                <div className="space-y-1.5">
                  <label htmlFor="hb-gh-repo" className="hb-label">
                    Repo (owner/repo or URL)
                  </label>
                  <input
                    id="hb-gh-repo"
                    className="w-full rounded-[var(--radius-control)] bg-panel-2 border border-line px-3 py-3 text-sm font-mono"
                    placeholder="owner/repo"
                    value={ghRepo}
                    onChange={(e) => setGhRepo(e.target.value)}
                    autoCapitalize="off"
                    spellCheck={false}
                  />
                </div>
                <div className="space-y-1.5">
                  <label htmlFor="hb-gh-branch" className="hb-label">
                    Branch (optional)
                  </label>
                  <input
                    id="hb-gh-branch"
                    className="w-full rounded-[var(--radius-control)] bg-panel-2 border border-line px-3 py-3 text-sm font-mono"
                    placeholder="default branch"
                    value={ghBranch}
                    onChange={(e) => setGhBranch(e.target.value)}
                    autoCapitalize="off"
                    spellCheck={false}
                  />
                </div>
                <div className="space-y-1.5">
                  <label htmlFor="hb-gh-folder" className="hb-label">
                    Workspace name
                  </label>
                  <p className="text-xs text-mute">
                    Clones into ~/MCP_WORKSPACES/&lt;name&gt; and opens the Git panel.
                  </p>
                  <input
                    id="hb-gh-folder"
                    className="w-full rounded-[var(--radius-control)] bg-panel-2 border border-line px-3 py-3 text-sm font-mono"
                    placeholder="my-app"
                    value={folderName}
                    onChange={(e) => {
                      setFolderName(e.target.value)
                      if (!nameTouched) setName(e.target.value)
                    }}
                    autoCapitalize="off"
                    spellCheck={false}
                  />
                </div>
                <div className="space-y-1.5">
                  <label htmlFor="hb-add-name" className="hb-label">
                    Display name
                  </label>
                  <input
                    id="hb-add-name"
                    ref={nameRef}
                    className="w-full rounded-[var(--radius-control)] bg-panel-2 border border-line px-3 py-3 text-sm"
                    placeholder="My App"
                    value={name}
                    onChange={(e) => {
                      setNameTouched(true)
                      setName(e.target.value)
                    }}
                  />
                </div>
              </div>
            ) : (
              <>
                <div className="space-y-1.5">
                  <label htmlFor="hb-add-path" className="hb-label">
                    {folderMode === 'create' ? 'Parent folder' : 'Project folder'}
                  </label>
                  <p className="text-sm text-mute">
                    {folderMode === 'create'
                      ? 'Absolute path where the new workspace folder will be created.'
                      : 'Absolute path on this computer — your own repo, not a copy.'}
                  </p>
                  <input
                    id="hb-add-path"
                    ref={pathRef}
                    data-dialog-initial
                    className="w-full rounded-[var(--radius-control)] bg-panel-2 border border-line px-3 py-3 text-sm font-mono"
                    placeholder={
                      folderMode === 'create'
                        ? '/home/you/APP_PROJECTS/GENERAL'
                        : '/home/you/projects/my-app'
                    }
                    value={path}
                    onChange={(e) => onPathChange(e.target.value)}
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                    enterKeyHint="next"
                    inputMode="text"
                    autoComplete="off"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && pathOk) {
                        e.preventDefault()
                        nameRef.current?.focus()
                      }
                    }}
                  />
                </div>
                {folderMode === 'create' ? (
                  <div className="space-y-1.5">
                    <label htmlFor="hb-add-folder-name" className="hb-label">
                      Folder name
                    </label>
                    <input
                      id="hb-add-folder-name"
                      className="w-full rounded-[var(--radius-control)] bg-panel-2 border border-line px-3 py-3 text-sm font-mono"
                      placeholder="my-app"
                      value={folderName}
                      onChange={(e) => {
                        setFolderName(e.target.value)
                        if (!nameTouched) setName(e.target.value)
                      }}
                      autoCapitalize="off"
                      autoCorrect="off"
                      spellCheck={false}
                    />
                  </div>
                ) : null}
                <div className="space-y-1.5">
                  <label htmlFor="hb-add-name" className="hb-label">
                    Display name
                  </label>
                  <input
                    id="hb-add-name"
                    ref={nameRef}
                    className="w-full rounded-[var(--radius-control)] bg-panel-2 border border-line px-3 py-3 text-sm"
                    placeholder="My App"
                    value={name}
                    onChange={(e) => {
                      setNameTouched(true)
                      setName(e.target.value)
                    }}
                    enterKeyHint="done"
                    autoComplete="off"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && step0Ok) {
                        e.preventDefault()
                        void goNextFromFolder()
                      }
                    }}
                  />
                </div>
              </>
            )}
            {error && <p className="text-danger text-sm">{error}</p>}
            <button
              type="button"
              className="hb-btn hb-btn-primary w-full !min-h-11"
              disabled={!step0Ok || busy}
              onClick={() => void goNextFromFolder()}
            >
              {busy
                ? folderMode === 'github'
                  ? '…'
                  : 'Checking folder…'
                : 'Continue'}
            </button>
          </div>
        )}

        {step === 1 && (
          <div className="space-y-3">
            <div className="space-y-1">
              <p className="hb-label mb-0">How to integrate</p>
              <p className="text-sm text-mute">
                Own projects start blank. Chat can detect Run/Ship for you, or pick a template.
              </p>
            </div>

            <div className="space-y-2">
              <button
                type="button"
                className={`w-full text-left rounded-[var(--radius-control)] border px-3 py-3 ${
                  !preset ? 'border-accent bg-accent/10' : 'border-line bg-panel-2'
                }`}
                onClick={() => {
                  setPreset('')
                  setAskAi(true)
                }}
              >
                <span className="block text-sm font-medium">Own project</span>
                <span className="block text-xs text-mute mt-0.5 leading-relaxed">
                  Keep your folder as-is. Add Run/Ship later — or let Chat wire them now.
                </span>
              </button>
              {selectablePresets.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={`w-full text-left rounded-[var(--radius-control)] border px-3 py-3 ${
                    preset === p.id ? 'border-accent bg-accent/10' : 'border-line bg-panel-2'
                  }`}
                  onClick={() => {
                    setPreset(p.id)
                    setAskAi(false)
                  }}
                >
                  <span className="block text-sm font-medium">{p.name}</span>
                  <span className="block text-xs text-mute mt-0.5">
                    Template ports &amp; actions
                  </span>
                </button>
              ))}
            </div>

            {!preset && (
              <label className="flex items-start gap-2.5 rounded-[var(--radius-control)] border border-line bg-panel-2 px-3 py-3 cursor-pointer">
                <input
                  type="checkbox"
                  className="mt-1 accent-[var(--hb-accent)]"
                  checked={askAi}
                  onChange={(e) => setAskAi(e.target.checked)}
                />
                <span>
                  <span className="block text-sm font-medium">Ask Chat to wire it</span>
                  <span className="block text-xs text-mute mt-0.5 leading-relaxed">
                    Opens Work chat after add and has the agent inspect the repo, then upsert
                    ports and actions.
                  </span>
                </span>
              </label>
            )}

            <div className="rounded-[var(--radius-control)] border border-line bg-panel-2 p-3 text-sm space-y-1">
              <p>
                <span className="text-mute">Name</span> · {name.trim()}
              </p>
              {folderMode === 'github' ? (
                <>
                  <p className="font-mono text-xs break-all">
                    <span className="text-mute font-sans">Repo</span> · {ghRepo.trim()}
                  </p>
                  <p className="font-mono text-xs break-all">
                    <span className="text-mute font-sans">Workspace</span> ·{' '}
                    ~/MCP_WORKSPACES/{folderName.trim()}
                  </p>
                </>
              ) : (
                <p className="font-mono text-xs break-all">
                  <span className="text-mute font-sans">Path</span> · {path.trim()}
                </p>
              )}
              <p>
                <span className="text-mute">Integrate</span> · {modeLabel}
                {!preset && askAi ? ' + Chat' : ''}
              </p>
            </div>

            {error && <p className="text-danger text-sm">{error}</p>}

            <div className="flex gap-2">
              <button
                type="button"
                className="hb-btn hb-btn-ghost flex-1 !min-h-11"
                disabled={busy}
                onClick={() => {
                  setError('')
                  setStep(0)
                }}
              >
                Back
              </button>
              <button
                type="button"
                className="hb-btn hb-btn-primary flex-1 !min-h-11"
                disabled={
                  busy ||
                  (folderMode === 'github'
                    ? !ghRepoOk || !ghNameOk
                    : !pathOk || !nameOk)
                }
                onClick={() => void submit()}
              >
                {busy
                  ? '…'
                  : folderMode === 'github'
                    ? askAi && !preset
                      ? 'Clone & open Chat'
                      : 'Clone workspace'
                    : folderMode === 'create'
                      ? askAi && !preset
                        ? 'Create & open Chat'
                        : 'Create workspace'
                      : askAi && !preset
                        ? 'Add & open Chat'
                        : 'Add app'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
