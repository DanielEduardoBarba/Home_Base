import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
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
import { UsageBillingPanel } from './UsageBillingPanel'
import { WireGuardPanel } from './WireGuardPanel'

type SettingsScene =
  | 'hub'
  | 'appearance'
  | 'server'
  | 'pin'
  | 'sudo'
  | 'cursor'
  | 'usage'
  | 'notifications'
  | 'setup'
  | 'wireguard'
  | 'cloudflare'
  | 'services'
  | 'storage'
  | 'session'
  | 'share'
  | 'about'

type HubRow = {
  id: SettingsScene
  title: string
  hint: string
  mobileOnly?: boolean
  localOnly?: boolean
}

type HubGroup = { label: string; rows: HubRow[] }

function SettingsRow({
  title,
  hint,
  onClick,
}: {
  title: string
  hint: string
  onClick: () => void
}) {
  return (
    <button type="button" className="hb-settings-row" onClick={onClick}>
      <span className="min-w-0 flex-1 text-left">
        <span className="block text-sm font-semibold text-text">{title}</span>
        {hint ? (
          <span className="block text-xs text-mute mt-0.5 leading-snug truncate">{hint}</span>
        ) : null}
      </span>
      <span className="hb-settings-chevron" aria-hidden>
        ›
      </span>
    </button>
  )
}

function SceneShell({
  title,
  hint,
  onBack,
  children,
}: {
  title: string
  hint?: string
  onBack: () => void
  children: ReactNode
}) {
  return (
    <div className="h-full overflow-y-auto">
      <div className="hb-page hb-page--no-nav space-y-4 hb-enter !max-w-lg">
        <header className="space-y-3">
          <button
            type="button"
            className="hb-btn hb-btn-ghost text-sm !min-h-9 !px-2.5 -ml-1"
            onClick={onBack}
          >
            ← Settings
          </button>
          <div>
            <div className="hb-brand-rule" />
            <h1 className="font-display text-2xl md:text-3xl font-extrabold tracking-tight">
              {title}
            </h1>
            {hint ? <p className="text-mute text-sm mt-1.5 leading-relaxed">{hint}</p> : null}
          </div>
        </header>
        {children}
      </div>
    </div>
  )
}

export function SettingsTab({
  onSignedOut,
  onHome,
}: {
  onSignedOut: () => void
  onHome?: () => void
}) {
  const [scene, setScene] = useState<SettingsScene>('hub')
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
  const [cursorHint, setCursorHint] = useState<string | null>(null)
  const [cursorKey, setCursorKey] = useState('')
  const [cursorMsg, setCursorMsg] = useState('')
  const [cursorBusy, setCursorBusy] = useState(false)
  const [sudoPersistent, setSudoPersistent] = useState(false)
  const [sudoSession, setSudoSession] = useState(false)
  const [sudoTtlSec, setSudoTtlSec] = useState(0)
  const [sudoWaiting, setSudoWaiting] = useState(false)
  const [sudoPassword, setSudoPassword] = useState('')
  const [sudoConfirm, setSudoConfirm] = useState('')
  const [sudoShow, setSudoShow] = useState(false)
  const [sudoMsg, setSudoMsg] = useState('')
  const [sudoBusy, setSudoBusy] = useState(false)
  const identity = useServerIdentity()
  const [nameDraft, setNameDraft] = useState('')
  const [nameMsg, setNameMsg] = useState('')
  const [nameBusy, setNameBusy] = useState(false)

  const refreshSudo = useCallback(() => {
    void api
      .sudoStatus()
      .then((s) => {
        setSudoPersistent(!!s.persistent)
        setSudoSession(!!s.sessionCached)
        setSudoTtlSec(Number(s.ttlSec) || 0)
        setSudoWaiting(!!s.askpassWaiting)
      })
      .catch(() => undefined)
  }, [])

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
      .then((s) => {
        setCursorConfigured(s.configured)
        setCursorHint(s.hint)
      })
      .catch(() => undefined)
    refreshSudo()
  }, [refreshSudo])

  useEffect(() => {
    if (!sudoSession) return
    const t = setInterval(() => {
      setSudoTtlSec((v) => {
        const next = Math.max(0, v - 1)
        if (next === 0) setSudoSession(false)
        return next
      })
    }, 1000)
    return () => clearInterval(t)
  }, [sudoSession])

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

  const goHub = () => setScene('hub')

  const hubGroups: HubGroup[] = useMemo(() => {
    const appearanceHint = `${theme === 'night' ? 'Night' : 'Day'}${
      safeTop ? ' · safe top on' : ''
    }`

    const groups: HubGroup[] = [
      {
        label: 'Look',
        rows: [{ id: 'appearance', title: 'Appearance', hint: appearanceHint }],
      },
      {
        label: 'This server',
        rows: [
          { id: 'server', title: 'Server name', hint: identity.displayName },
          {
            id: 'cursor',
            title: 'Cursor API key',
            hint: cursorConfigured
              ? cursorHint
                ? `Set · ${cursorHint}`
                : 'Set · encrypted'
              : 'Required for Chat',
          },
          {
            id: 'usage',
            title: 'Usage & billing',
            hint: cursorConfigured
              ? 'Account · messages · tokens · thinking'
              : 'Local activity · add key for account',
          },
          { id: 'setup', title: 'Setup', hint: 'Replay first-run wizard' },
        ],
      },
      {
        label: 'Security',
        rows: [
          {
            id: 'pin',
            title: 'App PIN',
            hint: pinEnabled ? `On · idle ${pinIdleMin}m` : 'Off',
          },
          {
            id: 'sudo',
            title: 'Sudo vault',
            hint: sudoPersistent
              ? sudoSession && sudoTtlSec > 0
                ? 'Global set · session active'
                : 'Global set'
              : 'Empty',
          },
          {
            id: 'share',
            title: 'Share & password',
            hint: 'QR login · change password',
            localOnly: true,
          },
        ],
      },
      {
        label: 'Remote access',
        rows: [
          { id: 'wireguard', title: 'WireGuard VPN', hint: 'Phone tunnel · peers · QR' },
          { id: 'cloudflare', title: 'Cloudflare Tunnel', hint: 'HTTPS link without port-forward' },
          {
            id: 'services',
            title: 'Services',
            hint: vpnUrl || lanUrl ? 'Restart · access URLs' : 'Restart Home Base',
          },
        ],
      },
      {
        label: 'Alerts',
        rows: [
          {
            id: 'notifications',
            title: 'Notifications',
            hint: [
              prefs.sound ? 'Sound on' : 'Sound off',
              prefs.os && permission === 'granted' ? 'banners on' : null,
            ]
              .filter(Boolean)
              .join(' · '),
          },
        ],
      },
      {
        label: 'Data',
        rows: [
          {
            id: 'storage',
            title: 'Storage',
            hint: `${cacheCount} cache item${cacheCount === 1 ? '' : 's'} · reset / erase`,
          },
          {
            id: 'session',
            title: 'Session',
            hint: sessionHint || 'Sign out',
          },
        ],
      },
      {
        label: 'About',
        rows: [{ id: 'about', title: 'About & legal', hint: 'MIT · Terms · Privacy' }],
      },
    ]
    return groups
  }, [
    theme,
    safeTop,
    identity.displayName,
    cursorConfigured,
    cursorHint,
    pinEnabled,
    pinIdleMin,
    sudoPersistent,
    sudoSession,
    sudoTtlSec,
    prefs.sound,
    prefs.os,
    permission,
    cacheCount,
    sessionHint,
    vpnUrl,
    lanUrl,
  ])

  const modals = (
    <>
      {confirmCache && (
        <div className="fixed inset-0 z-40 hb-overlay backdrop-blur-sm flex items-end sm:items-center justify-center p-4">
          <div className="w-full max-w-sm hb-surface p-4 space-y-3">
            <h2 className="font-semibold text-sm">Clear cache?</h2>
            <p className="text-sm text-mute">Removes local chats and prefs. Login stays.</p>
            <div className="flex gap-2">
              <button
                type="button"
                className="hb-btn hb-btn-ghost flex-1 !min-h-10"
                onClick={() => setConfirmCache(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="hb-btn hb-btn-danger flex-1 !min-h-10"
                onClick={doClearCache}
              >
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
              <button
                type="button"
                className="hb-btn hb-btn-ghost flex-1 !min-h-10"
                onClick={() => setConfirmSignOut(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="hb-btn hb-btn-danger flex-1 !min-h-10"
                onClick={doSignOut}
              >
                Sign out
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )

  if (scene === 'appearance') {
    return (
      <>
        <SceneShell title="Appearance" hint="Theme and phone display." onBack={goHub}>
          <section className="hb-surface p-3.5 space-y-3">
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
        </SceneShell>
        {modals}
      </>
    )
  }

  if (scene === 'server') {
    return (
      <>
        <SceneShell title="Server name" hint="Shown on login and Home." onBack={goHub}>
          <section className="hb-surface p-3.5 space-y-2.5">
            <p className="font-display text-xl font-extrabold tracking-tight">
              <BrandTitle name={nameDraft.trim() || identity.suggestedName} />
            </p>
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
        </SceneShell>
        {modals}
      </>
    )
  }

  if (scene === 'pin') {
    return (
      <>
        <SceneShell
          title="App PIN"
          hint="4-digit lock after idle or when you leave and come back. Hash and lock state live on the server."
          onBack={goHub}
        >
          <section className="hb-surface p-3.5 space-y-3">
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
        </SceneShell>
        {modals}
      </>
    )
  }

  if (scene === 'sudo') {
    return (
      <>
        <SceneShell
          title="Sudo vault"
          hint="Host password for elevated agent / shell commands. AES-256-GCM on this machine. Chat still asks Allow each use."
          onBack={goHub}
        >
          <section className="hb-surface p-3.5 space-y-3">
            <ul className="text-xs font-mono space-y-1 text-mute">
              <li className={sudoPersistent ? 'text-ok' : undefined}>
                {sudoPersistent ? '✓' : '·'} Global vault {sudoPersistent ? 'set' : 'empty'}
              </li>
              <li className={sudoSession && sudoTtlSec > 0 ? 'text-ok' : undefined}>
                {sudoSession && sudoTtlSec > 0 ? '✓' : '·'} Session cache{' '}
                {sudoSession && sudoTtlSec > 0
                  ? `active · ${Math.floor(sudoTtlSec / 60)}m ${sudoTtlSec % 60}s`
                  : 'none'}
              </li>
              {sudoWaiting && (
                <li className="text-warn">· Chat is waiting for Allow / password</li>
              )}
            </ul>
            <label className="block space-y-1.5">
              <span className="text-xs text-mute">
                {sudoPersistent ? 'New host sudo password' : 'Host sudo password'}
              </span>
              <div className="relative">
                <input
                  type={sudoShow ? 'text' : 'password'}
                  autoComplete="new-password"
                  placeholder="Linux user password for sudo"
                  value={sudoPassword}
                  onChange={(e) => setSudoPassword(e.target.value)}
                  className="w-full rounded-lg bg-panel-2 border border-line pl-3 pr-16 py-2.5 text-sm !min-h-11 outline-none focus:border-accent"
                />
                <button
                  type="button"
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg px-2.5 py-1.5 text-xs font-semibold text-mute hover:text-text"
                  onClick={() => setSudoShow((v) => !v)}
                >
                  {sudoShow ? 'Hide' : 'Show'}
                </button>
              </div>
            </label>
            <label className="block space-y-1.5">
              <span className="text-xs text-mute">Confirm</span>
              <input
                type={sudoShow ? 'text' : 'password'}
                autoComplete="new-password"
                placeholder="Repeat password"
                value={sudoConfirm}
                onChange={(e) => setSudoConfirm(e.target.value)}
                className="w-full rounded-lg bg-panel-2 border border-line px-3 py-2.5 text-sm !min-h-11 outline-none focus:border-accent"
              />
            </label>
            <button
              type="button"
              className="hb-btn hb-btn-primary text-sm !min-h-11 w-full"
              disabled={sudoBusy || !sudoPassword || sudoPassword !== sudoConfirm}
              onClick={() => {
                if (sudoPassword !== sudoConfirm) {
                  setSudoMsg('Passwords do not match')
                  return
                }
                setSudoBusy(true)
                setSudoMsg('')
                void api
                  .setSudo(sudoPassword, { persistent: true })
                  .then((s) => {
                    setSudoPersistent(!!s.persistent)
                    setSudoSession(!!s.sessionCached)
                    setSudoTtlSec(Number(s.ttlSec) || 0)
                    setSudoPassword('')
                    setSudoConfirm('')
                    setSudoMsg(sudoPersistent ? 'Global vault updated' : 'Global vault saved')
                  })
                  .catch((e) => setSudoMsg(e instanceof Error ? e.message : String(e)))
                  .finally(() => setSudoBusy(false))
              }}
            >
              {sudoPersistent ? 'Update global vault' : 'Save global vault'}
            </button>
            <div className="flex flex-col sm:flex-row gap-2">
              <button
                type="button"
                className="hb-btn hb-btn-ghost text-sm !min-h-11 flex-1"
                disabled={sudoBusy || !sudoSession}
                onClick={() => {
                  setSudoBusy(true)
                  setSudoMsg('')
                  void api
                    .clearSudo()
                    .then(() => {
                      setSudoSession(false)
                      setSudoTtlSec(0)
                      setSudoWaiting(false)
                      setSudoMsg('Session cache cleared')
                      refreshSudo()
                    })
                    .catch((e) => setSudoMsg(e instanceof Error ? e.message : String(e)))
                    .finally(() => setSudoBusy(false))
                }}
              >
                Clear session cache
              </button>
              <button
                type="button"
                className="hb-btn hb-btn-ghost text-sm !min-h-11 flex-1"
                disabled={sudoBusy || !sudoPersistent}
                onClick={() => {
                  setSudoBusy(true)
                  setSudoMsg('')
                  void api
                    .clearPersistentSudo()
                    .then(() => {
                      setSudoPersistent(false)
                      setSudoMsg('Global vault removed')
                      refreshSudo()
                    })
                    .catch((e) => setSudoMsg(e instanceof Error ? e.message : String(e)))
                    .finally(() => setSudoBusy(false))
                }}
              >
                Remove global vault
              </button>
            </div>
            {sudoMsg && (
              <p
                className={`text-xs ${
                  /match|fail|error|denied|invalid/i.test(sudoMsg) ? 'text-danger' : 'text-sky'
                }`}
              >
                {sudoMsg}
              </p>
            )}
          </section>
        </SceneShell>
        {modals}
      </>
    )
  }

  if (scene === 'cursor') {
    return (
      <>
        <SceneShell title="Cursor API key" hint="Encrypted on this laptop. Required for Chat." onBack={goHub}>
          <section className="hb-surface p-3.5 space-y-3">
            <p className="text-xs text-mute">
              {cursorConfigured
                ? cursorHint
                  ? `Stored key ${cursorHint}`
                  : 'Key is set.'
                : 'Paste a key from Cursor dashboard.'}
            </p>
            <input
              type="password"
              autoComplete="off"
              className="w-full rounded-[var(--radius-control)] bg-panel-2 border border-line px-3 py-2.5 text-sm font-mono"
              placeholder={cursorConfigured ? cursorHint || 'Replace key…' : 'Paste key'}
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
                    .then((s) => {
                      setCursorConfigured(true)
                      setCursorHint(s.hint)
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
                        setCursorHint(null)
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
            <button
              type="button"
              className="hb-btn hb-btn-ghost w-full !min-h-10 text-sm"
              onClick={() => setScene('usage')}
            >
              Usage &amp; billing →
            </button>
          </section>
        </SceneShell>
        {modals}
      </>
    )
  }

  if (scene === 'usage') {
    return (
      <>
        <SceneShell
          title="Usage & billing"
          hint="Cursor account when the API key allows it, plus Home Base chat activity on this server."
          onBack={goHub}
        >
          <UsageBillingPanel />
        </SceneShell>
        {modals}
      </>
    )
  }

  if (scene === 'notifications') {
    return (
      <>
        <SceneShell
          title="Notifications"
          hint="Toasts + ping in-app. Browser banners optional."
          onBack={goHub}
        >
          <section className="hb-surface p-3.5 space-y-2.5">
            <button
              type="button"
              role="switch"
              aria-checked={prefs.sound}
              onClick={() => {
                unlockAudio()
                setSound(!prefs.sound)
                if (!prefs.sound) {
                  ping({
                    title: 'Sound on',
                    body: 'You will hear a ping for new alerts',
                    level: 'success',
                  })
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
        </SceneShell>
        {modals}
      </>
    )
  }

  if (scene === 'setup') {
    return (
      <>
        <SceneShell title="Setup" hint="Run the first-run wizard again." onBack={goHub}>
          <section className="hb-surface p-3.5 space-y-2.5">
            <button
              type="button"
              className="hb-btn hb-btn-primary text-sm !min-h-11 w-full"
              onClick={() => {
                void api.saveOnboarding({ replay: true }).then(() => {
                  window.dispatchEvent(new Event('hb-onboarding-replay'))
                })
              }}
            >
              Replay setup
            </button>
          </section>
        </SceneShell>
        {modals}
      </>
    )
  }

  if (scene === 'wireguard') {
    return (
      <>
        <SceneShell title="WireGuard VPN" hint="Phone tunnel to this laptop." onBack={goHub}>
          <WireGuardPanel />
        </SceneShell>
        {modals}
      </>
    )
  }

  if (scene === 'cloudflare') {
    return (
      <>
        <SceneShell
          title="Cloudflare Tunnel"
          hint="HTTPS remote access without opening a home port."
          onBack={goHub}
        >
          <CloudflarePanel embedded />
        </SceneShell>
        {modals}
      </>
    )
  }

  if (scene === 'services') {
    return (
      <>
        <SceneShell
          title="Services"
          hint="Restart Home Base from your phone (needs root install)."
          onBack={goHub}
        >
          <section className="hb-surface p-3.5 space-y-2.5">
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
                  <p className="font-mono text-[12px] break-all text-mute">LAN · {lanUrl}</p>
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
        </SceneShell>
        {modals}
      </>
    )
  }

  if (scene === 'storage') {
    return (
      <>
        <SceneShell title="Storage" hint="Cache, soft reset, and full erase." onBack={goHub}>
          <section className="hb-surface p-3.5 space-y-2.5">
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
        </SceneShell>
        {modals}
      </>
    )
  }

  if (scene === 'session') {
    return (
      <>
        <SceneShell
          title="Session"
          hint={sessionHint ? `Signed in · ${sessionHint}` : 'End this browser session.'}
          onBack={goHub}
        >
          <section className="hb-surface p-3.5 space-y-2.5">
            <button
              type="button"
              className="hb-btn hb-btn-danger text-sm !min-h-11 w-full"
              onClick={() => setConfirmSignOut(true)}
            >
              Sign out
            </button>
          </section>
        </SceneShell>
        {modals}
      </>
    )
  }

  if (scene === 'share') {
    return (
      <>
        <SceneShell
          title="Share & password"
          hint="Localhost only — QR login and password change."
          onBack={goHub}
        >
          <SharingTab embedded />
        </SceneShell>
        {modals}
      </>
    )
  }

  if (scene === 'about') {
    return (
      <>
        <SceneShell title="About & legal" onBack={goHub}>
          <LegalAbout />
        </SceneShell>
        {modals}
      </>
    )
  }

  return (
    <>
      <div className="h-full overflow-y-auto">
        <div className="hb-page hb-page--no-nav space-y-5 hb-enter !max-w-lg">
          <header className="space-y-3">
            {onHome ? (
              <button
                type="button"
                className="hb-btn hb-btn-ghost text-sm !min-h-9 !px-2.5 -ml-1"
                onClick={onHome}
              >
                ← Home
              </button>
            ) : null}
            <div>
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
            </div>
          </header>

          {backup && (
            <div className="rounded-xl border border-warn/40 bg-warn/10 px-3 py-2.5 text-sm text-warn">
              Running last known-good build after a failed deploy. Redeploy when ready.
            </div>
          )}

          {hubGroups.map((group) => {
            const rows = group.rows.filter((r) => !r.localOnly || local)
            if (!rows.length) return null
            return (
              <section key={group.label} className="space-y-2">
                <h2 className="hb-label px-1">{group.label}</h2>
                <div className="hb-settings-group">
                  {rows.map((row) => (
                    <SettingsRow
                      key={row.id}
                      title={row.title}
                      hint={row.hint}
                      onClick={() => setScene(row.id)}
                    />
                  ))}
                </div>
              </section>
            )
          })}
        </div>
      </div>
      {modals}
    </>
  )
}
