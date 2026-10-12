'use client'

import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { refreshServerIdentity } from '../lib/serverIdentity'
import { BrandTitle } from './BrandTitle'
import { CloudflarePanel } from './CloudflarePanel'
import { WireGuardPanel } from './WireGuardPanel'

type Props = {
  onDone: () => void
}

type Step =
  | 'welcome'
  | 'name'
  | 'pin'
  | 'cursor'
  | 'remote'
  | 'wireguard'
  | 'cloudflare'
  | 'done'

export function OnboardingFlow({ onDone }: Props) {
  const [step, setStep] = useState<Step>('welcome')
  const [displayName, setDisplayName] = useState('Home Base')
  const [suggestedName, setSuggestedName] = useState('Home Base')
  const [pin, setPin] = useState('')
  const [pin2, setPin2] = useState('')
  const [idleMin, setIdleMin] = useState(5)
  const [apiKey, setApiKey] = useState('')
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  const [cursorOk, setCursorOk] = useState(false)

  useEffect(() => {
    void api.cursorCredentials().then((r) => setCursorOk(r.configured)).catch(() => {})
    void api
      .serverIdentity()
      .then((s) => {
        setSuggestedName(s.suggestedName)
        setDisplayName(s.customized ? s.displayName : s.suggestedName)
      })
      .catch(() => {})
  }, [])

  const digits = (v: string) => v.replace(/\D/g, '').slice(0, 4)

  const progressIndex =
    step === 'wireguard' || step === 'cloudflare'
      ? 4
      : step === 'welcome'
        ? 0
        : step === 'name'
          ? 1
          : step === 'pin'
            ? 2
            : step === 'cursor'
              ? 3
              : step === 'remote'
                ? 4
                : 5

  async function finish(opts?: {
    skippedRemote?: boolean
    remoteMode?: 'wireguard' | 'cloudflare' | null
  }) {
    setBusy(true)
    try {
      await api.saveOnboarding({
        complete: true,
        skippedRemote: opts?.skippedRemote,
        remoteMode: opts?.remoteMode ?? null,
      })
      await refreshServerIdentity()
      onDone()
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function saveName() {
    setMsg('')
    const name = displayName.trim()
    if (!name) {
      setMsg('Enter a name')
      return
    }
    setBusy(true)
    try {
      await api.setServerIdentity(name)
      await refreshServerIdentity()
      setStep('pin')
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function savePin() {
    setMsg('')
    if (pin.length !== 4 || pin !== pin2) {
      setMsg('Enter matching 4-digit PINs')
      return
    }
    setBusy(true)
    try {
      await api.appPinSet(pin)
      await api.appPinIdle(idleMin * 60_000)
      setStep('cursor')
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function saveKey() {
    setMsg('')
    if (!apiKey.trim()) {
      setMsg('Paste your Cursor API key')
      return
    }
    setBusy(true)
    try {
      await api.setCursorCredentials(apiKey.trim())
      setCursorOk(true)
      setApiKey('')
      setStep('remote')
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[60] bg-bg flex flex-col">
      <div className="flex-1 overflow-y-auto">
        <div className="hb-page !max-w-lg py-10 space-y-6">
          <div className="space-y-2">
            <div className="hb-brand-rule" />
            <p className="hb-label">Setup</p>
            <div className="flex gap-1.5 pt-1" aria-hidden>
              {[0, 1, 2, 3, 4, 5].map((i) => (
                <span
                  key={i}
                  className={`h-1 flex-1 rounded-full ${i <= progressIndex ? 'bg-accent' : 'bg-line'}`}
                />
              ))}
            </div>
          </div>

          {step === 'welcome' && (
            <div className="space-y-5 hb-enter">
              <h1 className="font-display text-3xl font-extrabold tracking-tight leading-tight">
                Welcome
              </h1>
              <p className="text-mute text-sm leading-relaxed">
                Your project is ready. A few quick steps and you can chat, run apps, and
                reach this laptop from your phone.
              </p>
              <button
                type="button"
                className="hb-btn hb-btn-primary w-full !min-h-12 text-base"
                onClick={() => setStep('name')}
              >
                Continue
              </button>
            </div>
          )}

          {step === 'name' && (
            <div className="space-y-4 hb-enter">
              <h1 className="font-display text-2xl font-extrabold tracking-tight">Name this server</h1>
              <p className="text-mute text-sm">
                Shown on login and Home. Suggested from your laptop user.
              </p>
              <p className="font-display text-xl font-extrabold tracking-tight">
                <BrandTitle name={displayName.trim() || suggestedName} />
              </p>
              <input
                className="w-full rounded-[var(--radius-control)] bg-panel-2 border border-line px-3 py-3 text-sm"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value.slice(0, 64))}
                placeholder={suggestedName}
                autoFocus
              />
              {displayName.trim() !== suggestedName && (
                <button
                  type="button"
                  className="text-xs text-sky underline underline-offset-2"
                  onClick={() => setDisplayName(suggestedName)}
                >
                  Use suggested · {suggestedName}
                </button>
              )}
              {msg && <p className="text-danger text-sm">{msg}</p>}
              <button
                type="button"
                className="hb-btn hb-btn-primary w-full !min-h-11"
                disabled={busy || !displayName.trim()}
                onClick={() => void saveName()}
              >
                Continue
              </button>
            </div>
          )}

          {step === 'pin' && (
            <div className="space-y-4 hb-enter">
              <h1 className="font-display text-2xl font-extrabold tracking-tight">App PIN</h1>
              <p className="text-mute text-sm">Optional lock when you step away.</p>
              <label className="block space-y-1">
                <span className="text-xs text-mute">PIN</span>
                <input
                  inputMode="numeric"
                  maxLength={4}
                  className="w-full rounded-[var(--radius-control)] bg-panel-2 border border-line px-3 py-3 text-center text-lg tracking-[0.4em] font-mono"
                  value={pin}
                  onChange={(e) => setPin(digits(e.target.value))}
                />
              </label>
              <label className="block space-y-1">
                <span className="text-xs text-mute">Confirm</span>
                <input
                  inputMode="numeric"
                  maxLength={4}
                  className="w-full rounded-[var(--radius-control)] bg-panel-2 border border-line px-3 py-3 text-center text-lg tracking-[0.4em] font-mono"
                  value={pin2}
                  onChange={(e) => setPin2(digits(e.target.value))}
                />
              </label>
              <label className="block space-y-1">
                <span className="text-xs text-mute">Lock after (minutes)</span>
                <input
                  type="number"
                  min={1}
                  max={30}
                  className="w-full rounded-[var(--radius-control)] bg-panel-2 border border-line px-3 py-2.5 text-sm"
                  value={idleMin}
                  onChange={(e) => setIdleMin(Math.min(30, Math.max(1, Number(e.target.value) || 5)))}
                />
              </label>
              {msg && <p className="text-danger text-sm">{msg}</p>}
              <button
                type="button"
                className="hb-btn hb-btn-primary w-full !min-h-11"
                disabled={busy}
                onClick={() => void savePin()}
              >
                Enable PIN
              </button>
              <button
                type="button"
                className="hb-btn hb-btn-ghost w-full !min-h-11"
                onClick={() => {
                  setMsg('')
                  setStep('cursor')
                }}
              >
                Skip
              </button>
            </div>
          )}

          {step === 'cursor' && (
            <div className="space-y-4 hb-enter">
              <h1 className="font-display text-2xl font-extrabold tracking-tight">Cursor API key</h1>
              <p className="text-mute text-sm">
                Powers Chat. Stored encrypted on this laptop.
                {cursorOk ? ' A key is already set.' : ''}
              </p>
              <input
                type="password"
                autoComplete="off"
                className="w-full rounded-[var(--radius-control)] bg-panel-2 border border-line px-3 py-3 text-sm font-mono"
                placeholder="Paste key"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
              />
              <a
                href="https://cursor.com/dashboard"
                target="_blank"
                rel="noreferrer"
                className="block text-xs text-sky underline underline-offset-2"
              >
                Get a key
              </a>
              {msg && <p className="text-danger text-sm">{msg}</p>}
              <button
                type="button"
                className="hb-btn hb-btn-primary w-full !min-h-11"
                disabled={busy}
                onClick={() => void saveKey()}
              >
                Save key
              </button>
              <button
                type="button"
                className="hb-btn hb-btn-ghost w-full !min-h-11"
                onClick={() => {
                  setMsg('')
                  setStep('remote')
                }}
              >
                {cursorOk ? 'Continue' : 'Skip for now'}
              </button>
            </div>
          )}

          {step === 'remote' && (
            <div className="space-y-4 hb-enter">
              <h1 className="font-display text-2xl font-extrabold tracking-tight">
                Phone access
              </h1>
              <p className="text-mute text-sm">How should your phone reach this laptop?</p>
              <button
                type="button"
                className="w-full text-left rounded-[var(--radius-control)] border border-line bg-panel-2 p-4 space-y-1 hover:border-accent/50"
                onClick={() => setStep('wireguard')}
              >
                <p className="font-semibold text-sm">WireGuard VPN</p>
                <p className="text-xs text-mute">Private tunnel. Forward one UDP port on your router.</p>
              </button>
              <button
                type="button"
                className="w-full text-left rounded-[var(--radius-control)] border border-line bg-panel-2 p-4 space-y-1 hover:border-accent/50"
                onClick={() => setStep('cloudflare')}
              >
                <p className="font-semibold text-sm">Cloudflare Tunnel</p>
                <p className="text-xs text-mute">HTTPS link. No public IP or router port.</p>
              </button>
              <button
                type="button"
                className="hb-btn hb-btn-ghost w-full !min-h-11"
                disabled={busy}
                onClick={() => void finish({ skippedRemote: true })}
              >
                Skip — same Wi‑Fi for now
              </button>
            </div>
          )}

          {step === 'wireguard' && (
            <div className="space-y-4 hb-enter">
              <h1 className="font-display text-2xl font-extrabold tracking-tight">WireGuard</h1>
              <WireGuardPanel />
              <button
                type="button"
                className="hb-btn hb-btn-primary w-full !min-h-11"
                disabled={busy}
                onClick={() => void finish({ remoteMode: 'wireguard' })}
              >
                Done
              </button>
              <button
                type="button"
                className="hb-btn hb-btn-ghost w-full !min-h-11"
                onClick={() => setStep('remote')}
              >
                Back
              </button>
            </div>
          )}

          {step === 'cloudflare' && (
            <div className="space-y-4 hb-enter">
              <h1 className="font-display text-2xl font-extrabold tracking-tight">Cloudflare</h1>
              <CloudflarePanel embedded />
              <button
                type="button"
                className="hb-btn hb-btn-primary w-full !min-h-11"
                disabled={busy}
                onClick={() => void finish({ remoteMode: 'cloudflare' })}
              >
                Done
              </button>
              <button
                type="button"
                className="hb-btn hb-btn-ghost w-full !min-h-11"
                onClick={() => setStep('remote')}
              >
                Back
              </button>
            </div>
          )}

          {step === 'done' && (
            <div className="space-y-5 hb-enter">
              <h1 className="font-display text-2xl font-extrabold tracking-tight">You are set</h1>
              <p className="text-mute text-sm">
                Open Chat — or add another app with + in Apps.
              </p>
              <button
                type="button"
                className="hb-btn hb-btn-primary w-full !min-h-12"
                onClick={() => onDone()}
              >
                Go home
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
