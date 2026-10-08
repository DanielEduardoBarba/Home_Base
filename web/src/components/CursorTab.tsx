import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import ReactMarkdown from 'react-markdown'
import { api, wsUrl } from '../lib/api'
import { uid } from '../lib/id'
import type { CursorModel, FsEntry, Project } from '../lib/types'
import { IconBtn } from './IconBtn'
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
  updatedAt: number
}

const MODEL_STORAGE_KEY = 'hb-cursor-model'
const TABS_VERSION = 2

function tabsKey(projectId: string) {
  return `hb-cursor-tabs:v${TABS_VERSION}:${projectId}`
}

function activeKey(projectId: string) {
  return `hb-cursor-active:v${TABS_VERSION}:${projectId}`
}

function newTab(cwd = '', title?: string): ChatTab {
  const leaf = cwd.split('/').filter(Boolean).pop()
  return {
    id: uid(10),
    title: title || (leaf ? `./${leaf}` : 'New chat'),
    cwd,
    messages: [],
    agentId: null,
    updatedAt: Date.now(),
  }
}

function loadTabs(projectId: string): { tabs: ChatTab[]; activeId: string } {
  try {
    const raw = localStorage.getItem(tabsKey(projectId))
    const tabs = (raw ? (JSON.parse(raw) as ChatTab[]) : []).map((t) => ({
      ...t,
      updatedAt: t.updatedAt || Date.now(),
      messages: t.messages || [],
    }))
    const activeId = localStorage.getItem(activeKey(projectId)) || tabs[0]?.id || ''
    if (tabs.length) {
      return {
        tabs,
        activeId: tabs.some((t) => t.id === activeId) ? activeId : tabs[0].id,
      }
    }
  } catch {
    /* ignore */
  }
  const t = newTab()
  return { tabs: [t], activeId: t.id }
}

function persistTabs(projectId: string, tabs: ChatTab[], activeId: string) {
  try {
    const slim = tabs.map((t) => ({
      ...t,
      messages: t.messages.slice(-120).map((m) => ({
        ...m,
        text: m.text && m.text.length > 12000 ? m.text.slice(0, 12000) + '…' : m.text,
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
      </div>
    )
  }
  if (m.role === 'status' || m.role === 'system') {
    return <div className="text-mute text-[11px] font-mono px-1">{m.text}</div>
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
  const [newOpen, setNewOpen] = useState(false)
  const [deleteId, setDeleteId] = useState<string | null>(null)
  const [pickerDir, setPickerDir] = useState('')
  const [pickerEntries, setPickerEntries] = useState<FsEntry[]>([])
  const [pickingFolder, setPickingFolder] = useState(false)

  const wsRef = useRef<WebSocket | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const assistantBuf = useRef('')
  const activeIdRef = useRef(activeId)
  const tabsRef = useRef(tabs)
  activeIdRef.current = activeId
  tabsRef.current = tabs

  const active = useMemo(
    () => tabs.find((t) => t.id === activeId) || tabs[0],
    [tabs, activeId],
  )

  useEffect(() => {
    if (!project) return
    const loaded = loadTabs(project.id)
    setTabs(loaded.tabs)
    setActiveId(loaded.activeId)
    setInput('')
    setError('')
    setStreaming(false)
  }, [project?.id])

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
      })
      .catch((e) => {
        if (!cancelled) setError(String(e.message || e))
      })
    return () => {
      cancelled = true
    }
  }, [])

  const patchTab = useCallback((chatId: string, fn: (t: ChatTab) => ChatTab) => {
    setTabs((prev) =>
      prev.map((t) => (t.id === chatId ? { ...fn(t), updatedAt: Date.now() } : t)),
    )
  }, [])

  // Single WebSocket per project — bind on tab change (avoids Vite ECONNRESET storms)
  useEffect(() => {
    if (!project) return
    let closed = false
    const ws = new WebSocket(wsUrl(`/ws/cursor?project=${encodeURIComponent(project.id)}`))
    wsRef.current = ws

    ws.onopen = () => {
      if (closed) return
      setConnected(true)
      const tab = tabsRef.current.find((t) => t.id === activeIdRef.current)
      ws.send(
        JSON.stringify({
          type: 'bind',
          chatId: activeIdRef.current || 'default',
          cwd: tab?.cwd || '',
        }),
      )
    }
    ws.onclose = () => {
      if (!closed) setConnected(false)
    }
    ws.onerror = () => {
      if (!closed) setError('Cursor socket error')
    }

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data)
        const chatId = activeIdRef.current
        if (msg.type === 'ready') {
          if (msg.chatId && msg.chatId !== chatId) return
          patchTab(chatId, (t) => ({ ...t, agentId: msg.cursor?.agentId || null }))
          if (!msg.cursor?.configured) setError('CURSOR_API_KEY not set on server')
        } else if (msg.type === 'agent') {
          patchTab(chatId, (t) => ({ ...t, agentId: msg.agentId }))
        } else if (msg.type === 'text') {
          assistantBuf.current += msg.text || ''
          pushAssistant(chatId, assistantBuf.current)
        } else if (msg.type === 'message') {
          handleSdkMessage(chatId, msg.message)
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
      closed = true
      try {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.close(1000, 'project-switch')
        }
      } catch {
        /* ignore */
      }
      if (wsRef.current === ws) wsRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id])

  // Bind chat context when switching tabs (same socket)
  useEffect(() => {
    if (!active || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return
    wsRef.current.send(
      JSON.stringify({ type: 'bind', chatId: active.id, cwd: active.cwd || '' }),
    )
  }, [active?.id, active?.cwd])

  function pushMsg(chatId: string, m: ChatMsg) {
    patchTab(chatId, (t) => ({ ...t, messages: [...t.messages, m] }))
  }

  function pushAssistant(chatId: string, text: string) {
    patchTab(chatId, (t) => {
      const msgs = [...t.messages]
      const last = msgs[msgs.length - 1]
      if (last?.role === 'assistant') {
        msgs[msgs.length - 1] = { ...last, text }
        return { ...t, messages: msgs }
      }
      return {
        ...t,
        messages: [...msgs, { id: uid(), role: 'assistant', text }],
      }
    })
  }

  function handleSdkMessage(
    chatId: string,
    message: {
      type?: string
      text?: string
      name?: string
      status?: string
      args?: unknown
      file?: { path: string; action: string }
      content?: { type: string; text?: string }[]
    },
  ) {
    const mtype = message?.type
    if (mtype === 'thinking') {
      pushMsg(chatId, { id: uid(), role: 'thinking', text: message.text || '' })
      return
    }
    if (mtype === 'tool_call') {
      if (message.file?.path) {
        pushMsg(chatId, {
          id: uid(),
          role: 'file',
          file: message.file,
        })
      }
      const detail =
        typeof message.args === 'string'
          ? message.args
          : message.args
            ? JSON.stringify(message.args).slice(0, 400)
            : undefined
      pushMsg(chatId, {
        id: uid(),
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
      pushMsg(chatId, {
        id: uid(),
        role: 'status',
        text: message.text || message.status || mtype,
      })
      return
    }
    const text = (message?.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text || '')
      .join('')
    if ((mtype === 'assistant' || text) && text) {
      assistantBuf.current += text
      pushAssistant(chatId, assistantBuf.current)
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

  function createChat(cwd = '', title?: string) {
    const t = newTab(cwd, title)
    setTabs((prev) => [...prev, t])
    setActiveId(t.id)
    setNewOpen(false)
    setPickingFolder(false)
  }

  function confirmDelete() {
    if (!deleteId) return
    setTabs((prev) => {
      if (prev.length <= 1) return prev
      const next = prev.filter((t) => t.id !== deleteId)
      if (activeId === deleteId) setActiveId(next[0].id)
      return next
    })
    setDeleteId(null)
  }

  async function openFolderPicker() {
    if (!project) return
    setPickingFolder(true)
    setPickerDir('')
    const data = await api.fsList(project.id, '')
    setPickerEntries(data.entries.filter((e) => e.type === 'dir'))
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
    pushMsg(active.id, { id: uid(), role: 'user', text: prompt })
    if (active.messages.length === 0 && (active.title === 'New chat' || active.title.startsWith('./'))) {
      const titled = prompt.slice(0, 32) + (prompt.length > 32 ? '…' : '')
      patchTab(active.id, (t) => ({ ...t, title: titled }))
    }
    setInput('')
    wsRef.current.send(
      JSON.stringify({
        type: 'send',
        prompt,
        model: model || defaultModel,
        chatId: active.id,
        cwd: active.cwd || undefined,
      }),
    )
  }

  function cancel() {
    if (!active) return
    wsRef.current?.send(JSON.stringify({ type: 'cancel', chatId: active.id }))
  }

  async function resetChat() {
    if (!project || !active) return
    await api.resetCursor(project.id, active.id)
    wsRef.current?.send(JSON.stringify({ type: 'reset', chatId: active.id }))
    patchTab(active.id, (t) => ({ ...t, messages: [], agentId: null }))
  }

  if (!project) {
    return (
      <div className="h-full flex flex-col min-h-0 pb-[5.5rem]">
        <p className="hb-page text-mute text-sm">
          {projects.length === 0 ? 'No projects loaded yet.' : 'Select a project.'}
        </p>
      </div>
    )
  }

  const modelOptions =
    models.length > 0
      ? models
      : [{ id: model || defaultModel, displayName: model || defaultModel, description: '' }]

  const cwdLabel = active?.cwd ? `./${active.cwd}` : 'project root'
  const pendingDelete = tabs.find((t) => t.id === deleteId)

  return (
    <div className="h-full flex flex-col min-h-0 pb-[5.5rem]">
      <div className="hb-chrome shrink-0">
        <div className="hb-chrome-inner space-y-2">
          <div className="flex gap-2 items-center">
            <ProjectSelect
              projects={projects}
              selectedId={project.id}
              onSelect={onSelect}
              className="flex-1"
            />
            <span
              className={`text-[11px] font-mono shrink-0 px-2 py-1 rounded-md border ${
                connected
                  ? 'text-ok border-ok/30 bg-ok/10'
                  : 'text-danger border-danger/30 bg-danger/10'
              }`}
            >
              {connected ? 'live' : 'offline'}
            </span>
          </div>

          <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5">
            {tabs.map((t) => (
              <div
                key={t.id}
                className={`flex items-center rounded-lg border shrink-0 ${
                  t.id === activeId
                    ? 'border-accent/50 bg-accent/12'
                    : 'border-line bg-panel-2'
                }`}
              >
                <button
                  type="button"
                  onClick={() => setActiveId(t.id)}
                  className="px-2.5 py-1.5 text-[11px] font-semibold max-w-[8.5rem] truncate"
                  title={t.cwd ? `./${t.cwd}` : 'project root'}
                >
                  {t.title}
                </button>
                <button
                  type="button"
                  className="pr-2 pl-0.5 text-mute hover:text-danger text-sm leading-none"
                  onClick={() => setDeleteId(t.id)}
                  aria-label={`Delete ${t.title}`}
                  disabled={tabs.length <= 1}
                >
                  ×
                </button>
              </div>
            ))}
            <IconBtn
              label="New chat"
              variant="ghost"
              className="!w-9 !h-9 !min-w-9"
              onClick={() => {
                setNewOpen(true)
                setPickingFolder(false)
              }}
            />
          </div>

          <p className="text-[11px] font-mono text-sky truncate">{cwdLabel}</p>
        </div>
      </div>

      {/* New chat modal */}
      {newOpen && (
        <div className="fixed inset-0 z-40 hb-overlay backdrop-blur-sm flex items-end sm:items-center justify-center p-4">
          <div className="w-full max-w-md hb-surface p-4 space-y-3 max-h-[80vh] flex flex-col">
            {!pickingFolder ? (
              <>
                <div className="flex items-center justify-between">
                  <h2 className="font-semibold text-sm">New chat</h2>
                  <button type="button" className="text-mute text-sm" onClick={() => setNewOpen(false)}>
                    Close
                  </button>
                </div>
                <button
                  type="button"
                  className="hb-btn hb-btn-primary w-full py-3"
                  onClick={() => createChat()}
                >
                  Chat in project root
                </button>
                <button
                  type="button"
                  className="hb-btn hb-btn-ghost w-full py-3"
                  onClick={() => void openFolderPicker()}
                >
                  Chat in a folder…
                </button>
              </>
            ) : (
              <>
                <div className="flex items-center justify-between gap-2">
                  <h2 className="font-semibold text-sm">Choose folder</h2>
                  <button
                    type="button"
                    className="text-mute text-sm"
                    onClick={() => setPickingFolder(false)}
                  >
                    Back
                  </button>
                </div>
                <p className="text-[11px] font-mono text-mute truncate">
                  {pickerDir ? `./${pickerDir}` : './'}
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
                    Up
                  </button>
                  <button
                    type="button"
                    className="hb-btn hb-btn-primary text-xs flex-1"
                    onClick={() =>
                      createChat(
                        pickerDir,
                        pickerDir ? `./${pickerDir.split('/').pop()}` : 'New chat',
                      )
                    }
                  >
                    Start here
                  </button>
                </div>
                <ul className="flex-1 overflow-y-auto space-y-1">
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
                  {pickerEntries.length === 0 && (
                    <li className="text-mute text-xs py-4 text-center">No subfolders</li>
                  )}
                </ul>
              </>
            )}
          </div>
        </div>
      )}

      {/* Delete confirmation */}
      {deleteId && pendingDelete && (
        <div className="fixed inset-0 z-40 hb-overlay backdrop-blur-sm flex items-end sm:items-center justify-center p-4">
          <div className="w-full max-w-sm hb-surface p-4 space-y-4">
            <h2 className="font-semibold text-sm">Delete this chat?</h2>
            <p className="text-sm text-mute leading-relaxed">
              <span className="text-text font-medium">{pendingDelete.title}</span>
              {pendingDelete.cwd ? (
                <span className="font-mono text-sky"> · ./{pendingDelete.cwd}</span>
              ) : null}
              <br />
              Messages for this tab will be removed from this device. This cannot be undone.
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                className="hb-btn hb-btn-ghost flex-1"
                onClick={() => setDeleteId(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="hb-btn hb-btn-danger flex-1"
                onClick={confirmDelete}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-3 py-3 space-y-3">
        {(!active || active.messages.length === 0) && (
          <div className="mt-6 max-w-md space-y-2">
            <p className="text-text font-semibold">Local Cursor agent</p>
            <p className="text-mute text-sm leading-relaxed">
              Chats are kept on this device until you delete a tab. Use + to start at the root or in
              a folder.
            </p>
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
        className="shrink-0 border-t border-line bg-panel/95 p-3 space-y-2"
      >
        <div className="flex items-center gap-2">
          <select
            value={model || defaultModel}
            onChange={(e) => chooseModel(e.target.value)}
            disabled={streaming}
            className="hb-select py-1.5 text-[11px] max-w-[55%] sm:max-w-xs"
            aria-label="Model"
          >
            {modelOptions.map((m) => (
              <option key={m.id} value={m.id}>
                {m.displayName}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => void resetChat()}
            disabled={streaming || !active?.messages.length}
            className="text-[11px] text-mute hover:text-danger ml-auto px-2 py-1 disabled:opacity-30"
            title="Clear messages and start a fresh agent for this tab"
          >
            Clear chat
          </button>
        </div>
        <div className="flex gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            rows={2}
            placeholder={`Message (${cwdLabel})…`}
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
              className="rounded-xl hb-btn-primary font-semibold px-4 py-2.5 text-sm disabled:opacity-40 border-0"
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
        </div>
      </form>
    </div>
  )
}
