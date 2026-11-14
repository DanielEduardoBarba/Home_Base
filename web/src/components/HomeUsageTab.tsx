'use client'

import { HomeIconButton } from './HomeGlyph'
import { UsageBillingPanel } from './UsageBillingPanel'

/**
 * Usage — Cursor plan / renewal / model pools / Grok MCP / local Chat activity
 * for the API key stored on this Home Base.
 */
export function HomeUsageTab({ onHome }: { onHome: () => void }) {
  return (
    <div className="h-full overflow-y-auto">
      <div className="hb-page hb-page--no-nav space-y-4 hb-enter !max-w-lg">
        <header className="space-y-3">
          <HomeIconButton onClick={onHome} className="hb-topbar-home shrink-0 -ml-1" />
          <div>
            <div className="hb-brand-rule" />
            <h1 className="font-display text-2xl md:text-3xl font-extrabold tracking-tight">
              Usage
            </h1>
            <p className="text-mute text-sm mt-1.5 leading-relaxed">
              Plan for the Cursor API key on this laptop — legacy vs The X Subscription, days
              until reset, Cursor / Other models, Grok bots, and local Chat.
            </p>
          </div>
        </header>
        <UsageBillingPanel />
      </div>
    </div>
  )
}
