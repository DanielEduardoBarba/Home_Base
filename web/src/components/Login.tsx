import { useEffect, useMemo, useState, type FormEvent } from 'react'
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

function strengthIssues(pw: string): string[] {
  const issues: string[] = []
  if (pw.length < 10) issues.push('10+ characters')
  if (!/[a-z]/.test(pw)) issues.push('lowercase')
  if (!/[A-Z]/.test(pw)) issues.push('uppercase')
  if (!/[0-9]/.test(pw)) issues.push('digit')
  if (!/[^A-Za-z0-9]/.test(pw)) issues.push('special character')
  return issues
}

export function Login({ onAuthed }: { onAuthed: () => void }) {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [show, setShow] = useState(false)
  const [error, setError] = useState('')
  const [retryAfter, setRetryAfter] = useState(0)
  const [autoStatus, setAutoStatus] = useState('')
  const [canBootstrap, setCanBootstrap] = useState<boolean | null>(null)
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
        setCanBootstrap(!!s.canBootstrap)
        if (s.lockout?.locked) setRetryAfter(s.lockout.retryAfter)
      })
      .catch(() => setCanBootstrap(false))
  }, [])

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
      } catch {
        if (cancelled) return
        scrubShareParamsFromUrl()
        setAutoStatus('')
        setError('Share link expired or already used — ask the host to reveal again')
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const setupMode = local && canBootstrap === true
  const issues = useMemo(
    () => (setupMode ? strengthIssues(password) : []),
    [setupMode, password],
  )

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (retryAfter > 0) return
    setError('')

    if (setupMode) {
      if (issues.length) {
        setError(`Password needs: ${issues.join(', ')}`)
        return
      }
      if (password !== confirm) {
        setError('Passwords do not match')
        return
      }
      try {
        const session = await api.bootstrapPassword(password)
        setSession(session.token, session.expiresAt)
        onAuthed()
      } catch (err) {
        const detail = (err as { detail?: unknown }).detail
        setError(
          typeof detail === 'string'
            ? detail
            : err instanceof Error
              ? err.message
              : String(err),
        )
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

  return (
    <div className="min-h-full flex flex-col justify-end sm:justify-center px-5 pb-14 pt-16 sm:px-8">
      <div className="w-full max-w-md mx-auto hb-enter">
        <div className="hb-brand-rule" />
        <h1 className="font-display text-[clamp(2.6rem,11vw,4.25rem)] font-extrabold leading-[0.92] tracking-tight">
          Home
          <span className="text-accent"> Base</span>
        </h1>
        <p className="mt-3 text-mute text-sm leading-relaxed max-w-sm">
          {setupMode
            ? 'Create a strong password for this machine. This can only be done once from localhost.'
            : 'Control plane for your workspaces.'}
        </p>

        {autoStatus && (
          <p className="mt-5 text-sm font-mono text-sky animate-pulse">{autoStatus}</p>
        )}

        <form onSubmit={submit} className="mt-8 hb-surface p-5 sm:p-6 space-y-4">
          <label className="block space-y-1.5">
            <span className="hb-label">{setupMode ? 'New password' : 'Password'}</span>
            <div className="relative">
              <input
                type={show ? 'text' : 'password'}
                autoComplete={setupMode ? 'new-password' : 'current-password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={setupMode ? 'Upper, lower, digit, special…' : 'Password'}
                disabled={retryAfter > 0 || !!autoStatus}
                className="w-full rounded-[var(--radius-control)] bg-panel-2 border border-line pl-4 pr-16 py-3.5 text-text disabled:opacity-50"
              />
              <button
                type="button"
                onClick={() => setShow((v) => !v)}
                disabled={retryAfter > 0}
                aria-label={show ? 'Hide password' : 'Show password'}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg px-2.5 py-1.5 text-xs font-semibold text-mute hover:text-text disabled:opacity-40"
              >
                {show ? 'Hide' : 'Show'}
              </button>
            </div>
          </label>

          {setupMode && (
            <>
              <label className="block space-y-1.5">
                <span className="hb-label">Confirm</span>
                <input
                  type={show ? 'text' : 'password'}
                  autoComplete="new-password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  placeholder="Repeat password"
                  className="w-full rounded-[var(--radius-control)] bg-panel-2 border border-line px-4 py-3.5 text-text"
                />
              </label>
              {password.length > 0 && (
                <ul className="text-[11px] font-mono space-y-0.5 pt-0.5">
                  {['10+ characters', 'lowercase', 'uppercase', 'digit', 'special character'].map(
                    (label) => {
                      const key =
                        label === '10+ characters'
                          ? '10+ characters'
                          : label === 'special character'
                            ? 'special character'
                            : label
                      const ok = !issues.includes(key)
                      return (
                        <li key={label} className={ok ? 'text-ok' : 'text-mute'}>
                          {ok ? '✓' : '·'} {label}
                        </li>
                      )
                    },
                  )}
                </ul>
              )}
            </>
          )}

          {error && <p className="text-danger text-sm">{error}</p>}
          {retryAfter > 0 && (
            <p className="text-warn text-sm font-mono">
              Locked — try again in {formatWait(retryAfter)}
            </p>
          )}
          {!local && canBootstrap === true && (
            <p className="text-warn text-sm leading-relaxed">
              Password has not been set yet. Open Home Base on the host via localhost first.
            </p>
          )}

          <button
            type="submit"
            disabled={retryAfter > 0 || !!autoStatus || canBootstrap === null}
            className="hb-btn hb-btn-primary w-full py-3.5 disabled:shadow-none"
          >
            {setupMode ? 'Create password' : 'Enter'}
          </button>
        </form>
      </div>
    </div>
  )
}
