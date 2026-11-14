'use client'

import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/api'
import { useSceneRefresh } from '../lib/sceneRefresh'

type Spending = Awaited<ReturnType<typeof api.usage>>['spending']
type Meter = Spending['included']

function money(cents: number | null | undefined): string {
  if (cents == null || !Number.isFinite(cents)) return '—'
  return `$${(cents / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`
}

function resetLine(s: Spending): string {
  if (!s.cycleEndMs) return ''
  const when = new Date(s.cycleEndMs).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  })
  const verb = s.cycleKind === 'weekly' ? 'Resets' : 'Renews'
  const left =
    s.daysRemaining == null
      ? ''
      : s.daysRemaining === 0
        ? ' · today'
        : s.daysRemaining === 1
          ? ' · 1 day'
          : ` · ${s.daysRemaining} days`
  return `${verb} ${when}${left}`
}

function MeterRow({ meter }: { meter: Meter }) {
  const shown = meter.percent == null ? '—' : `${meter.percent}%`
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span>{meter.label}</span>
        <span className="tabular-nums font-medium">{shown}</span>
      </div>
      <div className="h-2 rounded-full bg-line overflow-hidden">
        <div
          className="h-full rounded-full bg-accent"
          style={{ width: `${Math.max(0, Math.min(100, meter.width))}%` }}
        />
      </div>
      {meter.detail ? <p className="text-xs text-mute tabular-nums">{meter.detail}</p> : null}
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

  const onDemand =
    spending?.onDemandEnabled == null
      ? '—'
      : spending.onDemandEnabled
        ? `On · ${money(spending.onDemandUsedCents)}${
            spending.onDemandLimitCents != null ? ` / ${money(spending.onDemandLimitCents)}` : ''
          }`
        : `Off · ${money(spending.onDemandUsedCents ?? 0)}`

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

      <section className="hb-surface p-4 space-y-4">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-xl font-semibold tracking-tight">
            {spending?.planName || (busy ? 'Loading…' : 'Spending')}
          </h2>
          {spending?.price ? <p className="text-sm text-mute">{spending.price}</p> : null}
        </div>
        {spending ? <p className="text-sm text-mute">{resetLine(spending)}</p> : null}

        {spending?.ok ? (
          <div className="space-y-4">
            <MeterRow meter={spending.included} />
            <MeterRow meter={spending.cursorModels} />
            <MeterRow meter={spending.otherModels} />
            <div className="flex items-baseline justify-between gap-3 text-sm pt-1">
              <span>On-demand</span>
              <span className="tabular-nums">{onDemand}</span>
            </div>
          </div>
        ) : null}

        <a
          href={spending?.dashboardUrl || 'https://cursor.com/dashboard/spending'}
          target="_blank"
          rel="noreferrer"
          className="text-xs text-mute underline underline-offset-2"
        >
          cursor.com/dashboard/spending
        </a>
      </section>
    </div>
  )
}
