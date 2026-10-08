import { css } from '@codemirror/lang-css'
import { html } from '@codemirror/lang-html'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { python } from '@codemirror/lang-python'
import { oneDark } from '@codemirror/theme-one-dark'
import CodeMirror from '@uiw/react-codemirror'
import { useCallback, useEffect, useState } from 'react'
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

  const loadDir = useCallback(
    async (path: string) => {
      if (!project) return
      setError('')
      try {
        const data = await api.fsList(project.id, path)
        setDir(data.path === '.' ? '' : data.path)
        setEntries(data.entries)
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

  if (!project) {
    return <p className="p-6 text-mute text-sm">Add a workspace to browse files.</p>
  }

  return (
    <div className="h-full flex flex-col min-h-0 pb-16">
      <div className="shrink-0 px-3 pt-3 pb-2 border-b border-line/80 bg-panel/50 backdrop-blur-md flex flex-wrap gap-2 items-center">
        <select
          value={project.id}
          onChange={(e) => onSelect(e.target.value)}
          className="hb-select"
        >
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="md:hidden rounded-xl border border-line px-3 py-2 text-xs"
          onClick={() => setNavOpen((v) => !v)}
        >
          {navOpen ? 'Editor' : 'Files'}
        </button>
        {filePath && (
          <button
            type="button"
            disabled={!dirty}
            onClick={save}
            className="rounded-xl bg-accent text-ink font-semibold px-3 py-2 text-sm disabled:opacity-40"
          >
            Save
          </button>
        )}
        <span className="text-[11px] font-mono text-mute truncate flex-1">{status}</span>
      </div>

      <div className="flex-1 min-h-0 flex">
        <aside
          className={`${
            navOpen ? 'flex' : 'hidden'
          } md:flex w-full md:w-64 shrink-0 flex-col border-r border-line bg-panel/40`}
        >
          <div className="px-2 py-2 flex gap-1 border-b border-line">
            <button
              type="button"
              className="text-xs font-mono text-accent px-2 py-1"
              onClick={() => loadDir(parentDir(dir))}
              disabled={!dir}
            >
              ..
            </button>
            <span className="text-[11px] font-mono text-mute truncate py-1">
              {dir || '/'}
            </span>
          </div>
          <ul className="flex-1 overflow-y-auto text-sm">
            {entries.map((e) => (
              <li key={e.path}>
                <button
                  type="button"
                  className={`w-full text-left px-3 py-2.5 border-b border-line/60 hover:bg-panel-2 ${
                    filePath === e.path ? 'bg-accent/10 text-accent' : ''
                  }`}
                  onClick={() =>
                    e.type === 'dir' ? loadDir(e.path) : openFile(e.path)
                  }
                >
                  <span className="font-mono text-[11px] text-mute mr-2">
                    {e.type === 'dir' ? '▸' : '·'}
                  </span>
                  {e.name}
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
              Select a file to edit
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
