'use client'

import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/api'
import { useSceneRefresh } from '../lib/sceneRefresh'

type Spending = Awaited<ReturnType<typeof api.usage>>['spending']
type Meter = Spending['cursorModels']

function shortDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function daysLeft(n: number | null): string {
  if (n == null) return ''
  if (n === 0) return 'today'
  if (n === 1) return '1 day left'
  return `${n} days left`
}

function money(cents: number): string {
  return `$${(cents / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`
}

function MeterRow({ meter }: { meter: Meter }) {
  const shown = meter.percent == null ? '—' : `${meter.percent}% used`
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="min-w-0">
          {meter.label}
          {meter.label === 'Cursor Models' ? (
            <span className="text-mute"> · Includes Cursor Grok and Composer</span>
          ) : null}
        </span>
        <span className="tabular-nums shrink-0 text-mute">{shown}</span>
      </div>
      <div className="h-1.5 rounded-full bg-line overflow-hidden">
        <div
          className="h-full rounded-full bg-accent"
          style={{ width: `${Math.max(0, Math.min(100, meter.width))}%` }}
        />
      </div>
      {meter.detail ? <p className="text-xs text-mute leading-snug">{meter.detail}</p> : null}
    </div>
  )
}

function StatusRow({
  title,
  hint,
  value,
}: {
  title: string
  hint: string
  value: string
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <p className="text-sm">{title}</p>
        <p className="text-xs text-mute leading-snug mt-0.5">{hint}</p>
      </div>
      <p className="text-sm text-mute shrink-0">{value}</p>
    </div>
  )
}

export function UsageBillingPanel() {
  const [spending, setSpending] = useState<Spending | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async (refresh = false) => {
    setBusy(true)
    setError('')
    try {
      const next = await api.usage({ refresh })
      setSpending(next.spending)
      if (!next.spending?.ok && next.spending?.error) setError(next.spending.error)
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

  const planReset =
    spending?.cycleEndMs != null
      ? `Usage limits reset on ${shortDate(spending.cycleEndMs)}${
          spending.daysRemaining != null ? ` (${daysLeft(spending.daysRemaining)})` : ''
        }`
      : ''

  const grok = spending?.grokBot
  const grokReset =
    grok?.resetMs != null
      ? `Resets ${shortDate(grok.resetMs)}${
          grok.daysRemaining != null ? ` (${daysLeft(grok.daysRemaining)})` : ''
        }`
      : ''

  const onDemand =
    spending?.onDemandEnabled == null ? '—' : spending.onDemandEnabled ? 'Enabled' : 'Disabled'
  const monthly =
    spending?.onDemandEnabled === false || spending?.monthlyLimitCents == null
      ? 'Disabled'
      : money(spending.monthlyLimitCents)

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-end">
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

      <section className="hb-surface p-4 space-y-2">
        <p className="text-[11px] uppercase tracking-wide text-mute">Current plan</p>
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-xl font-semibold tracking-tight">
            {spending?.planName || (busy ? 'Loading…' : 'Spending')}
          </h2>
          {spending?.price ? <p className="text-sm text-mute">{spending.price}</p> : null}
        </div>
        {planReset ? <p className="text-sm text-mute">{planReset}</p> : null}
      </section>

      {spending?.ok ? (
        <>
          <section className="space-y-2">
            <h3 className="text-sm font-semibold px-0.5">
              Included in {spending.planName || 'plan'}
            </h3>
            <div className="hb-surface p-4 space-y-4">
              <MeterRow meter={spending.cursorModels} />
              <MeterRow meter={spending.otherModels} />
            </div>
          </section>

          {grok ? (
            <section className="space-y-2">
              <div className="px-0.5">
                <h3 className="text-sm font-semibold">Grok Bot</h3>
                {grok.includedLabel ? (
                  <p className="text-xs text-mute mt-0.5">{grok.includedLabel}</p>
                ) : null}
              </div>
              <div className="hb-surface p-4 space-y-1.5">
                <div className="flex items-baseline justify-between gap-3 text-sm">
                  <span>Weekly usage</span>
                  <span className="tabular-nums text-mute">
                    {grok.percent == null ? '—' : `${grok.percent}% used`}
                  </span>
                </div>
                <div className="h-1.5 rounded-full bg-line overflow-hidden">
                  <div
                    className="h-full rounded-full bg-accent"
                    style={{ width: `${Math.max(0, Math.min(100, grok.width))}%` }}
                  />
                </div>
                {grokReset ? <p className="text-xs text-mute">{grokReset}</p> : null}
                <p className="text-xs text-mute leading-snug">
                  Grok Bot pauses at the limit until it resets. Set an on-demand limit to keep going.
                </p>
              </div>
            </section>
          ) : null}

          <section className="space-y-2">
            <h3 className="text-sm font-semibold px-0.5">On-Demand Usage</h3>
            <div className="hb-surface p-4 space-y-4">
              <StatusRow
                title="On-Demand Spending"
                hint={
                  spending.onDemandEnabled
                    ? 'On-demand spending is on.'
                    : 'On-demand spending is currently disabled'
                }
                value={onDemand}
              />
              <StatusRow
                title="Monthly Limit"
                hint="Set a fixed amount or make it unlimited."
                value={monthly}
              />
            </div>
          </section>
        </>
      ) : null}
    </div>
  )
}
