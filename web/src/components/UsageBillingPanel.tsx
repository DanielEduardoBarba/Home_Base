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

function BarRow({ label, value, max, right }: { label: string; value: number; max: number; right?: string }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="truncate text-mute font-mono" title={label}>
          {label}
        </span>
        <span className="tabular-nums shrink-0 text-mute">
          {right || fmtInt(value)}
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-line overflow-hidden">
        <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

function ModelPoolList({
  title,
  hint,
  rows,
}: {
  title: string
  hint: string
  rows: UsagePayload['ai']['pools']['cursorModels']
}) {
  const max = Math.max(1, ...rows.map((r) => r.chats + r.events))
  return (
    <div className="space-y-2">
      <div>
        <p className="hb-label mb-0">{title}</p>
        <p className="text-[11px] text-mute leading-snug">{hint}</p>
      </div>
      {rows.length === 0 ? (
        <p className="text-xs text-mute">None seen yet.</p>
      ) : (
        rows.slice(0, 8).map((m) => (
          <BarRow
            key={m.id}
            label={m.id}
            value={m.chats + m.events}
            max={max}
            right={
              m.chargedCents
                ? `${fmtInt(m.chats + m.events)} · ${fmtCents(m.chargedCents)}`
                : fmtInt(m.chats + m.events)
            }
          />
        ))
      )}
    </div>
  )
}

export function UsageBillingPanel() {
  const [data, setData] = useState<UsagePayload | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [planBusy, setPlanBusy] = useState(false)
  const [planPick, setPlanPick] = useState('auto')

  const load = useCallback(async (refresh = false) => {
    setBusy(true)
    setError('')
    try {
      const next = await api.usage({ refresh })
      setData(next)
      if (next.ai?.plan?.source === 'manual' && next.ai.plan.family !== 'unknown') {
        const match = next.ai.availableTiers.find(
          (t) => t.family === next.ai.plan.family && t.tier === next.ai.plan.tier,
        )
        setPlanPick(match ? `${match.family}:${match.tier}` : 'auto')
      } else {
        setPlanPick('auto')
      }
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

  async function savePlan(value: string) {
    setPlanPick(value)
    setPlanBusy(true)
    setError('')
    try {
      if (value === 'auto') {
        await api.setUsagePlan({ family: 'auto', tier: null })
      } else {
        const [family, tier] = value.split(':')
        await api.setUsagePlan({ family, tier: tier || null })
      }
      await load(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setPlanBusy(false)
    }
  }

  const hb = data?.homebase
  const cur = data?.cursor
  const ai = data?.ai
  const plan = ai?.plan
  const dayMax = Math.max(
    1,
    ...(hb?.byDay || []).map((d) => d.userMessages + d.assistantMessages),
  )

  const billingLabel =
    plan?.billingModel === 'usage_based'
      ? 'Usage-based'
      : plan?.billingModel === 'request_based'
        ? 'Request-based'
        : plan?.billingModel === 'mixed'
          ? 'Mixed billing'
          : 'Billing unknown'

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
          disabled={busy || planBusy}
          onClick={() => void load(true)}
        >
          {busy ? '…' : 'Refresh'}
        </button>
      </div>

      {error ? <p className="text-sm text-danger">{error}</p> : null}

      <section className="hb-surface p-3.5 space-y-3">
        <div>
          <h2 className="text-sm font-semibold">Your plan</h2>
          <p className="text-xs text-mute mt-0.5 leading-relaxed">
            Legacy Cursor (Pro / Pro+ / Ultra) vs The X Subscription (Plus / Premium / Super /
            Ultra). Cursor keys rarely expose tier — confirm it here.
          </p>
        </div>

        {plan ? (
          <>
            <div className="rounded-[var(--radius-control)] border border-line bg-panel-2 p-3 space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-md border border-line bg-panel px-2 py-1 text-xs font-semibold">
                  {plan.familyLabel}
                </span>
                <span className="rounded-md border border-accent/30 bg-accent/10 px-2 py-1 text-xs font-semibold text-accent">
                  {plan.tierLabel || 'Tier unset'}
                </span>
                <span className="text-[11px] text-mute">
                  {billingLabel}
                  {' · '}
                  {plan.source === 'manual' ? 'manual' : `auto · ${plan.confidence}`}
                </span>
              </div>
              <p className="text-xs text-mute leading-relaxed">{plan.note}</p>
              {!!plan.signals?.length && (
                <ul className="space-y-1 text-[11px] text-mute">
                  {plan.signals.slice(0, 4).map((s) => (
                    <li key={s}>· {s}</li>
                  ))}
                </ul>
              )}
            </div>

            <label className="block text-xs text-mute">
              Set plan (optional)
              <select
                className="mt-1 w-full rounded-[var(--radius-control)] border border-line bg-panel-2 px-3 py-2 text-sm text-inherit"
                value={planPick}
                disabled={planBusy}
                onChange={(e) => void savePlan(e.target.value)}
              >
                <option value="auto">Auto-detect</option>
                {(ai?.availableTiers || []).map((t) => (
                  <option key={`${t.family}:${t.tier}`} value={`${t.family}:${t.tier}`}>
                    {t.label}
                  </option>
                ))}
              </select>
            </label>

            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <a
                href={plan.dashboardUrl}
                target="_blank"
                rel="noreferrer"
                className="hb-btn hb-btn-ghost w-full !min-h-10 text-sm no-underline text-center"
              >
                Open usage dashboard
              </a>
              <a
                href={plan.manageUrl}
                target="_blank"
                rel="noreferrer"
                className="hb-btn hb-btn-ghost w-full !min-h-10 text-sm no-underline text-center"
              >
                Manage billing
              </a>
            </div>
          </>
        ) : (
          <p className="text-sm text-mute">{busy ? 'Loading…' : 'No plan data yet.'}</p>
        )}
      </section>

      <section className="hb-surface p-3.5 space-y-3">
        <div>
          <h2 className="text-sm font-semibold">AI sources</h2>
          <p className="text-xs text-mute mt-0.5 leading-relaxed">
            Cursor Chat on this server, plus MCP clients (Grok bots and others) over VPN.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Stat
            label="Home Base chats"
            value={fmtInt(ai?.sources.homebaseChat.chats || 0)}
            hint={`${fmtInt(ai?.sources.homebaseChat.models || 0)} models · ${fmtTokens(ai?.sources.homebaseChat.tokensCaptured || 0)} tok`}
          />
          <Stat
            label="MCP tool calls (7d)"
            value={fmtInt(ai?.sources.mcp.toolCalls7d || 0)}
            hint={`${fmtInt(ai?.sources.mcp.tokenCount || 0)} tokens minted`}
          />
        </div>
        {!!ai?.sources.mcp.actors7d?.length && (
          <div className="space-y-2">
            <p className="hb-label mb-0">MCP / Grok bots (7d)</p>
            {ai.sources.mcp.actors7d.map((a) => (
              <div key={a.label} className="flex items-center justify-between gap-2 text-xs">
                <span className="truncate">{a.label}</span>
                <span className="tabular-nums text-mute shrink-0">{fmtInt(a.calls)} calls</span>
              </div>
            ))}
          </div>
        )}
        {!!ai?.sources.mcp.tokens?.length && (
          <div className="space-y-1.5">
            <p className="hb-label mb-0">Minted MCP tokens</p>
            {ai.sources.mcp.tokens.map((t) => (
              <div key={t.id} className="flex items-center justify-between gap-2 text-xs">
                <span className="truncate">{t.label}</span>
                <span className="font-mono text-mute shrink-0">{t.prefix}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="hb-surface p-3.5 space-y-4">
        <div>
          <h2 className="text-sm font-semibold">Models</h2>
          <p className="text-xs text-mute mt-0.5 leading-relaxed">
            Split into Cursor Models (Grok / Composer) and Other Models (Claude, GPT, Gemini…).
          </p>
        </div>
        <ModelPoolList
          title="Cursor Models"
          hint="Included pool on legacy plans; weekly shared pool on The X Subscription."
          rows={ai?.pools.cursorModels || []}
        />
        <ModelPoolList
          title="Other Models"
          hint="Third-party. Included on legacy Pro+; prepaid credit on X Premium+."
          rows={ai?.pools.otherModels || []}
        />
        {!!ai?.pools.unknown?.length && (
          <ModelPoolList
            title="Unclassified"
            hint="Auto / unknown ids from Chat history."
            rows={ai.pools.unknown}
          />
        )}
      </section>

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
              </div>
            ) : (
              <p className="text-xs text-mute leading-relaxed">
                {cur.billing?.error ? `Billing API: ${cur.billing.error}. ` : ''}
                {cur.note}
              </p>
            )}
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
