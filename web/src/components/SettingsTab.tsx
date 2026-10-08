import { useMemo, useState } from 'react'
import { clearToken, getExpiresAt } from '../lib/auth'
import { clearAppCache, getStoredTheme, listCacheKeys, setTheme, type ThemeMode } from '../lib/theme'
import { isLocalHostPage } from '../lib/types'
import { SharingTab } from './SharingTab'

export function SettingsTab({ onSignedOut }: { onSignedOut: () => void }) {
  const [theme, setThemeState] = useState<ThemeMode>(() => getStoredTheme())
  const [cacheMsg, setCacheMsg] = useState('')
  const [confirmCache, setConfirmCache] = useState(false)
  const [confirmSignOut, setConfirmSignOut] = useState(false)
  const local = isLocalHostPage()
  const cacheCount = useMemo(() => listCacheKeys().length, [cacheMsg])

  const sessionHint = useMemo(() => {
    const exp = getExpiresAt()
    if (exp == null) return 'Session active'
    const ms = exp * 1000 - Date.now()
    if (ms <= 0) return 'Session expired'
    const h = Math.floor(ms / 3_600_000)
    const m = Math.floor((ms % 3_600_000) / 60_000)
    if (h >= 24) return `Session · ~${Math.ceil(h / 24)}d left`
    if (h > 0) return `Session · ~${h}h ${m}m left`
    return `Session · ~${m}m left`
  }, [])

  function chooseTheme(mode: ThemeMode) {
    setTheme(mode)
    setThemeState(mode)
  }

  function doClearCache() {
    const { removed } = clearAppCache()
    setConfirmCache(false)
    setCacheMsg(
      removed
        ? `Cleared ${removed} cached item${removed === 1 ? '' : 's'} (chats, UI prefs). Theme & login kept.`
        : 'Nothing cached to clear.',
    )
  }

  function doSignOut() {
    clearToken()
    setConfirmSignOut(false)
    onSignedOut()
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="hb-page space-y-5 hb-enter !max-w-lg">
        <header>
          <div className="hb-brand-rule" />
          <h1 className="font-display text-3xl md:text-[2.5rem] font-extrabold tracking-tight">
            Settings
          </h1>
          <p className="text-mute text-sm mt-2 leading-relaxed">
            Appearance, device cache, and session. {sessionHint}.
          </p>
        </header>

        <section className="hb-surface p-4 sm:p-5 space-y-3">
          <h2 className="hb-label">Appearance</h2>
          <p className="text-xs text-mute leading-relaxed">
            Night is the default control-plane look. Day uses a light surface with stronger contrast
            for bright rooms.
          </p>
          <div className="hb-seg">
            <button
              type="button"
              className="hb-seg-btn"
              data-active={theme === 'night'}
              onClick={() => chooseTheme('night')}
            >
              Night
            </button>
            <button
              type="button"
              className="hb-seg-btn"
              data-active={theme === 'day'}
              onClick={() => chooseTheme('day')}
            >
              Day
            </button>
          </div>
        </section>

        <section className="hb-surface p-4 sm:p-5 space-y-3">
          <h2 className="hb-label">Storage</h2>
          <p className="text-xs text-mute leading-relaxed">
            Clears Cursor chat tabs and other device prefs stored in this browser. Does not delete
            files on disk or end your login.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="hb-btn hb-btn-ghost text-sm"
              onClick={() => setConfirmCache(true)}
            >
              Clear cache
            </button>
            <span className="text-[11px] font-mono text-mute">
              {cacheCount} key{cacheCount === 1 ? '' : 's'}
            </span>
          </div>
          {cacheMsg && <p className="text-xs font-mono text-sky">{cacheMsg}</p>}
        </section>

        <section className="hb-surface p-4 sm:p-5 space-y-3">
          <h2 className="hb-label">Session</h2>
          <p className="text-xs text-mute leading-relaxed">
            Sign out removes the JWT from this device. You will need the password (or a new share QR)
            to enter again.
          </p>
          <button
            type="button"
            className="hb-btn hb-btn-danger text-sm"
            onClick={() => setConfirmSignOut(true)}
          >
            Sign out
          </button>
        </section>

        {local && (
          <section className="space-y-3">
            <div className="px-1">
              <h2 className="hb-label">Share & password</h2>
              <p className="text-xs text-mute mt-1.5 leading-relaxed">
                Localhost only — QR share and password change.
              </p>
            </div>
            <SharingTab embedded />
          </section>
        )}

        {!local && (
          <section className="hb-surface p-4 sm:p-5">
            <h2 className="hb-label">Share & password</h2>
            <p className="text-xs text-mute mt-2 leading-relaxed">
              Sharing and password changes are only available when Home Base is opened on the host
              via <span className="font-mono text-accent">localhost</span>.
            </p>
          </section>
        )}
      </div>

      {confirmCache && (
        <div className="fixed inset-0 z-40 hb-overlay backdrop-blur-sm flex items-end sm:items-center justify-center p-4">
          <div className="w-full max-w-sm hb-surface p-4 sm:p-5 space-y-4 hb-enter">
            <h2 className="font-semibold text-sm">Clear device cache?</h2>
            <p className="text-sm text-mute leading-relaxed">
              Removes local Cursor chats and UI prefs from this browser. Your session and theme stay.
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                className="hb-btn hb-btn-ghost flex-1"
                onClick={() => setConfirmCache(false)}
              >
                Cancel
              </button>
              <button type="button" className="hb-btn hb-btn-danger flex-1" onClick={doClearCache}>
                Clear
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmSignOut && (
        <div className="fixed inset-0 z-40 hb-overlay backdrop-blur-sm flex items-end sm:items-center justify-center p-4">
          <div className="w-full max-w-sm hb-surface p-4 sm:p-5 space-y-4 hb-enter">
            <h2 className="font-semibold text-sm">Sign out?</h2>
            <p className="text-sm text-mute leading-relaxed">
              This device will forget the session token. Open files with unsaved edits are lost.
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                className="hb-btn hb-btn-ghost flex-1"
                onClick={() => setConfirmSignOut(false)}
              >
                Cancel
              </button>
              <button type="button" className="hb-btn hb-btn-danger flex-1" onClick={doSignOut}>
                Sign out
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
