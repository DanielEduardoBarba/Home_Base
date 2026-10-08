import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/api'
import { useNotify } from '../lib/NotifyContext'
import type { NotificationItem } from '../lib/types'
import { HoldButton } from './HoldButton'

const PAGE = 25

function levelDot(level: string): string {
  if (level === 'error') return 'bg-danger'
  if (level === 'warn') return 'bg-warn'
  if (level === 'success') return 'bg-ok'
  return 'bg-accent'
}

function AlertRow({
  n,
  onRead,
}: {
  n: NotificationItem
  onRead?: (id: string) => void
}) {
  return (
    <article
      className={`hb-surface p-3 ${
        n.read ? 'opacity-80' : 'border-accent/35 !shadow-[0_0_0_1px_rgba(45,212,191,0.08)]'
      }`}
    >
      <div className="flex items-start gap-2">
        <span className={`mt-1 w-2 h-2 rounded-full shrink-0 ${levelDot(n.level)}`} />
        <div className="flex-1 min-w-0">
          <div className="font-semibold text-sm">{n.title}</div>
          {n.body && <p className="text-mute text-xs mt-1 whitespace-pre-wrap">{n.body}</p>}
          <div className="text-[10px] font-mono text-mute mt-2">
            {n.category} · {new Date(n.ts).toLocaleString()}
          </div>
        </div>
        {!n.read && onRead && (
          <button
            type="button"
            onClick={() => onRead(n.id)}
            className="text-[11px] text-accent shrink-0 font-semibold"
          >
            Read
          </button>
        )}
      </div>
    </article>
  )
}

function HistoryDrawer() {
  const { historyOpen, closeHistory } = useNotify()
  const [items, setItems] = useState<NotificationItem[]>([])
  const [total, setTotal] = useState(0)
  const [offset, setOffset] = useState(0)
  const [error, setError] = useState('')
  const [flash, setFlash] = useState('')

  const load = useCallback(async () => {
    if (!historyOpen) return
    setError('')
    try {
      const data = await api.notifications({
        offset,
        limit: PAGE,
        history: true,
      })
      setItems(data.items)
      setTotal(data.total)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [historyOpen, offset])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (!historyOpen) setOffset(0)
  }, [historyOpen])

  async function clearOld() {
    await api.clearRead()
    setFlash('Cleared history')
    setTimeout(() => setFlash(''), 2000)
    void load()
  }

  const pages = Math.max(1, Math.ceil(total / PAGE))
  const page = Math.floor(offset / PAGE) + 1

  return (
    <>
      <div
        className="hb-drawer-backdrop"
        data-open={historyOpen}
        onClick={closeHistory}
        aria-hidden={!historyOpen}
      />
      <aside
        className="hb-drawer"
        data-open={historyOpen}
        aria-hidden={!historyOpen}
        aria-label="Alert history"
      >
        <div className="hb-drawer-head">
          <div>
            <h2 className="font-semibold text-sm">History</h2>
            <p className="text-[11px] text-mute mt-0.5">Read alerts archive</p>
          </div>
          <button type="button" className="text-mute text-sm px-2 py-1" onClick={closeHistory}>
            Close
          </button>
        </div>
        <div className="px-3 py-2 flex items-center gap-2 border-b border-line/70">
          <HoldButton
            label="Clear history"
            holdLabel="hold to clear…"
            holdMs={1000}
            className="text-danger px-2 py-1 text-xs"
            onConfirm={() => void clearOld()}
          />
          {flash && <p className="text-ok text-xs font-mono">{flash}</p>}
        </div>
        <div className="flex-1 overflow-y-auto px-3 py-3 space-y-2.5">
          {error && <p className="text-danger text-sm">{error}</p>}
          {!items.length && !error && (
            <p className="text-mute text-sm mt-8 text-center leading-relaxed">
              No read alerts yet
            </p>
          )}
          {items.map((n) => (
            <AlertRow key={n.id} n={n} />
          ))}
        </div>
        <div className="shrink-0 border-t border-line/80 px-3 py-2.5 flex items-center justify-between text-xs font-mono text-mute">
          <button
            type="button"
            disabled={offset <= 0}
            onClick={() => setOffset((o) => Math.max(0, o - PAGE))}
            className="disabled:opacity-30 px-2.5 py-1.5 rounded-lg hover:bg-panel-2"
          >
            Prev
          </button>
          <span>
            {page}/{pages} · {total}
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
      </aside>
    </>
  )
}

export function NotificationCenter() {
  const {
    inboxOpen,
    closeInbox,
    inbox,
    unread,
    markOne,
    markAll,
    openHistory,
    refresh,
    unlockAudio,
  } = useNotify()

  useEffect(() => {
    if (!inboxOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeInbox()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [inboxOpen, closeInbox])

  return (
    <>
      <div
        className="hb-inbox-backdrop"
        data-open={inboxOpen}
        onClick={closeInbox}
        aria-hidden={!inboxOpen}
      />
      <div
        className="hb-inbox-panel"
        data-open={inboxOpen}
        role="dialog"
        aria-modal="true"
        aria-label="Notifications"
        aria-hidden={!inboxOpen}
      >
        <div className="hb-inbox-head">
          <div className="flex items-center gap-2 min-w-0">
            <span className="font-semibold text-sm">Alerts</span>
            {unread > 0 && (
              <span className="text-[10px] font-mono text-accent bg-accent/12 border border-accent/30 rounded-md px-1.5 py-0.5">
                {unread}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <button
              type="button"
              className="text-[11px] text-accent font-semibold px-2 py-1"
              onClick={() => {
                unlockAudio()
                openHistory()
              }}
            >
              History
            </button>
            <button type="button" className="text-mute text-sm px-2 py-1" onClick={closeInbox}>
              Close
            </button>
          </div>
        </div>

        <div className="px-3 py-2 flex items-center gap-2 border-b border-line/70">
          {unread > 0 ? (
            <button
              type="button"
              onClick={() => void markAll()}
              className="text-accent text-xs font-semibold px-2 py-1"
            >
              Mark all read
            </button>
          ) : (
            <span className="text-[11px] text-mute px-2">Inbox empty</span>
          )}
          <button
            type="button"
            onClick={() => void refresh()}
            className="text-mute text-xs px-2 py-1 ml-auto"
          >
            Refresh
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-3 py-3 space-y-2.5">
          {!inbox.length && (
            <p className="text-mute text-sm mt-6 text-center leading-relaxed px-4">
              New alerts toast here and land in this inbox. Open History for older read items.
            </p>
          )}
          {inbox.map((n) => (
            <AlertRow key={n.id} n={n} onRead={(id) => void markOne(id)} />
          ))}
        </div>
      </div>
      <HistoryDrawer />
    </>
  )
}
