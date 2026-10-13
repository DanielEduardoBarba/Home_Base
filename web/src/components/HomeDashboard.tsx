'use client'

import { BrandTitle } from './BrandTitle'
import { useServerIdentity } from '../lib/serverIdentity'

type Props = {
  version?: string
  hostLabel?: string
  hostLink?: 'live' | 'reconnecting' | 'unreachable'
  vpnActive?: boolean | null
  onOpenHomework: () => void
  onOpenAccess: () => void
  onOpenAgent: () => void
  onOpenVision: () => void
}

/**
 * Post-login landing — Agent, Work, Access, Vision.
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
}: Props) {
  const { displayName } = useServerIdentity()
  const linkLabel =
    hostLink === 'live' ? 'Live' : hostLink === 'reconnecting' ? 'Reconnecting' : 'Unreachable'

  return (
    <div className="hb-home h-full overflow-y-auto">
      <div className="hb-home-inner">
        <header className="hb-home-brand">
          <p className="hb-home-kicker">Control plane</p>
          <h1 className="hb-home-title">
            <BrandTitle name={displayName} />
          </h1>
          <p className="hb-home-sub">
            {hostLabel}
            <span className="hb-status-sep">·</span>
            <span
              className={
                hostLink === 'live'
                  ? 'text-ok'
                  : hostLink === 'reconnecting'
                    ? 'text-amber'
                    : 'text-danger'
              }
            >
              {linkLabel}
            </span>
            {vpnActive !== null && (
              <>
                <span className="hb-status-sep">·</span>
                <span className={vpnActive ? 'text-ok' : 'text-amber'}>
                  VPN {vpnActive ? 'up' : 'down'}
                </span>
              </>
            )}
            {version ? (
              <>
                <span className="hb-status-sep">·</span>
                <span className="text-mute">v{version}</span>
              </>
            ) : null}
          </p>
        </header>

        <div className="hb-home-actions" role="navigation" aria-label="Areas">
          <button type="button" className="hb-home-card hb-home-card--agent" onClick={onOpenAgent}>
            <span className="hb-home-card-label">Agent</span>
            <span className="hb-home-card-desc">
              Simple project chat — pick a folder, talk or type, bare shell/files when you need them.
            </span>
            <span className="hb-home-card-go">Open →</span>
          </button>
          <button type="button" className="hb-home-card" onClick={onOpenHomework}>
            <span className="hb-home-card-label">Work</span>
            <span className="hb-home-card-desc">
              Projects, Work, Chat, Shell, Files, View — the full laptop control plane.
            </span>
            <span className="hb-home-card-go">Open →</span>
          </button>
          <button type="button" className="hb-home-card hb-home-card--access" onClick={onOpenAccess}>
            <span className="hb-home-card-label">Access</span>
            <span className="hb-home-card-desc">
              Buttons, toggles, sliders, and gauges that trip scripts and APIs around the house.
            </span>
            <span className="hb-home-card-go">Open →</span>
          </button>
          <button type="button" className="hb-home-card hb-home-card--vision" onClick={onOpenVision}>
            <span className="hb-home-card-label">Vision</span>
            <span className="hb-home-card-desc">
              Live desktop + chat — Arm to let the agent drive mouse and keyboard on Ubuntu X11.
            </span>
            <span className="hb-home-card-go">Open →</span>
          </button>
        </div>
      </div>
    </div>
  )
}
