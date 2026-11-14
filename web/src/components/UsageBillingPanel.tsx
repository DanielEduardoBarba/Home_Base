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

function fmtDate(ms?: number): string {
  if (!ms || !Number.isFinite(ms)) return '—'
  return new Date(ms).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
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

function BarRow({
  label,
  value,
  max,
  right,
}: {
  label: string
  value: number
  max: number
  right?: string
}) {
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
  summary,
  rows,
  empty,
}: {
  title: string
  hint: string
  summary?: UsagePayload['ai']['poolSummary']['cursorModels']
  rows: UsagePayload['ai']['pools']['cursorModels']
  empty: string
}) {
  const max = Math.max(1, ...rows.map((r) => r.chats + r.events))
  return (
    <div className="space-y-2">
      <div>
        <p className="hb-label mb-0">{title}</p>
        <p className="text-[11px] text-mute leading-snug">{hint}</p>
        {summary && (summary.models > 0 || summary.chats > 0 || summary.events > 0) ? (
          <p className="text-[11px] text-mute mt-1 tabular-nums">
            {fmtInt(summary.models)} models · {fmtInt(summary.chats)} chats ·{' '}
            {fmtInt(summary.events)} events
            {summary.chargedCents
              ? ` · ${fmtCents(summary.chargedCents)} charged`
              : ''}
          </p>
        ) : null}
      </div>
      {rows.length === 0 ? (
        <p className="text-xs text-mute">{empty}</p>
      ) : (
        rows.slice(0, 16).map((m) => (
          <BarRow
            key={m.id}
            label={m.id}
            value={m.chats + m.events}
            max={max}
            right={
              m.chargedCents
                ? `${fmtInt(m.chats + m.events)} · ${fmtCents(m.chargedCents)}`
                : m.chats && m.events
                  ? `${fmtInt(m.chats)} chats · ${fmtInt(m.events)} events`
                  : fmtInt(m.chats + m.events)
            }
          />
        ))
      )}
    </div>
  )
}

function cycleProgressPct(plan: UsagePayload['ai']['plan']): number | null {
  if (!plan.cycleStartMs || !plan.cycleEndMs) return null
  const span = plan.cycleEndMs - plan.cycleStartMs
  if (span <= 0) return null
  return Math.max(0, Math.min(100, Math.round(((Date.now() - plan.cycleStartMs) / span) * 100)))
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

  const cycleKindLabel =
    plan?.cycleKind === 'weekly'
      ? 'Weekly pool'
      : plan?.cycleKind === 'monthly'
        ? 'Monthly cycle'
        : 'Cycle unknown'

  const cyclePct = plan ? cycleProgressPct(plan) : null
  const familyShort =
    plan?.family === 'x_subscription'
      ? 'New (X)'
      : plan?.family === 'legacy_cursor'
        ? 'Legacy'
        : plan?.family === 'request_based'
          ? 'Request-era'
          : 'Unknown'

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
          <h2 className="text-sm font-semibold">Current plan</h2>
          <p className="text-xs text-mute mt-0.5 leading-relaxed">
            Detects Legacy Cursor vs The X Subscription from your API key signals. Confirm the
            tier if auto-detect is unsure — same idea as cursor.com / grok.com usage.
          </p>
        </div>

        {plan ? (
          <>
            <div className="rounded-[var(--radius-control)] border border-line bg-panel-2 p-3 space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-md border border-line bg-panel px-2 py-1 text-xs font-semibold">
                  {familyShort}
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

              <div>
                <p className="text-base font-semibold leading-snug">{plan.familyLabel}</p>
                <p className="text-sm text-mute mt-0.5">
                  {plan.tierLabel
                    ? `${plan.tierLabel} · ${cycleKindLabel}`
                    : cycleKindLabel}
                </p>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <Stat
                  label={plan.cycleKind === 'weekly' ? 'Until reset' : 'Until renewal'}
                  value={
                    plan.daysRemaining != null
                      ? plan.daysRemaining <= 0
                        ? plan.hoursRemaining != null
                          ? `${plan.hoursRemaining}h`
                          : '<1d'
                        : `${plan.daysRemaining}d`
                      : '—'
                  }
                  hint={plan.renewalLabel}
                />
                <Stat
                  label="Cycle end"
                  value={
                    plan.cycleEndMs
                      ? new Date(plan.cycleEndMs).toLocaleDateString(undefined, {
                          month: 'short',
                          day: 'numeric',
                        })
                      : '—'
                  }
                  hint={
                    plan.cycleStartMs
                      ? `Started ${fmtDate(plan.cycleStartMs)}`
                      : 'Needs Admin cycle or dashboard'
                  }
                />
              </div>

              {cyclePct != null ? (
                <div className="space-y-1">
                  <div className="flex items-center justify-between text-[11px] text-mute">
                    <span>Billing period</span>
                    <span className="tabular-nums">{cyclePct}% elapsed</span>
                  </div>
                  <div className="h-2 rounded-full bg-line overflow-hidden">
                    <div
                      className="h-full rounded-full bg-accent"
                      style={{ width: `${cyclePct}%` }}
                    />
                  </div>
                </div>
              ) : null}

              <p className="text-xs text-mute leading-relaxed">{plan.note}</p>
              {!!plan.signals?.length && (
                <ul className="space-y-1 text-[11px] text-mute">
                  {plan.signals.slice(0, 6).map((s) => (
                    <li key={s}>· {s}</li>
                  ))}
                </ul>
              )}
            </div>

            <label className="block text-xs text-mute">
              Confirm plan (optional)
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

      <section className="hb-surface p-3.5 space-y-4">
        <div>
          <h2 className="text-sm font-semibold">Model pools</h2>
          <p className="text-xs text-mute mt-0.5 leading-relaxed">
            Cursor Models (Grok / Composer) vs Other Models (Claude, GPT, Gemini…). Matches the
            pools on the Cursor spending / Grok usage pages.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Stat
            label="Cursor Models"
            value={fmtInt(
              (ai?.poolSummary.cursorModels.chats || 0) +
                (ai?.poolSummary.cursorModels.events || 0),
            )}
            hint={`${fmtInt(ai?.poolSummary.cursorModels.models || 0)} ids · ${fmtCents(ai?.poolSummary.cursorModels.chargedCents)}`}
          />
          <Stat
            label="Other Models"
            value={fmtInt(
              (ai?.poolSummary.otherModels.chats || 0) +
                (ai?.poolSummary.otherModels.events || 0),
            )}
            hint={`${fmtInt(ai?.poolSummary.otherModels.models || 0)} ids · ${fmtCents(ai?.poolSummary.otherModels.chargedCents)}`}
          />
        </div>
        <ModelPoolList
          title="Cursor Models"
          hint="Included pool on legacy plans; weekly shared pool on The X Subscription (Grok + Composer)."
          summary={ai?.poolSummary.cursorModels}
          rows={ai?.pools.cursorModels || []}
          empty="No Cursor-model activity seen yet."
        />
        <ModelPoolList
          title="Other Models"
          hint="Third-party. Included on legacy Pro+; prepaid credit on X Premium+."
          summary={ai?.poolSummary.otherModels}
          rows={ai?.pools.otherModels || []}
          empty="No Other-model activity seen yet."
        />
        {!!ai?.pools.unknown?.length && (
          <ModelPoolList
            title="Unclassified"
            hint="Auto / unknown ids from Chat history."
            summary={ai.poolSummary.unknown}
            rows={ai.pools.unknown}
            empty="None."
          />
        )}
      </section>

      <section className="hb-surface p-3.5 space-y-3">
        <div>
          <h2 className="text-sm font-semibold">Grok Bot & MCP</h2>
          <p className="text-xs text-mute mt-0.5 leading-relaxed">
            Network MCP clients (Grok bots and others) over VPN. On The X Subscription these share
            the same weekly Cursor-models pool as Chat.
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
        {!!ai?.sources.mcp.actors7d?.length ? (
          <div className="space-y-2">
            <p className="hb-label mb-0">Bots / actors (7d)</p>
            {ai.sources.mcp.actors7d.map((a) => (
              <div key={a.label} className="flex items-center justify-between gap-2 text-xs">
                <span className="truncate">{a.label}</span>
                <span className="tabular-nums text-mute shrink-0">{fmtInt(a.calls)} calls</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-xs text-mute">No MCP tool activity in the last 7 days.</p>
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

      <section className="hb-surface p-3.5 space-y-3">
        <div>
          <h2 className="text-sm font-semibold">Cursor account</h2>
          <p className="text-xs text-mute mt-0.5 leading-relaxed">
            From the API key stored in Home Base. Team spend and cycle dates need an Admin API key;
            personal keys still show identity.
          </p>
        </div>

        {!cur?.configured ? (
          <p className="text-sm text-mute">
            No Cursor API key yet — add one under Settings → Cursor API key.
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
                <p className="text-xs text-mute">Key created {fmtDate(Date.parse(cur.me.createdAt))}</p>
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
                    hint={
                      cur.billing.totalMembers
                        ? `Team · ${fmtInt(cur.billing.totalMembers)} members`
                        : 'Team Admin API'
                    }
                  />
                  <Stat
                    label="Events (30d sample)"
                    value={fmtInt(cur.billing.events?.count || 0)}
                    hint={fmtCents(cur.billing.events?.chargedCents)}
                  />
                </div>
                {cur.billing.events ? (
                  <>
                    <div className="grid grid-cols-2 gap-2">
                      <Stat
                        label="Input tokens"
                        value={fmtTokens(cur.billing.events.inputTokens)}
                        hint={
                          cur.billing.events.cacheReadTokens
                            ? `Cache read ${fmtTokens(cur.billing.events.cacheReadTokens)}`
                            : undefined
                        }
                      />
                      <Stat
                        label="Output tokens"
                        value={fmtTokens(cur.billing.events.outputTokens)}
                        hint={
                          cur.billing.events.cacheWriteTokens
                            ? `Cache write ${fmtTokens(cur.billing.events.cacheWriteTokens)}`
                            : undefined
                        }
                      />
                    </div>
                    {(cur.billing.events.tokenBasedCount ||
                      cur.billing.events.requestBasedCount) && (
                      <div className="grid grid-cols-2 gap-2">
                        <Stat
                          label="Token-based calls"
                          value={fmtInt(cur.billing.events.tokenBasedCount || 0)}
                        />
                        <Stat
                          label="Request-based calls"
                          value={fmtInt(cur.billing.events.requestBasedCount || 0)}
                        />
                      </div>
                    )}
                    {!!cur.billing.events.byKind?.length && (
                      <div className="space-y-2">
                        <p className="hb-label mb-0">Event kinds</p>
                        {cur.billing.events.byKind.map((k) => (
                          <div
                            key={k.kind}
                            className="flex items-center justify-between gap-2 text-xs"
                          >
                            <span className="truncate font-mono text-mute">{k.kind}</span>
                            <span className="tabular-nums shrink-0">{fmtInt(k.count)}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                ) : null}
                {!!cur.billing.members?.length && (
                  <div className="space-y-2">
                    <p className="hb-label mb-0">Team members (spend)</p>
                    {cur.billing.members.slice(0, 12).map((m) => (
                      <div
                        key={m.email || m.name || String(m.spendCents)}
                        className="flex items-center justify-between gap-2 text-xs"
                      >
                        <span className="truncate">{m.name || m.email || 'Member'}</span>
                        <span className="tabular-nums text-mute shrink-0">
                          {fmtCents(m.overallSpendCents ?? m.spendCents)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
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
            Local chats on this server — messages, thinking time, tools, and captured tokens from
            the Cursor SDK.
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

            {(hb.tokens.cacheRead > 0 || hb.tokens.cacheWrite > 0) && (
              <div className="grid grid-cols-2 gap-2">
                <Stat label="Cache read" value={fmtTokens(hb.tokens.cacheRead)} />
                <Stat label="Cache write" value={fmtTokens(hb.tokens.cacheWrite)} />
              </div>
            )}

            <div className="grid grid-cols-2 gap-2">
              <Stat
                label="File edits"
                value={fmtInt(hb.fileEdits)}
                hint={`${fmtInt(hb.imagesAttached)} images`}
              />
              <Stat
                label="Projects w/ chats"
                value={fmtInt(hb.projectsWithChats)}
                hint={`${fmtInt(data?.projects || 0)} registered`}
              />
            </div>

            {!!hb.modes.length && (
              <div className="space-y-1.5">
                <p className="hb-label mb-0">Modes</p>
                {hb.modes.map((m) => (
                  <div key={m.id} className="flex items-center justify-between gap-2 text-xs">
                    <span className="truncate font-mono text-mute">{m.id}</span>
                    <span className="tabular-nums shrink-0">{fmtInt(m.chats)} chats</span>
                  </div>
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
                      right={`${fmtInt(d.userMessages + d.assistantMessages)} · ${fmtTokens(d.inputTokens + d.outputTokens)} tok`}
                    />
                  ))}
                </div>
              </div>
            )}

            <p className="text-[11px] text-mute">
              {hb.oldestAt ? (
                <>History since {new Date(hb.oldestAt).toLocaleDateString()}</>
              ) : (
                <>No chat history yet</>
              )}
              {hb.newestAt ? (
                <> · latest {new Date(hb.newestAt).toLocaleString()}</>
              ) : null}
              {hb.tokens.ledgerOnly ? <> · tokens from post-ledger captures only</> : null}
            </p>
          </>
        )}
      </section>
    </div>
  )
}
