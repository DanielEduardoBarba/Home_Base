import { useEffect, useRef, useState, type FormEvent } from 'react'
import ReactMarkdown from 'react-markdown'
import { api, wsUrl } from '../lib/api'
import type { Project } from '../lib/types'

type ChatMsg = {
  id: string
  role: 'user' | 'assistant' | 'system'
  text: string
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
  const [messages, setMessages] = useState<ChatMsg[]>([])
  const [input, setInput] = useState('')
  const [connected, setConnected] = useState(false)
  const [streaming, setStreaming] = useState(false)
  const [agentId, setAgentId] = useState<string | null>(null)
  const [error, setError] = useState('')
  const wsRef = useRef<WebSocket | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const assistantBuf = useRef('')

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, streaming])

  useEffect(() => {
    if (!project) return
    setMessages([])
    setError('')
    setAgentId(project.cursor?.agentId || null)
    const ws = new WebSocket(wsUrl(`/ws/cursor?project=${project.id}`))
    wsRef.current = ws

    ws.onopen = () => setConnected(true)
    ws.onclose = () => setConnected(false)
    ws.onerror = () => setError('Cursor socket error')

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data)
        if (msg.type === 'ready') {
          setAgentId(msg.cursor?.agentId || null)
          if (!msg.cursor?.configured) {
            setError('CURSOR_API_KEY not set on server')
          }
        } else if (msg.type === 'agent') {
          setAgentId(msg.agentId)
        } else if (msg.type === 'text') {
          assistantBuf.current += msg.text || ''
          pushAssistant(assistantBuf.current)
        } else if (msg.type === 'message') {
          const blocks = msg.message?.content || []
          const text = blocks
            .filter((b: { type: string }) => b.type === 'text')
            .map((b: { text: string }) => b.text)
            .join('')
          const mtype = msg.message?.type
          if (mtype === 'assistant' || text) {
            if (text) {
              assistantBuf.current += text
              pushAssistant(assistantBuf.current)
            }
          } else if (mtype === 'tool_call' || mtype === 'thinking') {
            // light system breadcrumb
            setMessages((prev) => [
              ...prev,
              {
                id: crypto.randomUUID(),
                role: 'system',
                text: `_${mtype}_`,
              },
            ])
          }
        } else if (msg.type === 'done') {
          setStreaming(false)
          assistantBuf.current = ''
          if (msg.status === 'error') {
            setError('Agent run ended with error')
          }
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
  }, [project?.id])

  function pushAssistant(text: string) {
    setMessages((prev) => {
      const last = prev[prev.length - 1]
      if (last?.role === 'assistant') {
        return [...prev.slice(0, -1), { ...last, text }]
      }
      return [...prev, { id: crypto.randomUUID(), role: 'assistant', text }]
    })
  }

  function send(e: FormEvent) {
    e.preventDefault()
    const prompt = input.trim()
    if (!prompt || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return
    setError('')
    setStreaming(true)
    assistantBuf.current = ''
    setMessages((prev) => [...prev, { id: crypto.randomUUID(), role: 'user', text: prompt }])
    setInput('')
    wsRef.current.send(JSON.stringify({ type: 'send', prompt }))
  }

  function cancel() {
    wsRef.current?.send(JSON.stringify({ type: 'cancel' }))
  }

  async function reset() {
    if (!project) return
    await api.resetCursor(project.id)
    wsRef.current?.send(JSON.stringify({ type: 'reset' }))
    setMessages([])
    setAgentId(null)
  }

  if (!project) return null

  return (
    <div className="h-full flex flex-col min-h-0 pb-16">
      <div className="shrink-0 px-3 pt-3 pb-2 border-b border-line/80 bg-panel/50 backdrop-blur-md space-y-2">
        <div className="flex gap-2">
          <select
            value={project.id}
            onChange={(e) => onSelect(e.target.value)}
            className="hb-select flex-1"
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={reset}
            className="rounded-xl border border-line px-3 py-2 text-xs text-mute hover:text-text"
          >
            Reset
          </button>
        </div>
        <div className="flex items-center justify-between text-[11px] font-mono text-mute">
          <span>
            {connected ? (
              <span className="text-ok">live</span>
            ) : (
              <span className="text-danger">offline</span>
            )}{' '}
            · local agent · {project.name}
          </span>
          <span className="truncate max-w-[45%]">{agentId || 'new session'}</span>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-3">
        {messages.length === 0 && (
          <p className="text-mute text-sm leading-relaxed mt-6 max-w-md">
            Chat with a local Cursor agent in this workspace. Ask it to edit code, then use Apps or
            Shell to restart services.
          </p>
        )}
        {messages.map((m) => (
          <div
            key={m.id}
            className={`rounded-2xl px-3.5 py-3 text-sm leading-relaxed ${
              m.role === 'user'
                ? 'bg-accent/15 border border-accent/30 ml-6'
                : m.role === 'system'
                  ? 'text-mute text-xs font-mono'
                  : 'bg-panel/90 border border-line/80 mr-4'
            }`}
          >
            {m.role === 'assistant' ? (
              <div className="markdown-body">
                <ReactMarkdown>{m.text}</ReactMarkdown>
              </div>
            ) : (
              m.text
            )}
          </div>
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
          placeholder="Message Cursor…"
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
