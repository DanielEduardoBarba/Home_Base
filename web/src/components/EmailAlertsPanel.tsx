import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/api'

type Provider = 'resend' | 'smtp'

type Status = {
  enabled: boolean
  provider: Provider
  to: string
  from: string
  smtpHost: string
  smtpPort: number
  smtpUser: string
  smtpSecure: boolean
  resendConfigured: boolean
  resendHint: string | null
  smtpPassConfigured: boolean
  ready: boolean
  seat: {
    away: boolean
    reason: string
    idleMs: number | null
    locked: boolean
    detail?: string
  }
}

export function EmailAlertsPanel() {
  const [status, setStatus] = useState<Status | null>(null)
  const [enabled, setEnabled] = useState(false)
  const [provider, setProvider] = useState<Provider>('resend')
  const [to, setTo] = useState('')
  const [from, setFrom] = useState('')
  const [smtpHost, setSmtpHost] = useState('')
  const [smtpPort, setSmtpPort] = useState(587)
  const [smtpUser, setSmtpUser] = useState('')
  const [smtpSecure, setSmtpSecure] = useState(false)
  const [resendApiKey, setResendApiKey] = useState('')
  const [smtpPass, setSmtpPass] = useState('')
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(() => {
    void api
      .emailAlerts()
      .then((s) => {
        setStatus(s)
        setEnabled(s.enabled)
        setProvider(s.provider)
        setTo(s.to)
        setFrom(s.from)
        setSmtpHost(s.smtpHost)
        setSmtpPort(s.smtpPort)
        setSmtpUser(s.smtpUser)
        setSmtpSecure(s.smtpSecure)
      })
      .catch((e) => setMsg(e instanceof Error ? e.message : String(e)))
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const save = () => {
    setBusy(true)
    setMsg('')
    const body: Parameters<typeof api.saveEmailAlerts>[0] = {
      enabled,
      provider,
      to,
      from,
      smtpHost,
      smtpPort,
      smtpUser,
      smtpSecure,
    }
    if (resendApiKey.trim()) body.resendApiKey = resendApiKey.trim()
    if (smtpPass) body.smtpPass = smtpPass
    void api
      .saveEmailAlerts(body)
      .then(() => {
        setResendApiKey('')
        setSmtpPass('')
        setMsg('Saved')
        refresh()
      })
      .catch((e) => setMsg(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false))
  }

  const seatLabel = status
    ? status.seat.away
      ? `Away · ${status.seat.reason}${status.seat.detail ? ` · ${status.seat.detail}` : ''}`
      : 'Present at this laptop'
    : '…'

  return (
    <div className="space-y-3">
      <section className="hb-surface p-3.5 space-y-2.5">
        <p className="text-xs text-mute leading-relaxed">
          Emails only for suspicious auth (3+ failed logins / PIN attempts, or lockout) and when
          an AI uses Home Base while you are away (locked, no desktop session, or idle 10+ min).
          One AI mail per away period — not a stream of tool pings. Humans only; MCP cannot change
          this.
        </p>
        <p className="text-[11px] text-mute font-mono">Seat now: {seatLabel}</p>

        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          onClick={() => setEnabled(!enabled)}
          className="w-full flex items-center justify-between gap-3 text-left rounded-xl border border-line bg-panel-2/60 px-3 py-3"
        >
          <span className="min-w-0">
            <span className="block text-sm font-semibold">Email alerts</span>
            <span className="block text-xs text-mute mt-0.5">
              {status?.ready ? (enabled ? 'Armed' : 'Configured · off') : 'Needs destination + provider secrets'}
            </span>
          </span>
          <span className={`hb-switch shrink-0 ${enabled ? 'hb-switch--on' : ''}`} aria-hidden>
            <span className="hb-switch-knob" />
          </span>
        </button>

        <label className="block space-y-1">
          <span className="text-xs text-mute">Send to</span>
          <input
            type="email"
            autoComplete="email"
            className="w-full rounded-[var(--radius-control)] bg-panel-2 border border-line px-3 py-2.5 text-sm"
            placeholder="you@example.com"
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </label>

        <div className="flex gap-2">
          {(['resend', 'smtp'] as const).map((p) => (
            <button
              key={p}
              type="button"
              className={`hb-btn text-sm !min-h-9 flex-1 ${
                provider === p ? 'hb-btn-primary' : 'hb-btn-ghost'
              }`}
              onClick={() => setProvider(p)}
            >
              {p === 'resend' ? 'Resend' : 'SMTP'}
            </button>
          ))}
        </div>

        <label className="block space-y-1">
          <span className="text-xs text-mute">From</span>
          <input
            type="text"
            className="w-full rounded-[var(--radius-control)] bg-panel-2 border border-line px-3 py-2.5 text-sm"
            placeholder={
              provider === 'resend'
                ? 'Home Base <alerts@yourdomain.com>'
                : 'alerts@yourdomain.com'
            }
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </label>

        {provider === 'resend' ? (
          <label className="block space-y-1">
            <span className="text-xs text-mute">
              Resend API key
              {status?.resendConfigured
                ? ` · stored ${status.resendHint || '••••'}`
                : ''}
            </span>
            <input
              type="password"
              autoComplete="off"
              className="w-full rounded-[var(--radius-control)] bg-panel-2 border border-line px-3 py-2.5 text-sm font-mono"
              placeholder={status?.resendConfigured ? 'Replace key…' : 're_…'}
              value={resendApiKey}
              onChange={(e) => setResendApiKey(e.target.value)}
            />
          </label>
        ) : (
          <div className="space-y-2.5">
            <label className="block space-y-1">
              <span className="text-xs text-mute">SMTP host</span>
              <input
                type="text"
                className="w-full rounded-[var(--radius-control)] bg-panel-2 border border-line px-3 py-2.5 text-sm font-mono"
                placeholder="smtp.gmail.com"
                value={smtpHost}
                onChange={(e) => setSmtpHost(e.target.value)}
              />
            </label>
            <div className="flex gap-2">
              <label className="block space-y-1 flex-1">
                <span className="text-xs text-mute">Port</span>
                <input
                  type="number"
                  className="w-full rounded-[var(--radius-control)] bg-panel-2 border border-line px-3 py-2.5 text-sm font-mono"
                  value={smtpPort}
                  onChange={(e) => setSmtpPort(Number(e.target.value) || 587)}
                />
              </label>
              <button
                type="button"
                role="switch"
                aria-checked={smtpSecure}
                onClick={() => setSmtpSecure(!smtpSecure)}
                className="mt-5 flex items-center gap-2 rounded-xl border border-line bg-panel-2/60 px-3 py-2.5 text-xs"
              >
                <span className={`hb-switch shrink-0 ${smtpSecure ? 'hb-switch--on' : ''}`}>
                  <span className="hb-switch-knob" />
                </span>
                TLS (465)
              </button>
            </div>
            <label className="block space-y-1">
              <span className="text-xs text-mute">Username</span>
              <input
                type="text"
                autoComplete="username"
                className="w-full rounded-[var(--radius-control)] bg-panel-2 border border-line px-3 py-2.5 text-sm"
                value={smtpUser}
                onChange={(e) => setSmtpUser(e.target.value)}
              />
            </label>
            <label className="block space-y-1">
              <span className="text-xs text-mute">
                Password / app password
                {status?.smtpPassConfigured ? ' · stored' : ''}
              </span>
              <input
                type="password"
                autoComplete="new-password"
                className="w-full rounded-[var(--radius-control)] bg-panel-2 border border-line px-3 py-2.5 text-sm"
                placeholder={status?.smtpPassConfigured ? 'Replace…' : 'App password'}
                value={smtpPass}
                onChange={(e) => setSmtpPass(e.target.value)}
              />
            </label>
          </div>
        )}

        <div className="flex flex-wrap gap-2 pt-1">
          <button
            type="button"
            className="hb-btn hb-btn-primary text-sm !min-h-10"
            disabled={busy}
            onClick={save}
          >
            Save
          </button>
          <button
            type="button"
            className="hb-btn hb-btn-ghost text-sm !min-h-10"
            disabled={busy || !status?.ready}
            onClick={() => {
              setBusy(true)
              setMsg('')
              void api
                .testEmailAlerts()
                .then(() => setMsg('Test sent'))
                .catch((e) => setMsg(e instanceof Error ? e.message : String(e)))
                .finally(() => setBusy(false))
            }}
          >
            Send test
          </button>
          {(status?.resendConfigured || status?.smtpPassConfigured) && (
            <button
              type="button"
              className="hb-btn hb-btn-ghost text-sm !min-h-10"
              disabled={busy}
              onClick={() => {
                setBusy(true)
                void api
                  .clearEmailAlertSecrets()
                  .then(() => {
                    setMsg('Secrets cleared')
                    refresh()
                  })
                  .catch((e) => setMsg(e instanceof Error ? e.message : String(e)))
                  .finally(() => setBusy(false))
              }}
            >
              Clear secrets
            </button>
          )}
        </div>
        {msg && <p className="text-xs text-sky">{msg}</p>}
      </section>
    </div>
  )
}
