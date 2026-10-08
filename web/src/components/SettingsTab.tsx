import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../lib/api'
import { clearToken, getExpiresAt } from '../lib/auth'
import { clearAppCache, getStoredTheme, listCacheKeys, setTheme, type ThemeMode } from '../lib/theme'
import { isLocalHostPage } from '../lib/types'
import { HoldButton } from './HoldButton'
import { SharingTab } from './SharingTab'

export function SettingsTab({ onSignedOut }: { onSignedOut: () => void }) {
  const [theme, setThemeState] = useState<ThemeMode>(() => getStoredTheme())
  const [cacheMsg, setCacheMsg] = useState('')
  const [sysMsg, setSysMsg] = useState('')
  const [confirmCache, setConfirmCache] = useState(false)
  const [confirmSignOut, setConfirmSignOut] = useState(false)
  const [wgList, setWgList] = useState<{ id: string; unit: string }[]>([])
  const [wgId, setWgId] = useState('')
  const [version, setVersion] = useState('')
  const [backup, setBackup] = useState(false)
  const [busy, setBusy] = useState('')
  const local = isLocalHostPage()
  const cacheCount = useMemo(() => listCacheKeys().length, [cacheMsg])

  const loadSystem = useCallback(async () => {
    try {
      const s = await api.systemStatus()
      setWgList(s.wireguard || [])
      setWgId((prev) => prev || s.wireguard?.[0]?.id || '')
      setVersion(s.version || '')
      setBackup(!!s.backup)
    } catch {
      /* ignore */
    }
  }, [])

  useEffect(() => {
    void loadSystem()
  }, [loadSystem])

  const sessionHint = useMemo(() => {
    const exp = getExpiresAt()
    if (exp == null) return ''
    const ms = exp * 1000 - Date.now()
    if (ms <= 0) return 'Session expired'
    const h = Math.floor(ms / 3_600_000)
    if (h >= 24) return `~${Math.ceil(h / 24)}d left`
    if (h > 0) return `~${h}h left`
    return `~${Math.max(1, Math.floor(ms / 60_000))}m left`
  }, [])

  function chooseTheme(mode: ThemeMode) {
    setTheme(mode)
    setThemeState(mode)
  }

  function doClearCache() {
    const { removed } = clearAppCache()
    setConfirmCache(false)
    setCacheMsg(removed ? `Cleared ${removed} item${removed === 1 ? '' : 's'}` : 'Nothing to clear')
  }

  function doSignOut() {
    clearToken()
    setConfirmSignOut(false)
    onSignedOut()
  }

  async function restartHb() {
    setBusy('homebased')
    setSysMsg('')
    try {
      const r = await api.restartHomebased()
      setSysMsg(r.ok ? 'Home Base restarting…' : 'Restart may have failed — check host')
    } catch (e) {
      setSysMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy('')
    }
  }

  async function restartWg() {
    setBusy('vpn')
    setSysMsg('')
    try {
      const r = await api.restartWireguard(wgId || undefined)
      setSysMsg(r.ok ? 'VPN restarted' : 'VPN restart failed')
      void loadSystem()
    } catch (e) {
      setSysMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy('')
    }
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="hb-page space-y-4 hb-enter !max-w-lg">
        <header>
          <div className="hb-brand-rule" />
          <h1 className="font-display text-2xl md:text-3xl font-extrabold tracking-tight">
            Settings
          </h1>
          <p className="text-mute text-sm mt-1.5">
            {version ? `v${version}` : 'Home Base'}
            {backup ? ' · backup build' : ''}
            {sessionHint ? ` · ${sessionHint}` : ''}
          </p>
        </header>

        {backup && (
          <div className="rounded-xl border border-warn/40 bg-warn/10 px-3 py-2.5 text-sm text-warn">
            Running last known-good build after a failed deploy. Redeploy when ready.
          </div>
        )}

        <section className="hb-surface p-3.5 space-y-2.5">
          <h2 className="hb-label">Theme</h2>
          <div className="hb-seg">
            <button
              type="button"
              className="hb-seg-btn !py-2 text-sm"
              data-active={theme === 'night'}
              onClick={() => chooseTheme('night')}
            >
              Night
            </button>
            <button
              type="button"
              className="hb-seg-btn !py-2 text-sm"
              data-active={theme === 'day'}
              onClick={() => chooseTheme('day')}
            >
              Day
            </button>
          </div>
        </section>

        <section className="hb-surface p-3.5 space-y-2.5">
          <h2 className="hb-label">Services</h2>
          <p className="text-xs text-mute">Restart host services from your phone (needs root install).</p>

          <div className="space-y-2">
            <div className="flex gap-2 items-center">
              {wgList.length > 1 && (
                <select
                  value={wgId}
                  onChange={(e) => setWgId(e.target.value)}
                  className="hb-select flex-1 !min-h-10 !py-2 text-sm"
                >
                  {wgList.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.id}
                    </option>
                  ))}
                </select>
              )}
              <HoldButton
                label={busy === 'vpn' ? '…' : 'Restart VPN'}
                holdLabel="Hold…"
                disabled={!!busy || wgList.length === 0}
                className="hb-btn hb-btn-ghost !min-h-10 text-sm flex-1"
                onConfirm={() => void restartWg()}
              />
            </div>
            {wgList.length === 0 && (
              <p className="text-[11px] text-mute">No WireGuard configs found in /etc/wireguard</p>
            )}

            <HoldButton
              label={busy === 'homebased' ? '…' : 'Restart Home Base'}
              holdLabel="Hold…"
              disabled={!!busy}
              className="hb-btn hb-btn-ghost !min-h-10 text-sm w-full"
              onConfirm={() => void restartHb()}
            />
          </div>
          {sysMsg && <p className="text-xs text-sky">{sysMsg}</p>}
        </section>

        <section className="hb-surface p-3.5 space-y-2.5">
          <h2 className="hb-label">Storage</h2>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="hb-btn hb-btn-ghost text-sm !min-h-10"
              onClick={() => setConfirmCache(true)}
            >
              Clear cache
            </button>
            <span className="text-[11px] text-mute">{cacheCount} items</span>
          </div>
          {cacheMsg && <p className="text-xs text-sky">{cacheMsg}</p>}
        </section>

        <section className="hb-surface p-3.5 space-y-2.5">
          <h2 className="hb-label">Session</h2>
          <button
            type="button"
            className="hb-btn hb-btn-danger text-sm !min-h-10"
            onClick={() => setConfirmSignOut(true)}
          >
            Sign out
          </button>
        </section>

        {local && (
          <section className="space-y-2">
            <h2 className="hb-label px-1">Share & password</h2>
            <SharingTab embedded />
          </section>
        )}
      </div>

      {confirmCache && (
        <div className="fixed inset-0 z-40 hb-overlay backdrop-blur-sm flex items-end sm:items-center justify-center p-4">
          <div className="w-full max-w-sm hb-surface p-4 space-y-3">
            <h2 className="font-semibold text-sm">Clear cache?</h2>
            <p className="text-sm text-mute">Removes local chats and prefs. Login stays.</p>
            <div className="flex gap-2">
              <button type="button" className="hb-btn hb-btn-ghost flex-1 !min-h-10" onClick={() => setConfirmCache(false)}>
                Cancel
              </button>
              <button type="button" className="hb-btn hb-btn-danger flex-1 !min-h-10" onClick={doClearCache}>
                Clear
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmSignOut && (
        <div className="fixed inset-0 z-40 hb-overlay backdrop-blur-sm flex items-end sm:items-center justify-center p-4">
          <div className="w-full max-w-sm hb-surface p-4 space-y-3">
            <h2 className="font-semibold text-sm">Sign out?</h2>
            <div className="flex gap-2">
              <button type="button" className="hb-btn hb-btn-ghost flex-1 !min-h-10" onClick={() => setConfirmSignOut(false)}>
                Cancel
              </button>
              <button type="button" className="hb-btn hb-btn-danger flex-1 !min-h-10" onClick={doSignOut}>
                Sign out
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
