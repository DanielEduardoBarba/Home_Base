import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { useEffect, useRef, useState } from 'react'
import { Terminal as XTerm } from 'xterm'
import { wsUrl } from '../lib/api'
import {
  connStateLabel,
  connectWithReconnect,
  type WsConnState,
  type WsReconnectHandle,
} from '../lib/wsReconnect'

type Props = {
  /** Interactive shell WS path, e.g. /ws/pty?project=<id> */
  path: string
  /** Or attach to existing session */
  sessionId?: string
  onSession?: (id: string) => void
  className?: string
}

function safeDims(fit: FitAddon): { cols: number; rows: number } | null {
  const dims = fit.proposeDimensions()
  if (!dims) return null
  const cols = Math.floor(dims.cols)
  const rows = Math.floor(dims.rows)
  if (cols < 2 || rows < 2) return null
  return { cols, rows }
}

export function TerminalView({ path, sessionId, onSession, className }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<XTerm | null>(null)
  const handleRef = useRef<WsReconnectHandle | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const onSessionRef = useRef(onSession)
  const [connState, setConnState] = useState<WsConnState>('connecting')
  const endedRef = useRef(false)
  const announcedRef = useRef(false)
  const reconnectNoteAt = useRef(0)

  useEffect(() => {
    onSessionRef.current = onSession
  }, [onSession])

  useEffect(() => {
    if (!hostRef.current) return
    endedRef.current = false
    announcedRef.current = false

    const term = new XTerm({
      cursorBlink: true,
      fontFamily: '"IBM Plex Mono", ui-monospace, monospace',
      fontSize: 13,
      lineHeight: 1.25,
      theme: {
        background: '#0c1524',
        foreground: '#f4f8ff',
        cursor: '#2ee6c8',
        selectionBackground: '#2ee6c844',
        black: '#0c1524',
        brightBlack: '#6b829e',
        green: '#4ade80',
        cyan: '#2ee6c8',
        yellow: '#fbbf24',
        red: '#fb7185',
        blue: '#38bdf8',
        magenta: '#a78bfa',
      },
      allowProposedApi: true,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon())
    term.open(hostRef.current)
    // Defer fit until layout has a real size (flex panes often start at 0).
    requestAnimationFrame(() => {
      try {
        fit.fit()
      } catch {
        /* ignore */
      }
    })
    termRef.current = term
    fitRef.current = fit

    const sendResize = (sock: WebSocket) => {
      const dims = safeDims(fit)
      if (!dims || sock.readyState !== WebSocket.OPEN) return
      sock.send(JSON.stringify({ type: 'resize', cols: dims.cols, rows: dims.rows }))
    }

    const handle = connectWithReconnect({
      url: () => (sessionId ? wsUrl(`/ws/session/${sessionId}`) : wsUrl(path)),
      onState: (s) => {
        setConnState(s)
        if (s === 'reconnecting' && !endedRef.current) {
          const now = Date.now()
          // Rate-limit banner spam during a reconnect storm
          if (now - reconnectNoteAt.current > 2500) {
            reconnectNoteAt.current = now
            term.writeln('\r\n\x1b[33m[reconnecting…]\x1b[0m')
          }
        }
      },
      onOpen: (ws) => {
        endedRef.current = false
        // Give the flex layout a tick, then fit + resize
        requestAnimationFrame(() => {
          try {
            fit.fit()
          } catch {
            /* ignore */
          }
          sendResize(ws)
        })
      },
      onMessage: (ev) => {
        try {
          const msg = JSON.parse(ev.data as string)
          if (msg.type === 'output' && typeof msg.data === 'string') {
            term.write(msg.data)
          } else if (msg.type === 'ready' && msg.session?.id) {
            onSessionRef.current?.(msg.session.id)
            if (!announcedRef.current) {
              announcedRef.current = true
              term.writeln(`\x1b[90m# session ${msg.session.id}\x1b[0m`)
            }
          } else if (msg.type === 'exit') {
            endedRef.current = true
            term.writeln('\r\n\x1b[33m[session ended]\x1b[0m')
            // Managed attach: stop reconnecting — the process is gone.
            // Interactive PTY: also stop; user taps Live badge / opens a new shell.
            handle.dispose()
            setConnState('offline')
          } else if (msg.type === 'error') {
            term.writeln(`\r\n\x1b[31m${msg.error}\x1b[0m`)
            // Fatal attach errors (session not found) — don't spin forever
            if (sessionId && /not found|unknown/i.test(String(msg.error || ''))) {
              endedRef.current = true
              handle.dispose()
              setConnState('offline')
            }
          }
        } catch {
          term.write(String(ev.data))
        }
      },
    })
    handleRef.current = handle

    const disposable = term.onData((data) => {
      const sock = handle.getSocket()
      if (sock?.readyState === WebSocket.OPEN) {
        sock.send(JSON.stringify({ type: 'input', data }))
      }
    })

    let roTimer: ReturnType<typeof setTimeout> | undefined
    const ro = new ResizeObserver(() => {
      // Debounce — flex layout + xterm can fire dozens of RO events
      if (roTimer) clearTimeout(roTimer)
      roTimer = setTimeout(() => {
        try {
          fit.fit()
        } catch {
          /* ignore */
        }
        const sock = handle.getSocket()
        if (sock) sendResize(sock)
      }, 50)
    })
    ro.observe(hostRef.current)

    return () => {
      if (roTimer) clearTimeout(roTimer)
      disposable.dispose()
      ro.disconnect()
      handle.dispose()
      handleRef.current = null
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [path, sessionId])

  function sendCtrl(letter: string) {
    const code = String.fromCharCode(letter.toUpperCase().charCodeAt(0) - 64)
    const sock = handleRef.current?.getSocket()
    if (sock?.readyState === WebSocket.OPEN) {
      sock.send(JSON.stringify({ type: 'input', data: code }))
    }
    termRef.current?.focus()
  }

  function sendRaw(data: string) {
    const sock = handleRef.current?.getSocket()
    if (sock?.readyState === WebSocket.OPEN) {
      sock.send(JSON.stringify({ type: 'input', data }))
    }
    termRef.current?.focus()
  }

  const live = connState === 'live'

  return (
    <div className={`flex flex-col min-h-0 ${className || ''}`}>
      <div className="flex gap-2 px-2 py-2 border-b border-line bg-panel/80 overflow-x-auto shrink-0 items-center">
        {(['C', 'D', 'Z', 'L']).map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => sendCtrl(k)}
            disabled={!live}
            className="px-3 py-1.5 rounded-lg bg-panel-2 border border-line text-xs font-mono text-mute active:border-accent disabled:opacity-40"
          >
            Ctrl+{k}
          </button>
        ))}
        <button
          type="button"
          onClick={() => sendRaw('\x1b')}
          disabled={!live}
          className="px-3 py-1.5 rounded-lg bg-panel-2 border border-line text-xs font-mono text-mute disabled:opacity-40"
        >
          Esc
        </button>
        <button
          type="button"
          onClick={() => sendRaw('\t')}
          disabled={!live}
          className="px-3 py-1.5 rounded-lg bg-panel-2 border border-line text-xs font-mono text-mute disabled:opacity-40"
        >
          Tab
        </button>
        <button
          type="button"
          title={live ? 'Shell socket live' : 'Tap to reconnect'}
          onClick={() => {
            if (!live && !endedRef.current) handleRef.current?.reconnect()
          }}
          className={`ml-auto text-[10px] shrink-0 px-2 py-1 rounded-md border font-semibold ${
            live
              ? 'text-ok border-ok/30 bg-ok/10'
              : connState === 'reconnecting' || connState === 'connecting'
                ? 'text-amber border-amber/30 bg-amber/10'
                : 'text-danger border-danger/30 bg-danger/10'
          }`}
        >
          {connStateLabel(connState)}
        </button>
      </div>
      <div ref={hostRef} className="flex-1 min-h-0 p-2" onClick={() => termRef.current?.focus()} />
    </div>
  )
}
