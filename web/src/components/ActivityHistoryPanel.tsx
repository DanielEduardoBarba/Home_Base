'use client'

import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/api'
import { useSceneRefresh } from '../lib/sceneRefresh'
import { HoldButton } from './HoldButton'

type Ev = Awaited<ReturnType<typeof api.activityHistory>>['events'][number]

export function ActivityHistoryPanel() {
  const [day, setDay] = useState('')
  const [days, setDays] = useState<string[]>([])
  const [source, setSource] = useState<'all' | 'web' | 'mcp' | 'auth' | 'system'>(
    'all',
  )
  const [events, setEvents] = useState<Ev[]>([])
  const [total, setTotal] = useState(0)
  const [error, setError] = useState('')
  const [msg, setMsg] = useState('')

  const load = useCallback(async () => {
    try {
      const r = await api.activityHistory({
        day: day || undefined,
        source,
        limit: 200,
      })
      setDays(r.days)
      setDay(r.day)
      setEvents(r.events)
      setTotal(r.total)
      setError('')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [day, source])

  useSceneRefresh(load)

  useEffect(() => {
    void load()
  }, [load])

  return (
    <div className="space-y-3">
      <section className="hb-surface p-3.5 space-y-2.5">
        <p className="text-xs text-mute leading-relaxed">
          Human-only audit of Web GUI navigation/chat and MCP tool use. Stored under{' '}
          <code className="text-text">.runtime/activity/</code> (mode 0600). MCP bots cannot
          read this log.
        </p>
        <div className="flex flex-wrap gap-2">
          <select
            className="hb-select text-sm"
            value={day}
            onChange={(e) => setDay(e.target.value)}
          >
            {(days.length ? days : [day || '—']).map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
          <select
            className="hb-select text-sm"
            value={source}
            onChange={(e) =>
              setSource(e.target.value as 'all' | 'web' | 'mcp' | 'auth' | 'system')
            }
          >
            <option value="all">All sources</option>
            <option value="web">Web GUI</option>
            <option value="mcp">MCP</option>
            <option value="auth">Auth</option>
            <option value="system">System</option>
          </select>
          <button type="button" className="hb-btn hb-btn-ghost text-xs" onClick={() => void load()}>
            Refresh
          </button>
        </div>
        <p className="text-[11px] text-mute">
          {total} event{total === 1 ? '' : 's'} this day
        </p>
      </section>

      <section className="hb-surface p-3.5 space-y-2 max-h-[50vh] overflow-y-auto">
        {events.length === 0 ? (
          <p className="text-xs text-mute">No events yet.</p>
        ) : (
          <ul className="space-y-2">
            {events.map((ev) => (
              <li
                key={`${ev.at}-${ev.kind}-${ev.summary.slice(0, 24)}`}
                className="rounded-xl border border-line bg-panel-2/40 px-3 py-2"
              >
                <div className="flex items-center justify-between gap-2 text-[11px] text-mute">
                  <span>
                    {new Date(ev.at).toLocaleTimeString()} · {ev.source} · {ev.kind}
                  </span>
                  {ev.peerIp ? <span className="font-mono">{ev.peerIp}</span> : null}
                </div>
                <p className="text-sm text-text mt-0.5 leading-snug">{ev.summary}</p>
                {ev.actor ? (
                  <p className="text-[11px] text-mute mt-0.5">{ev.actor}</p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      {day ? (
        <HoldButton
          className="w-full"
          label={`Hold to clear ${day}`}
          tone="danger"
          onConfirm={() => {
            void api
              .clearActivityDay(day)
              .then(() => {
                setMsg(`Cleared ${day}`)
                return load()
              })
              .catch((e) => setError(e instanceof Error ? e.message : String(e)))
          }}
        />
      ) : null}

      {msg ? <p className="text-xs text-sky">{msg}</p> : null}
      {error ? <p className="text-xs text-danger">{error}</p> : null}
    </div>
  )
}
