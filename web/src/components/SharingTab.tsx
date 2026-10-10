import QRCode from 'qrcode'
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { api } from '../lib/api'
import { setSession } from '../lib/auth'
import { isLocalHostPage } from '../lib/types'

/**
 * Localhost-only: reveal a timed QR with a one-time share id (not the password).
 * Phone redeems it for a 24h JWT. Also: change password here.
 * Always embedded under More/Settings.
 */
export function SharingTab(_props: { embedded?: boolean } = {}) {
  const [hostname, setHostname] = useState('')
  const [active, setActive] = useState(false)
  const [expiresIn, setExpiresIn] = useState(0)
  const [qrDataUrl, setQrDataUrl] = useState('')
  const [error, setError] = useState('')
  const [statusLine, setStatusLine] = useState('')
  const [currentPw, setCurrentPw] = useState('')
  const [newPw, setNewPw] = useState('')
  const [confirmPw, setConfirmPw] = useState('')
  const [pwMsg, setPwMsg] = useState('')
  const loginUrlRef = useRef('')

  const secureClear = useCallback(async (reason: string) => {
    loginUrlRef.current = ''
    setQrDataUrl('')
    setActive(false)
    setExpiresIn(0)
    setStatusLine(reason)
    try {
      await api.shareHide()
    } catch {
      /* ignore */
    }
  }, [])

  const refreshStatus = useCallback(async () => {
    if (!isLocalHostPage()) return
    try {
      const s = await api.shareStatus()
      setHostname(s.hostname)
      if (!s.active) {
        if (loginUrlRef.current) {
          await secureClear(s.consumed ? 'Someone signed in — QR cleared' : 'Share ended')
        }
        return
      }
      setActive(true)
      setExpiresIn(s.expiresIn)
      if (s.expiresIn <= 0) {
        await secureClear('Timed out — QR cleared')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [secureClear])

  useEffect(() => {
    if (!isLocalHostPage()) return
    refreshStatus()
    const t = setInterval(() => void refreshStatus(), 1000)
    return () => clearInterval(t)
  }, [refreshStatus])

  useEffect(() => {
    if (!active) return
    const t = setInterval(() => {
      setExpiresIn((s) => {
        if (s <= 1) {
          void secureClear('Timed out — QR cleared')
          return 0
        }
        return s - 1
      })
    }, 1000)
    return () => clearInterval(t)
  }, [active, secureClear])

  async function reveal() {
    setError('')
    setStatusLine('')
    try {
      const port = Number(location.port) || (location.protocol === 'https:' ? 443 : 80)
      const data = await api.shareReveal(port, location.protocol.replace(':', '') || 'http')
      loginUrlRef.current = data.loginUrl
      setHostname(data.hostname)
      setActive(true)
      setExpiresIn(data.expiresIn)
      const url = await QRCode.toDataURL(data.loginUrl, {
        width: 280,
        margin: 2,
        color: { dark: '#041018', light: '#f4f8ff' },
        errorCorrectionLevel: 'M',
      })
      setQrDataUrl(url)
      setStatusLine('One-time link · 20s · grants a 24h session (not your password)')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      await secureClear('')
    }
  }

  async function changePassword(e: FormEvent) {
    e.preventDefault()
    setPwMsg('')
    if (newPw.length < 8) {
      setPwMsg('New password must be at least 8 characters')
      return
    }
    if (newPw !== confirmPw) {
      setPwMsg('Passwords do not match')
      return
    }
    try {
      const session = await api.changePassword(newPw, currentPw)
      setSession(session.token, session.expiresAt)
      setCurrentPw('')
      setNewPw('')
      setConfirmPw('')
      setPwMsg('Password updated')
    } catch (err) {
      setPwMsg(err instanceof Error ? err.message : String(err))
    }
  }

  if (!isLocalHostPage()) {
    return null
  }

  return (
    <div className="space-y-4">
      <section className="hb-surface p-4 sm:p-5 space-y-4">
        <p className="text-xs text-mute leading-relaxed">
          One-time QR for{' '}
          <span className="font-mono text-sky">{hostname || '…'}</span> — never your password.
        </p>
        {!active || !qrDataUrl ? (
          <button
            type="button"
            onClick={() => void reveal()}
            className="hb-btn hb-btn-primary w-full"
          >
            Reveal QR
          </button>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center justify-between text-xs font-mono">
              <span className="text-ok">Live</span>
              <span className={expiresIn <= 5 ? 'text-danger' : 'text-amber'}>
                {expiresIn}s left
              </span>
            </div>
            <div className="rounded-2xl bg-text p-3 sm:p-4 flex justify-center">
              <img
                src={qrDataUrl}
                alt="Login QR code"
                className="w-56 h-56 sm:w-64 sm:h-64"
              />
            </div>
            <p className="text-[11px] font-mono text-mute break-all text-center">
              {hostname}:{location.port || '80'}
            </p>
            <button
              type="button"
              onClick={() => void secureClear('Hidden')}
              className="hb-btn hb-btn-danger w-full"
            >
              Hide & clear
            </button>
          </div>
        )}
        {statusLine && <p className="text-xs font-mono text-sky">{statusLine}</p>}
        {error && <p className="text-sm text-danger">{error}</p>}
      </section>

      <section className="hb-surface p-4 sm:p-5 space-y-3">
        <h2 className="hb-label">Change password</h2>
        <form onSubmit={changePassword} className="space-y-2.5">
          <input
            type="password"
            autoComplete="current-password"
            value={currentPw}
            onChange={(e) => setCurrentPw(e.target.value)}
            placeholder="Current password"
            className="w-full rounded-[var(--radius-control)] bg-panel-2 border border-line px-3 py-2.5 text-sm"
          />
          <input
            type="password"
            autoComplete="new-password"
            value={newPw}
            onChange={(e) => setNewPw(e.target.value)}
            placeholder="New password (10+, upper/lower/digit/special)"
            className="w-full rounded-[var(--radius-control)] bg-panel-2 border border-line px-3 py-2.5 text-sm"
          />
          <input
            type="password"
            autoComplete="new-password"
            value={confirmPw}
            onChange={(e) => setConfirmPw(e.target.value)}
            placeholder="Confirm new password"
            className="w-full rounded-[var(--radius-control)] bg-panel-2 border border-line px-3 py-2.5 text-sm"
          />
          <button type="submit" className="hb-btn hb-btn-ghost w-full">
            Update password
          </button>
          {pwMsg && (
            <p className={`text-xs ${pwMsg.includes('updated') ? 'text-ok' : 'text-danger'}`}>
              {pwMsg}
            </p>
          )}
        </form>
      </section>
    </div>
  )
}
