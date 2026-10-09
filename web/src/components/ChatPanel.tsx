import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import ReactMarkdown from 'react-markdown'
import { api, wsUrl } from '../lib/api'
import { loadChatTabs, newChatTab, persistChatTabs } from '../lib/chatTabs'
import type {
  ApprovalPolicy,
  ChatMode,
  ChatMsg,
  ChatTab,
  PendingApproval,
  PresentRequest,
} from '../lib/chatTypes'
import { uid } from '../lib/id'
import { useNotifyOptional } from '../lib/NotifyContext'
import { presentFromTool, presentLabel } from '../lib/present'
import { useSceneRefresh } from '../lib/sceneRefresh'
import { speechSupported, startSpeechDictation, type SpeechHandle } from '../lib/speech'
import { formatMsgTime, polishThinking, prettyToolName } from '../lib/toolFormat'
import type { CursorModel, FsEntry, Project } from '../lib/types'
import {
  connStateLabel,
  connectWithReconnect,
  type WsConnState,
  type WsReconnectHandle,
} from '../lib/wsReconnect'
import { IconBtn } from './IconBtn'
import { ProjectSelect } from './ProjectSelect'

const MODEL_STORAGE_KEY = 'hb-cursor-model'
const MODE_STORAGE_KEY = 'hb-cursor-mode'
const APPROVAL_STORAGE_KEY = 'hb-cursor-approval-policy'
/** Previous system default — treat as unset so Auto becomes the new default. */
const LEGACY_DEFAULT_MODELS = new Set(['composer-2.5', 'composer-2', 'composer-1.5'])
const CHAT_MODES: { id: ChatMode; label: string; title: string }[] = [
  { id: 'agent', label: 'Agent', title: 'Build and edit — full tools' },
  { id: 'ask', label: 'Ask', title: 'Read-only Q&A — no edits or shell' },
  { id: 'plan', label: 'Plan', title: 'Design first, implement after you approve' },
  { id: 'debug', label: 'Debug', title: 'Hypothesis-driven debugging' },
]
/** Work chat dock: '1' = open, anything else / missing = minimized (default). */
export const DOCK_OPEN_KEY = 'hb-chat-dock-open'

export function readDockOpen(): boolean {
  try {
    return localStorage.getItem(DOCK_OPEN_KEY) === '1'
  } catch {
    return false
  }
}

export function writeDockOpen(open: boolean): void {
  try {
    localStorage.setItem(DOCK_OPEN_KEY, open ? '1' : '0')
  } catch {
    /* ignore */
  }
}

function MsgMeta({ at, align = 'start' }: { at?: number; align?: 'start' | 'end' }) {
  const t = formatMsgTime(at)
  if (!t) return null
  return (
    <time
      className={`hb-chat-meta block text-[10px] text-mute/80 mt-1 ${
        align === 'end' ? 'text-right' : 'text-left'
      }`}
      dateTime={at ? new Date(at).toISOString() : undefined}
    >
      {t}
    </time>
  )
}

function MessageCard({
  m,
  onPresent,
}: {
  m: ChatMsg
  onPresent?: (req: PresentRequest) => void
}) {
  if (m.role === 'user') {
    return (
      <div className="ml-6">
        <div className="hb-chat-user rounded-2xl px-3.5 py-3 text-sm leading-relaxed shadow-sm">
          {m.text}
        </div>
        <MsgMeta at={m.at} align="end" />
      </div>
    )
  }
  if (m.role === 'thinking') {
    const body = m.streaming ? m.text || '' : polishThinking(m.text || '')
    return (
      <details
        className={`hb-chat-thinking rounded-xl px-3 py-2 text-xs text-amber mr-8${
          m.streaming ? ' hb-chat-thinking-live open' : ''
        }`}
        open={m.streaming || undefined}
      >
        <summary className="cursor-pointer select-none list-none flex items-center gap-2">
          <span className="uppercase tracking-wider text-[10px] opacity-80 font-semibold">
            thinking{m.streaming ? '…' : ''}
          </span>
          {!m.streaming && <span className="text-mute opacity-70 normal-case tracking-normal">tap to expand</span>}
          <MsgMeta at={m.at} />
        </summary>
        <div className="mt-1.5 whitespace-pre-wrap leading-relaxed opacity-95 hb-chat-thinking-body">
          {body}
          {m.streaming && (
            <span className="hb-chat-caret" aria-hidden>
              ▍
            </span>
          )}
        </div>
      </details>
    )
  }
  if (m.role === 'tool') {
    const hint = presentFromTool(m.tool?.name || '', undefined, m.tool?.sessionId)
    const label = prettyToolName(m.tool?.name || 'tool')
    const status = m.tool?.status || 'running'
    return (
      <div className="mr-6">
        <div className="hb-chat-tool rounded-xl px-3 py-2.5 text-xs">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-violet font-semibold">{label}</span>
            <span
              className={
                status === 'completed'
                  ? 'text-ok'
                  : status === 'error'
                    ? 'text-danger'
                    : 'text-sky'
              }
            >
              {status === 'completed' ? 'done' : status === 'running' ? 'running…' : status}
            </span>
            {hint && onPresent && (status === 'completed' || m.tool?.sessionId) && (
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
            <p className="mt-1.5 text-[11px] text-mute leading-snug break-words">{m.tool.detail}</p>
          )}
        </div>
        <MsgMeta at={m.at} />
      </div>
    )
  }
  if (m.role === 'file') {
    return (
      <div className="mr-6">
        <div className="hb-chat-file rounded-xl px-3 py-2.5 text-xs shadow-sm">
          <div className="flex items-center gap-2">
            <span className="text-sky font-semibold uppercase text-[10px] tracking-wide">
              {m.file?.action || 'file'}
            </span>
            <span className="text-text truncate flex-1 min-w-0 font-mono text-[11px]">
              {m.file?.path}
            </span>
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
        <MsgMeta at={m.at} />
      </div>
    )
  }
  if (m.role === 'status' || m.role === 'system') {
    const err =
      m.role === 'system' &&
      /^(error|⚠|connection lost|agent run)/i.test((m.text || '').trim())
    const done = m.role === 'status' && /^done\b/i.test((m.text || '').trim())
    return (
      <div
        className={`hb-chat-status flex items-baseline gap-2 px-1 ${
          err ? 'text-danger' : done ? 'text-mute' : 'text-mute'
        }`}
      >
        <span className="text-[11px] leading-snug whitespace-pre-wrap break-words flex-1 min-w-0">
          {m.text}
        </span>
        <MsgMeta at={m.at} />
      </div>
    )
  }
  return (
    <div className="mr-4">
      <div className="hb-chat-assistant rounded-2xl px-3.5 py-3 text-sm leading-relaxed shadow-sm">
        {m.streaming ? (
          <div className="whitespace-pre-wrap break-words">
            {m.text}
            <span className="hb-chat-caret" aria-hidden>
              ▍
            </span>
          </div>
        ) : (
          <div className="markdown-body">
            <ReactMarkdown>{m.text || ''}</ReactMarkdown>
          </div>
        )}
      </div>
      <MsgMeta at={m.at} />
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
  const [connState, setConnState] = useState<WsConnState>('connecting')
  const connStateRef = useRef<WsConnState>('connecting')
  const connected = connState === 'live'
  const [streaming, setStreaming] = useState(false)
  const [error, setError] = useState('')
  const [models, setModels] = useState<CursorModel[]>([])
  const [pendingApprovals, setPendingApprovals] = useState<PendingApproval[]>([])
  const [mode, setMode] = useState<ChatMode>(() => {
    try {
      const saved = (localStorage.getItem(MODE_STORAGE_KEY) || 'agent') as ChatMode
      return CHAT_MODES.some((m) => m.id === saved) ? saved : 'agent'
    } catch {
      return 'agent'
    }
  })
  const [approvalPolicy, setApprovalPolicy] = useState<ApprovalPolicy>(() => {
    try {
      const saved = localStorage.getItem(APPROVAL_STORAGE_KEY) || 'ask'
      return saved === 'auto' ? 'auto' : 'ask'
    } catch {
      return 'ask'
    }
  })
  const [model, setModel] = useState(() => {
    try {
      const saved = localStorage.getItem(MODEL_STORAGE_KEY) || ''
      if (!saved || LEGACY_DEFAULT_MODELS.has(saved)) return ''
      return saved
    } catch {
      return ''
    }
  })
  const [defaultModel, setDefaultModel] = useState('auto')
  const [newOpen, setNewOpen] = useState(false)
  const [deleteId, setDeleteId] = useState<string | null>(null)
  const [pickerDir, setPickerDir] = useState('')
  const [pickerEntries, setPickerEntries] = useState<FsEntry[]>([])
  const [pickingFolder, setPickingFolder] = useState(false)
  const [listening, setListening] = useState(false)
  const [dockOpenLocal, setDockOpenLocal] = useState(() => readDockOpen())
  const canSpeak = useMemo(() => speechSupported(), [])

  const dockOpen = dockOpenProp ?? dockOpenLocal
  function setDockOpen(open: boolean) {
    writeDockOpen(open)
    if (onDockOpenChange) onDockOpenChange(open)
    else setDockOpenLocal(open)
  }

  const notify = useNotifyOptional()
  const wsRef = useRef<WebSocket | null>(null)
  const wsHandleRef = useRef<WsReconnectHandle | null>(null)
  const dockRef = useRef<HTMLElement | null>(null)
  const dockOpenedAt = useRef(0)
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
  connStateRef.current = connState
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
    // Debounce while streaming so every token doesn't hit localStorage
    const delay = streaming ? 750 : 0
    const t = window.setTimeout(() => persistChatTabs(project.id, tabs, activeId), delay)
    return () => window.clearTimeout(t)
  }, [project?.id, tabs, activeId, streaming])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [active?.messages, streaming])

  // Work dock: click outside → minimize (debounce so open-click / near-miss don't bounce)
  useEffect(() => {
    if (!isDock || !dockOpen) return
    dockOpenedAt.current = Date.now()
    const onPointer = (ev: PointerEvent) => {
      if (Date.now() - dockOpenedAt.current < 350) return
      const el = dockRef.current
      const t = ev.target
      if (!(t instanceof Node)) return
      if (el?.contains(t)) return
      if (t instanceof Element && t.closest('.hb-chat-fab')) return
      // Ignore while a dock modal is open
      if (newOpen || deleteId) return
      setDockOpen(false)
    }
    document.addEventListener('pointerdown', onPointer, true)
    return () => document.removeEventListener('pointerdown', onPointer, true)
  }, [isDock, dockOpen, newOpen, deleteId])

  const refreshModels = useCallback(async () => {
    try {
      const data = await api.cursorModels()
      setModels(data.models || [])
      const def = data.default || 'auto'
      setDefaultModel(def)
      setModel((prev) => {
        const ids = new Set((data.models || []).map((m) => m.id))
        // Keep an explicit user pick; otherwise fall through to server default (Auto).
        if (prev && !LEGACY_DEFAULT_MODELS.has(prev) && ids.has(prev)) return prev
        return ''
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
    const projectId = project.id
    const handle = connectWithReconnect({
      url: () => wsUrl(`/ws/cursor?project=${encodeURIComponent(projectId)}`),
      onState: (s) => {
        const prev = connStateRef.current
        connStateRef.current = s
        setConnState(s)
        if (
          (s === 'reconnecting' || s === 'offline') &&
          prev === 'live' &&
          streamingRef.current
        ) {
          setStreaming(false)
          const chatId = activeIdRef.current
          if (chatId) {
            finalizeStreamingBubbles(chatId)
            pushMsg(chatId, {
              id: uid(),
              role: 'system',
              text: 'Connection lost mid-run — socket will reconnect; you can continue this chat.',
            })
          }
          setError('Connection lost mid-run — reconnecting…')
          console.error('[cursor]', 'connection lost mid-run')
        }
      },
      onOpen: (ws) => {
        wsRef.current = ws
        const tab = tabsRef.current.find((t) => t.id === activeIdRef.current)
        ws.send(
          JSON.stringify({
            type: 'bind',
            chatId: activeIdRef.current || 'default',
            cwd: tab?.cwd || '',
          }),
        )
      },
      onMessage: (ev) => {
        try {
          const msg = JSON.parse(ev.data as string)
          const chatId = (msg.chatId as string) || activeIdRef.current
          if (msg.type === 'ready') {
            if (msg.chatId && msg.chatId !== activeIdRef.current) return
            patchTab(chatId, (t) => ({ ...t, agentId: msg.cursor?.agentId || null }))
            if (msg.cursor?.mode) {
              const m = String(msg.cursor.mode) as ChatMode
              if (CHAT_MODES.some((x) => x.id === m)) setMode(m)
            }
            if (msg.approvalPolicy === 'auto' || msg.approvalPolicy === 'ask') {
              setApprovalPolicy(msg.approvalPolicy)
            }
            if (Array.isArray(msg.pendingApprovals)) {
              setPendingApprovals(msg.pendingApprovals as PendingApproval[])
            }
            if (msg.cursor?.running) setStreaming(true)
            if (!msg.cursor?.configured) {
              setError(
                'Cursor key missing on this server. On the host, put CURSOR_API_KEY in .env then run ./build.sh --deploy (or restart homebased after syncing /var/lib/homebased/.env).',
              )
            }
          } else if (msg.type === 'running') {
            setStreaming(true)
            setError('Agent still working — wait or press Stop.')
          } else if (msg.type === 'approval') {
            const ap: PendingApproval = {
              id: String(msg.id || ''),
              kind: String(msg.kind || 'tool'),
              tool: String(msg.tool || 'tool'),
              detail: String(msg.detail || ''),
              command: msg.command ? String(msg.command) : undefined,
              cwd: msg.cwd ? String(msg.cwd) : undefined,
              chatId: msg.chatId ? String(msg.chatId) : undefined,
              createdAt: typeof msg.createdAt === 'number' ? msg.createdAt : Date.now() / 1000,
            }
            if (ap.id) {
              setPendingApprovals((prev) =>
                prev.some((p) => p.id === ap.id) ? prev : [...prev, ap],
              )
            }
          } else if (msg.type === 'approval-resolved' || msg.type === 'approval-ack') {
            const id = String(msg.id || '')
            if (id) setPendingApprovals((prev) => prev.filter((p) => p.id !== id))
          } else if (msg.type === 'approval-policy') {
            if (msg.policy === 'auto' || msg.policy === 'ask') setApprovalPolicy(msg.policy)
          } else if (msg.type === 'agent') {
            patchTab(chatId, (t) => ({ ...t, agentId: msg.agentId }))
          } else if (msg.type === 'run') {
            setStreaming(true)
          } else if (msg.type === 'text-delta' || msg.type === 'text') {
            assistantBuf.current += msg.text || ''
            pushAssistant(chatId, assistantBuf.current, true)
          } else if (msg.type === 'thinking-delta') {
            appendThinking(chatId, msg.text || '')
          } else if (msg.type === 'thinking-completed') {
            finishThinking(chatId)
          } else if (msg.type === 'tool-delta') {
            upsertTool(chatId, {
              callId: msg.callId ? String(msg.callId) : undefined,
              name: String(msg.name || 'tool'),
              status: String(msg.status || 'running'),
              args: msg.args,
              file: msg.file,
            })
          } else if (msg.type === 'status-delta') {
            /* light activity — avoid spamming status rows for every step */
          } else if (msg.type === 'message') {
            handleSdkMessage(chatId, msg.message)
          } else if (msg.type === 'done') {
            const wasStreaming = streamingRef.current
            setStreaming(false)
            finalizeStreamingBubbles(chatId)
            assistantBuf.current = ''
            const err =
              String(msg.status || '').toLowerCase() === 'error' ||
              String(msg.status || '').toLowerCase() === 'failed'
            if (err) {
              const detail = `Agent run ended with error (${msg.status}) — you can continue this chat.`
              setError(detail)
              pushMsg(chatId, { id: uid(), role: 'system', text: detail })
              console.error('[cursor]', detail, msg)
            } else {
              setError('')
            }
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
            setStreaming(false)
            finalizeStreamingBubbles(chatId)
            assistantBuf.current = ''
            const detail = String(msg.error || 'Agent error')
            const tip = msg.busy
              ? detail
              : `${detail} — chat is still open; cancel if stuck, then send again.`
            setError(tip)
            pushMsg(chatId, { id: uid(), role: 'system', text: `⚠ ${tip}` })
            console.error('[cursor]', tip, msg)
            if (notifyRef.current) {
              notifyRef.current.ping({
                title: 'Cursor error',
                body: tip.slice(0, 160),
                level: 'error',
                category: 'cursor',
              })
            }
          } else if (msg.type === 'cancelled') {
            setStreaming(false)
            finalizeStreamingBubbles(chatId)
            assistantBuf.current = ''
            pushMsg(chatId, {
              id: uid(),
              role: 'system',
              text: 'Run cancelled — you can continue this chat.',
            })
          }
        } catch {
          /* ignore */
        }
      },
    })
    wsHandleRef.current = handle

    return () => {
      handle.dispose()
      if (wsHandleRef.current === handle) wsHandleRef.current = null
      wsRef.current = null
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

  function pushAssistant(chatId: string, text: string, live = false) {
    patchTab(chatId, (t) => {
      const msgs = [...t.messages]
      const last = msgs[msgs.length - 1]
      if (last?.role === 'assistant') {
        msgs[msgs.length - 1] = { ...last, text, streaming: live }
        return { ...t, messages: msgs }
      }
      return {
        ...t,
        messages: [...msgs, { id: uid(), role: 'assistant', text, streaming: live }],
      }
    })
  }

  function appendThinking(chatId: string, chunk: string) {
    if (!chunk) return
    patchTab(chatId, (t) => {
      const msgs = [...t.messages]
      const last = msgs[msgs.length - 1]
      if (last?.role === 'thinking') {
        msgs[msgs.length - 1] = {
          ...last,
          text: (last.text || '') + chunk,
          streaming: true,
        }
        return { ...t, messages: msgs }
      }
      return {
        ...t,
        messages: [
          ...msgs,
          { id: uid(), role: 'thinking', text: chunk, streaming: true },
        ],
      }
    })
  }

  function finishThinking(chatId: string) {
    patchTab(chatId, (t) => {
      const msgs = [...t.messages]
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].role === 'thinking' && msgs[i].streaming) {
          msgs[i] = { ...msgs[i], streaming: false }
          break
        }
      }
      return { ...t, messages: msgs }
    })
  }

  function finalizeStreamingBubbles(chatId: string) {
    patchTab(chatId, (t) => ({
      ...t,
      messages: t.messages.map((m) =>
        m.streaming ? { ...m, streaming: false } : m,
      ),
    }))
  }

  function upsertTool(
    chatId: string,
    opts: {
      callId?: string
      name: string
      status: string
      args?: unknown
      file?: { path: string; action: string }
    },
  ) {
    const detail =
      typeof opts.args === 'string'
        ? opts.args
        : opts.args
          ? JSON.stringify(opts.args).slice(0, 400)
          : undefined
    let newlyCompleted = false
    patchTab(chatId, (t) => {
      const msgs = [...t.messages]
      const idx = opts.callId
        ? msgs.findIndex((m) => m.role === 'tool' && m.tool?.callId === opts.callId)
        : -1
      const prevStatus = idx >= 0 ? msgs[idx].tool?.status : undefined
      const tool = {
        name: opts.name,
        status: opts.status,
        detail: detail ?? (idx >= 0 ? msgs[idx].tool?.detail : undefined),
        callId: opts.callId,
      }
      if (idx >= 0) {
        msgs[idx] = { ...msgs[idx], tool }
      } else {
        msgs.push({ id: uid(), role: 'tool', tool })
      }
      newlyCompleted = opts.status === 'completed' && prevStatus !== 'completed'
      if (newlyCompleted && opts.file?.path) {
        const already = msgs.some(
          (m) => m.role === 'file' && m.file?.path === opts.file!.path,
        )
        if (!already) {
          msgs.push({ id: uid(), role: 'file', file: opts.file })
        }
      }
      return { ...t, messages: msgs }
    })
    if (newlyCompleted && opts.file?.path) {
      onPresentRef.current?.({ scene: 'files', path: opts.file.path })
    }
    const shellHint = presentFromTool(opts.name)
    if (shellHint && newlyCompleted) {
      onPresentRef.current?.(shellHint)
    }
  }

  function handleSdkMessage(
    chatId: string,
    message: {
      type?: string
      text?: string
      name?: string
      status?: string
      callId?: string
      call_id?: string
      args?: unknown
      file?: { path: string; action: string }
      content?: { type: string; text?: string }[]
    },
  ) {
    const mtype = message?.type
    if (mtype === 'thinking') {
      // Complete thinking snapshot — replace last thinking bubble (don't stack)
      patchTab(chatId, (t) => {
        const msgs = [...t.messages]
        const last = msgs[msgs.length - 1]
        const text = message.text || ''
        if (last?.role === 'thinking') {
          msgs[msgs.length - 1] = { ...last, text, streaming: false }
          return { ...t, messages: msgs }
        }
        return {
          ...t,
          messages: [...msgs, { id: uid(), role: 'thinking', text, streaming: false }],
        }
      })
      return
    }
    if (mtype === 'tool_call') {
      upsertTool(chatId, {
        callId: message.callId || message.call_id,
        name: message.name || 'tool',
        status: String(message.status || 'running'),
        args: message.args,
        file: message.file,
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
      // Final assistant snapshot after deltas — replace, don't double-append
      if (
        assistantBuf.current &&
        (text.startsWith(assistantBuf.current.slice(0, Math.min(40, assistantBuf.current.length))) ||
          assistantBuf.current.startsWith(text.slice(0, Math.min(40, text.length))))
      ) {
        assistantBuf.current = text
      } else if (!assistantBuf.current) {
        assistantBuf.current = text
      } else {
        assistantBuf.current += text
      }
      pushAssistant(chatId, assistantBuf.current, false)
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

  function chooseMode(next: ChatMode) {
    setMode(next)
    try {
      localStorage.setItem(MODE_STORAGE_KEY, next)
    } catch {
      /* ignore */
    }
  }

  function chooseApprovalPolicy(next: ApprovalPolicy) {
    setApprovalPolicy(next)
    try {
      localStorage.setItem(APPROVAL_STORAGE_KEY, next)
    } catch {
      /* ignore */
    }
    wsRef.current?.send(JSON.stringify({ type: 'approval_policy', policy: next }))
  }

  function decideApproval(id: string, decision: 'allow' | 'deny') {
    wsRef.current?.send(JSON.stringify({ type: 'approve', id, decision }))
    setPendingApprovals((prev) => prev.filter((p) => p.id !== id))
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
        mode,
        approvalPolicy,
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
      : [
          {
            id: model || defaultModel || 'auto',
            displayName:
              (model || defaultModel || 'auto').toLowerCase() === 'auto'
                ? 'Auto'
                : model || defaultModel || 'auto',
            description: '',
          },
        ]

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
            <button
              type="button"
              title={connected ? 'Cursor agent socket live' : 'Tap to reconnect'}
              onClick={() => {
                if (!connected) wsHandleRef.current?.reconnect()
              }}
              className={`text-[10px] shrink-0 px-2 py-1 rounded-md border font-semibold ${
                connected
                  ? 'text-ok border-ok/30 bg-ok/10'
                  : connState === 'reconnecting' || connState === 'connecting'
                    ? 'text-amber border-amber/30 bg-amber/10'
                    : 'text-danger border-danger/30 bg-danger/10'
              }`}
            >
              {connStateLabel(connState)}
            </button>
          </div>
        )}

        <div className="flex items-center gap-1.5 relative">
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

        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Mode">
          {CHAT_MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              title={m.title}
              disabled={streaming}
              onClick={() => chooseMode(m.id)}
              className={`px-2 py-1 rounded-md text-[11px] font-semibold border transition-colors disabled:opacity-40 ${
                mode === m.id
                  ? 'border-accent/50 bg-accent/15 text-accent'
                  : 'border-line bg-panel-2 text-mute hover:text-text'
              }`}
            >
              {m.label}
            </button>
          ))}
          <button
            type="button"
            title={
              approvalPolicy === 'ask'
                ? 'Tools/shell require Allow before running (safer)'
                : 'Tools run automatically (like trusted IDE workspace)'
            }
            disabled={streaming}
            onClick={() => chooseApprovalPolicy(approvalPolicy === 'ask' ? 'auto' : 'ask')}
            className={`ml-auto px-2 py-1 rounded-md text-[10px] font-semibold border disabled:opacity-40 ${
              approvalPolicy === 'ask'
                ? 'border-amber/40 bg-amber/10 text-amber'
                : 'border-ok/40 bg-ok/10 text-ok'
            }`}
          >
            {approvalPolicy === 'ask' ? 'Ask before tools' : 'Auto-run tools'}
          </button>
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
            <button
              type="button"
              title={connected ? 'Cursor agent socket live' : 'Tap to reconnect'}
              onClick={() => {
                if (!connected) wsHandleRef.current?.reconnect()
              }}
              className={`text-[10px] shrink-0 px-1.5 py-0.5 rounded border font-semibold ${
                connected
                  ? 'text-ok border-ok/30 bg-ok/10'
                  : connState === 'reconnecting' || connState === 'connecting'
                    ? 'text-amber border-amber/30 bg-amber/10'
                    : 'text-danger border-danger/30 bg-danger/10'
              }`}
            >
              {connStateLabel(connState)}
            </button>
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
      {pendingApprovals.map((ap) => (
        <div
          key={ap.id}
          className="rounded-xl border border-amber/40 bg-amber/10 px-3 py-2.5 space-y-2 mr-4"
        >
          <div className="flex items-center gap-2 text-xs font-semibold">
            <span className="text-amber uppercase tracking-wide text-[10px]">
              Pending approval
            </span>
            <span className="font-mono text-text">{ap.tool}</span>
          </div>
          <pre className="text-[11px] font-mono text-mute whitespace-pre-wrap break-all max-h-28 overflow-auto">
            {ap.command || ap.detail || ap.tool}
          </pre>
          <div className="flex gap-2">
            <button
              type="button"
              className="flex-1 rounded-lg hb-btn-primary text-xs font-semibold py-1.5 border-0"
              onClick={() => decideApproval(ap.id, 'allow')}
            >
              Allow
            </button>
            <button
              type="button"
              className="flex-1 rounded-lg border border-danger/50 text-danger text-xs font-semibold py-1.5"
              onClick={() => decideApproval(ap.id, 'deny')}
            >
              Deny
            </button>
          </div>
        </div>
      ))}
      {streaming && (
        <p className="text-xs font-mono text-accent animate-pulse">
          {pendingApprovals.length ? 'waiting for approval…' : 'agent working…'}
        </p>
      )}
      {error && <p className="text-sm text-danger">{error}</p>}
      <div ref={bottomRef} />
    </div>
  )

  const composer = (
    <form
      onSubmit={send}
      className={`hb-chat-composer shrink-0 border-t border-line px-3 pt-3 space-y-2 ${
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
            enterKeyHint="send"
            autoComplete="off"
            onFocus={() => {
              // Keep the fixed shell aligned with the visual viewport above the keyboard.
              window.scrollTo(0, 0)
              requestAnimationFrame(() => window.scrollTo(0, 0))
            }}
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
              className="rounded-xl border border-danger/50 text-danger text-xs py-2 font-semibold"
            >
              Stop
            </button>
          )}
        </div>
      </div>
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
      <>
        <button
          type="button"
          className="hb-chat-dock-scrim"
          aria-label="Minimize chat"
          onClick={() => setDockOpen(false)}
        />
        <aside ref={dockRef} className="hb-chat-dock" aria-label="Work chat">
          {modals}
          {header}
          {messages}
          {composer}
        </aside>
      </>
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
