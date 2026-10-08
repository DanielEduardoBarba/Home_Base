import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import ReactMarkdown from 'react-markdown'
import { api, wsUrl } from '../lib/api'
import { loadChatTabs, newChatTab, persistChatTabs } from '../lib/chatTabs'
import type { ChatMsg, ChatTab, PresentRequest } from '../lib/chatTypes'
import { uid } from '../lib/id'
import { useNotifyOptional } from '../lib/NotifyContext'
import { presentFromTool, presentLabel } from '../lib/present'
import { useSceneRefresh } from '../lib/sceneRefresh'
import { speechSupported, startSpeechDictation, type SpeechHandle } from '../lib/speech'
import type { CursorModel, FsEntry, Project } from '../lib/types'
import { IconBtn } from './IconBtn'
import { ProjectSelect } from './ProjectSelect'

const MODEL_STORAGE_KEY = 'hb-cursor-model'
const DOCK_OPEN_KEY = 'hb-chat-dock-open'

function MessageCard({
  m,
  onPresent,
}: {
  m: ChatMsg
  onPresent?: (req: PresentRequest) => void
}) {
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
    const hint = presentFromTool(m.tool?.name || '', undefined)
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
          {hint && onPresent && m.tool?.status === 'completed' && (
            <button
              type="button"
              className="ml-auto text-accent font-semibold hover:underline"
              onClick={() => onPresent(hint)}
            >
              {presentLabel(hint)}
            </button>
          )}
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
          <span className="text-text truncate flex-1 min-w-0">{m.file?.path}</span>
          {m.file?.path && onPresent && (
            <button
              type="button"
              className="text-accent font-semibold shrink-0 hover:underline"
              onClick={() => onPresent({ scene: 'files', path: m.file!.path })}
            >
              Show
            </button>
          )}
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

export function ChatPanel({
  projects,
  selectedId,
  onSelect,
  variant = 'page',
  onPresent,
  dockOpen: dockOpenProp,
  onDockOpenChange,
}: {
  projects: Project[]
  selectedId: string
  onSelect: (id: string) => void
  /** page = full Chat tab; dock = bottom-right Work panel */
  variant?: 'page' | 'dock'
  onPresent?: (req: PresentRequest) => void
  dockOpen?: boolean
  onDockOpenChange?: (open: boolean) => void
}) {
  const project = projects.find((p) => p.id === selectedId) || projects[0]
  const isDock = variant === 'dock'

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
  const [listening, setListening] = useState(false)
  const [dockOpenLocal, setDockOpenLocal] = useState(() => {
    try {
      return localStorage.getItem(DOCK_OPEN_KEY) !== '0'
    } catch {
      return true
    }
  })
  const canSpeak = useMemo(() => speechSupported(), [])

  const dockOpen = dockOpenProp ?? dockOpenLocal
  function setDockOpen(open: boolean) {
    if (onDockOpenChange) onDockOpenChange(open)
    else {
      setDockOpenLocal(open)
      try {
        localStorage.setItem(DOCK_OPEN_KEY, open ? '1' : '0')
      } catch {
        /* ignore */
      }
    }
  }

  const notify = useNotifyOptional()
  const wsRef = useRef<WebSocket | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const assistantBuf = useRef('')
  const activeIdRef = useRef(activeId)
  const tabsRef = useRef(tabs)
  const speechRef = useRef<SpeechHandle | null>(null)
  const inputBeforeSpeech = useRef('')
  const streamingRef = useRef(false)
  const notifyRef = useRef(notify)
  const onPresentRef = useRef(onPresent)
  activeIdRef.current = activeId
  tabsRef.current = tabs
  streamingRef.current = streaming
  notifyRef.current = notify
  onPresentRef.current = onPresent

  const active = useMemo(
    () => tabs.find((t) => t.id === activeId) || tabs[0],
    [tabs, activeId],
  )

  useEffect(() => {
    if (!project) return
    const loaded = loadChatTabs(project.id)
    setTabs(loaded.tabs)
    setActiveId(loaded.activeId)
    setInput('')
    setError('')
    setStreaming(false)
  }, [project?.id])

  useEffect(() => {
    if (!project || !tabs.length || !activeId) return
    persistChatTabs(project.id, tabs, activeId)
  }, [project?.id, tabs, activeId])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [active?.messages, streaming])

  const refreshModels = useCallback(async () => {
    try {
      const data = await api.cursorModels()
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
      if (data.error) setError(data.error)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useSceneRefresh(refreshModels)

  useEffect(() => {
    void refreshModels()
  }, [refreshModels])

  const patchTab = useCallback((chatId: string, fn: (t: ChatTab) => ChatTab) => {
    setTabs((prev) =>
      prev.map((t) => (t.id === chatId ? { ...fn(t), updatedAt: Date.now() } : t)),
    )
  }, [])

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
          if (!msg.cursor?.configured) {
            setError(
              'Cursor key missing on this server. On the host, put CURSOR_API_KEY in .env then run ./build.sh --deploy (or restart homebased after syncing /var/lib/homebased/.env).',
            )
          }
        } else if (msg.type === 'agent') {
          patchTab(chatId, (t) => ({ ...t, agentId: msg.agentId }))
        } else if (msg.type === 'text') {
          assistantBuf.current += msg.text || ''
          pushAssistant(chatId, assistantBuf.current)
        } else if (msg.type === 'message') {
          handleSdkMessage(chatId, msg.message)
        } else if (msg.type === 'done') {
          const wasStreaming = streamingRef.current
          setStreaming(false)
          assistantBuf.current = ''
          const err = msg.status === 'error'
          if (err) setError('Agent run ended with error')
          if (wasStreaming && notifyRef.current) {
            const tab = tabsRef.current.find((t) => t.id === activeIdRef.current)
            const label = tab?.title || 'Chat'
            notifyRef.current.ping({
              title: err ? 'Cursor finished with error' : 'Cursor finished',
              body: `${label} is ready to check`,
              level: err ? 'error' : 'success',
              category: 'cursor',
            })
          }
        } else if (msg.type === 'error') {
          const wasStreaming = streamingRef.current
          setStreaming(false)
          setError(msg.error || 'Agent error')
          if (wasStreaming && notifyRef.current) {
            notifyRef.current.ping({
              title: 'Cursor error',
              body: String(msg.error || 'Agent error').slice(0, 160),
              level: 'error',
              category: 'cursor',
            })
          }
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
        // Auto-present file edits into Work when available
        if (message.status === 'completed' || message.status === 'running') {
          onPresentRef.current?.({ scene: 'files', path: message.file.path })
        }
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
      const shellHint = presentFromTool(message.name || '')
      if (shellHint && message.status === 'completed') {
        onPresentRef.current?.(shellHint)
      }
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
    const t = newChatTab(cwd, title)
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

  function stopListening() {
    speechRef.current?.stop()
    speechRef.current = null
    setListening(false)
  }

  function toggleListen() {
    if (listening) {
      stopListening()
      return
    }
    notify?.unlockAudio()
    inputBeforeSpeech.current = input.trim()
    const handle = startSpeechDictation({
      onPartial: (text) => {
        const base = inputBeforeSpeech.current
        setInput(base ? `${base} ${text}` : text)
      },
      onFinal: (text) => {
        const base = inputBeforeSpeech.current
        const next = base ? `${base} ${text}` : text
        setInput(next)
        inputBeforeSpeech.current = next
      },
      onError: (message) => setError(message),
      onEnd: () => {
        speechRef.current = null
        setListening(false)
      },
      lang: 'en-US',
    })
    if (!handle) return
    speechRef.current = handle
    setListening(true)
    setError('')
  }

  useEffect(() => {
    return () => {
      speechRef.current?.stop()
    }
  }, [])

  async function resetChat() {
    if (!project || !active) return
    await api.resetCursor(project.id, active.id)
    wsRef.current?.send(JSON.stringify({ type: 'reset', chatId: active.id }))
    patchTab(active.id, (t) => ({ ...t, messages: [], agentId: null }))
  }

  if (!project) {
    return (
      <div className={isDock ? 'hb-chat-dock-body' : 'h-full flex flex-col min-h-0 hb-with-nav'}>
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

  const cwdLabel = active?.cwd
    ? active.cwd.split('/').filter(Boolean).slice(-2).join('/')
    : project.name
  const pendingDelete = tabs.find((t) => t.id === deleteId)

  const modals = (
    <>
      {newOpen && (
        <div className="fixed inset-0 z-50 hb-overlay backdrop-blur-sm flex items-end sm:items-center justify-center p-4">
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
                  className="hb-btn hb-btn-primary w-full !min-h-11"
                  onClick={() => createChat()}
                >
                  Whole app ({project.name})
                </button>
                <button
                  type="button"
                  className="hb-btn hb-btn-ghost w-full !min-h-11"
                  onClick={() => void openFolderPicker()}
                >
                  Pick a folder…
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

      {deleteId && pendingDelete && (
        <div className="fixed inset-0 z-50 hb-overlay backdrop-blur-sm flex items-end sm:items-center justify-center p-4">
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
              <button type="button" className="hb-btn hb-btn-danger flex-1" onClick={confirmDelete}>
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )

  const header = (
    <div className={`shrink-0 ${isDock ? 'hb-chat-dock-chrome' : 'hb-chrome'}`}>
      <div className={`${isDock ? 'px-3 py-2 space-y-2' : 'hb-chrome-inner space-y-2'}`}>
        {!isDock && (
          <div className="flex gap-2 items-center">
            <ProjectSelect
              projects={projects}
              selectedId={project.id}
              onSelect={onSelect}
              className="flex-1 !min-h-10 !py-2 text-sm"
            />
            <span
              className={`text-[10px] shrink-0 px-2 py-1 rounded-md border font-semibold ${
                connected
                  ? 'text-ok border-ok/30 bg-ok/10'
                  : 'text-danger border-danger/30 bg-danger/10'
              }`}
            >
              {connected ? 'On' : 'Off'}
            </span>
          </div>
        )}

        <div className="flex items-center gap-1.5">
          {isDock && (
            <button
              type="button"
              className="text-mute hover:text-text text-sm px-1 shrink-0"
              onClick={() => setDockOpen(false)}
              aria-label="Minimize chat"
              title="Minimize"
            >
              ▾
            </button>
          )}
          <div className="flex-1 min-w-0 flex items-center gap-1.5 overflow-x-auto pb-0.5">
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
                  className="px-2.5 py-1.5 text-[11px] font-semibold max-w-[7.5rem] truncate"
                  title={t.cwd ? `Folder: ${t.cwd}` : `App: ${project.name}`}
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
          </div>
          <IconBtn
            label="New chat"
            variant="primary"
            className="!w-9 !h-9 !min-w-9"
            onClick={() => {
              setNewOpen(true)
              setPickingFolder(false)
            }}
          />
        </div>

        <div className="flex items-center gap-2 text-[11px]">
          <select
            value={model || defaultModel}
            onChange={(e) => chooseModel(e.target.value)}
            disabled={streaming}
            className="hb-select py-1 text-[11px] min-w-0 flex-1 max-w-[14rem]"
            aria-label="Model"
          >
            {modelOptions.map((m) => (
              <option key={m.id} value={m.id}>
                {m.displayName}
              </option>
            ))}
          </select>
          <span className="text-mute truncate hidden sm:inline">
            <span className="text-sky font-medium">{cwdLabel}</span>
          </span>
          {isDock && (
            <span
              className={`text-[10px] shrink-0 px-1.5 py-0.5 rounded border font-semibold ${
                connected
                  ? 'text-ok border-ok/30 bg-ok/10'
                  : 'text-danger border-danger/30 bg-danger/10'
              }`}
            >
              {connected ? 'On' : 'Off'}
            </span>
          )}
          {!isDock && (
            <button
              type="button"
              className="text-accent font-semibold shrink-0 ml-auto"
              onClick={() => {
                setNewOpen(true)
                setPickingFolder(false)
              }}
            >
              Folder…
            </button>
          )}
        </div>

        {/* Quick present actions — chat can drive the workspace */}
        {onPresent && (
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              className="hb-chat-present-btn"
              onClick={() => onPresent({ scene: 'shell', newShell: true })}
            >
              + Shell
            </button>
            <button
              type="button"
              className="hb-chat-present-btn"
              onClick={() => onPresent({ scene: 'apps' })}
            >
              Apps
            </button>
            <button
              type="button"
              className="hb-chat-present-btn"
              onClick={() => onPresent({ scene: 'files' })}
            >
              Files
            </button>
            <button
              type="button"
              className="hb-chat-present-btn"
              onClick={() => onPresent({ scene: 'shell' })}
            >
              Sessions
            </button>
          </div>
        )}
      </div>
    </div>
  )

  const messages = (
    <div
      className={`flex-1 min-h-0 overflow-y-auto overscroll-contain px-3 py-3 space-y-3 ${
        isDock ? '' : ''
      }`}
    >
      {(!active || active.messages.length === 0) && (
        <div className="mt-2 max-w-md space-y-2">
          <p className="text-text font-semibold text-sm">
            {isDock ? 'Work chat' : 'Local Cursor agent'}
          </p>
          <p className="text-mute text-xs leading-relaxed">
            {isDock
              ? 'Ask anything. Use + Shell / Apps / Files to present in the workspace. Tabs are per project; pick a folder for scoped chats.'
              : 'Chats stay on this device. Use + to start at the root or in a folder. Present Shell from the toolbar to watch a process.'}
          </p>
        </div>
      )}
      {active?.messages.map((m) => (
        <MessageCard key={m.id} m={m} onPresent={onPresent} />
      ))}
      {streaming && (
        <p className="text-xs font-mono text-accent animate-pulse">agent working…</p>
      )}
      {error && <p className="text-sm text-danger">{error}</p>}
      <div ref={bottomRef} />
    </div>
  )

  const composer = (
    <form
      onSubmit={send}
      className={`shrink-0 border-t border-line bg-panel/95 p-3 space-y-2 ${
        isDock ? 'rounded-b-2xl' : ''
      }`}
    >
      {!isDock && (
        <div className="flex items-center gap-2">
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
      )}
      <div className="flex gap-2 items-stretch">
        <div className="flex-1 min-w-0 relative">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            rows={isDock ? 2 : 2}
            placeholder={listening ? 'Listening… speak in English' : `Message (${cwdLabel})…`}
            className={`w-full rounded-xl bg-panel-2 border px-3 py-2.5 pr-12 text-sm resize-none outline-none focus:border-accent ${
              listening ? 'border-accent/60' : 'border-line'
            }`}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                if (listening) stopListening()
                send(e)
              }
            }}
          />
          {canSpeak && (
            <button
              type="button"
              onClick={toggleListen}
              disabled={streaming}
              className={`hb-mic-btn ${listening ? 'hb-mic-btn-live' : ''}`}
              aria-pressed={listening}
              aria-label={listening ? 'Stop dictation' : 'Dictate in English'}
              title={listening ? 'Stop' : 'Speak (English → text)'}
            >
              <svg viewBox="0 0 24 24" className="hb-mic-icon" aria-hidden>
                {listening ? (
                  <rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" />
                ) : (
                  <>
                    <path
                      d="M12 3.5a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0v-5a3 3 0 0 0-3-3z"
                      fill="currentColor"
                    />
                    <path
                      d="M7 11a5 5 0 0 0 10 0M12 16v3.5M9 19.5h6"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.75"
                      strokeLinecap="round"
                    />
                  </>
                )}
              </svg>
            </button>
          )}
        </div>
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
      {isDock && (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => void resetChat()}
            disabled={streaming || !active?.messages.length}
            className="text-[11px] text-mute hover:text-danger px-1 disabled:opacity-30"
          >
            Clear
          </button>
        </div>
      )}
    </form>
  )

  // Dock: collapsed launcher
  if (isDock && !dockOpen) {
    return (
      <button
        type="button"
        className="hb-chat-fab"
        onClick={() => setDockOpen(true)}
        aria-label="Open chat"
      >
        <svg className="hb-nav-icon" viewBox="0 0 24 24" aria-hidden>
          <path d="M5 4.5 19 12 5 19.5V4.5z" />
        </svg>
        <span>Chat</span>
        {streaming && <span className="hb-chat-fab-dot" />}
      </button>
    )
  }

  if (isDock) {
    return (
      <aside className="hb-chat-dock" aria-label="Work chat">
        {modals}
        {header}
        {messages}
        {composer}
      </aside>
    )
  }

  return (
    <div className="h-full flex flex-col min-h-0 hb-with-nav">
      {modals}
      {header}
      {messages}
      {composer}
    </div>
  )
}
