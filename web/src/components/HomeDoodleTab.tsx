'use client'

import dynamic from 'next/dynamic'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../lib/api'
import type { Project } from '../lib/types'
import { DoodleBlob, type DoodleExpressView, type DoodleMouth } from './DoodleBlob'
import { DoodlePad, type DoodleStroke } from './DoodlePad'
import { HomeIconButton } from './HomeGlyph'

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
    color: '#4ecdc4',
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
  const [enrollPin, setEnrollPin] = useState('')
  const [enrollBusy, setEnrollBusy] = useState(false)
  const [enrollErr, setEnrollErr] = useState('')
  const [statusMsg, setStatusMsg] = useState('')
  const [clearHint, setClearHint] = useState('')
  const holdRef = useRef<{ start: number; timer: number | null }>({ start: 0, timer: null })
  const syncTimer = useRef<number | null>(null)
  const padWrap = useRef<HTMLDivElement>(null)

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
      setEnrolled(Boolean(st.enrolled))
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
        if (st.enrolled) {
          localStorage.setItem('hb-doodle-enrolled', '1')
          window.dispatchEvent(new Event('hb-doodle-enrolled'))
        }
      } catch {
        /* ignore */
      }
      if (!enrolled && st.pinRequiredForEnroll) {
        try {
          if (localStorage.getItem(ENROLL_SKIP_KEY) !== '1') setShowEnroll(true)
        } catch {
          setShowEnroll(true)
        }
      }
      const canvas = await api.doodleCanvas()
      if (Array.isArray(canvas.strokes)) setStrokes(canvas.strokes as DoodleStroke[])
    } catch (e) {
      setStatusMsg(e instanceof Error ? e.message : String(e))
    }
  }, [deviceId, enrolled])

  useEffect(() => {
    void refresh()
    const id = window.setInterval(() => void refresh(), 4000)
    return () => window.clearInterval(id)
  }, [refresh])

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 500)
    return () => window.clearInterval(id)
  }, [])

  function schedulePush(next: DoodleStroke[]) {
    setStrokes(next)
    if (syncTimer.current) window.clearTimeout(syncTimer.current)
    syncTimer.current = window.setTimeout(() => {
      void api.doodlePutCanvas(next).catch(() => undefined)
    }, 400)
  }

  async function doEnroll() {
    setEnrollBusy(true)
    setEnrollErr('')
    try {
      await api.doodleEnroll(deviceId, enrollPin, 'Doodle tablet')
      setEnrolled(true)
      setShowEnroll(false)
      setEnrollPin('')
      setStatusMsg('This tablet is remembered for Doodle — no PIN here for a month.')
      try {
        localStorage.removeItem(ENROLL_SKIP_KEY)
        localStorage.setItem('hb-doodle-enrolled', '1')
        window.dispatchEvent(new Event('hb-doodle-enrolled'))
      } catch {
        /* ignore */
      }
    } catch (e) {
      setEnrollErr(e instanceof Error ? e.message : String(e))
    } finally {
      setEnrollBusy(false)
    }
  }

  function skipEnroll() {
    try {
      localStorage.setItem(ENROLL_SKIP_KEY, '1')
    } catch {
      /* ignore */
    }
    setShowEnroll(false)
  }

  async function softClear() {
    try {
      await api.doodleClear(false)
      setStatusMsg('Chat restarted — drawings and files kept.')
      setClearHint('')
    } catch (e) {
      setStatusMsg(e instanceof Error ? e.message : String(e))
    }
  }

  async function hardClear() {
    try {
      await api.doodleClear(true)
      setStrokes([])
      setTimer(null)
      setTravel(null)
      setStatusMsg('Everything cleared — fresh start (workspace emptied).')
      setClearHint('')
      await refresh()
    } catch (e) {
      setStatusMsg(e instanceof Error ? e.message : String(e))
    }
  }

  function onClearPointerDown() {
    holdRef.current.start = Date.now()
    setClearHint('Hold to clear workspace too…')
    if (holdRef.current.timer) window.clearTimeout(holdRef.current.timer)
    holdRef.current.timer = window.setTimeout(() => {
      void hardClear()
      holdRef.current.timer = null
    }, 900)
  }

  function onClearPointerUp() {
    const held = Date.now() - holdRef.current.start
    if (holdRef.current.timer) {
      window.clearTimeout(holdRef.current.timer)
      holdRef.current.timer = null
    }
    if (held < 850) void softClear()
  }

  const clockLabel = new Date(now).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  })

  return (
    <div className="hb-doodle h-full min-h-0 flex flex-col">
      <header className="hb-doodle-bar shrink-0">
        {!doodleOnly ? (
          <HomeIconButton onClick={onHome} className="hb-topbar-home shrink-0" />
        ) : (
          <span className="hb-topbar-home shrink-0 w-9" aria-hidden />
        )}
        <div className="hb-doodle-bar-title min-w-0">
          <h1 className="hb-doodle-title">Doodle</h1>
          <p className="hb-doodle-sub truncate">
            Draw · chat · timers
            {enrolled ? (
              <>
                <span className="hb-status-sep">·</span>
                <span className="text-ok">tablet</span>
              </>
            ) : null}
          </p>
        </div>
        <button
          type="button"
          className="hb-btn hb-btn-ghost hb-btn-sm hb-doodle-clear"
          title="Tap: clear chat. Hold: clear chat + workspace"
          onPointerDown={onClearPointerDown}
          onPointerUp={onClearPointerUp}
          onPointerLeave={onClearPointerUp}
          onPointerCancel={onClearPointerUp}
        >
          Clear
        </button>
      </header>

      {clearHint ? (
        <p className="hb-doodle-banner text-mute" role="status">
          {clearHint}
        </p>
      ) : null}
      {statusMsg ? (
        <p className="hb-doodle-banner" role="status">
          {statusMsg}
        </p>
      ) : null}

      <div className="hb-doodle-body flex-1 min-h-0 flex flex-col relative">
        <div className="hb-doodle-stage flex-1 min-h-0 flex flex-col gap-2 p-2 sm:p-3">
          <div className="hb-doodle-toprow shrink-0 flex items-start justify-between gap-3">
            <DoodleBlob express={express} size={96} />
            <div className="hb-doodle-applets flex flex-col gap-2 min-w-0 flex-1 items-end">
              <div className="hb-doodle-chip" aria-live="polite">
                <span className="hb-doodle-chip-label">Clock</span>
                <span className="hb-doodle-chip-value">{clockLabel}</span>
              </div>
              {timer?.active && timer.endsAt > now ? (
                <div className="hb-doodle-chip hb-doodle-chip--timer" aria-live="polite">
                  <span className="hb-doodle-chip-label">{timer.label || 'Timer'}</span>
                  <span className="hb-doodle-chip-value">
                    {formatRemain(timer.endsAt - now)}
                  </span>
                </div>
              ) : null}
              {travel?.active && travel.leaveBy > now ? (
                <div className="hb-doodle-chip hb-doodle-chip--travel" aria-live="polite">
                  <span className="hb-doodle-chip-label">
                    {travel.label || `Leave for ${travel.destination}`}
                  </span>
                  <span className="hb-doodle-chip-value">
                    leave in {formatRemain(travel.leaveBy - now)}
                  </span>
                </div>
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
          aria-label="Talk to Doodle"
        >
          Talk
        </button>
      </div>

      {chatOpen ? (
        <div className="hb-doodle-chat-overlay" role="dialog" aria-modal="true" aria-label="Chat">
          <button
            type="button"
            className="hb-doodle-chat-backdrop"
            aria-label="Close chat"
            onClick={() => setChatOpen(false)}
          />
          <div className="hb-doodle-chat-panel">
            <div className="hb-doodle-chat-head">
              <h2>Talk with Doodle</h2>
              <button
                type="button"
                className="hb-btn hb-btn-ghost hb-btn-sm"
                onClick={() => setChatOpen(false)}
              >
                Done
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
              />
            </div>
          </div>
        </div>
      ) : null}

      {showEnroll && !enrolled ? (
        <div className="hb-doodle-enroll" role="dialog" aria-modal="true" aria-label="Remember tablet">
          <div className="hb-doodle-enroll-card">
            <h2>Remember this device?</h2>
            <p>
              Unlock as a <strong>Doodle tablet</strong> with your PIN. Then this scene won&apos;t
              ask for PIN again (for a month). Other Home Base areas still need the usual PIN and
              password security.
            </p>
            <input
              className="hb-input"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={4}
              placeholder="PIN"
              value={enrollPin}
              onChange={(e) => setEnrollPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
              aria-label="App PIN"
            />
            {enrollErr ? (
              <p className="text-danger text-sm" role="alert">
                {enrollErr}
              </p>
            ) : null}
            <div className="hb-doodle-enroll-actions">
              <button
                type="button"
                className="hb-btn hb-btn-primary"
                disabled={enrollBusy || enrollPin.length !== 4}
                onClick={() => void doEnroll()}
              >
                Remember tablet
              </button>
              <button type="button" className="hb-btn hb-btn-ghost" onClick={skipEnroll}>
                Not now
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
