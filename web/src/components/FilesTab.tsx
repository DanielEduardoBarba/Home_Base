import { css } from '@codemirror/lang-css'
import { html } from '@codemirror/lang-html'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { python } from '@codemirror/lang-python'
import { oneDark } from '@codemirror/theme-one-dark'
import CodeMirror from '@uiw/react-codemirror'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../lib/api'
import { useSceneRefresh } from '../lib/sceneRefresh'
import type { FsEntry, Project } from '../lib/types'

function langExt(language: string) {
  switch (language) {
    case 'python':
      return [python()]
    case 'javascript':
      return [javascript({ jsx: true })]
    case 'jsx':
      return [javascript({ jsx: true })]
    case 'typescript':
      return [javascript({ typescript: true })]
    case 'tsx':
      return [javascript({ jsx: true, typescript: true })]
    case 'json':
      return [json()]
    case 'markdown':
      return [markdown()]
    case 'html':
      return [html()]
    case 'css':
      return [css()]
    default:
      return []
  }
}

/** Normalize to a host-absolute POSIX path (`/` …). */
function toAbs(path: string): string {
  const raw = (path || '').trim()
  if (!raw || raw === '.' || raw === '/') return '/'
  const parts = raw.split('/').filter(Boolean)
  return '/' + parts.join('/')
}

/** Parent directory; `/` is its own parent. */
function parentDir(path: string): string {
  const abs = toAbs(path)
  if (abs === '/') return '/'
  const parts = abs.split('/').filter(Boolean)
  parts.pop()
  return parts.length ? '/' + parts.join('/') : '/'
}

/** Leaf name for a path (`/` → `/`). */
function leafName(path: string): string {
  const abs = toAbs(path)
  if (abs === '/') return '/'
  return abs.split('/').filter(Boolean).pop() || abs
}

/** Full explorer trail from Linux `/` through folders (and optional file leaf). */
function explorerTrail(
  dirPath: string,
  filePath: string | null,
): { label: string; path: string; kind: 'root' | 'dir' | 'file' }[] {
  const folderPath = toAbs(filePath ? parentDir(filePath) : dirPath)
  const parts = folderPath === '/' ? [] : folderPath.split('/').filter(Boolean)
  const out: { label: string; path: string; kind: 'root' | 'dir' | 'file' }[] = [
    { label: '/', path: '/', kind: 'root' },
  ]
  let acc = ''
  for (const p of parts) {
    acc += '/' + p
    out.push({ label: p, path: acc, kind: 'dir' })
  }
  if (filePath) {
    const absFile = toAbs(filePath)
    const name = absFile.split('/').filter(Boolean).pop() || absFile
    out.push({ label: name, path: absFile, kind: 'file' })
  }
  return out
}

function filterEntries(entries: FsEntry[], q: string): FsEntry[] {
  if (!q) return entries
  const needle = q.toLowerCase()
  return entries.filter((e) => e.name.toLowerCase().includes(needle))
}

type ConfirmKind =
  | { type: 'save' }
  | { type: 'revert' }
  | { type: 'navigate'; path: string }
  | null

export function FilesTab({
  projects,
  selectedId,
  onSelect,
  embedded = false,
  focusPath = null,
  onFocusPathConsumed,
}: {
  projects: Project[]
  selectedId: string
  onSelect: (id: string) => void
  /** When true (Work tab), hide mobile project picker. */
  embedded?: boolean
  /** Open this path (file or folder) once, then call onFocusPathConsumed. */
  focusPath?: string | null
  onFocusPathConsumed?: () => void
}) {
  const project = projects.find((p) => p.id === selectedId) || projects[0]
  const projectRoot = project ? toAbs(project.path) : '/'
  const [dir, setDir] = useState('/')
  const [entries, setEntries] = useState<FsEntry[]>([])
  const [filePath, setFilePath] = useState<string | null>(null)
  const [content, setContent] = useState('')
  const [savedContent, setSavedContent] = useState('')
  const [language, setLanguage] = useState('plaintext')
  const [dirty, setDirty] = useState(false)
  const [status, setStatus] = useState('')
  const [navOpen, setNavOpen] = useState(true)
  const [error, setError] = useState('')
  const [filter, setFilter] = useState('')
  const [showAll, setShowAll] = useState(false)
  const [confirm, setConfirm] = useState<ConfirmKind>(null)
  const [busy, setBusy] = useState(false)

  const loadDir = useCallback(
    async (path: string, opts?: { keepFile?: boolean }) => {
      if (!project) return
      const abs = toAbs(path)
      setError('')
      try {
        const data = await api.fsList(project.id, abs, { all: showAll })
        setDir(abs)
        setEntries(data.entries)
        setFilter('')
        if (!opts?.keepFile) {
          setFilePath(null)
          setContent('')
          setSavedContent('')
          setDirty(false)
          setStatus(abs)
        }
        setNavOpen(true)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      }
    },
    [project?.id, showAll],
  )

  const refreshScene = useCallback(async () => {
    if (!project) return
    await loadDir(dir || projectRoot, { keepFile: true })
    if (filePath && !dirty) {
      try {
        const data = await api.fsRead(project.id, filePath)
        setContent(data.content)
        setSavedContent(data.content)
        setDirty(false)
      } catch {
        /* keep editor buffer if read fails */
      }
    }
  }, [project, dir, filePath, dirty, loadDir, projectRoot])

  useSceneRefresh(refreshScene)

  useEffect(() => {
    setFilePath(null)
    setContent('')
    setSavedContent('')
    setDirty(false)
    setDir(projectRoot)
    setEntries([])
    setNavOpen(true)
    setConfirm(null)
    setStatus(projectRoot)
    void loadDir(projectRoot)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id, showAll])

  // Chat / Work can ask us to open a path
  useEffect(() => {
    if (!focusPath || !project) return
    const raw = focusPath.trim()
    const abs = raw.startsWith('/') ? toAbs(raw) : toAbs(`${project.path}/${raw}`)
    let cancelled = false
    ;(async () => {
      try {
        // Prefer file open; if that fails, open as directory
        const data = await api.fsRead(project.id, abs)
        if (cancelled) return
        const opened = toAbs(data.path)
        setFilePath(opened)
        setContent(data.content)
        setSavedContent(data.content)
        setLanguage(data.language)
        setDirty(false)
        setStatus(`${opened} · ${data.size}b`)
        const parent = parentDir(opened)
        setDir(parent)
        const listed = await api.fsList(project.id, parent, { all: showAll })
        if (!cancelled) setEntries(listed.entries)
        if (window.innerWidth < 768) setNavOpen(false)
      } catch {
        if (cancelled) return
        try {
          await loadDir(abs)
        } catch {
          /* ignore */
        }
      } finally {
        if (!cancelled) onFocusPathConsumed?.()
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusPath, project?.id])

  async function openFile(path: string) {
    if (!project) return
    const abs = toAbs(path)
    setError('')
    try {
      const data = await api.fsRead(project.id, abs)
      const opened = toAbs(data.path)
      setFilePath(opened)
      setContent(data.content)
      setSavedContent(data.content)
      setLanguage(data.language)
      setDirty(false)
      setStatus(`${opened} · ${data.size}b`)
      const parent = parentDir(opened)
      setDir(parent)
      // Keep listing the folder that contains this file (path-bar perspective)
      if (toAbs(dir) !== parent) {
        const listed = await api.fsList(project.id, parent, { all: showAll })
        setEntries(listed.entries)
      }
      if (window.innerWidth < 768) setNavOpen(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function doSave() {
    if (!project || !filePath) return
    setBusy(true)
    setStatus('saving…')
    try {
      await api.fsWrite(project.id, filePath, content)
      setSavedContent(content)
      setDirty(false)
      setStatus(`saved ${filePath}`)
      setConfirm(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setStatus('save failed')
    } finally {
      setBusy(false)
    }
  }

  function doRevert() {
    setContent(savedContent)
    setDirty(false)
    setStatus(`reverted ${filePath}`)
    setConfirm(null)
  }

  function goToFolder(path: string) {
    const abs = toAbs(path)
    if (!filePath && toAbs(dir) === abs) return
    if (dirty) {
      setConfirm({ type: 'navigate', path: abs })
      return
    }
    void loadDir(abs)
  }

  function jumpToProject(p: Project) {
    onSelect(p.id)
  }

  const trail = useMemo(() => explorerTrail(dir, filePath), [dir, filePath])
  const folderEntries = useMemo(() => filterEntries(entries, filter), [entries, filter])
  const editing = !!filePath && !navOpen
  const hereLabel = leafName(dir)

  if (!project) {
    return <p className="hb-page text-mute text-sm">Add a workspace to browse files.</p>
  }

  const shortcuts = (
    <div className="space-y-1.5">
      <p className="text-[10px] uppercase tracking-[0.18em] text-mute font-semibold">Shortcuts</p>
      <div className="flex flex-col gap-0.5 max-h-40 overflow-y-auto">
        <button
          type="button"
          onClick={() => goToFolder('/')}
          className={`w-full text-left rounded-md px-2 py-1.5 text-[12px] font-semibold truncate ${
            toAbs(dir) === '/' && !filePath
              ? 'bg-sky/15 text-sky'
              : 'text-mute hover:text-text hover:bg-panel-2'
          }`}
          title="Linux root /"
        >
          / <span className="font-mono font-normal opacity-70">root</span>
        </button>
        {projects.map((p) => {
          const active = p.id === project.id
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => jumpToProject(p)}
              className={`w-full text-left rounded-md px-2 py-1.5 text-[12px] font-semibold truncate ${
                active
                  ? 'bg-accent/15 text-accent'
                  : 'text-mute hover:text-text hover:bg-panel-2'
              }`}
              title={p.path}
            >
              {p.name}
            </button>
          )
        })}
      </div>
    </div>
  )

  const explorerBar = (
    <div className="flex items-stretch gap-2 min-w-0">
      {editing && (
        <button
          type="button"
          className="shrink-0 rounded-lg border border-accent/40 bg-accent/10 text-accent px-2.5 text-xs font-semibold md:hidden"
          onClick={() => setNavOpen(true)}
        >
          ←
        </button>
      )}

      <nav
        className="flex-1 min-w-0 flex items-center gap-0.5 overflow-x-auto rounded-[var(--radius-control)] border border-line bg-panel-2/90 px-1.5 py-1 font-mono text-[12px]"
        aria-label="Path"
      >
        <span
          className="shrink-0 inline-flex items-center justify-center w-7 h-7 rounded-md text-sky"
          title="Filesystem"
          aria-hidden
        >
          <svg
            viewBox="0 0 24 24"
            className="w-4 h-4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M3.5 7.5h5l2 2h10v8.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 2.5 18V9a1.5 1.5 0 0 1 1-1.5z" />
          </svg>
        </span>

        {trail.map((c, i) => {
          const isLast = i === trail.length - 1
          const isFile = c.kind === 'file'
          const isProjectRoot = c.kind === 'dir' && toAbs(c.path) === projectRoot
          return (
            <span key={`${c.kind}:${c.path}`} className="flex items-center gap-0.5 shrink-0">
              {i > 0 && (
                <span className="text-mute/50 px-0.5 select-none" aria-hidden>
                  /
                </span>
              )}
              {isFile ? (
                <span
                  className={`rounded-md px-2 py-1.5 font-semibold truncate max-w-[10rem] sm:max-w-[16rem] ${
                    dirty ? 'text-amber' : 'text-text'
                  }`}
                  title={c.path}
                >
                  {c.label}
                  {dirty ? ' •' : ''}
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => goToFolder(c.path)}
                  title={c.path}
                  className={`rounded-md px-2 py-1.5 transition-colors ${
                    isLast && !filePath
                      ? 'bg-sky/15 text-sky font-semibold'
                      : isProjectRoot
                        ? 'text-accent hover:bg-accent/10'
                        : 'text-mute hover:text-text hover:bg-ink/50'
                  }`}
                >
                  {c.kind === 'root' ? (
                    <span className="font-semibold text-sky">/</span>
                  ) : isProjectRoot ? (
                    <span title={c.path}>
                      {c.label}
                      <span className="ml-1 hidden lg:inline text-[10px] opacity-70 font-sans">
                        ({project.name})
                      </span>
                    </span>
                  ) : (
                    c.label
                  )}
                </button>
              )}
            </span>
          )
        })}
      </nav>

      <div className="flex items-center gap-1.5 shrink-0">
        <button
          type="button"
          disabled={!filePath || !dirty || busy}
          onClick={() => setConfirm({ type: 'revert' })}
          className="hb-btn hb-btn-ghost !min-h-9 px-2.5 sm:px-3 text-xs disabled:opacity-35"
          title="Revert unsaved changes"
        >
          Revert
        </button>
        <button
          type="button"
          disabled={!filePath || !dirty || busy}
          onClick={() => setConfirm({ type: 'save' })}
          className="hb-btn hb-btn-primary !min-h-9 px-2.5 sm:px-3 text-xs disabled:opacity-35"
          title="Save file"
        >
          Save
        </button>
      </div>
    </div>
  )

  const folderList = (
    <ul className="flex-1 overflow-y-auto text-sm min-h-0">
      {folderEntries.length === 0 && (
        <li className="px-3 py-6 text-mute text-xs text-center">Empty folder</li>
      )}
      {folderEntries.map((e) => (
        <li key={e.path}>
          <button
            type="button"
            className={`w-full text-left px-3 py-2.5 md:py-2 border-b border-line/40 flex items-center gap-2 ${
              filePath === e.path
                ? 'bg-accent/12 text-accent border-l-2 border-l-accent'
                : 'hover:bg-panel-2 active:bg-accent/10 border-l-2 border-l-transparent'
            }`}
            onClick={() => (e.type === 'dir' ? goToFolder(e.path) : void openFile(e.path))}
            title={e.path}
          >
            <span
              className={`inline-flex w-5 shrink-0 justify-center text-[11px] font-mono ${
                e.type === 'dir' ? 'text-sky' : 'text-mute'
              }`}
            >
              {e.type === 'dir' ? '▸' : '·'}
            </span>
            <span className={`truncate font-medium ${e.ignored ? 'text-mute italic' : ''}`}>
              {e.name}
            </span>
          </button>
        </li>
      ))}
    </ul>
  )

  return (
    <div className={`h-full flex flex-col min-h-0 ${embedded ? '' : 'hb-with-nav'}`}>
      <div className="hb-chrome shrink-0">
        <div className="px-3 pt-3 pb-2 space-y-2 max-w-6xl mx-auto w-full md:max-w-none md:mx-0">
          <div className="flex flex-wrap gap-2 items-center md:hidden">
            {!embedded && (
              <select
                value={project.id}
                onChange={(e) => onSelect(e.target.value)}
                className="hb-select flex-1 min-w-0 !min-h-10 py-2 text-sm"
                aria-label="Project shortcut"
              >
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            )}
            <button
              type="button"
              className={`hb-btn hb-btn-ghost !min-h-10 px-3 text-xs ${embedded ? 'ml-auto' : ''}`}
              onClick={() => setNavOpen((v) => !v)}
            >
              {navOpen ? (filePath ? 'Open editor' : 'Browse') : '← Files'}
            </button>
          </div>

          {explorerBar}

          <div className="flex items-center justify-between gap-2">
            <p className="text-[11px] font-mono text-mute truncate min-w-0">
              <span className="text-sky/90">Home Base files</span>
              <span className="opacity-50"> · </span>
              {status || project.name}
              <span className="opacity-40"> — not Cursor’s open editor</span>
            </p>
            {error && <p className="text-danger text-xs shrink-0">{error}</p>}
          </div>
        </div>
      </div>

      <div className="flex-1 min-h-0 flex">
        <aside
          className={`${
            navOpen ? 'flex' : 'hidden'
          } md:flex w-full md:w-72 lg:w-[19rem] xl:w-80 shrink-0 flex-col border-r border-line bg-panel/35 min-h-0`}
        >
          <div className="hidden md:block shrink-0 px-3 py-2.5 border-b border-line">
            {shortcuts}
          </div>

          <div className="px-2 py-2 flex gap-2 border-b border-line items-center shrink-0">
            <button
              type="button"
              className="hb-btn hb-btn-ghost !px-2.5 !py-1.5 shrink-0 disabled:opacity-30"
              onClick={() => goToFolder(parentDir(dir))}
              disabled={toAbs(dir) === '/'}
              title="Back one folder"
              aria-label="Back one folder"
            >
              <svg viewBox="0 0 24 24" className="hb-files-back-icon" aria-hidden>
                <path
                  d="M15 6 9 12l6 6"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
            <div
              className="min-w-0 flex-1 truncate font-mono text-[11px] text-sky font-semibold px-1"
              title={dir}
            >
              {hereLabel}
            </div>
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter…"
              className="w-[5.5rem] sm:w-24 shrink-0 rounded-lg bg-panel-2 border border-line px-2 py-1.5 text-xs outline-none focus:border-accent"
            />
            <label
              className="shrink-0 flex items-center gap-1 text-[10px] font-mono text-mute cursor-pointer select-none"
              title="Include node_modules, .git, dist, etc."
            >
              <input
                type="checkbox"
                checked={showAll}
                onChange={(e) => setShowAll(e.target.checked)}
                className="accent-[var(--color-accent)]"
              />
              all
            </label>
          </div>

          {folderList}
        </aside>

        <div
          className={`${navOpen ? 'hidden' : 'flex'} md:flex flex-1 min-w-0 flex-col min-h-0`}
        >
          {filePath ? (
            <CodeMirror
              value={content}
              height="100%"
              theme={oneDark}
              extensions={langExt(language)}
              onChange={(v) => {
                setContent(v)
                setDirty(v !== savedContent)
              }}
              basicSetup={{
                lineNumbers: true,
                foldGutter: true,
                highlightActiveLine: true,
              }}
              className="flex-1 min-h-0 text-[13px] overflow-hidden [&_.cm-editor]:h-full [&_.cm-scroller]:h-full"
            />
          ) : (
            <div className="flex-1 flex items-center justify-center text-mute text-sm p-6 text-center">
              <div>
                <p className="text-text font-semibold mb-1">Select a file</p>
                <p className="text-xs max-w-xs mx-auto leading-relaxed">
                  Left nav lists only this folder. Use the path bar or ← to move around.
                </p>
              </div>
            </div>
          )}
        </div>
      </div>

      {confirm && (
        <div className="fixed inset-0 z-40 hb-overlay backdrop-blur-sm flex items-end sm:items-center justify-center p-4">
          <div className="w-full max-w-sm hb-surface p-4 sm:p-5 space-y-4 hb-enter">
            <h2 className="font-semibold text-sm">
              {confirm.type === 'save'
                ? 'Save this file?'
                : confirm.type === 'revert'
                  ? 'Revert changes?'
                  : 'Discard unsaved changes?'}
            </h2>
            <p className="text-xs text-mute leading-relaxed">
              {confirm.type === 'save'
                ? filePath
                : confirm.type === 'revert'
                  ? 'Unsaved edits will be lost.'
                  : 'You have unsaved edits. Continue without saving?'}
            </p>
            <div className="flex gap-2 justify-end">
              <button
                type="button"
                className="hb-btn hb-btn-ghost text-sm"
                onClick={() => setConfirm(null)}
              >
                Cancel
              </button>
              {confirm.type === 'save' ? (
                <button
                  type="button"
                  className="hb-btn hb-btn-primary text-sm"
                  disabled={busy}
                  onClick={() => void doSave()}
                >
                  Save
                </button>
              ) : confirm.type === 'revert' ? (
                <button type="button" className="hb-btn hb-btn-danger text-sm" onClick={doRevert}>
                  Revert
                </button>
              ) : (
                <button
                  type="button"
                  className="hb-btn hb-btn-danger text-sm"
                  onClick={() => {
                    const path = confirm.path
                    setConfirm(null)
                    setDirty(false)
                    void loadDir(path)
                  }}
                >
                  Discard
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
