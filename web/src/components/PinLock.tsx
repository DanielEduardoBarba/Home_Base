'use client'

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { api } from '../lib/api'
import { getToken } from '../lib/auth'
import {
  clearLegacyLocalPin,
  readLegacyLocalPin,
  readPinIdleMs,
  writePinIdleMs,
} from '../lib/uiPrefs'

const PIN_ENABLED_CACHE = 'hb-pin-server-enabled'
const PIN_LOCKED_CACHE = 'hb-pin-server-locked'

function readCachedGate(): { enabled: boolean; locked: boolean } {
  try {
    const enabled = localStorage.getItem(PIN_ENABLED_CACHE) === '1'
    const locked = enabled && localStorage.getItem(PIN_LOCKED_CACHE) === '1'
    return { enabled, locked }
  } catch {
    return { enabled: false, locked: false }
  }
}

function writeCachedGate(enabled: boolean, locked: boolean): void {
  try {
    localStorage.setItem(PIN_ENABLED_CACHE, enabled ? '1' : '0')
    localStorage.setItem(PIN_LOCKED_CACHE, enabled && locked ? '1' : '0')
  } catch {
    /* ignore */
  }
}

/**
 * App PIN gate — idle / tab-return lock. Hash + locked flag live on the server
 * so a refresh cannot clear the lock. homebased keeps running; only this client
 * is covered and HTTP/WS commands are refused until the PIN unlocks.
 */
export function PinLock({ children }: { children: ReactNode }) {
  const cached = readCachedGate()
  const [enabled, setEnabled] = useState(cached.enabled)
  const [locked, setLocked] = useState(cached.locked)
  const [digits, setDigits] = useState('')
  const [shake, setShake] = useState(false)
  const lastActive = useRef(Date.now())
  const idleMs = useRef(readPinIdleMs())
  const enabledRef = useRef(cached.enabled)
  const lockedRef = useRef(cached.locked)

  enabledRef.current = enabled
  lockedRef.current = locked

  const applyStatus = useCallback((s: { enabled: boolean; locked: boolean; idleMs: number }) => {
    const nextLocked = s.enabled && s.locked
    setEnabled(s.enabled)
    setLocked(nextLocked)
    writeCachedGate(s.enabled, nextLocked)
    idleMs.current = s.idleMs
    writePinIdleMs(s.idleMs)
    if (!nextLocked) lastActive.current = Date.now()
  }, [])

  const refreshPrefs = useCallback(async () => {
    if (!getToken()) {
      setEnabled(false)
      setLocked(false)
      writeCachedGate(false, false)
      return
    }
    try {
      let s = await api.appPinStatus()
      if (!s.enabled) {
        const legacy = readLegacyLocalPin()
        if (legacy) {
          try {
            const imported = await api.appPinImport(legacy.salt, legacy.hash, legacy.idleMs)
            if (imported.imported || imported.enabled) {
              clearLegacyLocalPin()
              s = await api.appPinStatus()
            }
          } catch {
            /* keep trying next refresh */
          }
        }
      } else {
        clearLegacyLocalPin()
      }
      applyStatus(s)
    } catch {
      /* offline / unauthorized — keep cached gate so refresh stays locked */
    }
  }, [applyStatus])

  useEffect(() => {
    void refreshPrefs()
    const onStorage = (e: StorageEvent) => {
      if (!e.key || e.key.startsWith('hb-pin')) void refreshPrefs()
    }
    const onChanged = () => void refreshPrefs()
    const onForceLock = () => {
      if (enabledRef.current) {
        setLocked(true)
        writeCachedGate(true, true)
        setDigits('')
      }
    }
    window.addEventListener('storage', onStorage)
    window.addEventListener('hb-pin-changed', onChanged)
    window.addEventListener('hb-pin-lock', onForceLock)
    return () => {
      window.removeEventListener('storage', onStorage)
      window.removeEventListener('hb-pin-changed', onChanged)
      window.removeEventListener('hb-pin-lock', onForceLock)
    }
  }, [refreshPrefs])

  const markActive = useCallback(() => {
    lastActive.current = Date.now()
  }, [])

  const lock = useCallback(() => {
    if (!enabledRef.current) return
    setLocked(true)
    writeCachedGate(true, true)
    setDigits('')
    void api.appPinLock().catch(() => {
      /* UI still locked; next API call returns 423 */
    })
  }, [])

  useEffect(() => {
    if (!enabled) {
      if (!locked) return
      setLocked(false)
      return
    }
    const onPointer = () => {
      if (!lockedRef.current) markActive()
    }
    const onKey = () => {
      if (!lockedRef.current) markActive()
    }
    const onVis = () => {
      if (document.visibilityState === 'hidden') {
        lastActive.current = 0
      } else if (document.visibilityState === 'visible') {
        if (Date.now() - lastActive.current >= idleMs.current) lock()
        else markActive()
      }
    }
    const onPageHide = () => {
      lastActive.current = 0
      if (enabledRef.current && !lockedRef.current) {
        void api.appPinLock().catch(() => undefined)
      }
    }
    window.addEventListener('pointerdown', onPointer, true)
    window.addEventListener('keydown', onKey, true)
    document.addEventListener('visibilitychange', onVis)
    window.addEventListener('pagehide', onPageHide)
    const tick = window.setInterval(() => {
      if (lockedRef.current) return
      if (Date.now() - lastActive.current >= idleMs.current) lock()
    }, 5_000)
    return () => {
      window.removeEventListener('pointerdown', onPointer, true)
      window.removeEventListener('keydown', onKey, true)
      document.removeEventListener('visibilitychange', onVis)
      window.removeEventListener('pagehide', onPageHide)
      window.clearInterval(tick)
    }
  }, [enabled, lock, markActive])

  const tryUnlock = useCallback(
    async (pin: string) => {
      try {
        await api.appPinUnlock(pin)
        setLocked(false)
        writeCachedGate(true, false)
        setDigits('')
        markActive()
      } catch {
        setShake(true)
        setDigits('')
        window.setTimeout(() => setShake(false), 420)
      }
    },
    [markActive],
  )

  useEffect(() => {
    if (digits.length === 4) void tryUnlock(digits)
  }, [digits, tryUnlock])

  const press = useCallback((d: string) => {
    setDigits((prev) => (prev.length >= 4 ? prev : prev + d))
  }, [])

  const backspace = useCallback(() => {
    setDigits((prev) => prev.slice(0, -1))
  }, [])

  // Desktop / hardware keyboard only — no <input>, so mobile soft keyboard stays closed.
  useEffect(() => {
    if (!enabled || !locked) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (e.isComposing) return

      const key = e.key
      if (/^[0-9]$/.test(key)) {
        e.preventDefault()
        e.stopPropagation()
        press(key)
        return
      }
      if (e.code.startsWith('Numpad') && /^Numpad[0-9]$/.test(e.code)) {
        e.preventDefault()
        e.stopPropagation()
        press(e.code.slice(-1))
        return
      }
      if (key === 'Backspace' || key === 'Delete') {
        e.preventDefault()
        e.stopPropagation()
        backspace()
        return
      }
      if (key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        setDigits('')
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [enabled, locked, press, backspace])

  if (!enabled || !locked) return <>{children}</>

  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫']

  return (
    <>
      {/* Keep the app mounted (and server work alive); freeze interaction only. */}
      <div className="hb-pin-frozen h-full min-h-0" aria-hidden inert>
        {children}
      </div>
      <div className="hb-pin-overlay" role="dialog" aria-modal="true" aria-label="Enter PIN">
        <div className={`hb-pin-card${shake ? ' hb-pin-shake' : ''}`}>
          <h2 className="text-center font-semibold text-base">Enter PIN</h2>
          <p className="text-center text-xs text-mute mt-1.5 leading-snug">
            Server keeps running — unlock to use this client
          </p>
          <div className="hb-pin-dots" aria-hidden>
            {[0, 1, 2, 3].map((i) => (
              <span key={i} className="hb-pin-dot" data-on={digits.length > i ? '1' : '0'} />
            ))}
          </div>
          <div className="hb-pin-pad">
            {keys.map((k, i) =>
              k === '' ? (
                <span key={`sp-${i}`} />
              ) : (
                <button
                  key={k === '⌫' ? 'back' : k}
                  type="button"
                  tabIndex={-1}
                  onClick={() => (k === '⌫' ? backspace() : press(k))}
                  aria-label={k === '⌫' ? 'Delete' : k}
                >
                  {k}
                </button>
              ),
            )}
          </div>
        </div>
      </div>
    </>
  )
}
