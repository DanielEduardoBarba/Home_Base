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

/** Ancestors from `/` down to `path` (inclusive), for tree expansion. */
function ancestorDirs(path: string): string[] {
  const abs = toAbs(path)
  if (abs === '/') return ['/']
  const parts = abs.split('/').filter(Boolean)
  const out = ['/']
  let acc = ''
  for (const p of parts) {
    acc += '/' + p
    out.push(acc)
  }
  return out
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

function TreeRows({
  dirPath,
  depth,
  childrenByDir,
  expanded,
  filter,
  filePath,
  onToggleDir,
  onOpenFile,
}: {
  dirPath: string
  depth: number
  childrenByDir: Record<string, FsEntry[]>
  expanded: Set<string>
  filter: string
  filePath: string | null
  onToggleDir: (path: string) => void
  onOpenFile: (path: string) => void
}) {
  const entries = filterEntries(childrenByDir[dirPath] || [], filter)
  return (
    <>
      {entries.map((e) => {
        const open = expanded.has(e.path)
        const active = filePath === e.path
        return (
          <li key={e.path}>
            <button
              type="button"
              className={`w-full text-left flex items-center gap-1 pr-2 py-1.5 border-b border-line/40 ${
                active
                  ? 'bg-accent/12 text-accent border-l-2 border-l-accent'
                  : 'hover:bg-panel-2 border-l-2 border-l-transparent'
              }`}
              style={{ paddingLeft: `${0.5 + depth * 0.75}rem` }}
              onClick={() => (e.type === 'dir' ? onToggleDir(e.path) : onOpenFile(e.path))}
              title={e.path}
            >
              <span
                className={`inline-flex w-4 shrink-0 text-[10px] font-mono ${
                  e.type === 'dir' ? 'text-sky' : 'text-mute'
                }`}
              >
                {e.type === 'dir' ? (open ? '▾' : '▸') : '·'}
              </span>
              <span
                className={`truncate text-[13px] font-medium ${e.ignored ? 'text-mute italic' : ''}`}
              >
                {e.name}
              </span>
            </button>
            {e.type === 'dir' && open && (
              <ul>
                <TreeRows
                  dirPath={e.path}
                  depth={depth + 1}
                  childrenByDir={childrenByDir}
                  expanded={expanded}
                  filter={filter}
                  filePath={filePath}
                  onToggleDir={onToggleDir}
                  onOpenFile={onOpenFile}
                />
              </ul>
            )}
          </li>
        )
      })}
    </>
  )
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
}: {
  projects: Project[]
  selectedId: string
  onSelect: (id: string) => void
}) {
  const project = projects.find((p) => p.id === selectedId) || projects[0]
  const projectRoot = project ? toAbs(project.path) : '/'
  const [dir, setDir] = useState('/')
  const [entries, setEntries] = useState<FsEntry[]>([])
  const [childrenByDir, setChildrenByDir] = useState<Record<string, FsEntry[]>>({})
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['/']))
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

  const fetchDir = useCallback(
    async (path: string) => {
      if (!project) return [] as FsEntry[]
      const abs = toAbs(path)
      const data = await api.fsList(project.id, abs, { all: showAll })
      const list = data.entries
      setChildrenByDir((prev) => ({ ...prev, [abs]: list }))
      return list
    },
    [project?.id, showAll],
  )

  const loadDir = useCallback(
    async (path: string, opts?: { keepFile?: boolean }) => {
      if (!project) return
      const abs = toAbs(path)
      setError('')
      try {
        const list = await fetchDir(abs)
        setDir(abs)
        setEntries(list)
        setFilter('')
        if (!opts?.keepFile) {
          setFilePath(null)
          setContent('')
          setSavedContent('')
          setDirty(false)
          setStatus(abs)
        }
        const chain = ancestorDirs(abs)
        setExpanded((prev) => {
          const next = new Set(prev)
          for (const p of chain) next.add(p)
          return next
        })
        // Prefetch ancestors so the tree can expand from Linux `/`
        for (const p of chain) {
          void fetchDir(p)
        }
        setNavOpen(true)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      }
    },
    [project?.id, fetchDir],
  )

  useEffect(() => {
    setFilePath(null)
    setContent('')
    setSavedContent('')
    setDirty(false)
    setDir(projectRoot)
    setEntries([])
    setChildrenByDir({})
    setExpanded(new Set(['/']))
    setNavOpen(true)
    setConfirm(null)
    setStatus(projectRoot)
    // Open at the project path; path bar can walk up to `/`
    void loadDir(projectRoot)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id, showAll])

  async function toggleDir(path: string) {
    const abs = toAbs(path)
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(abs)) next.delete(abs)
      else next.add(abs)
      return next
    })
    setDir(abs)
    try {
      if (!childrenByDir[abs]) {
        const list = await fetchDir(abs)
        setEntries(list)
      } else {
        setEntries(childrenByDir[abs])
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

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
      setExpanded((prev) => {
        const next = new Set(prev)
        for (const p of ancestorDirs(parent)) next.add(p)
        return next
      })
      for (const p of ancestorDirs(parent)) void fetchDir(p)
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
    // Already at this folder with no file open — nothing to do
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
  const mobileFiltered = useMemo(() => filterEntries(entries, filter), [entries, filter])
  const editing = !!filePath && !navOpen
  const fileName = filePath?.split('/').filter(Boolean).pop() || filePath || ''

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

  return (
    <div className="h-full flex flex-col min-h-0 pb-[5.5rem]">
      {/* Always-visible explorer chrome */}
      <div className="hb-chrome shrink-0">
        <div className="px-3 pt-3 pb-2 space-y-2 max-w-6xl mx-auto w-full md:max-w-none md:mx-0">
          <div className="flex flex-wrap gap-2 items-center md:hidden">
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
            <button
              type="button"
              className="hb-btn hb-btn-ghost !min-h-10 px-3 text-xs"
              onClick={() => setNavOpen((v) => !v)}
            >
              {navOpen ? (filePath ? 'Open editor' : 'Browse') : '← Files'}
            </button>
          </div>

          {explorerBar}

          <div className="flex items-center justify-between gap-2">
            <p className="text-[11px] font-mono text-mute truncate min-w-0">
              {status || project.name}
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
              className="md:hidden hb-btn hb-btn-ghost text-xs px-2.5 py-1.5 shrink-0 disabled:opacity-30"
              onClick={() => goToFolder(parentDir(dir))}
              disabled={toAbs(dir) === '/'}
              title="Up one folder"
            >
              ↑ Up
            </button>
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter…"
              className="flex-1 min-w-0 rounded-lg bg-panel-2 border border-line px-2.5 py-1.5 text-xs outline-none focus:border-accent"
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

          <ul className="hidden md:block flex-1 overflow-y-auto text-sm min-h-0">
            {(childrenByDir['/'] || []).length === 0 && (
              <li className="px-3 py-6 text-mute text-xs text-center">Empty folder</li>
            )}
            <TreeRows
              dirPath="/"
              depth={0}
              childrenByDir={childrenByDir}
              expanded={expanded}
              filter={filter}
              filePath={filePath}
              onToggleDir={(p) => void toggleDir(p)}
              onOpenFile={(p) => void openFile(p)}
            />
          </ul>

          <ul className="md:hidden flex-1 overflow-y-auto text-sm min-h-0">
            {mobileFiltered.length === 0 && (
              <li className="px-3 py-6 text-mute text-xs text-center">Empty folder</li>
            )}
            {mobileFiltered.map((e) => (
              <li key={e.path}>
                <button
                  type="button"
                  className={`w-full text-left px-3 py-3.5 border-b border-line/40 active:bg-accent/10 ${
                    filePath === e.path
                      ? 'bg-accent/12 text-accent border-l-2 border-l-accent'
                      : 'hover:bg-panel-2'
                  }`}
                  onClick={() =>
                    e.type === 'dir' ? void loadDir(e.path) : void openFile(e.path)
                  }
                >
                  <span
                    className={`inline-flex items-center justify-center w-6 mr-2 text-[11px] font-mono ${
                      e.type === 'dir' ? 'text-sky' : 'text-mute'
                    }`}
                  >
                    {e.type === 'dir' ? '▸' : '·'}
                  </span>
                  <span className={`font-medium ${e.ignored ? 'text-mute italic' : ''}`}>
                    {e.name}
                  </span>
                </button>
              </li>
            ))}
          </ul>
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
                  Path bar walks the host from Linux <span className="font-mono">/</span>. Shortcuts
                  jump back to a workspace.
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
                  : 'Leave without saving?'}
            </h2>
            <p className="text-sm text-mute leading-relaxed">
              {confirm.type === 'save' && (
                <>
                  Write unsaved changes to{' '}
                  <span className="font-mono text-text break-all">{fileName}</span>?
                </>
              )}
              {confirm.type === 'revert' && (
                <>
                  Discard unsaved edits in{' '}
                  <span className="font-mono text-text break-all">{fileName}</span> and restore the
                  last saved version?
                </>
              )}
              {confirm.type === 'navigate' && (
                <>
                  You have unsaved changes in{' '}
                  <span className="font-mono text-text break-all">{fileName}</span>. Leave this
                  folder and discard them?
                </>
              )}
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                className="hb-btn hb-btn-ghost flex-1"
                disabled={busy}
                onClick={() => setConfirm(null)}
              >
                Cancel
              </button>
              {confirm.type === 'save' ? (
                <button
                  type="button"
                  className="hb-btn hb-btn-primary flex-1"
                  disabled={busy}
                  onClick={() => void doSave()}
                >
                  {busy ? 'Saving…' : 'Save'}
                </button>
              ) : confirm.type === 'revert' ? (
                <button
                  type="button"
                  className="hb-btn hb-btn-danger flex-1"
                  disabled={busy}
                  onClick={doRevert}
                >
                  Revert
                </button>
              ) : (
                <button
                  type="button"
                  className="hb-btn hb-btn-danger flex-1"
                  disabled={busy}
                  onClick={() => {
                    const path = confirm.path
                    setConfirm(null)
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
