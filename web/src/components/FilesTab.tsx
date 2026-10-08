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
import { ProjectSelect } from './ProjectSelect'

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

function crumbs(path: string): { label: string; path: string }[] {
  const parts = path.split('/').filter(Boolean)
  const out: { label: string; path: string }[] = [{ label: 'root', path: '' }]
  let acc = ''
  for (const p of parts) {
    acc = acc ? `${acc}/${p}` : p
    out.push({ label: p, path: acc })
  }
  return out
}

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
  const [dir, setDir] = useState('')
  const [entries, setEntries] = useState<FsEntry[]>([])
  const [filePath, setFilePath] = useState<string | null>(null)
  const [content, setContent] = useState('')
  const [language, setLanguage] = useState('plaintext')
  const [dirty, setDirty] = useState(false)
  const [status, setStatus] = useState('')
  const [navOpen, setNavOpen] = useState(true)
  const [error, setError] = useState('')
  const [filter, setFilter] = useState('')

  const loadDir = useCallback(
    async (path: string) => {
      if (!project) return
      setError('')
      try {
        const data = await api.fsList(project.id, path)
        setDir(data.path === '.' ? '' : data.path)
        setEntries(data.entries)
        setFilter('')
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      }
    },
    [project?.id],
  )

  useEffect(() => {
    setFilePath(null)
    setContent('')
    setDirty(false)
    setDir('')
    setNavOpen(true)
    loadDir('')
  }, [project?.id, loadDir])

  async function openFile(path: string) {
    if (!project) return
    setError('')
    try {
      const data = await api.fsRead(project.id, path)
      setFilePath(data.path)
      setContent(data.content)
      setLanguage(data.language)
      setDirty(false)
      setStatus(`${data.path} · ${data.size}b`)
      if (window.innerWidth < 768) setNavOpen(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function save() {
    if (!project || !filePath) return
    setStatus('saving…')
    try {
      await api.fsWrite(project.id, filePath, content)
      setDirty(false)
      setStatus(`saved ${filePath}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setStatus('save failed')
    }
  }

  function parentDir(path: string): string {
    if (!path || path === '.') return ''
    const parts = path.split('/').filter(Boolean)
    parts.pop()
    return parts.join('/')
  }

  const trail = useMemo(() => crumbs(dir), [dir])
  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return entries
    return entries.filter((e) => e.name.toLowerCase().includes(q))
  }, [entries, filter])

  if (!project) {
    return <p className="p-6 text-mute text-sm">Add a workspace to browse files.</p>
  }

  const editing = !!filePath && !navOpen

  return (
    <div className="h-full flex flex-col min-h-0 pb-16">
      <div className="shrink-0 px-3 pt-3 pb-2 border-b border-line bg-panel/80 backdrop-blur-md space-y-2 max-w-6xl mx-auto w-full">
        <div className="flex flex-wrap gap-2 items-center">
          <ProjectSelect projects={projects} selectedId={project.id} onSelect={onSelect} />
          <button
            type="button"
            className="md:hidden hb-btn hb-btn-ghost px-3 py-2 text-xs"
            onClick={() => setNavOpen((v) => !v)}
          >
            {navOpen ? (filePath ? 'Open editor' : 'Browse') : '← Files'}
          </button>
          {filePath && (
            <button
              type="button"
              disabled={!dirty}
              onClick={save}
              className="hb-btn hb-btn-primary px-3 py-2 text-sm"
            >
              Save{dirty ? ' •' : ''}
            </button>
          )}
          <span className="text-[11px] font-mono text-mute truncate flex-1 min-w-[6rem]">
            {status}
          </span>
        </div>

        {/* Breadcrumb trail — works on phone, tablet, desktop */}
        <nav
          className="flex items-center gap-1 overflow-x-auto text-[12px] font-mono pb-0.5"
          aria-label="Path"
        >
          {editing && (
            <button
              type="button"
              className="shrink-0 rounded-lg border border-accent/40 bg-accent/10 text-accent px-2.5 py-1.5 mr-1 font-semibold"
              onClick={() => setNavOpen(true)}
            >
              ← Back
            </button>
          )}
          {trail.map((c, i) => (
            <span key={c.path || 'root'} className="flex items-center gap-1 shrink-0">
              {i > 0 && <span className="text-mute/70">/</span>}
              <button
                type="button"
                onClick={() => {
                  setNavOpen(true)
                  loadDir(c.path)
                }}
                className={`rounded-md px-2 py-1 ${
                  i === trail.length - 1 && navOpen
                    ? 'bg-sky/15 text-sky font-semibold'
                    : 'text-mute hover:text-text hover:bg-panel-2'
                }`}
              >
                {c.label}
              </button>
            </span>
          ))}
        </nav>
      </div>

      <div className="flex-1 min-h-0 flex">
        <aside
          className={`${
            navOpen ? 'flex' : 'hidden'
          } md:flex w-full md:w-72 lg:w-80 shrink-0 flex-col border-r border-line bg-panel/40`}
        >
          <div className="px-2 py-2 flex gap-2 border-b border-line items-center">
            <button
              type="button"
              className="hb-btn hb-btn-ghost text-xs px-2.5 py-1.5 shrink-0 disabled:opacity-30"
              onClick={() => loadDir(parentDir(dir))}
              disabled={!dir}
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
          </div>
          <ul className="flex-1 overflow-y-auto text-sm">
            {filtered.length === 0 && (
              <li className="px-3 py-6 text-mute text-xs text-center">Empty folder</li>
            )}
            {filtered.map((e) => (
              <li key={e.path}>
                <button
                  type="button"
                  className={`w-full text-left px-3 py-3 md:py-2.5 border-b border-line/50 active:bg-accent/10 ${
                    filePath === e.path
                      ? 'bg-accent/12 text-accent border-l-2 border-l-accent'
                      : 'hover:bg-panel-2'
                  }`}
                  onClick={() => (e.type === 'dir' ? loadDir(e.path) : openFile(e.path))}
                >
                  <span
                    className={`inline-flex items-center justify-center w-6 mr-2 text-[11px] font-mono ${
                      e.type === 'dir' ? 'text-sky' : 'text-mute'
                    }`}
                  >
                    {e.type === 'dir' ? '▸' : '·'}
                  </span>
                  <span className="font-medium">{e.name}</span>
                  {e.type === 'dir' && (
                    <span className="float-right text-mute text-[10px] mt-1">folder</span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </aside>

        <div className={`${navOpen ? 'hidden' : 'flex'} md:flex flex-1 min-w-0 flex-col`}>
          {error && <p className="px-3 py-2 text-sm text-danger">{error}</p>}
          {filePath ? (
            <CodeMirror
              value={content}
              height="100%"
              theme={oneDark}
              extensions={langExt(language)}
              onChange={(v) => {
                setContent(v)
                setDirty(true)
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
                <p className="text-xs">Tap folders to drill in · breadcrumbs jump up the path</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
