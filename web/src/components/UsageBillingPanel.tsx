'use client'

import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/api'
import { useSceneRefresh } from '../lib/sceneRefresh'
import { AccessibleDialog } from './AccessibleDialog'

const PLANS = [
  { tier: 'pro' as const, name: 'Pro', price: '$20/mo', rank: 1 },
  { tier: 'pro_plus' as const, name: 'Pro+', price: '$60/mo', rank: 2 },
  { tier: 'ultra' as const, name: 'Ultra', price: '$200/mo', rank: 3 },
]

type PlanTier = (typeof PLANS)[number]['tier']
type LimitMode = 'disabled' | 'fixed' | 'unlimited'

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

function planTier(name: string | null | undefined): PlanTier | null {
  const n = (name || '').trim().toLowerCase()
  if (n === 'pro+') return 'pro_plus'
  if (n === 'pro') return 'pro'
  if (n === 'ultra') return 'ultra'
  return null
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

export function UsageBillingPanel() {
  const [spending, setSpending] = useState<Spending | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [planOpen, setPlanOpen] = useState(false)
  const [planPick, setPlanPick] = useState<PlanTier>('ultra')
  const [planBusy, setPlanBusy] = useState(false)
  const [limitMode, setLimitMode] = useState<LimitMode>('disabled')
  const [limitDollars, setLimitDollars] = useState('50')
  const [limitBusy, setLimitBusy] = useState(false)
  const [limitMsg, setLimitMsg] = useState('')

  const load = useCallback(async (refresh = false) => {
    setBusy(true)
    setError('')
    try {
      const next = await api.usage({ refresh })
      setSpending(next.spending)
      const mode = next.spending?.onDemandMode
      if (mode) setLimitMode(mode)
      if (next.spending?.onDemandLimitDollars != null) {
        setLimitDollars(String(next.spending.onDemandLimitDollars))
      }
      const tier = planTier(next.spending?.planName)
      if (tier) setPlanPick(tier)
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

  const currentTier = planTier(spending?.planName)
  const currentRank = PLANS.find((p) => p.tier === currentTier)?.rank ?? 0
  const picked = PLANS.find((p) => p.tier === planPick)
  const planAction =
    !picked || picked.tier === currentTier
      ? 'Current plan'
      : picked.rank < currentRank
        ? 'Schedule downgrade'
        : 'Continue to checkout'

  async function saveLimit() {
    setLimitBusy(true)
    setLimitMsg('')
    setError('')
    try {
      const dollars = Math.round(Number(limitDollars))
      await api.setUsageOnDemand(
        limitMode === 'fixed' ? { mode: 'fixed', dollars } : { mode: limitMode },
      )
      setLimitMsg('Saved')
      await load(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLimitBusy(false)
    }
  }

  async function confirmPlan() {
    if (!picked || picked.tier === currentTier) return
    setPlanBusy(true)
    setError('')
    try {
      const res = await api.startUsagePlanCheckout(picked.tier)
      if (res.url) window.open(res.url, '_blank', 'noopener,noreferrer')
      setPlanOpen(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setPlanBusy(false)
    }
  }

  const limitHint =
    spending?.onDemandMode === 'unlimited'
      ? 'Usage past your limit is billed later as on-demand.'
      : spending?.onDemandMode === 'fixed'
        ? "Requests stop at this limit. Overage from requests already running isn't billed unless the limit is raised this billing cycle."
        : 'On-demand spending is currently disabled'

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
        {spending?.ok ? (
          <button
            type="button"
            className="hb-btn hb-btn-ghost !min-h-9 !px-3 text-sm"
            onClick={() => {
              if (currentTier) setPlanPick(currentTier)
              setPlanOpen(true)
            }}
          >
            Adjust Plan
          </button>
        ) : null}
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
            <div className="hb-surface p-4 space-y-3">
              <div>
                <p className="text-sm">On-Demand Spending</p>
                <p className="text-xs text-mute leading-snug mt-0.5">{limitHint}</p>
              </div>
              <div className="flex flex-wrap items-center justify-end gap-2">
                <label className="text-xs text-mute sr-only" htmlFor="hb-ondemand-mode">
                  Monthly limit
                </label>
                <select
                  id="hb-ondemand-mode"
                  className="hb-select text-sm"
                  aria-label="Monthly limit"
                  value={limitMode}
                  disabled={limitBusy}
                  onChange={(e) => {
                    const next = e.target.value as LimitMode
                    setLimitMode(next)
                    setLimitMsg('')
                    if (next === 'fixed' && (!limitDollars || limitDollars === '0')) setLimitDollars('50')
                  }}
                >
                  <option value="fixed">Fixed</option>
                  <option value="unlimited">Unlimited</option>
                  <option value="disabled">Disabled</option>
                </select>
                {limitMode === 'fixed' ? (
                  <input
                    type="number"
                    min={1}
                    max={100000}
                    aria-label="Monthly limit amount"
                    className="w-24 rounded-[var(--radius-control)] border border-line bg-panel-2 px-2 py-2 text-sm tabular-nums"
                    value={limitDollars}
                    disabled={limitBusy}
                    onChange={(e) => {
                      setLimitDollars(e.target.value)
                      setLimitMsg('')
                    }}
                  />
                ) : null}
                <button
                  type="button"
                  className="hb-btn hb-btn-primary !min-h-9 !px-3 text-sm"
                  disabled={limitBusy}
                  onClick={() => void saveLimit()}
                >
                  {limitBusy ? '…' : 'Save'}
                </button>
              </div>
              <p className="text-xs text-mute">Set a fixed amount or make it unlimited.</p>
              {limitMsg ? <p className="text-xs text-sky">{limitMsg}</p> : null}
            </div>
          </section>
        </>
      ) : null}

      <AccessibleDialog
        open={planOpen}
        onClose={() => {
          if (!planBusy) setPlanOpen(false)
        }}
        title="Adjust plan"
        panelClassName="w-full max-w-md hb-surface p-4 space-y-3 shadow-xl"
      >
        <div className="space-y-2">
          {PLANS.map((plan) => {
            const selected = planPick === plan.tier
            const current = currentTier === plan.tier
            return (
              <button
                key={plan.tier}
                type="button"
                className={`w-full rounded-[var(--radius-control)] border px-3 py-2.5 text-left ${
                  selected ? 'border-accent bg-accent/10' : 'border-line bg-panel-2'
                }`}
                onClick={() => setPlanPick(plan.tier)}
              >
                <span className="flex items-baseline justify-between gap-3">
                  <span className="text-sm font-semibold">
                    {plan.name}
                    {current ? <span className="text-mute font-normal"> · Current</span> : null}
                  </span>
                  <span className="text-sm text-mute">{plan.price}</span>
                </span>
              </button>
            )
          })}
        </div>
        <p className="text-xs text-mute leading-snug">
          {picked && picked.rank < currentRank
            ? 'Downgrades keep this plan until the billing period ends. Cursor checkout confirms it.'
            : 'Upgrades take effect after checkout. Unused time on this plan is credited there.'}
        </p>
        <div className="flex gap-2">
          <button
            type="button"
            className="hb-btn hb-btn-ghost flex-1 !min-h-10"
            disabled={planBusy}
            onClick={() => setPlanOpen(false)}
          >
            Cancel
          </button>
          <button
            type="button"
            className="hb-btn hb-btn-primary flex-1 !min-h-10"
            disabled={planBusy || planPick === currentTier}
            onClick={() => void confirmPlan()}
          >
            {planBusy ? '…' : planAction}
          </button>
        </div>
      </AccessibleDialog>
    </div>
  )
}
