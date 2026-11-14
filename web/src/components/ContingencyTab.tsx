'use client'

import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { api } from '../lib/api'
import { formatWait, parseAuthError } from '../lib/authErrors'
import {
  playArmed,
  playKeyClick,
  playLaunch,
  playPinFail,
  playPinOk,
  playPress,
  playSpinTick,
  startSiren,
  stopSiren,
  unlockContingencyAudio,
} from '../lib/contingencyAudio'
import { HomeIconButton } from './HomeGlyph'

type Phase = 'pin' | 'ready' | 'spinning' | 'armed' | 'firing' | 'done'

type Props = {
  onHome: () => void
}

/**
 * Contingency — nuclear yellow/black kill switch.
 * PIN (if enabled) → press → full-circle spin → arm → final press → script + reboot.
 * Web GUI only; never exposed to MCP / Cursor tools.
 */
export function ContingencyTab({ onHome }: Props) {
  const [phase, setPhase] = useState<Phase>('pin')
  const [pinRequired, setPinRequired] = useState(true)
  const [digits, setDigits] = useState('')
  const [shake, setShake] = useState(false)
  const [error, setError] = useState('')
  const [retryAfter, setRetryAfter] = useState(0)
  const [ticket, setTicket] = useState<string | null>(null)
  const [ticketExpiresAt, setTicketExpiresAt] = useState<number | null>(null)
  const [script, setScript] = useState('')
  const [defaultScript, setDefaultScript] = useState('echo c > /proc/sysrq-trigger')
  const [isDefault, setIsDefault] = useState(true)
  const [scriptOpen, setScriptOpen] = useState(false)
  const [scriptEditing, setScriptEditing] = useState(false)
  const [scriptDraft, setScriptDraft] = useState('')
  const [scriptPassword, setScriptPassword] = useState('')
  const [scriptPin, setScriptPin] = useState('')
  const [scriptBusy, setScriptBusy] = useState(false)
  const [scriptMsg, setScriptMsg] = useState('')
  const [encryptedAtRest, setEncryptedAtRest] = useState(false)
  const [spinProgress, setSpinProgress] = useState(0)
  const [remainSec, setRemainSec] = useState(0)
  const [flash, setFlash] = useState(false)

  const btnRef = useRef<HTMLButtonElement>(null)
  const pressedRef = useRef(false)
  const lastAngleRef = useRef<number | null>(null)
  const accumRef = useRef(0)
  const lastTickRef = useRef(0)
  const phaseRef = useRef<Phase>('pin')
  phaseRef.current = phase

  const refresh = useCallback(async () => {
    try {
      const s = await api.contingency()
      setPinRequired(s.pinRequired)
      setScript(s.script)
      setDefaultScript(s.defaultScript)
      setIsDefault(s.isDefault)
      setEncryptedAtRest(!!s.encryptedAtRest)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [ticket])

  useEffect(() => {
    void refresh()
    return () => stopSiren()
  }, [refresh])

  useEffect(() => {
    if (retryAfter <= 0) return
    const tmr = window.setInterval(() => setRetryAfter((s) => Math.max(0, s - 1)), 1000)
    return () => window.clearInterval(tmr)
  }, [retryAfter])

  useEffect(() => {
    if (!ticketExpiresAt) {
      setRemainSec(0)
      return
    }
    const tick = () => {
      const left = Math.max(0, Math.ceil((ticketExpiresAt - Date.now()) / 1000))
      setRemainSec(left)
      if (left <= 0 && phaseRef.current !== 'firing' && phaseRef.current !== 'done') {
        setTicket(null)
        setTicketExpiresAt(null)
        setPhase('pin')
        setSpinProgress(0)
        stopSiren()
        setError('Arm expired — enter PIN again')
      }
    }
    tick()
    const iv = window.setInterval(tick, 500)
    return () => window.clearInterval(iv)
  }, [ticketExpiresAt])

  const authorize = useCallback(
    async (pin?: string) => {
      setError('')
      try {
        await unlockContingencyAudio()
        const res = await api.contingencyAuthorize(pin)
        setTicket(res.ticket)
        setTicketExpiresAt(res.expiresAt)
        setDigits('')
        setPhase('ready')
        setSpinProgress(0)
        accumRef.current = 0
        lastAngleRef.current = null
        playPinOk()
      } catch (err) {
        playPinFail()
        const parsed = parseAuthError(err, { surface: 'pin' })
        setError(parsed.headline || (err instanceof Error ? err.message : String(err)))
        if (parsed.retryAfter > 0) setRetryAfter(parsed.retryAfter)
        setDigits('')
        setShake(true)
        window.setTimeout(() => setShake(false), 420)
      }
    },
    [],
  )

  useEffect(() => {
    if (phase !== 'pin') return
    if (pinRequired && digits.length === 4 && retryAfter <= 0) {
      void authorize(digits)
    }
  }, [digits, phase, pinRequired, authorize, retryAfter])

  const pressDigit = useCallback((d: string) => {
    void unlockContingencyAudio()
    playKeyClick()
    setDigits((prev) => (prev.length >= 4 ? prev : prev + d))
  }, [])

  const backspace = useCallback(() => {
    playKeyClick()
    setDigits((prev) => prev.slice(0, -1))
  }, [])

  useEffect(() => {
    if (phase !== 'pin' || retryAfter > 0) return
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return
      if (/^[0-9]$/.test(e.key)) {
        e.preventDefault()
        pressDigit(e.key)
        return
      }
      if (e.key === 'Backspace' || e.key === 'Delete') {
        e.preventDefault()
        backspace()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [phase, pressDigit, backspace, retryAfter])

  const angleAt = (clientX: number, clientY: number): number | null => {
    const el = btnRef.current
    if (!el) return null
    const r = el.getBoundingClientRect()
    const cx = r.left + r.width / 2
    const cy = r.top + r.height / 2
    return Math.atan2(clientY - cy, clientX - cx)
  }

  const onPointerDown = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (phase === 'ready') {
      e.currentTarget.setPointerCapture(e.pointerId)
      pressedRef.current = true
      setPhase('spinning')
      setSpinProgress(0)
      accumRef.current = 0
      lastAngleRef.current = angleAt(e.clientX, e.clientY)
      void unlockContingencyAudio()
      playPress()
      return
    }
    if (phase === 'armed') {
      void fire()
    }
  }

  const onPointerMove = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (phaseRef.current !== 'spinning' || !pressedRef.current) return
    const ang = angleAt(e.clientX, e.clientY)
    if (ang == null || lastAngleRef.current == null) {
      lastAngleRef.current = ang
      return
    }
    let delta = ang - lastAngleRef.current
    // unwrap to (-π, π]
    while (delta > Math.PI) delta -= Math.PI * 2
    while (delta < -Math.PI) delta += Math.PI * 2
    lastAngleRef.current = ang
    accumRef.current += Math.abs(delta)
    const prog = Math.min(1, accumRef.current / (Math.PI * 2))
    setSpinProgress(prog)
    if (prog - lastTickRef.current > 0.08) {
      lastTickRef.current = prog
      playSpinTick()
    }
    if (prog >= 1) {
      pressedRef.current = false
      setPhase('armed')
      setSpinProgress(1)
      playArmed()
      startSiren()
      try {
        if (typeof navigator !== 'undefined' && navigator.vibrate) navigator.vibrate([40, 40, 80])
      } catch {
        /* ignore */
      }
    }
  }

  const onPointerUp = () => {
    if (phaseRef.current === 'spinning') {
      // Released early — reset to ready
      pressedRef.current = false
      setPhase('ready')
      setSpinProgress(0)
      accumRef.current = 0
      lastAngleRef.current = null
      lastTickRef.current = 0
    }
  }

  const fire = async () => {
    if (!ticket || phaseRef.current === 'firing' || phaseRef.current === 'done') return
    setPhase('firing')
    stopSiren()
    playLaunch()
    setFlash(true)
    window.setTimeout(() => setFlash(false), 600)
    try {
      if (typeof navigator !== 'undefined' && navigator.vibrate) {
        navigator.vibrate([80, 40, 80, 40, 200])
      }
    } catch {
      /* ignore */
    }
    try {
      await api.contingencyExecute(ticket)
      setPhase('done')
      setTicket(null)
      setTicketExpiresAt(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setPhase('pin')
      setTicket(null)
      setTicketExpiresAt(null)
      setSpinProgress(0)
    }
  }

  const closeScriptPanel = () => {
    setScriptOpen(false)
    setScriptEditing(false)
    setScriptPassword('')
    setScriptPin('')
    setScriptMsg('')
    setScriptDraft(script)
  }

  const saveScript = async () => {
    if (!scriptPassword.trim()) {
      setScriptMsg('Enter your Home Base password to save')
      return
    }
    if (pinRequired && scriptPin.replace(/\D/g, '').length !== 4) {
      setScriptMsg('Enter your 4-digit App PIN to save')
      return
    }
    setScriptBusy(true)
    setScriptMsg('')
    try {
      const pin = pinRequired ? scriptPin.replace(/\D/g, '').slice(0, 4) : undefined
      const res = await api.contingencySetScript(scriptDraft, scriptPassword, pin)
      setScript(res.script)
      setIsDefault(res.isDefault)
      setEncryptedAtRest(!!res.encryptedAtRest)
      setScriptMsg('Saved · encrypted at rest')
      setScriptEditing(false)
      setScriptPassword('')
      setScriptPin('')
      setTicket(null)
      setTicketExpiresAt(null)
      setPhase('pin')
      setSpinProgress(0)
      stopSiren()
    } catch (e) {
      const parsed = parseAuthError(e, { surface: 'login' })
      setScriptMsg(parsed.headline || (e instanceof Error ? e.message : String(e)))
      if (parsed.retryAfter > 0) setRetryAfter(parsed.retryAfter)
    } finally {
      setScriptBusy(false)
    }
  }

  const lockAgain = async () => {
    stopSiren()
    try {
      await api.contingencyRevoke()
    } catch {
      /* ignore */
    }
    setTicket(null)
    setTicketExpiresAt(null)
    setPhase('pin')
    setDigits('')
    setSpinProgress(0)
    setError('')
  }

  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫']
  const spinDeg = Math.round(spinProgress * 360)
  const buttonLabel =
    phase === 'ready'
      ? 'PRESS & SPIN'
      : phase === 'spinning'
        ? `${spinDeg}°`
        : phase === 'armed'
          ? 'EXECUTE'
          : phase === 'firing'
            ? 'FIRING…'
            : phase === 'done'
              ? 'AWAY'
              : 'LOCKED'

  return (
    <div className={`hb-contingency h-full min-h-0 flex flex-col${flash ? ' hb-contingency--flash' : ''}`}>
      <div className="hb-contingency-stripes" aria-hidden />
      <header className="hb-contingency-bar shrink-0">
        <HomeIconButton onClick={onHome} className="hb-topbar-home shrink-0" />
        <div className="hb-contingency-bar-title min-w-0">
          <h1 className="hb-contingency-title">CONTINGENCY</h1>
          <p className="hb-contingency-sub truncate">
            {phase === 'done'
              ? 'Payload started'
              : phase === 'armed'
                ? `ARMED · ${remainSec}s`
                : phase === 'ready' || phase === 'spinning'
                  ? `Armed auth · ${remainSec}s`
                  : pinRequired
                    ? 'PIN required'
                    : 'Authorize to unlock'}
          </p>
        </div>
        <button
          type="button"
          className="hb-contingency-script-btn shrink-0"
          onClick={() => {
            void unlockContingencyAudio()
            if (scriptOpen) {
              closeScriptPanel()
              return
            }
            setScriptDraft(script)
            setScriptEditing(false)
            setScriptPassword('')
            setScriptPin('')
            setScriptMsg('')
            setScriptOpen(true)
          }}
        >
          Script
        </button>
      </header>

      {scriptOpen ? (
        <div className="hb-contingency-script-panel">
          <p className="hb-contingency-script-hint">
            Bash run as homebased. Epilogue always attempts <code>reboot</code> after your script
            {isDefault ? ' · currently default crash' : ''}.
            {encryptedAtRest ? ' · vault encrypted' : ' · will encrypt on first save'}.
            {' '}Readable here; edit needs password{pinRequired ? ' + PIN' : ''}.
          </p>
          <textarea
            className="hb-contingency-script-area"
            value={scriptEditing ? scriptDraft : script}
            onChange={(e) => scriptEditing && setScriptDraft(e.target.value)}
            readOnly={!scriptEditing}
            rows={8}
            spellCheck={false}
            aria-label="Contingency script"
            aria-readonly={!scriptEditing}
          />
          {scriptEditing ? (
            <div className="hb-contingency-script-creds">
              <label className="hb-contingency-field">
                <span>Password</span>
                <input
                  type="password"
                  autoComplete="current-password"
                  value={scriptPassword}
                  onChange={(e) => setScriptPassword(e.target.value)}
                  placeholder="Home Base password"
                />
              </label>
              {pinRequired ? (
                <label className="hb-contingency-field">
                  <span>PIN</span>
                  <input
                    type="password"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={4}
                    value={scriptPin}
                    onChange={(e) => setScriptPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
                    placeholder="4-digit PIN"
                  />
                </label>
              ) : null}
            </div>
          ) : null}
          <div className="hb-contingency-script-actions">
            {!scriptEditing ? (
              <button
                type="button"
                className="hb-btn hb-btn-primary"
                onClick={() => {
                  setScriptDraft(script)
                  setScriptEditing(true)
                  setScriptMsg('')
                }}
              >
                Unlock to edit
              </button>
            ) : (
              <>
                <button
                  type="button"
                  className="hb-btn"
                  disabled={scriptBusy}
                  onClick={() => setScriptDraft(defaultScript)}
                >
                  Reset default
                </button>
                <button
                  type="button"
                  className="hb-btn hb-btn-primary"
                  disabled={scriptBusy}
                  onClick={() => void saveScript()}
                >
                  {scriptBusy ? 'Saving…' : 'Save'}
                </button>
                <button
                  type="button"
                  className="hb-btn"
                  disabled={scriptBusy}
                  onClick={() => {
                    setScriptEditing(false)
                    setScriptDraft(script)
                    setScriptPassword('')
                    setScriptPin('')
                    setScriptMsg('')
                  }}
                >
                  Cancel edit
                </button>
              </>
            )}
            <button type="button" className="hb-btn" onClick={closeScriptPanel}>
              Close
            </button>
          </div>
          {scriptMsg ? <p className="hb-contingency-script-msg">{scriptMsg}</p> : null}
        </div>
      ) : null}

      <main className="hb-contingency-stage flex-1 min-h-0">
        {error ? (
          <div className="hb-contingency-error" role="alert">
            {error}
            {retryAfter > 0 ? ` · ${formatWait(retryAfter)}` : ''}
          </div>
        ) : null}

        {phase === 'pin' ? (
          <div className={`hb-contingency-pin${shake ? ' hb-contingency-shake' : ''}`}>
            <div className="hb-contingency-hazard" aria-hidden>
              <span className="hb-contingency-tri" />
              <span>AUTHORIZED PERSONNEL ONLY</span>
              <span className="hb-contingency-tri" />
            </div>
            {pinRequired ? (
              <>
                <p className="hb-contingency-pin-label">ENTER PIN</p>
                <div className="hb-contingency-dots" aria-hidden>
                  {[0, 1, 2, 3].map((i) => (
                    <span key={i} data-on={digits.length > i ? '1' : '0'} />
                  ))}
                </div>
                <div className="hb-contingency-pad" data-disabled={retryAfter > 0 ? '1' : '0'}>
                  {keys.map((k, i) =>
                    k === '' ? (
                      <span key={`sp-${i}`} />
                    ) : (
                      <button
                        key={k === '⌫' ? 'back' : k}
                        type="button"
                        tabIndex={-1}
                        disabled={retryAfter > 0}
                        onClick={() => (k === '⌫' ? backspace() : pressDigit(k))}
                        aria-label={k === '⌫' ? 'Delete' : k}
                      >
                        {k}
                      </button>
                    ),
                  )}
                </div>
              </>
            ) : (
              <div className="hb-contingency-nopin">
                <p>No App PIN set — authorize with your session.</p>
                <button
                  type="button"
                  className="hb-contingency-auth-btn"
                  onClick={() => void authorize()}
                >
                  AUTHORIZE
                </button>
              </div>
            )}
          </div>
        ) : (
          <div className="hb-contingency-launch">
            <div className="hb-contingency-ring-wrap">
              <svg className="hb-contingency-ring" viewBox="0 0 120 120" aria-hidden>
                <circle className="hb-contingency-ring-track" cx="60" cy="60" r="52" />
                <circle
                  className="hb-contingency-ring-prog"
                  cx="60"
                  cy="60"
                  r="52"
                  style={{
                    strokeDasharray: `${2 * Math.PI * 52}`,
                    strokeDashoffset: `${2 * Math.PI * 52 * (1 - spinProgress)}`,
                  }}
                />
              </svg>
              <button
                ref={btnRef}
                type="button"
                className={`hb-contingency-bigbtn hb-contingency-bigbtn--${phase}`}
                disabled={phase === 'firing' || phase === 'done'}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
                style={
                  phase === 'spinning'
                    ? { transform: `rotate(${spinDeg}deg)` }
                    : phase === 'armed'
                      ? { transform: 'rotate(360deg)' }
                      : undefined
                }
                aria-label={buttonLabel}
              >
                <span className="hb-contingency-bigbtn-glow" aria-hidden />
                <span className="hb-contingency-bigbtn-label">{buttonLabel}</span>
                {phase === 'ready' || phase === 'spinning' ? (
                  <span className="hb-contingency-bigbtn-hint">
                    {phase === 'ready' ? 'hold · drag full circle' : 'keep spinning…'}
                  </span>
                ) : null}
                {phase === 'armed' ? (
                  <span className="hb-contingency-bigbtn-hint">press once more</span>
                ) : null}
              </button>
            </div>
            <p className="hb-contingency-steps">
              {phase === 'ready' && '1 · Press  →  2 · Full spin  →  3 · Execute'}
              {phase === 'spinning' && 'Keep finger down — complete one full revolution'}
              {phase === 'armed' && 'Button lit — final press runs the script'}
              {phase === 'firing' && 'Contingency payload launched'}
              {phase === 'done' && 'Host should halt or reboot. Connection may drop.'}
            </p>
            {phase !== 'firing' && phase !== 'done' ? (
              <button type="button" className="hb-contingency-abort" onClick={() => void lockAgain()}>
                Abort · re-lock
              </button>
            ) : null}
          </div>
        )}
      </main>
    </div>
  )
}
