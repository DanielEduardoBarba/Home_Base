'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../lib/api'
import { getToken } from '../lib/auth'
import { formatWait } from '../lib/authErrors'
import { useSceneRefresh } from '../lib/sceneRefresh'

type Ev = Awaited<ReturnType<typeof api.securityEvents>>['events'][number]
type Dev = Awaited<ReturnType<typeof api.securityStatus>>['devices'][number]

function badgeClass(cls: string) {
  if (cls === 'known_grok_bot' || cls === 'known_vpn_device' || cls === 'lan' || cls === 'unknown_external') {
    return cls
  }
  return 'unknown_external'
}

async function downloadExport(opts: Record<string, string>, format: 'csv' | 'json') {
  const q = new URLSearchParams({ format })
  for (const [k, v] of Object.entries(opts)) {
    if (v && v !== 'all') q.set(k, v)
  }
  const token = getToken()
  const res = await fetch(`/api/security/export?${q}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  if (!res.ok) throw new Error(`Export failed (HTTP ${res.status})`)
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `homebase-security.${format}`
  a.click()
  URL.revokeObjectURL(url)
}

export function SecurityPanel() {
  const [source, setSource] = useState('all')
  const [result, setResult] = useState('all')
  const [klass, setKlass] = useState('all')
  const [ip, setIp] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [q, setQ] = useState('')
  const [offset, setOffset] = useState(0)
  const [events, setEvents] = useState<Ev[]>([])
  const [total, setTotal] = useState(0)
  const [limit, setLimit] = useState(50)
  const [integrityOk, setIntegrityOk] = useState(true)
  const [devices, setDevices] = useState<Dev[]>([])
  const [lockout, setLockout] = useState<{ locked: boolean; retryAfter: number; failCount: number; threshold: number } | null>(null)
  const [mcpLockout, setMcpLockout] = useState<{ locked: boolean; retryAfter: number; failCount: number; ip: string } | null>(null)
  const [error, setError] = useState('')
  const [msg, setMsg] = useState('')
  const [retryTick, setRetryTick] = useState(0)

  const filters = useMemo(
    () => ({ source, result, class: klass, ip, from, to, q, offset, limit: 50 }),
    [source, result, klass, ip, from, to, q, offset],
  )

  const load = useCallback(async () => {
    try {
      const [log, st] = await Promise.all([api.securityEvents(filters), api.securityStatus()])
      setEvents(log.events)
      setTotal(log.total)
      setLimit(log.limit)
      setIntegrityOk(log.integrityOk)
      setDevices(st.devices)
      setLockout(st.lockout)
      setMcpLockout(st.mcpLockout)
      setError('')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [filters])

  useSceneRefresh(load)
  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    const locked = (lockout?.locked && (lockout.retryAfter || 0) > 0) || (mcpLockout?.locked && (mcpLockout.retryAfter || 0) > 0)
    if (!locked) return
    const t = window.setInterval(() => setRetryTick((n) => n + 1), 1000)
    return () => window.clearInterval(t)
  }, [lockout, mcpLockout])
  void retryTick

  const page = Math.floor(offset / limit)
  const pages = Math.max(1, Math.ceil(total / limit))

  return (
    <div className="space-y-3">
      <section className="hb-surface p-3.5 space-y-2">
        <h2 className="text-sm font-semibold text-text">Lockout status</h2>
        <p className="text-xs text-mute leading-relaxed">
          Login and PIN share one lockout. MCP tokens have a separate per-source limit. Correct
          credentials cannot be used to skip an active lockout.
        </p>
        <div className="rounded-xl border border-line bg-panel-2/40 px-3 py-2 text-sm">
          {lockout?.locked ? (
            <p className="text-danger">
              UI lockout active — try again in {formatWait(lockout.retryAfter)} ({lockout.failCount}{' '}
              failures).
            </p>
          ) : (
            <p>
              UI login/PIN: not locked
              {lockout ? ` · ${lockout.failCount}/${lockout.threshold} failures` : ''}.
            </p>
          )}
          {mcpLockout?.locked ? (
            <p className="text-danger mt-1">
              MCP lockout for this address ({mcpLockout.ip}) — try again in{' '}
              {formatWait(mcpLockout.retryAfter)}.
            </p>
          ) : (
            <p className="text-mute text-xs mt-1">
              MCP from this address: not locked
              {mcpLockout ? ` (${mcpLockout.failCount} recorded failures)` : ''}.
            </p>
          )}
        </div>
      </section>

      <section className="hb-surface p-3.5 space-y-2.5">
        <h2 className="text-sm font-semibold text-text">Devices</h2>
        <p className="text-xs text-mute leading-relaxed">
          New or unknown devices are flagged until you name them and mark them trusted.
        </p>
        {devices.length === 0 ? (
          <p className="text-xs text-mute">No devices recorded yet.</p>
        ) : (
          <ul className="space-y-2">
            {devices.map((d) => (
              <li
                key={d.id}
                className="rounded-xl border border-line bg-panel-2/40 px-3 py-2 space-y-1.5"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold text-text">{d.name}</span>
                  <span className="hb-sec-badge" data-class={badgeClass(d.class)} data-trusted={d.trusted ? '1' : '0'}>
                    {d.trusted ? 'Trusted' : d.class.replace(/_/g, ' ')}
                  </span>
                  {!d.trusted ? (
                    <span className="text-[11px] text-warn font-semibold">New / untrusted</span>
                  ) : null}
                </div>
                <p className="text-[11px] text-mute font-mono">
                  {d.ip}
                  {d.wgPeerName ? ` · VPN ${d.wgPeerName}` : ''}
                  {d.connectorLabel ? ` · ${d.connectorLabel}` : ''}
                  {d.userAgent ? ` · ${d.userAgent}` : ''}
                </p>
                <p className="text-[11px] text-mute">
                  First seen {new Date(d.firstSeenAt).toLocaleString()} · last{' '}
                  {new Date(d.lastSeenAt).toLocaleString()} · {d.seenCount} sighting
                  {d.seenCount === 1 ? '' : 's'}
                </p>
                <div className="flex flex-wrap gap-2">
                  <input
                    className="flex-1 min-w-[8rem] rounded-[var(--radius-control)] bg-panel border border-line px-2 py-1.5 text-xs"
                    defaultValue={d.name}
                    aria-label={`Name for ${d.ip}`}
                    onBlur={(e) => {
                      const name = e.target.value.trim()
                      if (!name || name === d.name) return
                      void api
                        .updateSecurityDevice(d.id, { name })
                        .then(() => void load())
                        .catch((err) => setError(err instanceof Error ? err.message : String(err)))
                    }}
                  />
                  <button
                    type="button"
                    className="hb-btn hb-btn-ghost text-xs !min-h-8"
                    onClick={() =>
                      void api
                        .updateSecurityDevice(d.id, { trusted: !d.trusted })
                        .then(() => {
                          setMsg(d.trusted ? 'Device unmarked' : 'Device marked trusted')
                          void load()
                        })
                    }
                  >
                    {d.trusted ? 'Remove trust' : 'Mark trusted'}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="hb-surface p-3.5 space-y-2.5">
        <h2 className="text-sm font-semibold text-text">Security log</h2>
        <p className="text-xs text-mute leading-relaxed">
          Append-only, hash-chained events. Secrets, tokens, PINs and passwords are never stored
          here.
          {!integrityOk ? (
            <span className="text-danger"> Log integrity check reported a broken or unreadable line.</span>
          ) : null}
        </p>
        <div className="flex flex-wrap gap-2">
          <input
            className="flex-1 min-w-[10rem] rounded-[var(--radius-control)] bg-panel-2 border border-line px-3 py-2 text-sm"
            placeholder="Search"
            value={q}
            onChange={(e) => {
              setOffset(0)
              setQ(e.target.value)
            }}
          />
          <select className="hb-select text-sm" value={source} onChange={(e) => { setOffset(0); setSource(e.target.value) }}>
            <option value="all">All sources</option>
            <option value="ui">UI</option>
            <option value="mcp">MCP</option>
            <option value="api">API</option>
          </select>
          <select className="hb-select text-sm" value={result} onChange={(e) => { setOffset(0); setResult(e.target.value) }}>
            <option value="all">All results</option>
            <option value="success">Success</option>
            <option value="failure">Failure</option>
            <option value="lockout">Lockout</option>
            <option value="expired">Expired</option>
            <option value="invalid">Invalid</option>
            <option value="revoked">Revoked</option>
          </select>
          <select className="hb-select text-sm" value={klass} onChange={(e) => { setOffset(0); setKlass(e.target.value) }}>
            <option value="all">All classes</option>
            <option value="known_grok_bot">Known Grok Bot</option>
            <option value="known_vpn_device">Known VPN device</option>
            <option value="lan">LAN</option>
            <option value="unknown_external">Unknown / external</option>
          </select>
          <input
            className="w-36 rounded-[var(--radius-control)] bg-panel-2 border border-line px-3 py-2 text-sm font-mono"
            placeholder="IP"
            value={ip}
            onChange={(e) => { setOffset(0); setIp(e.target.value) }}
          />
          <input type="date" className="hb-select text-sm" value={from} onChange={(e) => { setOffset(0); setFrom(e.target.value) }} aria-label="From date" />
          <input type="date" className="hb-select text-sm" value={to} onChange={(e) => { setOffset(0); setTo(e.target.value) }} aria-label="To date" />
          <button type="button" className="hb-btn hb-btn-ghost text-xs" onClick={() => void load()}>
            Refresh
          </button>
          <button
            type="button"
            className="hb-btn hb-btn-ghost text-xs"
            onClick={() =>
              void downloadExport({ source, result, class: klass, ip, from, to, q }, 'csv')
                .then(() => setMsg('CSV exported'))
                .catch((e) => setError(e instanceof Error ? e.message : String(e)))
            }
          >
            Export CSV
          </button>
          <button
            type="button"
            className="hb-btn hb-btn-ghost text-xs"
            onClick={() =>
              void downloadExport({ source, result, class: klass, ip, from, to, q }, 'json')
                .then(() => setMsg('JSON exported'))
                .catch((e) => setError(e instanceof Error ? e.message : String(e)))
            }
          >
            Export JSON
          </button>
        </div>
        <p className="text-[11px] text-mute">
          {total} event{total === 1 ? '' : 's'} · page {page + 1}/{pages}
        </p>
        <div className="overflow-x-auto max-h-[50vh] overflow-y-auto">
          {events.length === 0 ? (
            <p className="text-xs text-mute">No events match these filters.</p>
          ) : (
            <table className="w-full text-left text-xs">
              <thead className="text-mute">
                <tr>
                  <th className="py-1 pr-2 font-semibold">Time</th>
                  <th className="py-1 pr-2 font-semibold">Source</th>
                  <th className="py-1 pr-2 font-semibold">IP</th>
                  <th className="py-1 pr-2 font-semibold">Event</th>
                  <th className="py-1 pr-2 font-semibold">Result</th>
                  <th className="py-1 font-semibold">Class</th>
                </tr>
              </thead>
              <tbody>
                {events.map((ev) => (
                  <tr key={ev.id} className="border-t border-line align-top">
                    <td className="py-1.5 pr-2 whitespace-nowrap font-mono text-[11px]">
                      {new Date(ev.ts).toLocaleString()}
                    </td>
                    <td className="py-1.5 pr-2 uppercase tracking-wide">{ev.source}</td>
                    <td className="py-1.5 pr-2 font-mono text-[11px]">
                      {ev.ip}
                      {ev.userAgent ? (
                        <span className="block text-mute truncate max-w-[14rem]" title={ev.userAgent}>
                          {ev.userAgent}
                        </span>
                      ) : null}
                    </td>
                    <td className="py-1.5 pr-2">
                      {ev.event}
                      {ev.message ? <span className="block text-mute">{ev.message}</span> : null}
                    </td>
                    <td className="py-1.5 pr-2">{ev.result}</td>
                    <td className="py-1.5">
                      <span className="hb-sec-badge" data-class={badgeClass(ev.class)} data-trusted={ev.trusted ? '1' : '0'}>
                        {ev.classLabel}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            className="hb-btn hb-btn-ghost text-xs"
            disabled={offset <= 0}
            onClick={() => setOffset((o) => Math.max(0, o - limit))}
          >
            Previous
          </button>
          <button
            type="button"
            className="hb-btn hb-btn-ghost text-xs"
            disabled={offset + limit >= total}
            onClick={() => setOffset((o) => o + limit)}
          >
            Next
          </button>
        </div>
      </section>

      {error ? <p className="text-danger text-sm">{error}</p> : null}
      {msg ? <p className="text-ok text-sm">{msg}</p> : null}
    </div>
  )
}
