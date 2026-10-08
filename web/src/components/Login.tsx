import { useEffect, useState, type FormEvent } from 'react'
import { api } from '../lib/api'
import { setSession } from '../lib/auth'
import { isLocalHostPage } from '../lib/types'

function formatWait(sec: number): string {
  if (sec >= 86400) return `${Math.ceil(sec / 86400)}d`
  if (sec >= 3600) return `${Math.ceil(sec / 3600)}h`
  if (sec >= 60) return `${Math.ceil(sec / 60)}m`
  return `${sec}s`
}

function scrubShareParamsFromUrl() {
  try {
    const url = new URL(location.href)
    if (!url.searchParams.has('hb_share') && !url.searchParams.has('hb_token')) return
    url.searchParams.delete('hb_share')
    url.searchParams.delete('hb_token')
    const clean =
      url.pathname + (url.searchParams.toString() ? `?${url.searchParams}` : '') + url.hash
    history.replaceState(null, '', clean || '/')
  } catch {
    /* ignore */
  }
}

function readShareId(): string {
  try {
    return (new URLSearchParams(location.search).get('hb_share') || '').trim()
  } catch {
    return ''
  }
}

export function Login({ onAuthed }: { onAuthed: () => void }) {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [show, setShow] = useState(false)
  const [error, setError] = useState('')
  const [retryAfter, setRetryAfter] = useState(0)
  const [autoStatus, setAutoStatus] = useState('')
  const [passwordSet, setPasswordSet] = useState<boolean | null>(null)
  const local = isLocalHostPage()

  useEffect(() => {
    if (retryAfter <= 0) return
    const t = setInterval(() => setRetryAfter((s) => Math.max(0, s - 1)), 1000)
    return () => clearInterval(t)
  }, [retryAfter])

  useEffect(() => {
    api
      .authStatus()
      .then((s) => {
        setPasswordSet(s.passwordSet)
        if (s.lockout?.locked) setRetryAfter(s.lockout.retryAfter)
      })
      .catch(() => setPasswordSet(true))
  }, [])

  // QR share: redeem one-time id → 24h JWT, scrub URL
  useEffect(() => {
    const shareId = readShareId()
    if (!shareId) return
    let cancelled = false
    setAutoStatus('Redeeming share link…')
    ;(async () => {
      try {
        scrubShareParamsFromUrl()
        const session = await api.shareRedeem(shareId)
        if (cancelled) return
        setSession(session.token, session.expiresAt)
        setAutoStatus('')
        onAuthed()
      } catch (err) {
        if (cancelled) return
        scrubShareParamsFromUrl()
        setAutoStatus('')
        const detail = (err as { detail?: unknown }).detail
        setError(
          typeof detail === 'string'
            ? detail
            : 'Share link expired or already used — ask the host to reveal again',
        )
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (retryAfter > 0) return
    setError('')

    // Localhost first-run: create password
    if (local && passwordSet === false) {
      if (password.length < 8) {
        setError('Password must be at least 8 characters')
        return
      }
      if (password !== confirm) {
        setError('Passwords do not match')
        return
      }
      try {
        const session = await api.setPassword(password)
        setSession(session.token, session.expiresAt)
        onAuthed()
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
      return
    }

    try {
      const session = await api.login(password)
      setSession(session.token, session.expiresAt)
      onAuthed()
    } catch (err) {
      const detail = (err as { detail?: unknown }).detail
      let message = 'Invalid password'
      let wait = 0
      if (typeof detail === 'object' && detail) {
        const d = detail as { message?: string; retryAfter?: number }
        message = d.message || message
        wait = d.retryAfter || 0
      } else if (typeof detail === 'string') {
        try {
          const parsed = JSON.parse(detail)
          message = parsed.message || message
          wait = parsed.retryAfter || 0
        } catch {
          message = detail
        }
      }
      setError(message)
      if (wait > 0) setRetryAfter(wait)
    }
  }

  const setupMode = local && passwordSet === false

  return (
    <div className="min-h-full flex flex-col justify-end sm:justify-center px-5 pb-12 pt-20">
      <div className="max-w-md w-full mx-auto hb-enter">
        <div className="mb-6 h-px w-14 bg-gradient-to-r from-accent to-transparent" />
        <p className="font-display text-[clamp(2.75rem,12vw,4.5rem)] font-extrabold leading-[0.9] tracking-tight text-text">
          Home
          <span className="text-accent"> Base</span>
        </p>
        <p className="mt-5 text-mute text-base max-w-sm leading-relaxed">
          {setupMode
            ? 'Create a password on this machine. Only localhost can set or change it.'
            : 'Sign in with your password. Sessions last 24 hours.'}
        </p>
        {autoStatus && (
          <p className="mt-4 text-sm font-mono text-sky animate-pulse">{autoStatus}</p>
        )}
        <form onSubmit={submit} className="mt-10 space-y-4">
          <label className="block">
            <span className="text-[11px] uppercase tracking-[0.2em] text-mute">
              {setupMode ? 'New password' : 'Password'}
            </span>
            <div className="relative mt-2">
              <input
                type={show ? 'text' : 'password'}
                autoComplete={setupMode ? 'new-password' : 'current-password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={setupMode ? 'At least 8 characters' : 'Password'}
                disabled={retryAfter > 0 || !!autoStatus}
                className="w-full rounded-xl bg-panel/90 border border-line pl-4 pr-12 py-3.5 text-text disabled:opacity-50"
              />
              <button
                type="button"
                onClick={() => setShow((v) => !v)}
                disabled={retryAfter > 0}
                aria-label={show ? 'Hide password' : 'Show password'}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg p-2 text-mute hover:text-text disabled:opacity-40"
              >
                {show ? 'Hide' : 'Show'}
              </button>
            </div>
          </label>
          {setupMode && (
            <label className="block">
              <span className="text-[11px] uppercase tracking-[0.2em] text-mute">Confirm</span>
              <input
                type={show ? 'text' : 'password'}
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder="Repeat password"
                className="mt-2 w-full rounded-xl bg-panel/90 border border-line px-4 py-3.5 text-text"
              />
            </label>
          )}
          {error && <p className="text-danger text-sm">{error}</p>}
          {retryAfter > 0 && (
            <p className="text-warn text-sm font-mono">
              Locked — try again in {formatWait(retryAfter)}
            </p>
          )}
          {!local && passwordSet === false && (
            <p className="text-warn text-sm">
              Password has not been set yet. Open Home Base on the host via localhost first.
            </p>
          )}
          <button
            type="submit"
            disabled={retryAfter > 0 || !!autoStatus || passwordSet === null}
            className="w-full rounded-xl bg-accent text-ink font-semibold py-3.5 shadow-[0_8px_28px_rgba(46,230,200,0.22)] disabled:opacity-40 disabled:shadow-none"
          >
            {setupMode ? 'Create password' : 'Enter'}
          </button>
        </form>
      </div>
    </div>
  )
}
