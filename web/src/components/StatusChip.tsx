import { useEffect, useRef, useState } from 'react'

type HostLink = 'live' | 'reconnecting' | 'unreachable'

/** Compact top-bar connection indicator; tap for host / VPN / Cursor / version details. */
export function StatusChip({
  hostLabel,
  hostLink,
  vpnActive,
  vpnHostHint,
  cursorConfigured,
  cursorRunning,
  version,
  backup,
}: {
  hostLabel: string
  hostLink: HostLink
  vpnActive: boolean | null
  vpnHostHint: string | null
  cursorConfigured: boolean
  cursorRunning: boolean
  version: string
  backup: boolean
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onPointer = (e: PointerEvent) => {
      if (rootRef.current && e.target instanceof Node && rootRef.current.contains(e.target)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointer, true)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  const linkLabel =
    hostLink === 'live' ? 'Live' : hostLink === 'reconnecting' ? 'Reconnecting' : 'Unreachable'
  const tone = hostLink === 'live' ? 'ok' : hostLink === 'reconnecting' ? 'warn' : 'err'

  return (
    <div className="hb-status-chip-wrap" ref={rootRef}>
      <button
        type="button"
        className="hb-status-chip"
        data-tone={tone}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={`Connection: ${linkLabel}. Tap for details`}
        onClick={() => setOpen((v) => !v)}
      >
        <span className={`hb-status-dot hb-status-dot--${tone}`} />
        <span className="hb-status-chip-label">{linkLabel}</span>
        {vpnActive !== null && (
          <span className="hb-status-chip-vpn" data-up={vpnActive ? '1' : '0'}>
            VPN
          </span>
        )}
      </button>
      {open && (
        <div className="hb-status-pop" role="dialog" aria-label="Connection details">
          <dl>
            <div>
              <dt>Host</dt>
              <dd className="font-mono truncate" title={hostLabel}>
                {hostLabel}
              </dd>
            </div>
            <div>
              <dt>Link</dt>
              <dd className={tone === 'ok' ? 'text-ok' : tone === 'warn' ? 'text-amber' : 'text-danger'}>
                {linkLabel}
              </dd>
            </div>
            {vpnActive !== null && (
              <div>
                <dt>VPN</dt>
                <dd className={vpnActive ? 'text-ok' : 'text-amber'}>
                  {vpnActive ? `Up${vpnHostHint ? ` · ${vpnHostHint}` : ''}` : 'Down — Settings → WireGuard'}
                </dd>
              </div>
            )}
            {cursorConfigured && (
              <div>
                <dt>Cursor</dt>
                <dd className={cursorRunning ? 'text-sky' : 'text-mute'}>
                  {cursorRunning ? 'Agent running' : 'Idle'}
                </dd>
              </div>
            )}
            {version && (
              <div>
                <dt>Version</dt>
                <dd className="font-mono">
                  v{version}
                  {backup ? ' · backup binary' : ''}
                </dd>
              </div>
            )}
          </dl>
        </div>
      )}
    </div>
  )
}
