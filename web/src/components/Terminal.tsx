import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { useEffect, useRef } from 'react'
import { Terminal as XTerm } from 'xterm'
import { wsUrl } from '../lib/api'

type Props = {
  /** Interactive shell WS path, e.g. /ws/pty?project=<id> */
  path: string
  /** Or attach to existing session */
  sessionId?: string
  onSession?: (id: string) => void
  className?: string
}

export function TerminalView({ path, sessionId, onSession, className }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<XTerm | null>(null)
  const wsRef = useRef<WebSocket | null>(null)

  useEffect(() => {
    if (!hostRef.current) return
    const term = new XTerm({
      cursorBlink: true,
      fontFamily: '"IBM Plex Mono", ui-monospace, monospace',
      fontSize: 13,
      lineHeight: 1.25,
      theme: {
        background: '#0c1117',
        foreground: '#e8eef7',
        cursor: '#2dd4bf',
        selectionBackground: '#2dd4bf44',
        black: '#0c1117',
        brightBlack: '#5a6a80',
        green: '#34d399',
        cyan: '#2dd4bf',
        yellow: '#fbbf24',
        red: '#f87171',
        blue: '#60a5fa',
        magenta: '#c084fc',
      },
      allowProposedApi: true,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon())
    term.open(hostRef.current)
    fit.fit()
    termRef.current = term

    const url = sessionId
      ? wsUrl(`/ws/session/${sessionId}`)
      : wsUrl(path)
    const ws = new WebSocket(url)
    wsRef.current = ws

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data)
        if (msg.type === 'output' && typeof msg.data === 'string') {
          term.write(msg.data)
        } else if (msg.type === 'ready' && msg.session?.id) {
          onSession?.(msg.session.id)
          term.writeln(`\x1b[90m# session ${msg.session.id}\x1b[0m`)
        } else if (msg.type === 'exit') {
          term.writeln('\r\n\x1b[33m[session ended]\x1b[0m')
        } else if (msg.type === 'error') {
          term.writeln(`\r\n\x1b[31m${msg.error}\x1b[0m`)
        }
      } catch {
        term.write(ev.data)
      }
    }

    ws.onopen = () => {
      const dims = fit.proposeDimensions()
      if (dims) {
        ws.send(JSON.stringify({ type: 'resize', cols: dims.cols, rows: dims.rows }))
      }
    }

    const disposable = term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'input', data }))
      }
    })

    const ro = new ResizeObserver(() => {
      fit.fit()
      const dims = fit.proposeDimensions()
      if (dims && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols: dims.cols, rows: dims.rows }))
      }
    })
    ro.observe(hostRef.current)

    return () => {
      disposable.dispose()
      ro.disconnect()
      ws.close()
      term.dispose()
      termRef.current = null
      wsRef.current = null
    }
  }, [path, sessionId, onSession])

  function sendCtrl(letter: string) {
    const code = String.fromCharCode(letter.toUpperCase().charCodeAt(0) - 64)
    wsRef.current?.send(JSON.stringify({ type: 'input', data: code }))
    termRef.current?.focus()
  }

  return (
    <div className={`flex flex-col min-h-0 ${className || ''}`}>
      <div className="flex gap-2 px-2 py-2 border-b border-line bg-panel/80 overflow-x-auto shrink-0">
        {(['C', 'D', 'Z', 'L']).map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => sendCtrl(k)}
            className="px-3 py-1.5 rounded-lg bg-panel-2 border border-line text-xs font-mono text-mute active:border-accent"
          >
            Ctrl+{k}
          </button>
        ))}
        <button
          type="button"
          onClick={() => {
            wsRef.current?.send(JSON.stringify({ type: 'input', data: '\x1b' }))
            termRef.current?.focus()
          }}
          className="px-3 py-1.5 rounded-lg bg-panel-2 border border-line text-xs font-mono text-mute"
        >
          Esc
        </button>
        <button
          type="button"
          onClick={() => {
            wsRef.current?.send(JSON.stringify({ type: 'input', data: '\t' }))
            termRef.current?.focus()
          }}
          className="px-3 py-1.5 rounded-lg bg-panel-2 border border-line text-xs font-mono text-mute"
        >
          Tab
        </button>
      </div>
      <div ref={hostRef} className="flex-1 min-h-0 p-2" onClick={() => termRef.current?.focus()} />
    </div>
  )
}
