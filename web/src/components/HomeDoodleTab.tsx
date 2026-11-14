'use client'

import dynamic from 'next/dynamic'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../lib/api'
import { formatWait, parseAuthError } from '../lib/authErrors'
import type { Project } from '../lib/types'
import { DoodleBlob, type DoodleExpressView, type DoodleMouth } from './DoodleBlob'
import { DoodlePad, exportDoodlePadImage, type DoodleStroke } from './DoodlePad'
import { HomeIconButton } from './HomeGlyph'

const PIN_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫'] as const

const ChatPanel = dynamic(() => import('./ChatPanel').then((m) => m.ChatPanel), {
  ssr: false,
})

const DEVICE_KEY = 'hb-doodle-device-id'
const ENROLL_SKIP_KEY = 'hb-doodle-enroll-skip'

function readDeviceId(): string {
  try {
    let id = localStorage.getItem(DEVICE_KEY)
    if (id && /^[a-zA-Z0-9_-]{8,64}$/.test(id)) return id
    id = `d${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`
    localStorage.setItem(DEVICE_KEY, id)
    return id
  } catch {
    return `d${Date.now().toString(36)}`
  }
}

function formatRemain(ms: number): string {
  if (ms <= 0) return '0:00'
  const s = Math.ceil(ms / 1000)
  const m = Math.floor(s / 60)
  const r = s % 60
  if (m >= 60) {
    const h = Math.floor(m / 60)
    return `${h}h ${m % 60}m`
  }
  return `${m}:${r.toString().padStart(2, '0')}`
}

type TimerState = {
  active: boolean
  label: string
  endsAt: number
} | null

type TravelState = {
  active: boolean
  destination: string
  leaveBy: number
  arriveBy: number
  label: string
} | null

/**
 * Doodle — kid mascot + pad + floating chat over /opt/homebase-doodle sandbox.
 */
export function HomeDoodleTab({
  onHome,
  doodleOnly = false,
}: {
  onHome: () => void
  /** Session is doodle-scoped only — hide leaving without password. */
  doodleOnly?: boolean
}) {
  const deviceId = useMemo(() => readDeviceId(), [])
  const [workspace, setWorkspace] = useState('/opt/homebase-doodle')
  const [express, setExpress] = useState<DoodleExpressView>({
    mouth: 'happy',
    color: '#ffb703',
    energy: 0.55,
    name: 'Doodle',
  })
  const [strokes, setStrokes] = useState<DoodleStroke[]>([])
  const [timer, setTimer] = useState<TimerState>(null)
  const [travel, setTravel] = useState<TravelState>(null)
  const [now, setNow] = useState(Date.now())
  const [chatOpen, setChatOpen] = useState(false)
  const [enrolled, setEnrolled] = useState(false)
  const [showEnroll, setShowEnroll] = useState(false)
  /** App PIN enabled → confirm with same pad as PinLock; otherwise Yes/No only. */
  const [pinRequired, setPinRequired] = useState(false)
  const [enrollStep, setEnrollStep] = useState<'ask' | 'pin'>('ask')
  const [enrollPin, setEnrollPin] = useState('')
  const [enrollBusy, setEnrollBusy] = useState(false)
  const [enrollErr, setEnrollErr] = useState('')
  const [enrollErrStatus, setEnrollErrStatus] = useState('')
  const [enrollRetryAfter, setEnrollRetryAfter] = useState(0)
  const [enrollShake, setEnrollShake] = useState(false)
  const [statusMsg, setStatusMsg] = useState('')
  const [clearHint, setClearHint] = useState('')
  const [clearHolding, setClearHolding] = useState(false)
  /** Strokes last shown to the AI — only re-attach the pad when it changed. */
  const sentStrokesRef = useRef<DoodleStroke[] | null>(null)
  const holdRef = useRef<{ start: number; timer: number | null }>({ start: 0, timer: null })
  const syncTimer = useRef<number | null>(null)
  const padWrap = useRef<HTMLDivElement>(null)
  const enrollBusyRef = useRef(false)

  const doodleProject: Project = useMemo(
    () => ({
      id: 'doodle',
      name: 'Doodle',
      path: workspace,
      ports: [],
      actions: [],
      exists: true,
    }),
    [workspace],
  )

  const refresh = useCallback(async () => {
    try {
      const st = await api.doodleStatus(deviceId)
      setWorkspace(st.workspace || '/opt/homebase-doodle')
      const isEnrolled = Boolean(st.enrolled)
      setEnrolled(isEnrolled)
      setPinRequired(Boolean(st.pinRequiredForEnroll))
      if (st.express) {
        setExpress({
          mouth: (st.express.mouth as DoodleMouth) || 'happy',
          color: st.express.color,
          energy: st.express.energy,
          bubble: st.express.bubble,
          name: st.express.name,
        })
      }
      setTimer(st.timer?.active ? st.timer : st.timer)
      setTravel(st.travel?.active ? st.travel : st.travel)
      try {
        if (isEnrolled) {
          localStorage.setItem('hb-doodle-enrolled', '1')
          window.dispatchEvent(new Event('hb-doodle-enrolled'))
        }
      } catch {
        /* ignore */
      }
      if (!isEnrolled) {
        try {
          if (localStorage.getItem(ENROLL_SKIP_KEY) !== '1') setShowEnroll(true)
        } catch {
          setShowEnroll(true)
        }
      }
      const canvas = await api.doodleCanvas()
      if (Array.isArray(canvas.strokes)) setStrokes(canvas.strokes as DoodleStroke[])
    } catch (e) {
      console.warn('[doodle] refresh', e)
      setStatusMsg('Hmm, Doodle is taking a nap. Trying again…')
    }
  }, [deviceId])

  useEffect(() => {
    void refresh()
    const id = window.setInterval(() => void refresh(), 4000)
    return () => window.clearInterval(id)
  }, [refresh])

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 500)
    return () => window.clearInterval(id)
  }, [])

  useEffect(() => {
    if (enrollRetryAfter <= 0) return
    const tmr = window.setInterval(
      () => setEnrollRetryAfter((s) => Math.max(0, s - 1)),
      1000,
    )
    return () => window.clearInterval(tmr)
  }, [enrollRetryAfter])

  useEffect(() => {
    if (!statusMsg) return
    const t = window.setTimeout(() => setStatusMsg(''), 4200)
    return () => window.clearTimeout(t)
  }, [statusMsg])

  function attachPad() {
    if (sentStrokesRef.current === strokes) return null
    const img = exportDoodlePadImage(padWrap.current)
    if (img) sentStrokesRef.current = strokes
    return img
  }

  function schedulePush(next: DoodleStroke[]) {
    setStrokes(next)
    if (syncTimer.current) window.clearTimeout(syncTimer.current)
    syncTimer.current = window.setTimeout(() => {
      void api.doodlePutCanvas(next).catch(() => undefined)
    }, 400)
  }

  const doEnroll = useCallback(
    async (pin?: string) => {
      if (enrollBusyRef.current) return
      enrollBusyRef.current = true
      setEnrollBusy(true)
      setEnrollErr('')
      setEnrollErrStatus('')
      try {
        await api.doodleEnroll(deviceId, pin, 'Doodle tablet')
        setEnrolled(true)
        setShowEnroll(false)
        setEnrollStep('ask')
        setEnrollPin('')
        setStatusMsg(
          pinRequired
            ? 'This tablet is remembered for Doodle — no PIN here for a month.'
            : 'This tablet is remembered for Doodle.',
        )
        try {
          localStorage.removeItem(ENROLL_SKIP_KEY)
          localStorage.setItem('hb-doodle-enrolled', '1')
          window.dispatchEvent(new Event('hb-doodle-enrolled'))
        } catch {
          /* ignore */
        }
      } catch (e) {
        const parsed = parseAuthError(e, { surface: 'pin' })
        setEnrollErr(parsed.headline)
        setEnrollErrStatus(parsed.statusLine)
        if (parsed.retryAfter > 0) setEnrollRetryAfter(parsed.retryAfter)
        setEnrollPin('')
        if (parsed.kind === 'wrong_credentials') {
          setEnrollShake(true)
          window.setTimeout(() => setEnrollShake(false), 420)
        }
      } finally {
        enrollBusyRef.current = false
        setEnrollBusy(false)
      }
    },
    [deviceId, pinRequired],
  )

  useEffect(() => {
    if (enrollStep !== 'pin' || enrollRetryAfter > 0 || enrollBusy) return
    if (enrollPin.length === 4) void doEnroll(enrollPin)
  }, [enrollPin, enrollStep, enrollRetryAfter, enrollBusy, doEnroll])

  useEffect(() => {
    if (!showEnroll || enrollStep !== 'pin' || enrollRetryAfter > 0) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return
      const key = e.key
      if (/^[0-9]$/.test(key)) {
        e.preventDefault()
        e.stopPropagation()
        setEnrollPin((prev) => (prev.length >= 4 ? prev : prev + key))
        return
      }
      if (e.code.startsWith('Numpad') && /^Numpad[0-9]$/.test(e.code)) {
        e.preventDefault()
        e.stopPropagation()
        setEnrollPin((prev) => (prev.length >= 4 ? prev : prev + e.code.slice(-1)))
        return
      }
      if (key === 'Backspace' || key === 'Delete') {
        e.preventDefault()
        e.stopPropagation()
        setEnrollPin((prev) => prev.slice(0, -1))
        return
      }
      if (key === 'Escape') {
        e.preventDefault()
        setEnrollPin('')
        setEnrollStep('ask')
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [showEnroll, enrollStep, enrollRetryAfter])

  function skipEnroll() {
    try {
      localStorage.setItem(ENROLL_SKIP_KEY, '1')
    } catch {
      /* ignore */
    }
    setShowEnroll(false)
    setEnrollStep('ask')
    setEnrollPin('')
  }

  function acceptRemember() {
    setEnrollErr('')
    setEnrollErrStatus('')
    if (pinRequired) {
      setEnrollStep('pin')
      setEnrollPin('')
      return
    }
    void doEnroll()
  }

  async function softClear() {
    try {
      await api.doodleClear(false)
      setStatusMsg('Fresh new chat! Your drawing is still here.')
      setClearHint('')
    } catch (e) {
      console.warn('[doodle] clear', e)
      setStatusMsg('Oops! That did not work. Try again?')
    }
  }

  async function hardClear() {
    try {
      await api.doodleClear(true)
      setStrokes([])
      setTimer(null)
      setTravel(null)
      setStatusMsg('All clean! A brand new start ✨')
      setClearHint('')
      await refresh()
    } catch (e) {
      console.warn('[doodle] clear', e)
      setStatusMsg('Oops! That did not work. Try again?')
    }
  }

  function onClearPointerDown() {
    holdRef.current.start = Date.now()
    setClearHolding(true)
    setClearHint('Keep holding to clean everything…')
    if (holdRef.current.timer) window.clearTimeout(holdRef.current.timer)
    holdRef.current.timer = window.setTimeout(() => {
      void hardClear()
      holdRef.current.timer = null
      setClearHolding(false)
    }, 900)
  }

  function onClearPointerUp() {
    if (!holdRef.current.start) return
    setClearHolding(false)
    const held = Date.now() - holdRef.current.start
    if (holdRef.current.timer) {
      window.clearTimeout(holdRef.current.timer)
      holdRef.current.timer = null
    }
    holdRef.current.start = 0
    if (held < 850) void softClear()
  }

  const clockLabel = new Date(now).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  })
  const buddyName = express.name || 'Doodle'
  const timerOn = Boolean(timer?.active && timer.endsAt > now)
  const travelOn = Boolean(travel?.active && travel.leaveBy > now)

  return (
    <div className="hb-doodle h-full min-h-0 flex flex-col">
      <span className="hb-doodle-confetti" aria-hidden />
      <header className="hb-doodle-bar shrink-0">
        {!doodleOnly ? (
          <HomeIconButton onClick={onHome} className="hb-doodle-home shrink-0" />
        ) : (
          <span className="shrink-0 w-11" aria-hidden />
        )}
        <h1 className="hb-doodle-title" aria-label="Doodle">
          {'Doodle'.split('').map((ch, i) => (
            <span key={i} style={{ ['--i' as string]: i }}>
              {ch}
            </span>
          ))}
        </h1>
        <div className="hb-doodle-clock" aria-live="polite" title={enrolled ? 'Doodle tablet' : undefined}>
          {clockLabel}
        </div>
        <button
          type="button"
          className={`hb-doodle-clear${clearHolding ? ' hb-doodle-clear--hold' : ''}`}
          title="Tap: new chat. Hold: clean everything"
          aria-label="Clear. Tap for a new chat, hold to clean everything"
          onPointerDown={onClearPointerDown}
          onPointerUp={onClearPointerUp}
          onPointerLeave={onClearPointerUp}
          onPointerCancel={onClearPointerUp}
          onContextMenu={(e) => e.preventDefault()}
        >
          <svg viewBox="0 0 24 24" aria-hidden>
            <path d="M14 3 9.5 10.5" stroke="#9c6644" strokeWidth="2.4" strokeLinecap="round" />
            <path d="M6 11h8l2 9H4z" fill="#ffd60a" stroke="#b8860b" strokeWidth="1.4" strokeLinejoin="round" />
            <path d="M7.5 14v4M10 14v4M12.5 14v4" stroke="#b8860b" strokeWidth="1.2" strokeLinecap="round" />
          </svg>
          <span>Clear</span>
        </button>
      </header>

      {clearHint || statusMsg ? (
        <p className="hb-doodle-toast" role="status">
          {clearHint || statusMsg}
        </p>
      ) : null}

      <div className="hb-doodle-body flex-1 min-h-0 flex flex-col relative">
        <div className="hb-doodle-stage flex-1 min-h-0 flex flex-col gap-2 p-2 sm:p-3">
          <div className="hb-doodle-toprow shrink-0">
            <button
              type="button"
              className="hb-doodle-buddy-btn"
              onClick={() => setChatOpen(true)}
              aria-label={`Talk to ${buddyName}`}
            >
              <DoodleBlob express={express} size={104} />
            </button>
            <div className="hb-doodle-applets">
              {timerOn && timer ? (
                <div className="hb-doodle-chip hb-doodle-chip--timer" aria-live="polite">
                  <span className="hb-doodle-chip-icon" aria-hidden>
                    ⏰
                  </span>
                  <span className="hb-doodle-chip-text">
                    <span className="hb-doodle-chip-label">{timer.label || 'Timer'}</span>
                    <span className="hb-doodle-chip-value">{formatRemain(timer.endsAt - now)}</span>
                  </span>
                </div>
              ) : null}
              {travelOn && travel ? (
                <div className="hb-doodle-chip hb-doodle-chip--travel" aria-live="polite">
                  <span className="hb-doodle-chip-icon" aria-hidden>
                    🚗
                  </span>
                  <span className="hb-doodle-chip-text">
                    <span className="hb-doodle-chip-label">
                      {travel.label || `Off to ${travel.destination}`}
                    </span>
                    <span className="hb-doodle-chip-value">
                      leave in {formatRemain(travel.leaveBy - now)}
                    </span>
                  </span>
                </div>
              ) : null}
              {!timerOn && !travelOn ? (
                <p className="hb-doodle-hint">Draw something fun, then tap Talk to show {buddyName}!</p>
              ) : null}
            </div>
          </div>

          <div className="flex-1 min-h-0" ref={padWrap}>
            <DoodlePad strokes={strokes} onChange={schedulePush} className="h-full" />
          </div>
        </div>

        <button
          type="button"
          className="hb-doodle-talk"
          onClick={() => setChatOpen(true)}
          aria-label={`Talk to ${buddyName}`}
        >
          <svg viewBox="0 0 24 24" aria-hidden>
            <path
              d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H11l-4.5 4v-4h0A2.5 2.5 0 0 1 4 13.5z"
              fill="currentColor"
            />
            <circle cx="9" cy="9.5" r="1.3" fill="#ff4d6d" />
            <circle cx="12" cy="9.5" r="1.3" fill="#ff4d6d" />
            <circle cx="15" cy="9.5" r="1.3" fill="#ff4d6d" />
          </svg>
          <span>Talk!</span>
        </button>
      </div>

      {chatOpen ? (
        <div
          className="hb-doodle-chat-overlay"
          role="dialog"
          aria-modal="true"
          aria-label={`Chat with ${buddyName}`}
        >
          <button
            type="button"
            className="hb-doodle-chat-backdrop"
            aria-label="Close chat"
            onClick={() => setChatOpen(false)}
          />
          <div className="hb-doodle-chat-panel">
            <div className="hb-doodle-chat-head">
              <DoodleBlob express={{ ...express, bubble: '', name: '' }} size={52} />
              <h2>Chat with {buddyName}</h2>
              <button
                type="button"
                className="hb-doodle-chat-close"
                onClick={() => setChatOpen(false)}
                aria-label="Back to drawing"
              >
                <svg viewBox="0 0 24 24" aria-hidden>
                  <path d="M7 7l10 10M17 7 7 17" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
                </svg>
              </button>
            </div>
            <div className="hb-doodle-chat-body min-h-0 flex-1">
              <ChatPanel
                projects={[doodleProject]}
                selectedId="doodle"
                onSelect={() => undefined}
                variant="agent"
                defaultCwd={workspace}
                defaultCwdLabel="Doodle pad"
                kid
                kidName={buddyName}
                kidAttachImage={attachPad}
              />
            </div>
          </div>
        </div>
      ) : null}

      {showEnroll && !enrolled ? (
        <div
          className="hb-doodle-enroll"
          role="dialog"
          aria-modal="true"
          aria-label="Remember tablet"
        >
          {enrollStep === 'pin' && pinRequired ? (
            <div className={`hb-pin-card${enrollShake ? ' hb-pin-shake' : ''}`}>
              <h2 className="text-center font-semibold text-base">Enter PIN</h2>
              <p className="text-center text-xs text-mute mt-1.5 leading-snug">
                Confirm this device as a Doodle tablet. Other areas still use the usual PIN.
              </p>
              {(enrollErr || enrollRetryAfter > 0) && (
                <div className="hb-pin-error" role="alert">
                  <p>
                    {enrollErr ||
                      (enrollRetryAfter > 0
                        ? `Too many attempts. Try again in ${formatWait(enrollRetryAfter)}.`
                        : '')}
                  </p>
                  {enrollErrStatus ? (
                    <span className="hb-pin-error-status">{enrollErrStatus}</span>
                  ) : null}
                  {enrollRetryAfter > 0 ? (
                    <span className="hb-pin-error-status">
                      Try again in {formatWait(enrollRetryAfter)}
                    </span>
                  ) : null}
                </div>
              )}
              <div className="hb-pin-dots" aria-hidden>
                {[0, 1, 2, 3].map((i) => (
                  <span
                    key={i}
                    className="hb-pin-dot"
                    data-on={enrollPin.length > i ? '1' : '0'}
                  />
                ))}
              </div>
              <div
                className="hb-pin-pad"
                data-disabled={enrollRetryAfter > 0 || enrollBusy ? '1' : '0'}
              >
                {PIN_KEYS.map((k, i) =>
                  k === '' ? (
                    <span key={`sp-${i}`} />
                  ) : (
                    <button
                      key={k === '⌫' ? 'back' : k}
                      type="button"
                      tabIndex={-1}
                      disabled={enrollRetryAfter > 0 || enrollBusy}
                      onClick={() =>
                        k === '⌫'
                          ? setEnrollPin((prev) => prev.slice(0, -1))
                          : setEnrollPin((prev) => (prev.length >= 4 ? prev : prev + k))
                      }
                      aria-label={k === '⌫' ? 'Delete' : k}
                    >
                      {k}
                    </button>
                  ),
                )}
              </div>
              <button
                type="button"
                className="hb-pin-password"
                onClick={() => {
                  setEnrollStep('ask')
                  setEnrollPin('')
                  setEnrollErr('')
                  setEnrollErrStatus('')
                }}
              >
                Back
              </button>
            </div>
          ) : (
            <div className="hb-doodle-enroll-card">
              <DoodleBlob express={{ ...express, mouth: 'curious', bubble: '', name: '' }} size={72} />
              <h2>Grown-ups: remember this tablet?</h2>
              <p>
                Unlock as a <strong>Doodle tablet</strong>
                {pinRequired
                  ? ' — next you will enter your PIN on the same pad used elsewhere.'
                  : ' — App PIN is not set up, so a yes is enough.'}{' '}
                Then this scene can skip re-locking for a month. Other Home Base areas keep the
                usual security.
              </p>
              <div className="hb-doodle-enroll-actions">
                <button
                  type="button"
                  className="hb-btn hb-btn-primary"
                  disabled={enrollBusy}
                  onClick={acceptRemember}
                >
                  Yes, remember
                </button>
                <button
                  type="button"
                  className="hb-btn hb-btn-ghost"
                  disabled={enrollBusy}
                  onClick={skipEnroll}
                >
                  Not now
                </button>
              </div>
            </div>
          )}
        </div>
      ) : null}
    </div>
  )
}
