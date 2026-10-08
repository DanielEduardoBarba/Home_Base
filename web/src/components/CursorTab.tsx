import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import ReactMarkdown from 'react-markdown'
import { api, wsUrl } from '../lib/api'
import type { CursorModel, FsEntry, Project } from '../lib/types'
import { ProjectSelect } from './ProjectSelect'

type ChatRole = 'user' | 'assistant' | 'thinking' | 'tool' | 'file' | 'status' | 'system'

type ChatMsg = {
  id: string
  role: ChatRole
  text?: string
  tool?: { name: string; status: string; detail?: string }
  file?: { path: string; action: string }
}

type ChatTab = {
  id: string
  title: string
  cwd: string
  messages: ChatMsg[]
  agentId?: string | null
}

const MODEL_STORAGE_KEY = 'hb-cursor-model'

function tabsKey(projectId: string) {
  return `hb-cursor-tabs:${projectId}`
}

function activeKey(projectId: string) {
  return `hb-cursor-active:${projectId}`
}

function newTab(cwd = '', title?: string): ChatTab {
  const leaf = cwd.split('/').filter(Boolean).pop()
  return {
    id: crypto.randomUUID().slice(0, 10),
    title: title || (leaf ? leaf : 'Chat'),
    cwd,
    messages: [],
    agentId: null,
  }
}

function loadTabs(projectId: string): { tabs: ChatTab[]; activeId: string } {
  try {
    const raw = localStorage.getItem(tabsKey(projectId))
    const tabs = raw ? (JSON.parse(raw) as ChatTab[]) : []
    const activeId = localStorage.getItem(activeKey(projectId)) || tabs[0]?.id || ''
    if (tabs.length) return { tabs, activeId: tabs.some((t) => t.id === activeId) ? activeId : tabs[0].id }
  } catch {
    /* ignore */
  }
  const t = newTab()
  return { tabs: [t], activeId: t.id }
}

function persistTabs(projectId: string, tabs: ChatTab[], activeId: string) {
  try {
    // Cap persisted message text to keep localStorage healthy
    const slim = tabs.map((t) => ({
      ...t,
      messages: t.messages.slice(-80).map((m) => ({
        ...m,
        text: m.text && m.text.length > 8000 ? m.text.slice(0, 8000) + '…' : m.text,
      })),
    }))
    localStorage.setItem(tabsKey(projectId), JSON.stringify(slim))
    localStorage.setItem(activeKey(projectId), activeId)
  } catch {
    /* ignore */
  }
}

function MessageCard({ m }: { m: ChatMsg }) {
  if (m.role === 'user') {
    return (
      <div className="hb-chat-user rounded-2xl px-3.5 py-3 text-sm leading-relaxed ml-6 shadow-sm">
        {m.text}
      </div>
    )
  }
  if (m.role === 'thinking') {
    return (
      <div className="hb-chat-thinking rounded-xl px-3 py-2 text-xs font-mono text-amber mr-8">
        <span className="uppercase tracking-wider text-[10px] opacity-80">thinking</span>
        <div className="mt-1 whitespace-pre-wrap opacity-90">{m.text}</div>
      </div>
    )
  }
  if (m.role === 'tool') {
    return (
      <div className="hb-chat-tool rounded-xl px-3 py-2.5 mr-6 text-xs">
        <div className="flex items-center gap-2 font-mono">
          <span className="text-violet font-semibold">{m.tool?.name || 'tool'}</span>
          <span
            className={
              m.tool?.status === 'completed'
                ? 'text-ok'
                : m.tool?.status === 'error'
                  ? 'text-danger'
                  : 'text-sky'
            }
          >
            {m.tool?.status || 'running'}
          </span>
        </div>
        {m.tool?.detail && (
          <pre className="mt-1.5 text-[11px] text-mute whitespace-pre-wrap break-all max-h-28 overflow-auto">
            {m.tool.detail}
          </pre>
        )}
      </div>
    )
  }
  if (m.role === 'file') {
    return (
      <div className="hb-chat-file rounded-xl px-3 py-2.5 mr-6 text-xs font-mono shadow-sm">
        <div className="flex items-center gap-2">
          <span className="text-sky font-semibold uppercase text-[10px] tracking-wide">
            {m.file?.action || 'file'}
          </span>
          <span className="text-text truncate">{m.file?.path}</span>
        </div>
        {m.text && <p className="text-mute mt-1 text-[11px]">{m.text}</p>}
      </div>
    )
  }
  if (m.role === 'status' || m.role === 'system') {
    return (
      <div className="text-mute text-[11px] font-mono px-1">{m.text}</div>
    )
  }
  return (
    <div className="hb-chat-assistant rounded-2xl px-3.5 py-3 text-sm leading-relaxed mr-4 shadow-sm">
      <div className="markdown-body">
        <ReactMarkdown>{m.text || ''}</ReactMarkdown>
      </div>
    </div>
  )
}

export function CursorTab({
  projects,
  selectedId,
  onSelect,
}: {
  projects: Project[]
  selectedId: string
  onSelect: (id: string) => void
}) {
  const project = projects.find((p) => p.id === selectedId) || projects[0]
  const [tabs, setTabs] = useState<ChatTab[]>([])
  const [activeId, setActiveId] = useState('')
  const [input, setInput] = useState('')
  const [connected, setConnected] = useState(false)
  const [streaming, setStreaming] = useState(false)
  const [error, setError] = useState('')
  const [models, setModels] = useState<CursorModel[]>([])
  const [model, setModel] = useState(() => {
    try {
      return localStorage.getItem(MODEL_STORAGE_KEY) || ''
    } catch {
      return ''
    }
  })
  const [defaultModel, setDefaultModel] = useState('composer-2.5')
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerDir, setPickerDir] = useState('')
  const [pickerEntries, setPickerEntries] = useState<FsEntry[]>([])
  const wsRef = useRef<WebSocket | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const assistantBuf = useRef('')
  const modelRef = useRef(model)
  modelRef.current = model

  const active = useMemo(
    () => tabs.find((t) => t.id === activeId) || tabs[0],
    [tabs, activeId],
  )

  // Load tabs when project changes
  useEffect(() => {
    if (!project) return
    const loaded = loadTabs(project.id)
    setTabs(loaded.tabs)
    setActiveId(loaded.activeId)
    setInput('')
    setError('')
    setStreaming(false)
  }, [project?.id])

  // Persist tabs
  useEffect(() => {
    if (!project || !tabs.length || !activeId) return
    persistTabs(project.id, tabs, activeId)
  }, [project?.id, tabs, activeId])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [active?.messages, streaming])

  useEffect(() => {
    let cancelled = false
    api
      .cursorModels()
      .then((data) => {
        if (cancelled) return
        setModels(data.models || [])
        setDefaultModel(data.default)
        setModel((prev) => {
          const saved = prev || data.default
          const ids = new Set((data.models || []).map((m) => m.id))
          const next = ids.has(saved) ? saved : data.default
          try {
            localStorage.setItem(MODEL_STORAGE_KEY, next)
          } catch {
            /* ignore */
          }
          return next
        })
        if (data.error) setError(`Model list: ${data.error}`)
      })
      .catch((e) => {
        if (!cancelled) setError(String(e.message || e))
      })
    return () => {
      cancelled = true
    }
  }, [])

  const patchActive = useCallback((fn: (t: ChatTab) => ChatTab) => {
    setTabs((prev) => prev.map((t) => (t.id === activeId ? fn(t) : t)))
  }, [activeId])

  // WS per active chat tab
  useEffect(() => {
    if (!project || !active) return
    setConnected(false)
    assistantBuf.current = ''
    const q = new URLSearchParams({
      project: project.id,
      chat: active.id,
    })
    if (active.cwd) q.set('cwd', active.cwd)
    const ws = new WebSocket(wsUrl(`/ws/cursor?${q}`))
    wsRef.current = ws

    ws.onopen = () => setConnected(true)
    ws.onclose = () => setConnected(false)
    ws.onerror = () => setError('Cursor socket error')

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data)
        if (msg.type === 'ready') {
          patchActive((t) => ({ ...t, agentId: msg.cursor?.agentId || null }))
          if (!msg.cursor?.configured) setError('CURSOR_API_KEY not set on server')
        } else if (msg.type === 'agent') {
          patchActive((t) => ({ ...t, agentId: msg.agentId }))
        } else if (msg.type === 'text') {
          assistantBuf.current += msg.text || ''
          pushAssistant(assistantBuf.current)
        } else if (msg.type === 'message') {
          handleSdkMessage(msg.message)
        } else if (msg.type === 'done') {
          setStreaming(false)
          assistantBuf.current = ''
          if (msg.status === 'error') setError('Agent run ended with error')
        } else if (msg.type === 'error') {
          setStreaming(false)
          setError(msg.error || 'Agent error')
        } else if (msg.type === 'cancelled') {
          setStreaming(false)
        }
      } catch {
        /* ignore */
      }
    }

    return () => {
      ws.close()
      wsRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id, active?.id, active?.cwd])

  function pushMsg(m: ChatMsg) {
    patchActive((t) => ({ ...t, messages: [...t.messages, m] }))
  }

  function pushAssistant(text: string) {
    patchActive((t) => {
      const msgs = [...t.messages]
      const last = msgs[msgs.length - 1]
      if (last?.role === 'assistant') {
        msgs[msgs.length - 1] = { ...last, text }
        return { ...t, messages: msgs }
      }
      return {
        ...t,
        messages: [...msgs, { id: crypto.randomUUID(), role: 'assistant', text }],
      }
    })
  }

  function handleSdkMessage(message: {
    type?: string
    text?: string
    name?: string
    status?: string
    args?: unknown
    result?: unknown
    file?: { path: string; action: string }
    content?: { type: string; text?: string; name?: string; raw?: string }[]
  }) {
    const mtype = message?.type
    if (mtype === 'thinking') {
      pushMsg({
        id: crypto.randomUUID(),
        role: 'thinking',
        text: message.text || '',
      })
      return
    }
    if (mtype === 'tool_call') {
      if (message.file?.path) {
        pushMsg({
          id: crypto.randomUUID(),
          role: 'file',
          file: message.file,
          text: message.name,
        })
      }
      const detail =
        typeof message.args === 'string'
          ? message.args
          : message.args
            ? JSON.stringify(message.args, null, 0).slice(0, 400)
            : undefined
      pushMsg({
        id: crypto.randomUUID(),
        role: 'tool',
        tool: {
          name: message.name || 'tool',
          status: String(message.status || 'running'),
          detail,
        },
      })
      return
    }
    if (mtype === 'status' || mtype === 'task') {
      pushMsg({
        id: crypto.randomUUID(),
        role: 'status',
        text: message.text || message.status || mtype,
      })
      return
    }
    const blocks = message?.content || []
    const text = blocks
      .filter((b) => b.type === 'text')
      .map((b) => b.text || '')
      .join('')
    if (mtype === 'assistant' || text) {
      if (text) {
        assistantBuf.current += text
        pushAssistant(assistantBuf.current)
      }
    }
  }

  function chooseModel(id: string) {
    setModel(id)
    try {
      localStorage.setItem(MODEL_STORAGE_KEY, id)
    } catch {
      /* ignore */
    }
  }

  function addChat(cwd = '', title?: string) {
    const t = newTab(cwd, title)
    setTabs((prev) => [...prev, t])
    setActiveId(t.id)
    setPickerOpen(false)
  }

  function closeTab(id: string) {
    setTabs((prev) => {
      if (prev.length <= 1) return prev
      const next = prev.filter((t) => t.id !== id)
      if (activeId === id) setActiveId(next[0].id)
      return next
    })
  }

  async function openPicker() {
    if (!project) return
    setPickerOpen(true)
    setPickerDir('')
    try {
      const data = await api.fsList(project.id, '')
      setPickerEntries(data.entries.filter((e) => e.type === 'dir'))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function browsePicker(path: string) {
    if (!project) return
    setPickerDir(path)
    const data = await api.fsList(project.id, path)
    setPickerEntries(data.entries.filter((e) => e.type === 'dir'))
  }

  function send(e: FormEvent) {
    e.preventDefault()
    const prompt = input.trim()
    if (!prompt || !active || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return
    setError('')
    setStreaming(true)
    assistantBuf.current = ''
    pushMsg({ id: crypto.randomUUID(), role: 'user', text: prompt })
    // Auto-title first message
    if (active.messages.length === 0 && active.title === 'Chat') {
      patchActive((t) => ({
        ...t,
        title: prompt.slice(0, 28) + (prompt.length > 28 ? '…' : ''),
      }))
    }
    setInput('')
    wsRef.current.send(
      JSON.stringify({
        type: 'send',
        prompt,
        model: model || defaultModel,
        cwd: active.cwd || undefined,
      }),
    )
  }

  function cancel() {
    wsRef.current?.send(JSON.stringify({ type: 'cancel' }))
  }

  async function reset() {
    if (!project || !active) return
    await api.resetCursor(project.id, active.id)
    wsRef.current?.send(JSON.stringify({ type: 'reset' }))
    patchActive((t) => ({ ...t, messages: [], agentId: null }))
  }

  if (!project) return null

  const modelOptions =
    models.length > 0
      ? models
      : [{ id: model || defaultModel, displayName: model || defaultModel, description: '' }]

  const cwdLabel = active?.cwd ? `./${active.cwd}` : project.name

  return (
    <div className="h-full flex flex-col min-h-0 pb-16">
      <div className="shrink-0 border-b border-line bg-panel/80 backdrop-blur-md">
        <div className="px-3 pt-3 pb-2 space-y-2 max-w-5xl mx-auto w-full">
          <div className="flex gap-2">
            <ProjectSelect
              projects={projects}
              selectedId={project.id}
              onSelect={onSelect}
              className="flex-1"
            />
            <button type="button" onClick={reset} className="hb-btn hb-btn-ghost text-xs px-3 py-2">
              Reset
            </button>
          </div>

          {/* Chat tabs */}
          <div className="flex items-center gap-1 overflow-x-auto pb-0.5">
            {tabs.map((t) => (
              <div
                key={t.id}
                className={`flex items-center gap-1 rounded-lg border shrink-0 ${
                  t.id === activeId
                    ? 'border-accent/50 bg-accent/12 text-text'
                    : 'border-line bg-panel-2 text-mute'
                }`}
              >
                <button
                  type="button"
                  onClick={() => setActiveId(t.id)}
                  className="px-2.5 py-1.5 text-[11px] font-semibold max-w-[9rem] truncate"
                  title={t.cwd ? `./${t.cwd}` : 'project root'}
                >
                  {t.title}
                </button>
                {tabs.length > 1 && (
                  <button
                    type="button"
                    className="pr-2 text-mute hover:text-danger text-xs"
                    onClick={() => closeTab(t.id)}
                    aria-label="Close tab"
                  >
                    ×
                  </button>
                )}
              </div>
            ))}
            <button
              type="button"
              onClick={() => addChat()}
              className="hb-btn hb-btn-ghost text-xs px-2.5 py-1.5 shrink-0"
              title="New chat in project root"
            >
              +
            </button>
            <button
              type="button"
              onClick={() => void openPicker()}
              className="hb-btn hb-btn-ghost text-xs px-2.5 py-1.5 shrink-0"
              title="New chat in a folder"
            >
              Folder+
            </button>
          </div>

          <div className="flex items-center gap-2">
            <select
              value={model || defaultModel}
              onChange={(e) => chooseModel(e.target.value)}
              disabled={streaming}
              className="hb-select flex-1 py-2 text-xs"
              aria-label="Model"
            >
              {modelOptions.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.displayName}
                </option>
              ))}
            </select>
            <div className="text-[11px] font-mono text-mute shrink-0 max-w-[40%] truncate">
              {connected ? <span className="text-ok">live</span> : <span className="text-danger">offline</span>}
              {' · '}
              <span className="text-sky">{cwdLabel}</span>
            </div>
          </div>
        </div>
      </div>

      {pickerOpen && (
        <div className="fixed inset-0 z-40 bg-ink/70 backdrop-blur-sm flex items-end sm:items-center justify-center p-4">
          <div className="w-full max-w-md hb-surface p-4 space-y-3 max-h-[80vh] flex flex-col">
            <div className="flex items-center justify-between gap-2">
              <h2 className="font-semibold text-sm">Open folder chat</h2>
              <button type="button" className="text-mute text-sm" onClick={() => setPickerOpen(false)}>
                Close
              </button>
            </div>
            <p className="text-[11px] font-mono text-mute truncate">
              {pickerDir ? `./${pickerDir}` : './ (project root)'}
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                className="hb-btn hb-btn-ghost text-xs flex-1"
                disabled={!pickerDir}
                onClick={() => {
                  const parent = pickerDir.split('/').slice(0, -1).join('/')
                  void browsePicker(parent)
                }}
              >
                ↑ Up
              </button>
              <button
                type="button"
                className="hb-btn hb-btn-primary text-xs flex-1"
                onClick={() =>
                  addChat(pickerDir, pickerDir.split('/').filter(Boolean).pop() || 'root')
                }
              >
                Start chat here
              </button>
            </div>
            <ul className="flex-1 overflow-y-auto space-y-1">
              {pickerEntries.length === 0 && (
                <li className="text-mute text-xs py-4 text-center">No subfolders</li>
              )}
              {pickerEntries.map((e) => (
                <li key={e.path}>
                  <button
                    type="button"
                    className="w-full text-left rounded-lg border border-line px-3 py-2.5 text-sm hover:border-sky/50 hover:bg-sky/10"
                    onClick={() => void browsePicker(e.path)}
                  >
                    <span className="text-sky font-mono text-xs mr-2">▸</span>
                    {e.name}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-3">
        {(!active || active.messages.length === 0) && (
          <div className="mt-6 max-w-md space-y-2">
            <p className="text-text font-semibold">Local Cursor agent</p>
            <p className="text-mute text-sm leading-relaxed">
              Chat like the IDE — pick a model, open folder tabs with Folder+, and watch tool /
              file cards stream in.
            </p>
            <p className="text-[11px] font-mono text-sky">cwd {cwdLabel}</p>
          </div>
        )}
        {active?.messages.map((m) => (
          <MessageCard key={m.id} m={m} />
        ))}
        {streaming && (
          <p className="text-xs font-mono text-accent animate-pulse">agent working…</p>
        )}
        {error && <p className="text-sm text-danger">{error}</p>}
        <div ref={bottomRef} />
      </div>

      <form
        onSubmit={send}
        className="shrink-0 border-t border-line bg-panel/90 p-3 flex gap-2"
      >
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          rows={2}
          placeholder={`Message in ${cwdLabel}…`}
          className="flex-1 rounded-xl bg-panel-2 border border-line px-3 py-2.5 text-sm resize-none outline-none focus:border-accent"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              send(e)
            }
          }}
        />
        <div className="flex flex-col gap-2">
          <button
            type="submit"
            disabled={streaming || !connected}
            className="rounded-xl bg-accent text-ink font-semibold px-4 py-2.5 text-sm disabled:opacity-40"
          >
            Send
          </button>
          {streaming && (
            <button
              type="button"
              onClick={cancel}
              className="rounded-xl border border-danger/50 text-danger text-xs py-2"
            >
              Cancel
            </button>
          )}
        </div>
      </form>
    </div>
  )
}
