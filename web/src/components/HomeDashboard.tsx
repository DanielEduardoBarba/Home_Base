'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { BrandTitle } from './BrandTitle'
import { useServerIdentity } from '../lib/serverIdentity'
import { readShowAccess } from '../lib/uiPrefs'

type Props = {
  version?: string
  hostLabel?: string
  hostLink?: 'live' | 'reconnecting' | 'unreachable'
  vpnActive?: boolean | null
  onOpenHomework: () => void
  onOpenAccess: () => void
  onOpenAgent: () => void
  onOpenVision: () => void
  onOpenSettings: () => void
}

function HomeCard({
  tone,
  label,
  desc,
  badge,
  icon,
  onClick,
}: {
  tone: 'work' | 'agent' | 'vision' | 'settings' | 'access'
  label: string
  desc: string
  badge?: string
  icon: ReactNode
  onClick: () => void
}) {
  return (
    <button
      type="button"
      className={`hb-home-card hb-home-card--${tone}${badge ? ' hb-home-card--advanced' : ''}`}
      onClick={onClick}
    >
      <span className="hb-home-card-icon" aria-hidden>
        <svg viewBox="0 0 24 24">{icon}</svg>
      </span>
      <span className="hb-home-card-text">
        <span className="hb-home-card-label">
          {label}
          {badge ? <span className="hb-home-card-badge">{badge}</span> : null}
        </span>
        <span className="hb-home-card-desc">{desc}</span>
      </span>
      <svg className="hb-home-card-chev" viewBox="0 0 24 24" aria-hidden>
        <path d="m9 6 6 6-6 6" />
      </svg>
    </button>
  )
}

/**
 * Post-login landing — Agent, Work, Vision, Settings.
 * Home Access is advanced / off-by-default (Settings → Appearance).
 */
export function HomeDashboard({
  version,
  hostLabel = 'host',
  hostLink = 'live',
  vpnActive = null,
  onOpenHomework,
  onOpenAccess,
  onOpenAgent,
  onOpenVision,
  onOpenSettings,
}: Props) {
  const { displayName } = useServerIdentity()
  const [showAccess, setShowAccess] = useState(false)
  useEffect(() => {
    setShowAccess(readShowAccess())
  }, [])
  const linkLabel =
    hostLink === 'live' ? 'Live' : hostLink === 'reconnecting' ? 'Reconnecting' : 'Unreachable'
  const linkTone = hostLink === 'live' ? 'ok' : hostLink === 'reconnecting' ? 'warn' : 'err'

  return (
    <div className="hb-home h-full overflow-y-auto">
      <div className="hb-home-inner">
        <header className="hb-home-brand">
          <p className="hb-home-kicker">Control plane</p>
          <h1 className="hb-home-title">
            <BrandTitle name={displayName} />
          </h1>
          <div className="hb-home-sub" role="status" aria-live="polite">
            <span className="hb-home-pill" data-tone={linkTone}>
              <span className={`hb-status-dot hb-status-dot--${linkTone}`} />
              <span className="truncate max-w-[10rem]">{hostLabel}</span>
              <span className="opacity-60">·</span>
              {linkLabel}
            </span>
            {vpnActive !== null && (
              <span className="hb-home-pill" data-tone={vpnActive ? 'ok' : 'warn'}>
                VPN {vpnActive ? 'up' : 'down'}
              </span>
            )}
            {version ? <span className="hb-home-pill">v{version}</span> : null}
          </div>
        </header>

        <div className="hb-home-actions" role="navigation" aria-label="Areas">
          <HomeCard
            tone="work"
            label="Work"
            desc="Apps, Shell, Files, Git and Chat for each workspace."
            onClick={onOpenHomework}
            icon={
              <>
                <rect x="3.5" y="5" width="17" height="14" rx="2" />
                <path d="M3.5 9.5h17" />
                <path d="m8 13 2 1.75L8 16.5M12.5 16.5h3.5" />
              </>
            }
          />
          <HomeCard
            tone="agent"
            label="Agent"
            desc="Simple project chat — pick a folder, then talk or type."
            onClick={onOpenAgent}
            icon={
              <>
                <path d="M5 5.5h14a1.5 1.5 0 0 1 1.5 1.5v8.5A1.5 1.5 0 0 1 19 17h-7l-4.5 3.5V17H5a1.5 1.5 0 0 1-1.5-1.5V7A1.5 1.5 0 0 1 5 5.5z" />
                <path d="M8 10h8M8 13h5" />
              </>
            }
          />
          <HomeCard
            tone="vision"
            label="Vision"
            desc="Live desktop + chat. Arm to let the agent drive mouse and keyboard."
            onClick={onOpenVision}
            icon={
              <>
                <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
                <circle cx="12" cy="12" r="3" />
              </>
            }
          />
          <HomeCard
            tone="settings"
            label="Settings"
            desc="Theme, PIN, Cursor key, AI usage, VPN, tunnel, storage."
            onClick={onOpenSettings}
            icon={
              <>
                <circle cx="12" cy="12" r="3" />
                <path d="M12 2.75v2.5M12 18.75v2.5M2.75 12h2.5M18.75 12h2.5M5.46 5.46l1.77 1.77M16.77 16.77l1.77 1.77M5.46 18.54l1.77-1.77M16.77 7.23l1.77-1.77" />
              </>
            }
          />
          {showAccess ? (
            <HomeCard
              tone="access"
              label="Access"
              badge="Advanced"
              desc="Buttons, toggles, sliders and gauges that trip scripts and APIs."
              onClick={onOpenAccess}
              icon={
                <>
                  <rect x="4" y="4" width="7" height="7" rx="1.5" />
                  <rect x="13" y="4" width="7" height="7" rx="1.5" />
                  <path d="M4 17.5h16" />
                  <circle cx="9" cy="17.5" r="2" />
                </>
              }
            />
          ) : null}
        </div>
      </div>
    </div>
  )
}
