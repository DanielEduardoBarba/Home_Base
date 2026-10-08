import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/api'
import type { NotificationItem } from '../lib/types'
import { HoldButton } from './HoldButton'

const PAGE = 25

export function AlertsTab() {
  const [mode, setMode] = useState<'inbox' | 'history'>('inbox')
  const [items, setItems] = useState<NotificationItem[]>([])
  const [total, setTotal] = useState(0)
  const [unread, setUnread] = useState(0)
  const [offset, setOffset] = useState(0)
  const [error, setError] = useState('')
  const [flash, setFlash] = useState('')

  const load = useCallback(async () => {
    setError('')
    try {
      const data = await api.notifications({
        offset,
        limit: PAGE,
        history: mode === 'history',
        unreadOnly: mode === 'inbox',
      })
      setItems(data.items)
      setTotal(data.total)
      setUnread(data.unread)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [mode, offset])

  useEffect(() => {
    load()
    const t = setInterval(load, 12000)
    return () => clearInterval(t)
  }, [load])

  useEffect(() => {
    setOffset(0)
  }, [mode])

  async function markAll() {
    await api.markRead([], true)
    setFlash('Moved to History')
    setTimeout(() => setFlash(''), 2000)
    load()
  }

  async function markOne(id: string) {
    await api.markRead([id])
    setFlash('Moved to History')
    setTimeout(() => setFlash(''), 2000)
    load()
  }

  async function clearOld() {
    await api.clearRead()
    setFlash('Cleared history')
    setTimeout(() => setFlash(''), 2000)
    load()
  }

  const pages = Math.max(1, Math.ceil(total / PAGE))
  const page = Math.floor(offset / PAGE) + 1

  return (
    <div className="h-full flex flex-col min-h-0 pb-[5.5rem]">
      <div className="hb-chrome shrink-0">
        <div className="hb-chrome-inner space-y-2.5">
          <div className="hb-seg">
            <button
              type="button"
              onClick={() => setMode('inbox')}
              className="hb-seg-btn"
              data-active={mode === 'inbox'}
            >
              Inbox {unread > 0 ? `(${unread})` : ''}
            </button>
            <button
              type="button"
              onClick={() => setMode('history')}
              className="hb-seg-btn"
              data-active={mode === 'history'}
            >
              History
            </button>
          </div>
          <div className="flex gap-2 text-xs items-center flex-wrap">
            {mode === 'inbox' && (
              <button
                type="button"
                onClick={markAll}
                className="text-accent px-2 py-1 font-semibold"
              >
                Mark all read
              </button>
            )}
            {mode === 'history' && (
              <HoldButton
                label="Clear history"
                holdLabel="hold to clear…"
                holdMs={1000}
                className="text-danger px-2 py-1 text-xs"
                onConfirm={clearOld}
              />
            )}
            <button type="button" onClick={load} className="ml-auto text-mute px-2 py-1">
              Refresh
            </button>
          </div>
          {flash && <p className="text-ok text-xs font-mono">{flash}</p>}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-3 sm:px-5 space-y-2.5 max-w-[56rem] mx-auto w-full">
        {error && <p className="text-danger text-sm">{error}</p>}
        {!items.length && !error && (
          <p className="text-mute text-sm mt-8 text-center leading-relaxed">
            {mode === 'inbox'
              ? 'Inbox empty — mark items read to archive them in History'
              : 'No read alerts yet'}
          </p>
        )}
        {items.map((n) => (
          <article
            key={n.id}
            className={`hb-surface p-3.5 ${
              n.read ? 'opacity-80' : 'border-accent/35 !shadow-[0_0_0_1px_rgba(45,212,191,0.08)]'
            }`}
          >
            <div className="flex items-start gap-2">
              <span
                className={`mt-1 w-2 h-2 rounded-full shrink-0 ${
                  n.level === 'error'
                    ? 'bg-danger'
                    : n.level === 'warn'
                      ? 'bg-warn'
                      : n.level === 'success'
                        ? 'bg-ok'
                        : 'bg-accent'
                }`}
              />
              <div className="flex-1 min-w-0">
                <div className="font-semibold text-sm">{n.title}</div>
                {n.body && <p className="text-mute text-xs mt-1 whitespace-pre-wrap">{n.body}</p>}
                <div className="text-[10px] font-mono text-mute mt-2">
                  {n.category} · {new Date(n.ts).toLocaleString()}
                </div>
              </div>
              {!n.read && (
                <button
                  type="button"
                  onClick={() => markOne(n.id)}
                  className="text-[11px] text-accent shrink-0 font-semibold"
                >
                  Read
                </button>
              )}
            </div>
          </article>
        ))}
      </div>

      <div className="shrink-0 border-t border-line/80 px-3 py-2.5 flex items-center justify-between text-xs font-mono text-mute max-w-[56rem] mx-auto w-full">
        <button
          type="button"
          disabled={offset <= 0}
          onClick={() => setOffset((o) => Math.max(0, o - PAGE))}
          className="disabled:opacity-30 px-2.5 py-1.5 rounded-lg hover:bg-panel-2"
        >
          Prev
        </button>
        <span>
          {page}/{pages} · {total} total
        </span>
        <button
          type="button"
          disabled={offset + PAGE >= total}
          onClick={() => setOffset((o) => o + PAGE)}
          className="disabled:opacity-30 px-2.5 py-1.5 rounded-lg hover:bg-panel-2"
        >
          Next
        </button>
      </div>
    </div>
  )
}
