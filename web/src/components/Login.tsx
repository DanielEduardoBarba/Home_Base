import { useEffect, useState, type FormEvent } from 'react'
import { api } from '../lib/api'
import { setToken } from '../lib/auth'

function formatWait(sec: number): string {
  if (sec >= 86400) return `${Math.ceil(sec / 86400)}d`
  if (sec >= 3600) return `${Math.ceil(sec / 3600)}h`
  if (sec >= 60) return `${Math.ceil(sec / 60)}m`
  return `${sec}s`
}

export function Login({ onAuthed }: { onAuthed: () => void }) {
  const [token, setLocal] = useState('')
  const [error, setError] = useState('')
  const [retryAfter, setRetryAfter] = useState(0)

  useEffect(() => {
    if (retryAfter <= 0) return
    const t = setInterval(() => setRetryAfter((s) => Math.max(0, s - 1)), 1000)
    return () => clearInterval(t)
  }, [retryAfter])

  useEffect(() => {
    api.lockout()
      .then((l) => {
        if (l.locked) setRetryAfter(l.retryAfter)
      })
      .catch(() => undefined)
  }, [])

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (retryAfter > 0) return
    setError('')
    try {
      await api.login(token.trim())
      setToken(token.trim())
      onAuthed()
    } catch (err) {
      const detail = (err as { detail?: unknown }).detail
      let message = 'Token rejected'
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
    <div className="min-h-full flex flex-col justify-end sm:justify-center px-5 pb-12 pt-20">
      <div className="max-w-md w-full mx-auto hb-enter">
        <div className="mb-6 h-px w-14 bg-gradient-to-r from-accent to-transparent" />
        <p className="font-display text-[clamp(2.75rem,12vw,4.5rem)] font-extrabold leading-[0.9] tracking-tight text-text">
          Home
          <span className="text-accent"> Base</span>
        </p>
        <p className="mt-5 text-mute text-base max-w-sm leading-relaxed">
          Remote control for your configured workspaces — actions, shells, files, and Cursor.
        </p>
        <form onSubmit={submit} className="mt-10 space-y-4">
          <label className="block">
            <span className="text-[11px] uppercase tracking-[0.2em] text-mute">Access token</span>
            <input
              type="password"
              autoComplete="current-password"
              value={token}
              onChange={(e) => setLocal(e.target.value)}
              placeholder="HOMEBASE_TOKEN"
              disabled={retryAfter > 0}
              className="mt-2 w-full rounded-xl bg-panel/90 border border-line px-4 py-3.5 text-text disabled:opacity-50"
            />
          </label>
          {error && <p className="text-danger text-sm">{error}</p>}
          {retryAfter > 0 && (
            <p className="text-warn text-sm font-mono">
              Locked — try again in {formatWait(retryAfter)}
            </p>
          )}
          <button
            type="submit"
            disabled={retryAfter > 0}
            className="w-full rounded-xl bg-accent text-ink font-semibold py-3.5 shadow-[0_8px_28px_rgba(45,212,191,0.18)] disabled:opacity-40 disabled:shadow-none"
          >
            Enter
          </button>
        </form>
      </div>
    </div>
  )
}
