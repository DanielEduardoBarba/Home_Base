'use client'

import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/api'
import { DoodleBlob } from './DoodleBlob'
import { VoiceCheck } from './VoiceCheck'

export type DoodleTabletRow = {
  deviceId: string
  name: string
  enrolledAt: number
  lastSeenAt: number
  userAgent: string | null
  tokenRev: number
}

function shortId(id: string): string {
  if (id.length <= 14) return id
  return `${id.slice(0, 8)}…${id.slice(-4)}`
}

function deviceKind(ua: string | null): string {
  if (!ua) return 'Device'
  const u = ua.toLowerCase()
  if (/ipad/.test(u)) return 'iPad'
  if (/iphone/.test(u)) return 'iPhone'
  if (/android/.test(u) && /mobile/.test(u)) return 'Phone'
  if (/android/.test(u)) return 'Tablet'
  if (/macintosh|mac os/.test(u)) return 'Mac'
  if (/windows/.test(u)) return 'PC'
  if (/linux/.test(u)) return 'Linux'
  return 'Device'
}

function relTime(ts: number): string {
  if (!ts) return '—'
  const sec = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (sec < 45) return 'just now'
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`
  if (sec < 86400 * 14) return `${Math.floor(sec / 86400)}d ago`
  return new Date(ts).toLocaleDateString()
}

/**
 * Settings → Doodle → Devices — kid-themed list of trusted tablets.
 * Session-auth only; untrust removes the device, revoke kills its 30-day JWT.
 */
export function DoodleDevicesSettings({ onBack }: { onBack: () => void }) {
  const [tablets, setTablets] = useState<DoodleTabletRow[]>([])
  const [ttlSec, setTtlSec] = useState(30 * 24 * 60 * 60)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [msg, setMsg] = useState('')
  const [confirm, setConfirm] = useState<
    | null
    | { kind: 'forget' | 'revoke'; deviceId: string; name: string }
    | { kind: 'forgetAll' | 'revokeAll' }
  >(null)

  const load = useCallback(async () => {
    try {
      const res = await api.doodleTablets()
      setTablets(res.tablets || [])
      if (res.ttlSec) setTtlSec(res.ttlSec)
      setErr('')
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (!msg) return
    const t = window.setTimeout(() => setMsg(''), 4200)
    return () => window.clearTimeout(t)
  }, [msg])

  async function runConfirm() {
    if (!confirm || busy) return
    setBusy(true)
    setErr('')
    try {
      if (confirm.kind === 'forget') {
        const res = await api.doodleTabletsForget({ deviceId: confirm.deviceId })
        setTablets(res.tablets || [])
        setMsg(`Untrusted ${confirm.name}.`)
        try {
          localStorage.removeItem('hb-doodle-enrolled')
        } catch {
          /* ignore */
        }
      } else if (confirm.kind === 'forgetAll') {
        const res = await api.doodleTabletsForget({ all: true })
        setTablets(res.tablets || [])
        setMsg('All Doodle tablets untrusted.')
        try {
          localStorage.removeItem('hb-doodle-enrolled')
        } catch {
          /* ignore */
        }
      } else if (confirm.kind === 'revoke') {
        const res = await api.doodleTabletsRevoke({ deviceId: confirm.deviceId })
        setTablets(res.tablets || [])
        setMsg(`Long-term token reset for ${confirm.name}.`)
      } else {
        const res = await api.doodleTabletsRevoke({ all: true })
        setTablets(res.tablets || [])
        setMsg('All Doodle long-term tokens reset.')
      }
      setConfirm(null)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const days = Math.round(ttlSec / 86400)

  return (
    <div className="hb-doodle-settings h-full overflow-y-auto">
      <div className="hb-doodle-settings-inner hb-enter">
        <header className="hb-doodle-settings-head">
          <button type="button" className="hb-doodle-settings-back" onClick={onBack}>
            ← Settings
          </button>
          <div className="hb-doodle-settings-hero">
            <DoodleBlob
              express={{ mouth: 'happy', color: '#ffb703', energy: 0.7, bubble: '', name: '' }}
              size={72}
            />
            <div className="min-w-0">
              <p className="hb-doodle-settings-eyebrow">Doodle</p>
              <h1>Devices</h1>
              <p>
                Trusted tablets that can open Doodle without the App PIN for about {days} days.
                Other Home Base areas still use normal security.
              </p>
            </div>
          </div>
        </header>

        {msg ? (
          <p className="hb-doodle-settings-toast" role="status">
            {msg}
          </p>
        ) : null}
        {err ? (
          <p className="hb-doodle-settings-err" role="alert">
            {err}
          </p>
        ) : null}

        <div className="hb-doodle-settings-actions">
          <button
            type="button"
            className="hb-doodle-settings-pill"
            disabled={busy || tablets.length === 0}
            onClick={() => setConfirm({ kind: 'revokeAll' })}
          >
            Reset all tokens
          </button>
          <button
            type="button"
            className="hb-doodle-settings-pill hb-doodle-settings-pill--warn"
            disabled={busy || tablets.length === 0}
            onClick={() => setConfirm({ kind: 'forgetAll' })}
          >
            Untrust all
          </button>
        </div>

        {tablets.length === 0 ? (
          <div className="hb-doodle-settings-empty">
            <DoodleBlob
              express={{ mouth: 'curious', color: '#3a86ff', energy: 0.5, bubble: '', name: '' }}
              size={88}
            />
            <p className="hb-doodle-settings-empty-title">No trusted tablets yet</p>
            <p>
              Open Doodle on a device and tap <strong>Yes, remember</strong> when asked. It will
              show up here.
            </p>
          </div>
        ) : (
          <ul className="hb-doodle-settings-list">
            {tablets.map((t) => (
              <li key={t.deviceId} className="hb-doodle-settings-card">
                <div className="hb-doodle-settings-card-top">
                  <span className="hb-doodle-settings-badge" aria-hidden>
                    {deviceKind(t.userAgent) === 'iPad'
                      ? '📱'
                      : deviceKind(t.userAgent) === 'iPhone'
                        ? '📱'
                        : '💻'}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="hb-doodle-settings-name">{t.name || 'Doodle tablet'}</p>
                    <p className="hb-doodle-settings-meta">
                      {deviceKind(t.userAgent)} · {shortId(t.deviceId)}
                    </p>
                    <p className="hb-doodle-settings-meta">
                      Seen {relTime(t.lastSeenAt)} · trusted {relTime(t.enrolledAt)}
                      {t.tokenRev > 0 ? ` · token #${t.tokenRev + 1}` : ''}
                    </p>
                  </div>
                </div>
                <div className="hb-doodle-settings-card-actions">
                  <button
                    type="button"
                    className="hb-doodle-settings-btn"
                    disabled={busy}
                    onClick={() =>
                      setConfirm({ kind: 'revoke', deviceId: t.deviceId, name: t.name })
                    }
                  >
                    Reset token
                  </button>
                  <button
                    type="button"
                    className="hb-doodle-settings-btn hb-doodle-settings-btn--warn"
                    disabled={busy}
                    onClick={() =>
                      setConfirm({ kind: 'forget', deviceId: t.deviceId, name: t.name })
                    }
                  >
                    Untrust
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}

        <p className="hb-doodle-settings-footnote">
          <strong>Untrust</strong> forgets the device — it must enroll again.{' '}
          <strong>Reset token</strong> keeps it listed but kills its month-long cookie until a
          grown-up re-remembers it from Doodle.
        </p>

        <VoiceCheck kid className="hb-doodle-voice-check" />
      </div>

      {confirm ? (
        <div className="hb-doodle-settings-confirm" role="dialog" aria-modal="true">
          <div className="hb-doodle-settings-confirm-card">
            <DoodleBlob
              express={{
                mouth: confirm.kind === 'forget' || confirm.kind === 'forgetAll' ? 'sad' : 'blank',
                color: '#ff70c4',
                energy: 0.4,
                bubble: '',
                name: '',
              }}
              size={64}
            />
            <h2>
              {confirm.kind === 'forget'
                ? `Untrust ${confirm.name}?`
                : confirm.kind === 'forgetAll'
                  ? 'Untrust every tablet?'
                  : confirm.kind === 'revoke'
                    ? `Reset token for ${confirm.name}?`
                    : 'Reset every Doodle token?'}
            </h2>
            <p>
              {confirm.kind === 'forget' || confirm.kind === 'forgetAll'
                ? 'That device will need Yes, remember (and PIN if set) to skip Doodle lock again.'
                : 'Its long-term cookie stops working right away. The tablet stays trusted until untrusted, but must enroll again for a new cookie.'}
            </p>
            <div className="hb-doodle-settings-confirm-actions">
              <button
                type="button"
                className="hb-doodle-settings-btn"
                disabled={busy}
                onClick={() => setConfirm(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="hb-doodle-settings-btn hb-doodle-settings-btn--warn"
                disabled={busy}
                onClick={() => void runConfirm()}
              >
                {busy ? 'Working…' : 'Yes, do it'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
