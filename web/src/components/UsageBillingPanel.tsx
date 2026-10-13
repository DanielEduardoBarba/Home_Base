'use client'

import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/api'
import { useSceneRefresh } from '../lib/sceneRefresh'

type UsagePayload = Awaited<ReturnType<typeof api.usage>>

function fmtInt(n: number): string {
  if (!Number.isFinite(n)) return '0'
  return Math.round(n).toLocaleString()
}

function fmtTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 10_000) return `${(n / 1000).toFixed(1)}k`
  return fmtInt(n)
}

function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

function fmtCents(cents?: number): string {
  if (cents == null || !Number.isFinite(cents)) return '—'
  return `$${(cents / 100).toFixed(2)}`
}

function Stat({
  label,
  value,
  hint,
}: {
  label: string
  value: string
  hint?: string
}) {
  return (
    <div className="rounded-[var(--radius-control)] border border-line bg-panel-2 px-3 py-2.5 min-w-0">
      <p className="text-[11px] text-mute uppercase tracking-wide">{label}</p>
      <p className="text-lg font-semibold tabular-nums mt-0.5 truncate" title={value}>
        {value}
      </p>
      {hint ? <p className="text-[11px] text-mute mt-0.5 leading-snug">{hint}</p> : null}
    </div>
  )
}

function BarRow({ label, value, max }: { label: string; value: number; max: number }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="truncate text-mute font-mono" title={label}>
          {label}
        </span>
        <span className="tabular-nums shrink-0">{fmtInt(value)}</span>
      </div>
      <div className="h-1.5 rounded-full bg-line overflow-hidden">
        <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

export function UsageBillingPanel() {
  const [data, setData] = useState<UsagePayload | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async (refresh = false) => {
    setBusy(true)
    setError('')
    try {
      setData(await api.usage({ refresh }))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    void load(false)
  }, [load])

  useSceneRefresh(() => void load(false))

  const hb = data?.homebase
  const cur = data?.cursor
  const dayMax = Math.max(
    1,
    ...(hb?.byDay || []).map((d) => d.userMessages + d.assistantMessages),
  )

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-mute">
          {data
            ? `Updated ${new Date(data.generatedAt).toLocaleString()}`
            : busy
              ? 'Loading…'
              : '—'}
        </p>
        <button
          type="button"
          className="hb-btn hb-btn-ghost !min-h-9 !px-3 text-xs"
          disabled={busy}
          onClick={() => void load(true)}
        >
          {busy ? '…' : 'Refresh'}
        </button>
      </div>

      {error ? <p className="text-sm text-danger">{error}</p> : null}

      <section className="hb-surface p-3.5 space-y-3">
        <div>
          <h2 className="text-sm font-semibold">Cursor account</h2>
          <p className="text-xs text-mute mt-0.5 leading-relaxed">
            From your stored API key. Team billing needs an Admin key.
          </p>
        </div>

        {!cur?.configured ? (
          <p className="text-sm text-mute">
            No Cursor API key yet — add one under Cursor API key to link account info.
          </p>
        ) : (
          <div className="space-y-3">
            <div className="rounded-[var(--radius-control)] border border-line bg-panel-2 p-3 text-sm space-y-1">
              {cur.me?.userEmail || cur.me?.userFirstName ? (
                <p>
                  <span className="text-mute">Account</span> ·{' '}
                  {[cur.me.userFirstName, cur.me.userLastName].filter(Boolean).join(' ') ||
                    '—'}
                  {cur.me.userEmail ? (
                    <span className="text-mute"> · {cur.me.userEmail}</span>
                  ) : null}
                </p>
              ) : null}
              <p>
                <span className="text-mute">API key</span> ·{' '}
                {cur.me?.apiKeyName || 'Stored key'}
                {cur.keyHint ? (
                  <span className="font-mono text-xs text-mute"> · {cur.keyHint}</span>
                ) : null}
              </p>
              {cur.me?.createdAt ? (
                <p>
                  <span className="text-mute">Key created</span> ·{' '}
                  {new Date(cur.me.createdAt).toLocaleDateString()}
                </p>
              ) : null}
              {cur.meError ? (
                <p className="text-amber text-xs">Could not load identity: {cur.meError}</p>
              ) : null}
            </div>

            {cur.billing?.available ? (
              <div className="space-y-2">
                <div className="grid grid-cols-2 gap-2">
                  <Stat
                    label="Cycle spend"
                    value={fmtCents(cur.billing.overallSpendCents ?? cur.billing.spendCents)}
                    hint="Team Admin API"
                  />
                  <Stat
                    label="Events (30d sample)"
                    value={fmtInt(cur.billing.events?.count || 0)}
                    hint={fmtCents(cur.billing.events?.chargedCents)}
                  />
                </div>
                {cur.billing.events ? (
                  <div className="grid grid-cols-2 gap-2">
                    <Stat
                      label="Input tokens"
                      value={fmtTokens(cur.billing.events.inputTokens)}
                    />
                    <Stat
                      label="Output tokens"
                      value={fmtTokens(cur.billing.events.outputTokens)}
                    />
                  </div>
                ) : null}
                {!!cur.billing.events?.byModel?.length && (
                  <div className="space-y-2 pt-1">
                    <p className="hb-label mb-0">Models (sample)</p>
                    {cur.billing.events.byModel.slice(0, 6).map((m) => (
                      <div
                        key={m.model}
                        className="flex items-center justify-between gap-2 text-xs"
                      >
                        <span className="font-mono truncate">{m.model}</span>
                        <span className="text-mute shrink-0 tabular-nums">
                          {fmtInt(m.count)} · {fmtCents(m.chargedCents)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <p className="text-xs text-mute leading-relaxed">
                {cur.billing?.error
                  ? `Billing API: ${cur.billing.error}. `
                  : ''}
                {cur.note}
              </p>
            )}

            <a
              href={cur.dashboardUrl}
              target="_blank"
              rel="noreferrer"
              className="hb-btn hb-btn-ghost w-full !min-h-10 text-sm no-underline text-center"
            >
              Open Cursor dashboard
            </a>
          </div>
        )}
      </section>

      <section className="hb-surface p-3.5 space-y-3">
        <div>
          <h2 className="text-sm font-semibold">Home Base activity</h2>
          <p className="text-xs text-mute mt-0.5 leading-relaxed">
            From chats on this server — messages, thinking time, tools, and captured tokens.
          </p>
        </div>

        {!hb ? (
          <p className="text-sm text-mute">{busy ? 'Loading…' : 'No data yet.'}</p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-2">
              <Stat label="User messages" value={fmtInt(hb.userMessages)} />
              <Stat label="AI replies" value={fmtInt(hb.assistantMessages)} />
              <Stat
                label="Thinking time"
                value={fmtDuration(hb.thinkingMs)}
                hint={`${fmtInt(hb.thinkingMessages)} thinking blocks`}
              />
              <Stat
                label="Tool calls"
                value={fmtInt(hb.toolCalls)}
                hint={hb.toolErrors ? `${fmtInt(hb.toolErrors)} errors` : 'ok'}
              />
              <Stat label="Chats" value={fmtInt(hb.chats)} hint={`${fmtInt(hb.projectsWithChats)} apps`} />
              <Stat
                label="File edits"
                value={fmtInt(hb.fileEdits)}
                hint={hb.imagesAttached ? `${fmtInt(hb.imagesAttached)} images` : undefined}
              />
            </div>

            <div className="grid grid-cols-2 gap-2">
              <Stat
                label="Tokens in"
                value={fmtTokens(hb.tokens.input)}
                hint={hb.tokens.events ? `${fmtInt(hb.tokens.events)} captures` : 'after upgrade'}
              />
              <Stat
                label="Tokens out"
                value={fmtTokens(hb.tokens.output)}
                hint={
                  hb.tokens.total
                    ? `${fmtTokens(hb.tokens.total)} total`
                    : 'Captured on new runs'
                }
              />
            </div>
            {hb.tokens.ledgerOnly && hb.tokens.events === 0 ? (
              <p className="text-[11px] text-mute leading-relaxed">
                Token totals fill in as Chat runs complete (SDK usage events). Older history still
                counts messages and thinking time.
              </p>
            ) : null}

            {!!hb.models.length && (
              <div className="space-y-2">
                <p className="hb-label mb-0">Models used</p>
                {hb.models.slice(0, 8).map((m) => (
                  <BarRow
                    key={m.id}
                    label={m.id}
                    value={m.chats}
                    max={hb.models[0]?.chats || 1}
                  />
                ))}
              </div>
            )}

            {!!hb.byDay.length && (
              <div className="space-y-2">
                <p className="hb-label mb-0">Last days</p>
                <div className="space-y-2 max-h-48 overflow-y-auto pr-0.5">
                  {[...hb.byDay].reverse().map((d) => (
                    <BarRow
                      key={d.day}
                      label={d.day}
                      value={d.userMessages + d.assistantMessages}
                      max={dayMax}
                    />
                  ))}
                </div>
              </div>
            )}

            <p className="text-[11px] text-mute">
              Registered apps on this server: {fmtInt(data?.projects || 0)}
              {hb.oldestAt ? (
                <>
                  {' '}
                  · history since {new Date(hb.oldestAt).toLocaleDateString()}
                </>
              ) : null}
            </p>
          </>
        )}
      </section>
    </div>
  )
}
