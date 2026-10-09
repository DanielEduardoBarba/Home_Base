import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import { useSceneRefresh } from '../lib/sceneRefresh'
import type { TraceLine } from '../lib/types'

const MAX = 300

type LogFilter = 'all' | 'server' | 'web' | 'cursor' | 'journald'

function levelClass(level: string): string {
  if (level === 'error') return 'text-danger'
  if (level === 'warn' || level === 'warning') return 'text-warn'
  if (level === 'debug') return 'text-mute'
  return 'text-text'
}

function sourceClass(source: string): string {
  if (source === 'web') return 'text-sky'
  if (source === 'cursor') return 'text-violet'
  if (source === 'journald') return 'text-amber'
  return 'text-mute'
}

function formatTs(ts: number): string {
  if (!ts) return ''
  try {
    return new Date(ts * 1000).toLocaleTimeString()
  } catch {
    return ''
  }
}

function lineText(l: TraceLine): string {
  return `${formatTs(l.ts)}\t${l.source || 'server'}\t${l.level}\t${l.message}`
}

/**
 * Shared ring (server / web / cursor) + Journald category for homebased unit.
 * Cap = 300 on both ends — no unbounded arrays in the UI.
 */
export function LogsTab() {
  const [lines, setLines] = useState<TraceLine[]>([])
  const [journalLines, setJournalLines] = useState<TraceLine[]>([])
  const [filter, setFilter] = useState<LogFilter>('all')
  const [error, setError] = useState('')
  const [paused, setPaused] = useState(false)
  const [copied, setCopied] = useState('')
  const stickBottom = useRef(true)
  const listRef = useRef<HTMLDivElement>(null)

  const load = useCallback(async () => {
    if (paused) return
    try {
      if (filter === 'journald') {
        const data = await api.traceJournal(MAX)
        setJournalLines(data.items.slice(-MAX))
        setError(data.error || '')
      } else {
        const data = await api.trace(MAX)
        setLines(data.items.slice(-MAX))
        setError('')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [paused, filter])

  useSceneRefresh(load)

  useEffect(() => {
    void load()
    const t = setInterval(() => void load(), filter === 'journald' ? 4000 : 2000)
    return () => clearInterval(t)
  }, [load, filter])

  const visible =
    filter === 'journald'
      ? journalLines
      : lines.filter((l) => {
          if (filter === 'all') return true
          return (l.source || 'server') === filter
        })

  useEffect(() => {
    if (!stickBottom.current || !listRef.current) return
    listRef.current.scrollTop = listRef.current.scrollHeight
  }, [visible])

  async function copyVisible() {
    const text = visible.map(lineText).join('\n')
    if (!text) {
      setCopied('nothing to copy')
      setTimeout(() => setCopied(''), 1500)
      return
    }
    try {
      await navigator.clipboard.writeText(text)
      setCopied(`copied ${visible.length}`)
    } catch {
      setCopied('clipboard blocked')
    }
    setTimeout(() => setCopied(''), 2000)
  }

  async function copyOne(l: TraceLine) {
    try {
      await navigator.clipboard.writeText(lineText(l))
      setCopied('line copied')
    } catch {
      setCopied('clipboard blocked')
    }
    setTimeout(() => setCopied(''), 1500)
  }

  return (
    <div className="h-full flex flex-col min-h-0 hb-with-nav">
      <div className="hb-chrome shrink-0">
        <div className="hb-chrome-inner space-y-2">
          <div className="flex flex-wrap gap-2 items-center">
            <h1 className="font-display font-bold text-base mr-auto tracking-tight">Logs</h1>
            <select
              value={filter}
              onChange={(e) => {
                stickBottom.current = true
                setFilter(e.target.value as LogFilter)
              }}
              className="hb-select !min-h-9 py-1.5 text-xs"
            >
              <option value="all">All</option>
              <option value="server">Server</option>
              <option value="web">Web</option>
              <option value="cursor">Cursor</option>
              <option value="journald">Journald</option>
            </select>
            <button
              type="button"
              onClick={() => setPaused((p) => !p)}
              className={`hb-btn text-xs !min-h-9 px-3 ${paused ? 'hb-btn-primary' : 'hb-btn-ghost'}`}
            >
              {paused ? 'Resume' : 'Pause'}
            </button>
            <button
              type="button"
              onClick={() => void copyVisible()}
              className="hb-btn hb-btn-ghost text-xs !min-h-9 px-3"
              title="Copy visible lines"
            >
              {copied || 'Copy'}
            </button>
          </div>
          <p className="text-[11px] font-mono text-mute">
            {filter === 'journald'
              ? `journalctl -u homebased · max ${MAX} · tap a line to copy`
              : `Shared ring · max ${MAX} · python + browser + cursor · tap a line to copy`}
          </p>
          {error && <p className="text-danger text-xs">{error}</p>}
        </div>
      </div>

      <div
        ref={listRef}
        className="flex-1 min-h-0 overflow-y-auto px-3 py-2 sm:px-5 max-w-[56rem] mx-auto w-full"
        onScroll={(e) => {
          const el = e.currentTarget
          stickBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
        }}
      >
        <ul className="font-mono text-[11px] leading-relaxed space-y-0.5">
          {visible.length === 0 && (
            <li className="text-mute py-6 text-center">No log lines yet.</li>
          )}
          {visible.map((l, idx) => (
            <li key={`${l.source}-${l.id}-${idx}`}>
              <button
                type="button"
                onClick={() => void copyOne(l)}
                className="w-full flex gap-2 border-b border-line/35 py-1.5 text-left hover:bg-panel-2/80 rounded-md px-1"
                title="Copy line"
              >
                <span className="text-mute shrink-0 w-[4.5rem]">{formatTs(l.ts) || '—'}</span>
                <span className={`shrink-0 w-16 uppercase ${sourceClass(l.source || 'server')}`}>
                  {l.source || 'server'}
                </span>
                <span className={`shrink-0 w-12 uppercase ${levelClass(l.level)}`}>{l.level}</span>
                <span className={`min-w-0 break-all ${levelClass(l.level)}`}>{l.message}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
