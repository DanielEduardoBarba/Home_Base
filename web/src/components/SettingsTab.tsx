import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../lib/api'
import { clearSession, getExpiresAt } from '../lib/auth'
import { useNotify } from '../lib/NotifyContext'
import { useSceneRefresh } from '../lib/sceneRefresh'
import {
  clearAppCache,
  getMobileSafeTop,
  getStoredTheme,
  listCacheKeys,
  setMobileSafeTop,
  setTheme,
  type ThemeMode,
} from '../lib/theme'
import { isLocalHostPage } from '../lib/types'
import { readPinIdleMs, writePinIdleMs } from '../lib/uiPrefs'
import { HoldButton } from './HoldButton'
import { SharingTab } from './SharingTab'
import { refreshServerIdentity, useServerIdentity } from '../lib/serverIdentity'
import { BrandTitle } from './BrandTitle'
import { CloudflarePanel } from './CloudflarePanel'
import { LegalAbout } from './LegalAbout'
import { WireGuardPanel } from './WireGuardPanel'

export function SettingsTab({ onSignedOut }: { onSignedOut: () => void }) {
  const [theme, setThemeState] = useState<ThemeMode>(() => getStoredTheme())
  const [safeTop, setSafeTopState] = useState(() => getMobileSafeTop())
  const [cacheMsg, setCacheMsg] = useState('')
  const [sysMsg, setSysMsg] = useState('')
  const [notifyMsg, setNotifyMsg] = useState('')
  const [confirmCache, setConfirmCache] = useState(false)
  const [confirmSignOut, setConfirmSignOut] = useState(false)
  const [softStep, setSoftStep] = useState(0)
  const [hardStep, setHardStep] = useState(0)
  const [hardTyped, setHardTyped] = useState('')
  const [resetMsg, setResetMsg] = useState('')
  const [version, setVersion] = useState('')
  const [backup, setBackup] = useState(false)
  const [busy, setBusy] = useState('')
  const [vpnUrl, setVpnUrl] = useState<string | null>(null)
  const [lanUrl, setLanUrl] = useState<string | null>(null)
  const [pinEnabled, setPinEnabled] = useState(false)
  const [pinIdleMin, setPinIdleMin] = useState(() => Math.round(readPinIdleMs() / 60_000))
  const [pinCurrent, setPinCurrent] = useState('')
  const [pinDraft, setPinDraft] = useState('')
  const [pinConfirm, setPinConfirm] = useState('')
  const [pinMsg, setPinMsg] = useState('')
  const [pinBusy, setPinBusy] = useState(false)
  const [cursorConfigured, setCursorConfigured] = useState(false)
  const [cursorKey, setCursorKey] = useState('')
  const [cursorMsg, setCursorMsg] = useState('')
  const [cursorBusy, setCursorBusy] = useState(false)
  const identity = useServerIdentity()
  const [nameDraft, setNameDraft] = useState('')
  const [nameMsg, setNameMsg] = useState('')
  const [nameBusy, setNameBusy] = useState(false)

  useEffect(() => {
    void api
      .appPinStatus()
      .then((s) => {
        setPinEnabled(s.enabled)
        setPinIdleMin(Math.round(s.idleMs / 60_000))
        writePinIdleMs(s.idleMs)
      })
      .catch(() => undefined)
    void api
      .cursorCredentials()
      .then((s) => setCursorConfigured(s.configured))
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    setNameDraft(identity.displayName)
  }, [identity.displayName])

  const pinDigits = (v: string) => v.replace(/\D/g, '').slice(0, 4)
  const pinInputClass =
    'w-full rounded-lg bg-panel-2 border border-line px-3 py-2.5 text-sm !min-h-11 font-mono tracking-[0.35em] outline-none focus:border-accent'

  function clearPinFields() {
    setPinCurrent('')
    setPinDraft('')
    setPinConfirm('')
  }

  function pinErrMessage(e: unknown): string {
    if (!(e instanceof Error)) return String(e)
    try {
      const d = JSON.parse(e.message) as { message?: string }
      if (d?.message) return d.message
    } catch {
      /* plain */
    }
    return e.message
  }

  async function submitPin() {
    setPinMsg('')
    if (pinDraft.length !== 4 || pinConfirm.length !== 4) {
      setPinMsg('Enter the new PIN twice')
      return
    }
    if (pinDraft !== pinConfirm) {
      setPinMsg('New PINs do not match')
      return
    }
    if (pinEnabled && pinCurrent.length !== 4) {
      setPinMsg('Enter your current PIN')
      return
    }
    setPinBusy(true)
    try {
      await api.appPinSet(pinDraft, pinEnabled ? pinCurrent : undefined)
      clearPinFields()
      setPinEnabled(true)
      setPinMsg(pinEnabled ? 'PIN updated' : 'PIN enabled')
      window.dispatchEvent(new Event('hb-pin-changed'))
    } catch (e) {
      setPinMsg(pinErrMessage(e))
      if (/incorrect|bad_pin/i.test(pinErrMessage(e))) setPinCurrent('')
    } finally {
      setPinBusy(false)
    }
  }

  async function turnOffPin() {
    setPinMsg('')
    if (pinCurrent.length !== 4) {
      setPinMsg('Enter your current PIN to turn it off')
      return
    }
    setPinBusy(true)
    try {
      await api.appPinClear(pinCurrent)
      clearPinFields()
      setPinEnabled(false)
      setPinMsg('PIN turned off')
      window.dispatchEvent(new Event('hb-pin-changed'))
    } catch (e) {
      setPinMsg(pinErrMessage(e))
      setPinCurrent('')
    } finally {
      setPinBusy(false)
    }
  }
  const local = isLocalHostPage()
  const cacheCount = useMemo(() => listCacheKeys().length, [cacheMsg])
  const {
    prefs,
    permission,
    setSound,
    setOs,
    enableOsNotifications,
    ping,
    unlockAudio,
  } = useNotify()

  const loadSystem = useCallback(async () => {
    try {
      const s = await api.systemStatus()
      setVersion(s.version || '')
      setBackup(!!s.backup)
      setVpnUrl(s.urls?.vpn || null)
      setLanUrl(s.urls?.lan || null)
    } catch {
      /* ignore */
    }
  }, [])

  useSceneRefresh(loadSystem)

  useEffect(() => {
    void loadSystem()
  }, [loadSystem])

  const [sessionHint, setSessionHint] = useState('')
  useEffect(() => {
    const tick = () => {
      const exp = getExpiresAt()
      if (exp == null) {
        setSessionHint('')
        return
      }
      const ms = exp * 1000 - Date.now()
      if (ms <= 0) {
        setSessionHint('Session expired')
        return
      }
      const h = Math.floor(ms / 3_600_000)
      if (h >= 24) setSessionHint(`~${Math.ceil(h / 24)}d left`)
      else if (h > 0) setSessionHint(`~${h}h left`)
      else setSessionHint(`~${Math.max(1, Math.floor(ms / 60_000))}m left`)
    }
    tick()
    const t = setInterval(tick, 30_000)
    return () => clearInterval(t)
  }, [])

  function chooseTheme(mode: ThemeMode) {
    setTheme(mode)
    setThemeState(mode)
  }

  function toggleSafeTop() {
    const next = !safeTop
    setMobileSafeTop(next)
    setSafeTopState(next)
  }

  function doClearCache() {
    const { removed } = clearAppCache()
    setConfirmCache(false)
    setCacheMsg(removed ? `Cleared ${removed} item${removed === 1 ? '' : 's'}` : 'Nothing to clear')
  }

  function doSignOut() {
    clearSession('signed_out')
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

  return (
    <div className="h-full overflow-y-auto">
      <div className="hb-page space-y-4 hb-enter !max-w-lg">
        <header>
          <div className="hb-brand-rule" />
          <h1 className="font-display text-2xl md:text-3xl font-extrabold tracking-tight">
            Settings
          </h1>
          <p className="text-mute text-sm mt-1.5">
            <BrandTitle name={identity.displayName} />
            {version ? ` · v${version}` : ''}
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
          <h2 className="hb-label">Server name</h2>
          <p className="text-xs text-mute">Shown on login and Home.</p>
          <input
            className="w-full rounded-[var(--radius-control)] bg-panel-2 border border-line px-3 py-2.5 text-sm"
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value.slice(0, 64))}
            placeholder={identity.suggestedName}
          />
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="hb-btn hb-btn-primary text-sm !min-h-10"
              disabled={nameBusy || !nameDraft.trim() || nameDraft.trim() === identity.displayName}
              onClick={() => {
                setNameBusy(true)
                setNameMsg('')
                void api
                  .setServerIdentity(nameDraft.trim())
                  .then(async () => {
                    await refreshServerIdentity()
                    setNameMsg('Saved')
                  })
                  .catch((e) => setNameMsg(e instanceof Error ? e.message : String(e)))
                  .finally(() => setNameBusy(false))
              }}
            >
              Save
            </button>
            <button
              type="button"
              className="hb-btn hb-btn-ghost text-sm !min-h-10"
              disabled={nameBusy}
              onClick={() => setNameDraft(identity.suggestedName)}
            >
              Suggest
            </button>
          </div>
          {nameMsg && <p className="text-xs text-sky">{nameMsg}</p>}
        </section>

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

        <section className="hb-surface p-3.5 space-y-3">
          <h2 className="hb-label">App PIN</h2>
          <p className="text-xs text-mute leading-relaxed">
            4-digit lock after idle or when you leave and come back. Hash and lock state live on the
            server so a refresh cannot clear the lock.
          </p>
          <label className="flex items-center gap-2 text-sm">
            <span className="text-mute text-xs w-24 shrink-0">Idle</span>
            <select
              className="flex-1 rounded-lg bg-panel-2 border border-line px-3 py-2.5 text-sm !min-h-11 outline-none focus:border-accent"
              value={pinIdleMin}
              onChange={(e) => {
                const mins = Math.max(1, Number(e.target.value) || 5)
                setPinIdleMin(mins)
                const ms = mins * 60_000
                writePinIdleMs(ms)
                void api
                  .appPinIdle(ms)
                  .then(() => window.dispatchEvent(new Event('hb-pin-changed')))
                  .catch(() => undefined)
              }}
            >
              {[1, 2, 5, 10, 15, 30].map((m) => (
                <option key={m} value={m}>
                  {m} min
                </option>
              ))}
            </select>
          </label>
          {pinEnabled && (
            <label className="block space-y-1.5">
              <span className="text-xs text-mute">Current PIN</span>
              <input
                type="password"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={4}
                autoComplete="current-password"
                placeholder="••••"
                value={pinCurrent}
                onChange={(e) => setPinCurrent(pinDigits(e.target.value))}
                className={pinInputClass}
              />
            </label>
          )}
          <label className="block space-y-1.5">
            <span className="text-xs text-mute">{pinEnabled ? 'New PIN' : 'PIN'}</span>
            <input
              type="password"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={4}
              autoComplete="new-password"
              placeholder="••••"
              value={pinDraft}
              onChange={(e) => setPinDraft(pinDigits(e.target.value))}
              className={pinInputClass}
            />
          </label>
          <label className="block space-y-1.5">
            <span className="text-xs text-mute">Confirm PIN</span>
            <input
              type="password"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={4}
              autoComplete="new-password"
              placeholder="••••"
              value={pinConfirm}
              onChange={(e) => setPinConfirm(pinDigits(e.target.value))}
              className={pinInputClass}
            />
          </label>
          <button
            type="button"
            className="hb-btn hb-btn-primary text-sm !min-h-11 w-full"
            disabled={
              pinBusy ||
              pinDraft.length !== 4 ||
              pinConfirm.length !== 4 ||
              (pinEnabled && pinCurrent.length !== 4)
            }
            onClick={() => void submitPin()}
          >
            {pinEnabled ? 'Update PIN' : 'Enable PIN'}
          </button>
          {pinEnabled && (
            <button
              type="button"
              className="hb-btn hb-btn-ghost text-sm !min-h-11 w-full"
              disabled={pinBusy || pinCurrent.length !== 4}
              onClick={() => void turnOffPin()}
            >
              Turn off PIN
            </button>
          )}
          {pinMsg && (
            <p
              className={`text-xs ${
                /incorrect|match|Enter|must/i.test(pinMsg) ? 'text-danger' : 'text-sky'
              }`}
            >
              {pinMsg}
            </p>
          )}
        </section>

        <section className="hb-surface p-3.5 space-y-2.5">
          <h2 className="hb-label">Notifications</h2>
          <p className="text-xs text-mute leading-relaxed">
            Toasts + ping sound in-app. Chrome / iPhone: enable browser alerts below. On iPhone,
            Add to Home Screen gives the best chance of lock-screen banners while you leave Chat
            working.
          </p>

          <button
            type="button"
            role="switch"
            aria-checked={prefs.sound}
            onClick={() => {
              unlockAudio()
              setSound(!prefs.sound)
              if (!prefs.sound) {
                ping({ title: 'Sound on', body: 'You will hear a ping for new alerts', level: 'success' })
              }
            }}
            className="w-full flex items-center justify-between gap-3 text-left rounded-xl border border-line bg-panel-2/60 px-3 py-3"
          >
            <span className="min-w-0">
              <span className="block text-sm font-semibold">Ping sound</span>
              <span className="block text-xs text-mute mt-0.5 leading-snug">
                Short beep when Cursor finishes or an alert arrives
              </span>
            </span>
            <span
              className={`hb-switch shrink-0 ${prefs.sound ? 'hb-switch--on' : ''}`}
              aria-hidden
            >
              <span className="hb-switch-knob" />
            </span>
          </button>

          <button
            type="button"
            role="switch"
            aria-checked={prefs.os && permission === 'granted'}
            onClick={() => {
              void (async () => {
                unlockAudio()
                if (permission !== 'granted') {
                  const perm = await enableOsNotifications()
                  if (perm === 'granted') {
                    setNotifyMsg('Browser notifications enabled')
                    ping({
                      title: 'Alerts ready',
                      body: 'You will get a system notification when Cursor finishes',
                      level: 'success',
                    })
                  } else if (perm === 'denied') {
                    setNotifyMsg('Permission blocked — check site settings in Chrome')
                  } else if (perm === 'unsupported') {
                    setNotifyMsg(
                      'This browser has no Notification API. Toasts + sound still work; try Add to Home Screen on iPhone.',
                    )
                  } else {
                    setNotifyMsg('Permission not granted yet')
                  }
                  return
                }
                setOs(!prefs.os)
                setNotifyMsg(prefs.os ? 'System banners off' : 'System banners on')
              })()
            }}
            className="w-full flex items-center justify-between gap-3 text-left rounded-xl border border-line bg-panel-2/60 px-3 py-3"
          >
            <span className="min-w-0">
              <span className="block text-sm font-semibold">Browser / lock screen</span>
              <span className="block text-xs text-mute mt-0.5 leading-snug">
                Status:{' '}
                {permission === 'granted'
                  ? prefs.os
                    ? 'allowed'
                    : 'allowed (off)'
                  : permission === 'denied'
                    ? 'blocked'
                    : permission === 'unsupported'
                      ? 'unsupported'
                      : 'not asked'}
              </span>
            </span>
            <span
              className={`hb-switch shrink-0 ${
                prefs.os && permission === 'granted' ? 'hb-switch--on' : ''
              }`}
              aria-hidden
            >
              <span className="hb-switch-knob" />
            </span>
          </button>
          {notifyMsg && <p className="text-xs text-sky">{notifyMsg}</p>}
        </section>

        {/* Phone / tablet only — desktop never shows or applies this */}
        <section className="hb-surface p-3.5 space-y-2.5 md:hidden">
          <h2 className="hb-label">Display</h2>
          <button
            type="button"
            role="switch"
            aria-checked={safeTop}
            onClick={toggleSafeTop}
            className="w-full flex items-center justify-between gap-3 text-left rounded-xl border border-line bg-panel-2/60 px-3 py-3"
          >
            <span className="min-w-0">
              <span className="block text-sm font-semibold">Top safe area</span>
              <span className="block text-xs text-mute mt-0.5 leading-snug">
                Extra top padding for iPhone island / notch. Turn off if you don’t need it.
              </span>
            </span>
            <span className={`hb-switch shrink-0 ${safeTop ? 'hb-switch--on' : ''}`} aria-hidden>
              <span className="hb-switch-knob" />
            </span>
          </button>
        </section>

        <section className="hb-surface p-3.5 space-y-3">
          <h2 className="hb-label">Cursor API key</h2>
          <p className="text-xs text-mute">
            {cursorConfigured ? 'Key is set and encrypted on this laptop.' : 'Required for Chat.'}
          </p>
          <input
            type="password"
            autoComplete="off"
            className="w-full rounded-[var(--radius-control)] bg-panel-2 border border-line px-3 py-2.5 text-sm font-mono"
            placeholder={cursorConfigured ? 'Replace key…' : 'Paste key'}
            value={cursorKey}
            onChange={(e) => setCursorKey(e.target.value)}
          />
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="hb-btn hb-btn-primary text-sm !min-h-10"
              disabled={cursorBusy || !cursorKey.trim()}
              onClick={() => {
                setCursorBusy(true)
                setCursorMsg('')
                void api
                  .setCursorCredentials(cursorKey.trim())
                  .then(() => {
                    setCursorConfigured(true)
                    setCursorKey('')
                    setCursorMsg('Saved')
                  })
                  .catch((e) => setCursorMsg(e instanceof Error ? e.message : String(e)))
                  .finally(() => setCursorBusy(false))
              }}
            >
              Save
            </button>
            {cursorConfigured && (
              <button
                type="button"
                className="hb-btn hb-btn-ghost text-sm !min-h-10"
                disabled={cursorBusy}
                onClick={() => {
                  setCursorBusy(true)
                  void api
                    .clearCursorCredentials()
                    .then(() => {
                      setCursorConfigured(false)
                      setCursorMsg('Cleared')
                    })
                    .catch((e) => setCursorMsg(e instanceof Error ? e.message : String(e)))
                    .finally(() => setCursorBusy(false))
                }}
              >
                Remove
              </button>
            )}
          </div>
          {cursorMsg && <p className="text-xs text-sky">{cursorMsg}</p>}
        </section>

        <section className="hb-surface p-3.5 space-y-2.5">
          <h2 className="hb-label">Setup</h2>
          <button
            type="button"
            className="hb-btn hb-btn-ghost text-sm !min-h-10 w-full"
            onClick={() => {
              void api.saveOnboarding({ replay: true }).then(() => {
                window.dispatchEvent(new Event('hb-onboarding-replay'))
              })
            }}
          >
            Replay setup
          </button>
        </section>

        <WireGuardPanel />
        <CloudflarePanel />

        <section className="hb-surface p-3.5 space-y-2.5">
          <h2 className="hb-label">Services</h2>
          <p className="text-xs text-mute">
            Restart Home Base from your phone (needs root install). VPN controls are above.
          </p>

          {(vpnUrl || lanUrl) && (
            <div className="rounded-xl border border-line bg-panel-2/50 px-3 py-2.5 text-xs space-y-1.5">
              <p className="text-mute leading-relaxed">
                On phone VPN open the WireGuard URL — the Wi‑Fi address is only for the same LAN.
              </p>
              {vpnUrl && (
                <p className="font-mono text-[12px] break-all">
                  <span className="text-mute">VPN · </span>
                  <a href={vpnUrl} className="text-sky underline-offset-2 hover:underline">
                    {vpnUrl}
                  </a>
                </p>
              )}
              {lanUrl && (
                <p className="font-mono text-[12px] break-all text-mute">
                  LAN · {lanUrl}
                </p>
              )}
            </div>
          )}

          <HoldButton
            label={busy === 'homebased' ? '…' : 'Restart Home Base'}
            holdLabel="Hold…"
            holdMs={1600}
            tone="warn"
            disabled={!!busy}
            className="!min-h-10 text-sm w-full"
            title="Hold to restart Home Base — brief disconnect"
            onConfirm={() => void restartHb()}
          />
          <p className="text-xs text-mute">Hold to confirm — won’t fire on a tap.</p>
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
            <span className="text-xs text-mute">{cacheCount} items</span>
          </div>
          {cacheMsg && <p className="text-xs text-sky">{cacheMsg}</p>}

          <div className="border-t border-line pt-2.5 space-y-2">
            <p className="text-xs text-mute">
              Reset data keeps password, PIN, Cursor key, and VPN / tunnel settings.
            </p>
            <button
              type="button"
              className="hb-btn hb-btn-ghost text-sm !min-h-10 w-full"
              onClick={() => setSoftStep(1)}
            >
              Reset data
            </button>
            {local && (
              <button
                type="button"
                className="hb-btn hb-btn-danger text-sm !min-h-10 w-full"
                onClick={() => {
                  setHardStep(1)
                  setHardTyped('')
                }}
              >
                Erase everything
              </button>
            )}
            {resetMsg && <p className="text-xs text-sky">{resetMsg}</p>}
          </div>
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

        <LegalAbout />
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

      {softStep > 0 && (
        <div className="fixed inset-0 z-40 hb-overlay backdrop-blur-sm flex items-end sm:items-center justify-center p-4">
          <div className="w-full max-w-sm hb-surface p-4 space-y-3">
            <h2 className="font-semibold text-sm">
              {softStep === 1 ? 'Reset data?' : 'Are you sure?'}
            </h2>
            <p className="text-sm text-mute">
              Clears chats, Home Access widgets, and notifications. Keeps password, PIN, Cursor key,
              and remote access.
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                className="hb-btn hb-btn-ghost flex-1 !min-h-10"
                onClick={() => setSoftStep(0)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="hb-btn hb-btn-danger flex-1 !min-h-10"
                onClick={() => {
                  if (softStep === 1) {
                    setSoftStep(2)
                    return
                  }
                  void api
                    .systemReset('soft')
                    .then((r) => {
                      setResetMsg(`Reset ${r.removed} items`)
                      doClearCache()
                      setSoftStep(0)
                    })
                    .catch((e) => {
                      setResetMsg(e instanceof Error ? e.message : String(e))
                      setSoftStep(0)
                    })
                }}
              >
                {softStep === 1 ? 'Continue' : 'Reset'}
              </button>
            </div>
          </div>
        </div>
      )}

      {hardStep > 0 && (
        <div className="fixed inset-0 z-40 hb-overlay backdrop-blur-sm flex items-end sm:items-center justify-center p-4">
          <div className="w-full max-w-sm hb-surface p-4 space-y-3">
            <h2 className="font-semibold text-sm">
              {hardStep === 1 ? 'Erase everything?' : 'Are you sure?'}
            </h2>
            <p className="text-sm text-mute">
              Removes password, PIN, keys, projects, chats, and remote access. Localhost only.
            </p>
            {hardStep === 1 && (
              <label className="block space-y-1">
                <span className="text-xs text-mute">Type ERASE</span>
                <input
                  className="w-full rounded-[var(--radius-control)] bg-panel-2 border border-line px-3 py-2.5 text-sm font-mono uppercase"
                  value={hardTyped}
                  onChange={(e) => setHardTyped(e.target.value)}
                  autoFocus
                />
              </label>
            )}
            <div className="flex gap-2">
              <button
                type="button"
                className="hb-btn hb-btn-ghost flex-1 !min-h-10"
                onClick={() => {
                  setHardStep(0)
                  setHardTyped('')
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="hb-btn hb-btn-danger flex-1 !min-h-10"
                disabled={hardStep === 1 && hardTyped.trim().toUpperCase() !== 'ERASE'}
                onClick={() => {
                  if (hardStep === 1) {
                    setHardStep(2)
                    return
                  }
                  void api
                    .systemReset('hard', 'ERASE')
                    .then(() => {
                      setHardStep(0)
                      clearSession('signed_out')
                      onSignedOut()
                    })
                    .catch((e) => {
                      setResetMsg(e instanceof Error ? e.message : String(e))
                      setHardStep(0)
                    })
                }}
              >
                {hardStep === 1 ? 'Continue' : 'Erase'}
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
