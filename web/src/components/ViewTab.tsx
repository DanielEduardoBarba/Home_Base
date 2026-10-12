import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type WheelEvent } from 'react'
import { api, wsUrl } from '../lib/api'
import { useNotifyOptional } from '../lib/NotifyContext'
import {
  connStateLabel,
  connectWithReconnect,
  type WsConnState,
  type WsReconnectHandle,
} from '../lib/wsReconnect'

const FRAME_MAGIC = 0x48425646
const HEADER_LEN = 20
const MIN_ZOOM = 1
const MAX_ZOOM = 5
const TAP_MS = 220
const LONG_MS = 480
const MOVE_PX = 12
const LS_CONTROL = 'hb-view-control'
const LS_MONITOR = 'hb-view-monitor'
const LS_QUALITY = 'hb-view-quality'
const LS_HINT = 'hb-view-hint-v2'
const DEFAULT_AUTO_WIDTH = 1280

type QualityPreset = 'auto' | 'ultra' | 'high' | 'medium' | 'low'
type ControlMode = 'touch' | 'mouse'

type MonitorInfo = {
  index: number
  label: string
  left: number
  top: number
  width: number
  height: number
}

const QUALITY_OPTIONS: { id: QualityPreset; label: string; title: string }[] = [
  { id: 'auto', label: 'Auto', title: 'Adaptive quality from link + zoom' },
  { id: 'ultra', label: 'Ultra', title: 'Native screen pixels · heavy bandwidth' },
  { id: 'high', label: 'High', title: 'More detail · uses more bandwidth' },
  { id: 'medium', label: 'Med', title: 'Balanced quality and speed' },
  { id: 'low', label: 'Low', title: 'Less detail · smoother on slow VPN' },
]

const PRESETS: Record<Exclude<QualityPreset, 'auto'>, { maxWidth: number; quality: number; fps: number }> = {
  // Native-ish (server caps ~4K); keep encode under the worker IPC budget.
  ultra: { maxWidth: 3840, quality: 85, fps: 12 },
  high: { maxWidth: 1680, quality: 72, fps: 18 },
  medium: { maxWidth: 1280, quality: 55, fps: 12 },
  low: { maxWidth: 960, quality: 36, fps: 8 },
}

function parseHeader(buf: ArrayBuffer) {
  if (buf.byteLength < HEADER_LEN) return null
  const v = new DataView(buf)
  const magic = v.getUint32(0, true)
  if (magic !== FRAME_MAGIC) return null
  return {
    seq: v.getUint32(4, true),
    width: v.getUint16(8, true),
    height: v.getUint16(10, true),
    screenW: v.getUint16(12, true),
    screenH: v.getUint16(14, true),
    quality: v.getUint8(17),
  }
}

function loadControl(): ControlMode {
  try {
    const v = localStorage.getItem(LS_CONTROL)
    if (v === 'mouse' || v === 'touch') {
      // Phones often had "Mouse" selected when they meant trackpad Touch — fix once.
      if (
        v === 'mouse' &&
        typeof window !== 'undefined' &&
        window.matchMedia('(pointer: coarse)').matches &&
        localStorage.getItem('hb-view-control-touchpref') !== '1'
      ) {
        localStorage.setItem('hb-view-control-touchpref', '1')
        localStorage.setItem(LS_CONTROL, 'touch')
        return 'touch'
      }
      return v
    }
  } catch {
    /* ignore */
  }
  return 'touch'
}

function loadMonitor(): number {
  try {
    const n = Number(localStorage.getItem(LS_MONITOR))
    if (Number.isFinite(n) && n >= 0) return Math.floor(n)
  } catch {
    /* ignore */
  }
  return 0
}

function loadQuality(): QualityPreset {
  try {
    const v = localStorage.getItem(LS_QUALITY)
    if (v === 'auto' || v === 'ultra' || v === 'high' || v === 'medium' || v === 'low') return v
    // Legacy network-named presets
    if (v === 'lan') return 'high'
    if (v === 'vpn') return 'low'
  } catch {
    /* ignore */
  }
  return 'auto'
}

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n))
}

function dist(a: { x: number; y: number }, b: { x: number; y: number }) {
  const dx = a.x - b.x
  const dy = a.y - b.y
  return Math.hypot(dx, dy)
}

/** View — connect explicitly; maximize hides chrome; touch trackpad + zoom/pan. */
export function ViewTab() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const cursorElRef = useRef<HTMLDivElement>(null)
  const connRef = useRef<WsReconnectHandle | null>(null)
  const bitmapRef = useRef<ImageBitmap | null>(null)
  const paintRectRef = useRef({ x: 0, y: 0, w: 0, h: 0 })
  const lastPointerRef = useRef(0)
  const rafRef = useRef(0)
  const presetRef = useRef<QualityPreset>('auto')
  const controlRef = useRef<ControlMode>('touch')
  const monitorRef = useRef(0)
  const zoomRef = useRef(1)
  const panRef = useRef({ x: 0, y: 0 })
  const screenRef = useRef({ w: 0, h: 0 })
  const monitorsRef = useRef<MonitorInfo[]>([])
  const cursorNormRef = useRef({ x: 0.5, y: 0.5 })
  /** Displayed overlay pos (lerped toward cursorNorm for less jarring motion). */
  const cursorDrawRef = useRef({ x: 0.5, y: 0.5 })
  const cursorShowRef = useRef(false)
  const cursorRafRef = useRef(0)
  const schedulePaintRef = useRef<() => void>(() => {})
  const bumpZoomRef = useRef<(z: number) => void>(() => {})
  const relAccumRef = useRef({ dx: 0, dy: 0 })
  const relFlushRafRef = useRef(0)
  const absPendingRef = useRef<{
    action: string
    clientX: number
    clientY: number
    button: number
    deltaY: number
  } | null>(null)
  const absFlushRafRef = useRef(0)
  const notifyRef = useRef<ReturnType<typeof useNotifyOptional>>(null)
  /** While set, Home Base owns the pointer — ignore native cursor sync (stops rubber-banding). */
  const hbControlUntilRef = useRef(0)
  const lastNativeCursorRef = useRef({ x: -1, y: -1 })

  const pointersRef = useRef<Map<number, { x: number; y: number }>>(new Map())
  const gestureRef = useRef<{
    kind: 'none' | 'touch' | 'mouse' | 'pinch'
    startT: number
    startX: number
    startY: number
    lastX: number
    lastY: number
    moved: boolean
    longFired: boolean
    leftDown: boolean
    pinchDist: number
    pinchZoom: number
    pinchPanX: number
    pinchPanY: number
    pinchMidX: number
    pinchMidY: number
  }>({
    kind: 'none',
    startT: 0,
    startX: 0,
    startY: 0,
    lastX: 0,
    lastY: 0,
    moved: false,
    longFired: false,
    leftDown: false,
    pinchDist: 0,
    pinchZoom: 1,
    pinchPanX: 0,
    pinchPanY: 0,
    pinchMidX: 0,
    pinchMidY: 0,
  })
  const longTimerRef = useRef(0)

  const [wanted, setWanted] = useState(false)
  const [conn, setConn] = useState<WsConnState>('offline')
  const [error, setError] = useState('')
  const [preset, setPreset] = useState<QualityPreset>(() => loadQuality())
  // Load once — avoid mount effect race that overwrote LS and flashed the wrong mode.
  const [control, setControl] = useState<ControlMode>(() => loadControl())
  const [monitor, setMonitor] = useState(() => loadMonitor())
  const [monitors, setMonitors] = useState<MonitorInfo[]>([])
  const [zoom, setZoom] = useState(1)
  const [stats, setStats] = useState({ fps: 0, kbps: 0, quality: 0, screen: '' })
  const [focused, setFocused] = useState(false)
  const [maximized, setMaximized] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [probe, setProbe] = useState('')
  const [hint, setHint] = useState(() => {
    try {
      return localStorage.getItem(LS_HINT) !== '1'
    } catch {
      return true
    }
  })
  const [holdPulse, setHoldPulse] = useState(false)
  const notify = useNotifyOptional()
  notifyRef.current = notify
  const [cursorOn, setCursorOn] = useState(false)
  const fpsCount = useRef(0)
  const fpsT0 = useRef(performance.now())
  const gotFrameRef = useRef(false)
  const frameWatchRef = useRef(0)
  presetRef.current = preset
  controlRef.current = control
  monitorRef.current = monitor
  zoomRef.current = zoom

  useEffect(() => {
    void api
      .viewStatus()
      .then((s) => {
        setProbe(s.ok ? `${s.screenW}×${s.screenH}` : s.error || 'unavailable')
        if (Array.isArray(s.monitors) && s.monitors.length) {
          setMonitors(s.monitors as MonitorInfo[])
          monitorsRef.current = s.monitors as MonitorInfo[]
        }
      })
      .catch((e) => setProbe(e instanceof Error ? e.message : String(e)))
  }, [])

  useEffect(() => {
    document.documentElement.classList.toggle('hb-view-max', maximized)
    return () => document.documentElement.classList.remove('hb-view-max')
  }, [maximized])

  useEffect(() => {
    if (!menuOpen) return
    const onPointer = (e: globalThis.PointerEvent) => {
      const t = e.target
      if (!(t instanceof Element)) return
      if (t.closest('.hb-view-maxbar, .hb-chrome, .hb-view-menu')) return
      setMenuOpen(false)
    }
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false)
    }
    document.addEventListener('pointerdown', onPointer, true)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [menuOpen])

  useEffect(() => {
    try {
      localStorage.setItem(LS_CONTROL, control)
    } catch {
      /* ignore */
    }
  }, [control])

  useEffect(() => {
    try {
      localStorage.setItem(LS_QUALITY, preset)
    } catch {
      /* ignore */
    }
  }, [preset])

  useEffect(() => {
    try {
      localStorage.setItem(LS_MONITOR, String(monitor))
    } catch {
      /* ignore */
    }
    // Update input mapping immediately from monitor metadata (don't wait for next JPEG).
    // Stale All-displays screenW/H makes touch deltas overshoot into the other screen.
    const monMeta = monitorsRef.current.find((m) => m.index === monitor)
    if (monMeta && monMeta.width > 0 && monMeta.height > 0) {
      screenRef.current = { w: monMeta.width, h: monMeta.height }
      setStats((s) => ({
        ...s,
        screen: `${monMeta.width}×${monMeta.height}`,
      }))
    }
    // Drop previous capture so paintRect/aspect can't mismatch the new monitor.
    if (bitmapRef.current) {
      bitmapRef.current.close()
      bitmapRef.current = null
    }
    paintRectRef.current = { x: 0, y: 0, w: 0, h: 0 }
    cursorNormRef.current = { x: 0.5, y: 0.5 }
    const ws = connRef.current?.getSocket()
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'config', monitor }))
    }
    // Reset view framing when switching displays
    zoomRef.current = 1
    panRef.current = { x: 0, y: 0 }
    setZoom(1)
    schedulePaintRef.current()
  }, [monitor])

  /** Live draw rect from current bitmap/zoom/pan — never trust a stale paintRect for input. */
  function livePaintRect(): { x: number; y: number; w: number; h: number } | null {
    const wrap = wrapRef.current
    const bmp = bitmapRef.current
    if (!wrap || !bmp || bmp.width < 1 || bmp.height < 1) return null
    const cw = wrap.clientWidth
    const ch = wrap.clientHeight
    if (cw < 2 || ch < 2) return null
    const z = zoomRef.current
    const base = Math.min(cw / bmp.width, ch / bmp.height)
    const scale = base * z
    const dw = bmp.width * scale
    const dh = bmp.height * scale
    const pan = clampPan(z, panRef.current.x, panRef.current.y)
    panRef.current = pan
    return { x: (cw - dw) / 2 + pan.x, y: (ch - dh) / 2 + pan.y, w: dw, h: dh }
  }

  function placeCursorEl() {
    const el = cursorElRef.current
    const r = livePaintRect() || paintRectRef.current
    if (!el) return
    if (!cursorShowRef.current || r.w < 1) {
      el.style.display = 'none'
      return
    }
    const n = cursorDrawRef.current
    el.style.display = 'block'
    el.style.left = `${r.x + n.x * r.w}px`
    el.style.top = `${r.y + n.y * r.h}px`
  }

  function tickCursorLerp() {
    cursorRafRef.current = 0
    // While we are driving, stay snapped — no lag chasing our own target.
    if (performance.now() < hbControlUntilRef.current) {
      cursorDrawRef.current = { ...cursorNormRef.current }
      placeCursorEl()
      return
    }
    const t = cursorNormRef.current
    const d = cursorDrawRef.current
    const dx = t.x - d.x
    const dy = t.y - d.y
    const dist = Math.hypot(dx, dy)
    if (dist < 0.0008) {
      cursorDrawRef.current = { x: t.x, y: t.y }
      placeCursorEl()
      return
    }
    // Native laptop moves: light smoothing only.
    const a = dist > 0.08 ? 0.5 : 0.28
    cursorDrawRef.current = { x: d.x + dx * a, y: d.y + dy * a }
    placeCursorEl()
    cursorRafRef.current = requestAnimationFrame(tickCursorLerp)
  }

  function markHbControl() {
    hbControlUntilRef.current = performance.now() + 900
  }

  function pixelsFromNorm(nx: number, ny: number) {
    const sw = Math.max(2, screenRef.current.w | 0)
    const sh = Math.max(2, screenRef.current.h | 0)
    const x = clamp(nx, 0, 1)
    const y = clamp(ny, 0, 1)
    return {
      nx: x,
      ny: y,
      px: Math.round(x * (sw - 1)),
      py: Math.round(y * (sh - 1)),
    }
  }

  /** Warp the real X11 cursor to the Home Base overlay position (source of truth). */
  function sendAbsNorm(
    action: string,
    nx: number,
    ny: number,
    button = 0,
    deltaY = 0,
  ) {
    if (!wanted) return
    markHbControl()
    const m = pixelsFromNorm(nx, ny)
    lastPointerRef.current = performance.now()
    sendWs({
      type: 'pointer',
      mode: 'abs',
      action,
      x: m.nx,
      y: m.ny,
      px: m.px,
      py: m.py,
      screenW: screenRef.current.w,
      screenH: screenRef.current.h,
      button,
      deltaY,
    })
    setCursorNorm(m.nx, m.ny, true, true)
  }

  function setCursorNorm(x: number, y: number, show = true, snap = false) {
    cursorNormRef.current = { x: clamp(x, 0, 1), y: clamp(y, 0, 1) }
    cursorShowRef.current = show
    if (show && !cursorOn) setCursorOn(true)
    if (!show && cursorOn) setCursorOn(false)
    if (snap || performance.now() < hbControlUntilRef.current) {
      cursorDrawRef.current = { ...cursorNormRef.current }
      placeCursorEl()
      if (cursorRafRef.current) {
        cancelAnimationFrame(cursorRafRef.current)
        cursorRafRef.current = 0
      }
      return
    }
    if (!cursorRafRef.current) {
      cursorRafRef.current = requestAnimationFrame(tickCursorLerp)
    }
  }

  /**
   * Apply X11 root coords to the overlay.
   * Home Base control wins while active; native laptop mouse wins when idle.
   */
  function applyRemoteCursor(
    cursorX: number,
    cursorY: number,
    source: 'native' | 'remote' | 'hello' = 'native',
  ) {
    if (!Number.isFinite(cursorX) || !Number.isFinite(cursorY) || cursorX < 0 || cursorY < 0) {
      return
    }
    // Ignore echoes / native sync while the viewer is moving the pointer.
    if (source !== 'hello' && performance.now() < hbControlUntilRef.current) {
      return
    }
    if (source === 'remote') {
      // Server echo of our own input — already mirrored locally; skip to avoid tug-of-war.
      return
    }
    const mon =
      monitorsRef.current.find((m) => m.index === monitorRef.current) ||
      monitorsRef.current.find((m) => m.index === 0)
    if (!mon || mon.width < 1 || mon.height < 1) return
    const nx = (cursorX - mon.left) / mon.width
    const ny = (cursorY - mon.top) / mon.height
    // Other display (or past the rim): don't pin the overlay to an edge — that
    // desyncs clicks when viewing one screen of a dual-monitor setup.
    if (monitorRef.current !== 0 && (nx < -0.001 || nx > 1.001 || ny < -0.001 || ny > 1.001)) {
      return
    }
    const prev = lastNativeCursorRef.current
    const moved =
      prev.x < 0 || Math.hypot(cursorX - prev.x, cursorY - prev.y) >= 1
    lastNativeCursorRef.current = { x: cursorX, y: cursorY }
    if (!moved && source === 'native') return
    setCursorNorm(clamp(nx, 0, 1), clamp(ny, 0, 1), true, source === 'hello')
  }

  function forceQualityLocal(preset: QualityPreset, reason: string, from?: string) {
    if (preset === 'auto') return
    presetRef.current = preset
    setPreset(preset)
    notifyRef.current?.ping({
      title: 'View quality lowered',
      body:
        reason ||
        `Server switched${from ? ` from ${from}` : ''} to ${preset} for performance.`,
      level: 'warn',
      category: 'view-quality',
    })
  }

  function clampPan(zoomMul: number, panX: number, panY: number) {
    const wrap = wrapRef.current
    const bmp = bitmapRef.current
    if (!wrap || !bmp) return { x: panX, y: panY }
    const cw = wrap.clientWidth
    const ch = wrap.clientHeight
    const base = Math.min(cw / bmp.width, ch / bmp.height)
    const scale = base * zoomMul
    const dw = bmp.width * scale
    const dh = bmp.height * scale
    const maxX = Math.max(0, (dw - cw) / 2 + 24)
    const maxY = Math.max(0, (dh - ch) / 2 + 24)
    return { x: clamp(panX, -maxX, maxX), y: clamp(panY, -maxY, maxY) }
  }

  function applyZoom(next: number, anchorX?: number, anchorY?: number) {
    const wrap = wrapRef.current
    const prev = zoomRef.current
    const z = clamp(next, MIN_ZOOM, MAX_ZOOM)
    if (!wrap || Math.abs(z - prev) < 0.001) {
      zoomRef.current = z
      setZoom(z)
      return
    }
    if (anchorX != null && anchorY != null && prev > 0) {
      const bounds = wrap.getBoundingClientRect()
      const lx = anchorX - bounds.left - wrap.clientWidth / 2
      const ly = anchorY - bounds.top - wrap.clientHeight / 2
      const ratio = z / prev
      panRef.current = clampPan(
        z,
        lx - (lx - panRef.current.x) * ratio,
        ly - (ly - panRef.current.y) * ratio,
      )
    } else {
      panRef.current = clampPan(z, panRef.current.x, panRef.current.y)
    }
    zoomRef.current = z
    setZoom(z)
    schedulePaintRef.current()
    bumpZoomRef.current(z)
  }

  useEffect(() => {
    bumpZoomRef.current = (z: number) => {
      const ws = connRef.current?.getSocket()
      if (!ws || ws.readyState !== WebSocket.OPEN) return
      if (presetRef.current !== 'auto') return
      const maxWidth = z >= 2.2 ? 1920 : z >= 1.4 ? 1600 : DEFAULT_AUTO_WIDTH
      ws.send(JSON.stringify({ type: 'config', maxWidth }))
    }
  })

  useEffect(() => {
    let disposed = false

    const paint = () => {
      rafRef.current = 0
      const canvas = canvasRef.current
      const bmp = bitmapRef.current
      const wrap = wrapRef.current
      if (!canvas || !bmp || !wrap) return
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      const cw = wrap.clientWidth
      const ch = wrap.clientHeight
      if (cw < 2 || ch < 2) return
      const needW = Math.round(cw * dpr)
      const needH = Math.round(ch * dpr)
      if (canvas.width !== needW || canvas.height !== needH) {
        canvas.width = needW
        canvas.height = needH
      }
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.fillStyle = '#0a0c10'
      ctx.fillRect(0, 0, cw, ch)
      const z = zoomRef.current
      const base = Math.min(cw / bmp.width, ch / bmp.height)
      const scale = base * z
      const dw = bmp.width * scale
      const dh = bmp.height * scale
      const pan = clampPan(z, panRef.current.x, panRef.current.y)
      panRef.current = pan
      const dx = (cw - dw) / 2 + pan.x
      const dy = (ch - dh) / 2 + pan.y
      paintRectRef.current = { x: dx, y: dy, w: dw, h: dh }
      ctx.imageSmoothingEnabled = z < 1.5
      ctx.imageSmoothingQuality = z < 1.5 ? 'medium' : 'low'
      ctx.drawImage(bmp, dx, dy, dw, dh)
      placeCursorEl()
    }

    const schedulePaint = () => {
      if (!rafRef.current) rafRef.current = requestAnimationFrame(paint)
    }
    schedulePaintRef.current = schedulePaint

    const sendJson = (obj: unknown) => {
      const ws = connRef.current?.getSocket()
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj))
    }

    const stopConn = () => {
      connRef.current?.dispose()
      connRef.current = null
      if (!disposed) setConn('offline')
    }

    const startConn = () => {
      if (connRef.current) return
      connRef.current = connectWithReconnect({
        url: () => wsUrl('/ws/view'),
        onState: (s) => {
          if (!disposed) setConn(s)
          // Auth-lost disposes the handle permanently — drop it so Start can reopen.
          if (s === 'auth') {
            connRef.current = null
            if (!disposed) {
              setWanted(false)
              setError('Session expired — sign in again, then Start View.')
            }
          }
        },
        onOpen: (ws) => {
          if (disposed) return
          ws.binaryType = 'arraybuffer'
          setError('')
          gotFrameRef.current = false
          if (frameWatchRef.current) window.clearTimeout(frameWatchRef.current)
          frameWatchRef.current = window.setTimeout(() => {
            if (disposed || gotFrameRef.current) return
            if (presetRef.current === 'ultra' || presetRef.current === 'high') {
              const from = presetRef.current
              const next: QualityPreset = from === 'ultra' ? 'high' : 'medium'
              forceQualityLocal(
                next,
                `No frames at ${from} — switched to ${next} for performance.`,
                from,
              )
              const sock = connRef.current?.getSocket()
              if (sock && sock.readyState === WebSocket.OPEN) {
                sock.send(
                  JSON.stringify({
                    type: 'config',
                    ...PRESETS[next],
                    monitor: monitorRef.current,
                  }),
                )
              }
              return
            }
            setError('No video frames yet — try Med/Low quality, or Stop and Start again.')
          }, 5000)
          const p = presetRef.current
          // Prefer a safe first stream; Ultra can be selected after frames flow.
          const cfg: Record<string, unknown> = {
            type: 'config',
            monitor: monitorRef.current,
            ...(p === 'auto' ? {} : p === 'ultra' ? PRESETS.high : PRESETS[p]),
          }
          ws.send(JSON.stringify(cfg))
          if (p === 'ultra') {
            // Apply Ultra after the worker is warm (avoids black screen on cold start).
            window.setTimeout(() => {
              if (disposed || !gotFrameRef.current) return
              const sock = connRef.current?.getSocket()
              if (sock && sock.readyState === WebSocket.OPEN) {
                sock.send(
                  JSON.stringify({
                    type: 'config',
                    ...PRESETS.ultra,
                    monitor: monitorRef.current,
                  }),
                )
              }
            }, 1200)
          }
        },
        onMessage: (ev) => {
          if (disposed) return
          if (typeof ev.data === 'string') {
            try {
              const msg = JSON.parse(ev.data) as Record<string, unknown>
              if (msg.type === 'hello' || msg.type === 'config') {
                const mons = Array.isArray(msg.monitors) ? (msg.monitors as MonitorInfo[]) : null
                if (mons && mons.length) {
                  monitorsRef.current = mons
                  setMonitors(mons)
                }
                const cfgMon = Number(msg.monitor)
                const monIdx = Number.isFinite(cfgMon) ? cfgMon : monitorRef.current
                const monMeta = (mons || monitorsRef.current).find((m) => m.index === monIdx)
                if (monMeta && monMeta.width > 0 && monMeta.height > 0) {
                  screenRef.current = { w: monMeta.width, h: monMeta.height }
                } else if (msg.screenW && msg.screenH) {
                  screenRef.current = { w: Number(msg.screenW), h: Number(msg.screenH) }
                }
                if (msg.type === 'hello') {
                  setStats((s) => ({
                    ...s,
                    screen: `${msg.screenW}×${msg.screenH}`,
                    quality: Number(msg.quality) || s.quality,
                  }))
                  applyRemoteCursor(Number(msg.cursorX), Number(msg.cursorY), 'hello')
                } else {
                  setStats((s) => ({ ...s, quality: Number(msg.quality) || s.quality }))
                }
              } else if (msg.type === 'cursor') {
                const src = msg.source === 'remote' ? 'remote' : 'native'
                applyRemoteCursor(Number(msg.cursorX), Number(msg.cursorY), src)
              } else if (msg.type === 'quality-forced') {
                const p = String(msg.preset || '') as QualityPreset
                if (p === 'ultra' || p === 'high' || p === 'medium' || p === 'low') {
                  forceQualityLocal(
                    p,
                    String(msg.reason || 'Server lowered quality for performance.'),
                    String(msg.from || ''),
                  )
                }
              } else if (msg.type === 'error') {
                setError(String(msg.error || 'View error'))
              }
            } catch {
              /* ignore */
            }
            return
          }
          const data = ev.data as ArrayBuffer
          const header = parseHeader(data)
          if (!header) {
            if (!gotFrameRef.current) {
              setError('Got a bad video packet — try Stop, then Start.')
            }
            return
          }
          const jpeg = new Uint8Array(data, HEADER_LEN)
          const tSend = performance.now()
          const ack = () => {
            sendJson({ type: 'ack', seq: header.seq, rttMs: performance.now() - tSend })
          }
          void createImageBitmap(new Blob([jpeg], { type: 'image/jpeg' }))
            .then((bmp) => {
              if (disposed) {
                bmp.close()
                ack()
                return
              }
              gotFrameRef.current = true
              if (frameWatchRef.current) {
                window.clearTimeout(frameWatchRef.current)
                frameWatchRef.current = 0
              }
              setError((e) => (e.startsWith('No video') || e.startsWith('Ultra was') ? '' : e))
              const prev = bitmapRef.current
              bitmapRef.current = bmp
              if (prev) prev.close()
              screenRef.current = { w: header.screenW, h: header.screenH }
              schedulePaint()
              fpsCount.current += 1
              const now = performance.now()
              if (now - fpsT0.current >= 1000) {
                const fps = (fpsCount.current * 1000) / (now - fpsT0.current)
                setStats((s) => ({
                  ...s,
                  fps,
                  kbps: (jpeg.byteLength * 8 * fps) / 1000,
                  quality: header.quality,
                  screen: `${header.screenW}×${header.screenH}`,
                }))
                fpsCount.current = 0
                fpsT0.current = now
              }
              ack()
            })
            .catch(() => {
              if (!gotFrameRef.current) {
                setError('Could not decode video frame — try Med quality.')
              }
              ack()
            })
        },
      })
    }

    if (wanted) startConn()
    else stopConn()

    const onResize = () => schedulePaint()
    window.addEventListener('resize', onResize)
    return () => {
      disposed = true
      window.removeEventListener('resize', onResize)
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      if (longTimerRef.current) window.clearTimeout(longTimerRef.current)
      if (frameWatchRef.current) window.clearTimeout(frameWatchRef.current)
      if (cursorRafRef.current) cancelAnimationFrame(cursorRafRef.current)
      if (relFlushRafRef.current) cancelAnimationFrame(relFlushRafRef.current)
      if (absFlushRafRef.current) cancelAnimationFrame(absFlushRafRef.current)
      stopConn()
      bitmapRef.current?.close()
      bitmapRef.current = null
      document.documentElement.classList.remove('hb-view-max')
    }
  }, [wanted])

  useEffect(() => {
    const ws = connRef.current?.getSocket()
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    if (preset === 'auto') {
      bumpZoomRef.current(zoomRef.current)
      return
    }
    ws.send(JSON.stringify({ type: 'config', ...PRESETS[preset], monitor: monitorRef.current }))
  }, [preset])

  function disconnect() {
    setWanted(false)
    setMaximized(false)
    setMenuOpen(false)
    setError('')
    cursorShowRef.current = false
    setCursorOn(false)
  }

  function dismissHint() {
    setHint(false)
    try {
      localStorage.setItem(LS_HINT, '1')
    } catch {
      /* ignore */
    }
  }

  function mapClientToRemote(clientX: number, clientY: number): {
    nx: number
    ny: number
    px: number
    py: number
  } | null {
    const wrap = wrapRef.current
    const rect = livePaintRect()
    if (!wrap || !rect || rect.w < 1 || rect.h < 1) return null
    const bounds = wrap.getBoundingClientRect()
    // Normalize against the same box used for hit-testing (CSS px, not device px).
    const scaleX = bounds.width > 0 ? wrap.clientWidth / bounds.width : 1
    const scaleY = bounds.height > 0 ? wrap.clientHeight / bounds.height : 1
    const lx = (clientX - bounds.left) * scaleX
    const ly = (clientY - bounds.top) * scaleY
    const sw = screenRef.current.w | 0
    const sh = screenRef.current.h | 0
    if (sw < 2 || sh < 2) return null
    // Clamp to the painted monitor image — dragging past the View edge (or toward
    // another display) must park on this monitor's rim, not drop updates / desync.
    const nx = clamp((lx - rect.x) / rect.w, 0, 1)
    const ny = clamp((ly - rect.y) / rect.h, 0, 1)
    // Integer pixels inside the capture/monitor rect (matches XGetImage region).
    const px = Math.round(nx * (sw - 1))
    const py = Math.round(ny * (sh - 1))
    return { nx, ny, px, py }
  }

  function sendWs(obj: Record<string, unknown>) {
    const ws = connRef.current?.getSocket()
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify(obj))
  }

  function flushAbsPending() {
    absFlushRafRef.current = 0
    const pending = absPendingRef.current
    absPendingRef.current = null
    if (!pending || !wanted) return
    const m = mapClientToRemote(pending.clientX, pending.clientY)
    if (!m) return
    markHbControl()
    lastPointerRef.current = performance.now()
    sendWs({
      type: 'pointer',
      mode: 'abs',
      action: pending.action,
      x: m.nx,
      y: m.ny,
      px: m.px,
      py: m.py,
      screenW: screenRef.current.w,
      screenH: screenRef.current.h,
      button: pending.button,
      deltaY: pending.deltaY,
    })
    setCursorNorm(m.nx, m.ny, true, true)
  }

  function sendAbs(action: string, clientX: number, clientY: number, button = 0, deltaY = 0) {
    if (!wanted) return
    // Coalesce move samples to one per animation frame — smoother on the host.
    if (action === 'move') {
      absPendingRef.current = { action, clientX, clientY, button, deltaY }
      if (!absFlushRafRef.current) {
        absFlushRafRef.current = requestAnimationFrame(flushAbsPending)
      }
      return
    }
    // down/up/wheel: flush any pending move first, then send immediately
    if (absFlushRafRef.current) {
      cancelAnimationFrame(absFlushRafRef.current)
      absFlushRafRef.current = 0
      flushAbsPending()
    }
    const m = mapClientToRemote(clientX, clientY)
    if (!m) return
    markHbControl()
    lastPointerRef.current = performance.now()
    sendWs({
      type: 'pointer',
      mode: 'abs',
      action,
      x: m.nx,
      y: m.ny,
      px: m.px,
      py: m.py,
      screenW: screenRef.current.w,
      screenH: screenRef.current.h,
      button,
      deltaY,
    })
    setCursorNorm(m.nx, m.ny, true, true)
  }

  function flushRelAccum() {
    relFlushRafRef.current = 0
    const { dx, dy } = relAccumRef.current
    relAccumRef.current = { dx: 0, dy: 0 }
    if (!wanted) return
    if (Math.abs(dx) < 0.15 && Math.abs(dy) < 0.15) return
    const sw = screenRef.current.w || 1
    const sh = screenRef.current.h || 1
    // Trackpad-feel locally, but always absolute-warp the host to the overlay
    // so a fighting laptop mouse cannot desync click targets.
    const nx = clamp(cursorNormRef.current.x + dx / sw, 0, 1)
    const ny = clamp(cursorNormRef.current.y + dy / sh, 0, 1)
    sendAbsNorm('move', nx, ny)
  }

  function sendRel(dxPx: number, dyPx: number) {
    if (!wanted) return
    const rect = livePaintRect()
    const sw = screenRef.current.w || 1
    const sh = screenRef.current.h || 1
    if (!rect || rect.w < 1 || rect.h < 1) return
    // 1:1 with on-screen remote pixels; accumulate + flush per frame for smoothness.
    const dx = (dxPx * sw) / rect.w
    const dy = (dyPx * sh) / rect.h
    if (Math.abs(dx) < 0.05 && Math.abs(dy) < 0.05) return
    relAccumRef.current.dx += dx
    relAccumRef.current.dy += dy
    if (!relFlushRafRef.current) {
      relFlushRafRef.current = requestAnimationFrame(flushRelAccum)
    }
  }

  function sendClick(button: number) {
    // Flush pending trackpad motion, then click at the overlay — never at a drifted native spot.
    if (relFlushRafRef.current) {
      cancelAnimationFrame(relFlushRafRef.current)
      relFlushRafRef.current = 0
      flushRelAccum()
    }
    if (absFlushRafRef.current) {
      cancelAnimationFrame(absFlushRafRef.current)
      absFlushRafRef.current = 0
      flushAbsPending()
    }
    const n = cursorNormRef.current
    sendAbsNorm('click', n.x, n.y, button)
    if (navigator.vibrate) {
      try {
        navigator.vibrate(button === 2 ? 24 : 12)
      } catch {
        /* ignore */
      }
    }
  }

  function clearLongTimer() {
    if (longTimerRef.current) {
      window.clearTimeout(longTimerRef.current)
      longTimerRef.current = 0
    }
    setHoldPulse(false)
  }

  function armLongPress() {
    clearLongTimer()
    setHoldPulse(true)
    longTimerRef.current = window.setTimeout(() => {
      const g = gestureRef.current
      if (g.kind !== 'touch' && g.kind !== 'mouse') return
      if (g.moved || g.longFired) return
      g.longFired = true
      if (g.leftDown) {
        sendAbsNorm('up', cursorNormRef.current.x, cursorNormRef.current.y, 0)
        g.leftDown = false
      }
      sendClick(2)
      setHoldPulse(false)
      if (navigator.vibrate) {
        try {
          navigator.vibrate([0, 10, 30])
        } catch {
          /* ignore */
        }
      }
    }, LONG_MS)
  }

  function beginPinch() {
    const pts = [...pointersRef.current.values()]
    if (pts.length < 2) return
    clearLongTimer()
    const g = gestureRef.current
    if (g.leftDown) {
      sendAbsNorm('up', cursorNormRef.current.x, cursorNormRef.current.y, 0)
      g.leftDown = false
    }
    g.kind = 'pinch'
    g.moved = true
    g.pinchDist = dist(pts[0], pts[1]) || 1
    g.pinchZoom = zoomRef.current
    g.pinchPanX = panRef.current.x
    g.pinchPanY = panRef.current.y
    g.pinchMidX = (pts[0].x + pts[1].x) / 2
    g.pinchMidY = (pts[0].y + pts[1].y) / 2
  }

  function onPointerDown(e: PointerEvent) {
    if (!wanted) return
    wrapRef.current?.focus()
    setFocused(true)
    ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    const count = pointersRef.current.size

    if (count >= 2) {
      beginPinch()
      e.preventDefault()
      return
    }

    const g = gestureRef.current
    g.startT = performance.now()
    g.startX = e.clientX
    g.startY = e.clientY
    g.lastX = e.clientX
    g.lastY = e.clientY
    g.moved = false
    g.longFired = false
    g.leftDown = false

    if (controlRef.current === 'mouse' && e.pointerType === 'mouse') {
      g.kind = 'mouse'
      sendAbs('down', e.clientX, e.clientY, e.button)
    } else if (controlRef.current === 'mouse') {
      // Absolute finger: place cursor now; tap/hold resolved on up
      g.kind = 'mouse'
      sendAbs('move', e.clientX, e.clientY, 0)
      armLongPress()
    } else {
      g.kind = 'touch'
      armLongPress()
    }
    e.preventDefault()
  }

  function onPointerMove(e: PointerEvent) {
    if (!wanted) return
    if (!pointersRef.current.has(e.pointerId)) {
      // Hover-only mouse move in absolute mode
      if (controlRef.current === 'mouse' && e.pointerType === 'mouse' && pointersRef.current.size === 0) {
        sendAbs('move', e.clientX, e.clientY, 0)
      }
      return
    }
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    const g = gestureRef.current

    if (g.kind === 'pinch' || pointersRef.current.size >= 2) {
      if (g.kind !== 'pinch') beginPinch()
      const pts = [...pointersRef.current.values()]
      if (pts.length >= 2) {
        const d = dist(pts[0], pts[1]) || 1
        const midX = (pts[0].x + pts[1].x) / 2
        const midY = (pts[0].y + pts[1].y) / 2
        const scaleRatio = d / g.pinchDist
        // Fit view + two-finger swipe (little pinch) → remote scroll
        if (
          controlRef.current === 'touch' &&
          zoomRef.current <= 1.05 &&
          Math.abs(scaleRatio - 1) < 0.08
        ) {
          const dy = midY - g.pinchMidY
          const dx = midX - g.pinchMidX
          if (Math.abs(dy) > 2 || Math.abs(dx) > 2) {
            sendAbsNorm('wheel', cursorNormRef.current.x, cursorNormRef.current.y, 0, dy * 1.6)
            g.pinchMidX = midX
            g.pinchMidY = midY
          }
          e.preventDefault()
          return
        }
        const nextZoom = clamp(g.pinchZoom * scaleRatio, MIN_ZOOM, MAX_ZOOM)
        const dx = midX - g.pinchMidX
        const dy = midY - g.pinchMidY
        zoomRef.current = nextZoom
        setZoom(nextZoom)
        panRef.current = clampPan(nextZoom, g.pinchPanX + dx, g.pinchPanY + dy)
        schedulePaintRef.current()
      }
      e.preventDefault()
      return
    }

    const dx = e.clientX - g.lastX
    const dy = e.clientY - g.lastY
    const traveled = Math.hypot(e.clientX - g.startX, e.clientY - g.startY)
    if (traveled > MOVE_PX) {
      g.moved = true
      clearLongTimer()
    }
    g.lastX = e.clientX
    g.lastY = e.clientY

    if (g.kind === 'touch') {
      if (g.moved) sendRel(dx, dy)
      e.preventDefault()
      return
    }

    if (g.kind === 'mouse') {
      if (e.pointerType === 'mouse') {
        sendAbs('move', e.clientX, e.clientY, e.button)
      } else if (g.moved && !g.longFired) {
        // Finger drag in Mouse mode = click-drag from the press point
        if (!g.leftDown) {
          g.leftDown = true
          sendAbs('down', g.startX, g.startY, 0)
        }
        sendAbs('move', e.clientX, e.clientY, 0)
      }
      e.preventDefault()
    }
  }

  function onPointerUp(e: PointerEvent) {
    if (!wanted) return
    pointersRef.current.delete(e.pointerId)
    const g = gestureRef.current
    const remaining = pointersRef.current.size

    if (g.kind === 'pinch') {
      if (remaining >= 2) {
        beginPinch()
      } else if (remaining === 1) {
        // Drop back to single-finger without a click
        g.kind = 'none'
        clearLongTimer()
        bumpZoomRef.current(zoomRef.current)
      } else {
        g.kind = 'none'
        clearLongTimer()
        bumpZoomRef.current(zoomRef.current)
      }
      e.preventDefault()
      return
    }

    if (remaining > 0) {
      e.preventDefault()
      return
    }

    clearLongTimer()
    const elapsed = performance.now() - g.startT

    if (g.longFired) {
      g.kind = 'none'
      e.preventDefault()
      return
    }

    if (controlRef.current === 'touch') {
      if (!g.moved && elapsed <= TAP_MS) sendClick(0)
      else if (!g.moved && elapsed > TAP_MS && elapsed < LONG_MS) sendClick(0)
    } else if (e.pointerType === 'mouse') {
      sendAbs('up', e.clientX, e.clientY, e.button)
    } else {
      // Absolute finger tap / drag release
      if (!g.moved) {
        sendAbs('down', e.clientX, e.clientY, 0)
        sendAbs('up', e.clientX, e.clientY, 0)
      } else if (g.leftDown) {
        sendAbs('up', e.clientX, e.clientY, 0)
      }
    }

    g.leftDown = false
    g.kind = 'none'
    e.preventDefault()
  }

  function onWheel(e: WheelEvent) {
    if (!wanted) return
    if (e.ctrlKey || e.metaKey) {
      const factor = e.deltaY > 0 ? 0.9 : 1.1
      applyZoom(zoomRef.current * factor, e.clientX, e.clientY)
      e.preventDefault()
      return
    }
    if (controlRef.current === 'touch') {
      // Wheel at the overlay cursor (abs) so native drift can't steal the target.
      sendAbsNorm('wheel', cursorNormRef.current.x, cursorNormRef.current.y, 0, e.deltaY)
    } else {
      sendAbs('wheel', e.clientX, e.clientY, 0, e.deltaY)
    }
    e.preventDefault()
  }

  function onKey(e: KeyboardEvent, action: 'down' | 'up') {
    if (!wanted || !focused) return
    if (e.key === 'Escape' && maximized && action === 'down') {
      setMaximized(false)
      e.preventDefault()
      return
    }
    e.preventDefault()
    sendWs({ type: 'key', action, key: e.key, code: e.code })
  }

  const live = wanted && conn === 'live'
  const link =
    conn === 'live' ? 'text-ok' : conn === 'reconnecting' || conn === 'connecting' ? 'text-amber' : 'text-danger'

  /** Display / mode / quality. In maximize, Stop + Exit live here too (toolbar hits are unreliable). */
  const controls = (
    <>
      {monitors.filter((m) => m.index > 0).length >= 2 && (
        <label className="hb-view-menu-field">
          <span>Display</span>
          <select
            className="hb-select hb-select-sm w-full"
            aria-label="Display"
            value={monitor}
            onChange={(e) => setMonitor(Number(e.target.value))}
          >
            {monitors.map((m) => (
              <option key={m.index} value={m.index}>
                {m.index === 0 ? 'All' : `D${m.index}`} · {m.width}×{m.height}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="hb-view-menu-field">
        <span>Control</span>
        <div className="hb-view-mode hb-view-mode--stretch" role="group" aria-label="Control mode">
          <button
            type="button"
            className={`hb-view-mode-btn ${control === 'touch' ? 'on' : ''}`}
            aria-pressed={control === 'touch'}
            title="Trackpad: drag moves the PC cursor · tap = click · hold = right-click"
            onClick={() => setControl('touch')}
          >
            Touch
          </button>
          <button
            type="button"
            className={`hb-view-mode-btn ${control === 'mouse' ? 'on' : ''}`}
            aria-pressed={control === 'mouse'}
            title="Point: tap where you want the cursor · hold = right-click"
            onClick={() => setControl('mouse')}
          >
            Point
          </button>
        </div>
      </div>
      <div className="hb-view-menu-field">
        <span>Quality</span>
        <div className="hb-view-mode hb-view-mode--stretch hb-view-mode--wrap" role="group" aria-label="Stream quality">
          {QUALITY_OPTIONS.map((q) => (
            <button
              key={q.id}
              type="button"
              className={`hb-view-mode-btn ${preset === q.id ? 'on' : ''}`}
              aria-pressed={preset === q.id}
              title={q.title}
              onClick={() => {
                setPreset(q.id)
                setMenuOpen(false)
              }}
            >
              {q.label}
            </button>
          ))}
        </div>
      </div>
      {maximized && wanted && (
        <div className="hb-view-menu-field">
          <span>Session</span>
          <div className="hb-view-menu-actions">
            <button
              type="button"
              className="hb-btn hb-btn-ghost hb-btn-sm"
              onClick={() => {
                disconnect()
                setMenuOpen(false)
              }}
            >
              Stop
            </button>
            <button
              type="button"
              className="hb-btn hb-btn-primary hb-btn-sm"
              onClick={() => {
                setMaximized(false)
                setMenuOpen(false)
              }}
            >
              Exit max
            </button>
          </div>
        </div>
      )}
    </>
  )

  return (
    <div
      className={`h-full min-h-0 flex flex-col ${maximized ? 'hb-view-root-max' : 'hb-with-nav'}`}
      style={{ minHeight: '100%' }}
    >
      {/* Compact chrome: actions stay tappable; quality/display/mode live in Menu sheet */}
      <div className={`shrink-0 ${maximized ? 'hb-view-maxbar' : 'hb-chrome'}`}>
        <div className={maximized ? undefined : 'hb-chrome-inner'}>
          <div className="hb-view-toolbar">
            {maximized ? (
              <button
                type="button"
                className="hb-view-max-tab"
                aria-expanded={menuOpen}
                onClick={() => setMenuOpen((o) => !o)}
              >
                <span className={`hb-view-max-dot ${live ? 'ok' : 'warn'}`} />
                Menu
              </button>
            ) : (
              <div className="hb-view-toolbar-meta min-w-0">
                <p className="text-xs font-semibold tracking-tight">View</p>
                <p className="text-[0.65rem] text-mute truncate">
                  {wanted ? (
                    <>
                      <span className={link}>{connStateLabel(conn)}</span>
                      {stats.screen ? ` · ${stats.screen}` : ''}
                      {stats.fps > 0 ? ` · ${Math.round(stats.fps)}fps` : ''}
                      {` · ${QUALITY_OPTIONS.find((q) => q.id === preset)?.label || 'Auto'}`}
                      {zoom > 1.05 ? ` · ${zoom.toFixed(1)}×` : ''}
                    </>
                  ) : (
                    <>Off{probe ? ` · ${probe}` : ''}</>
                  )}
                </p>
              </div>
            )}
            {/* Maximize: only Menu tab — Stop/Exit live inside the dropdown (stage steals hits). */}
            {!maximized && (
              <div className="hb-view-toolbar-actions">
                <button
                  type="button"
                  className="hb-btn hb-btn-ghost hb-btn-sm"
                  aria-expanded={menuOpen}
                  onClick={() => setMenuOpen((o) => !o)}
                >
                  Menu
                </button>
                {wanted ? (
                  <>
                    <button
                      type="button"
                      className="hb-btn hb-btn-ghost hb-btn-sm"
                      disabled={!live}
                      onClick={() => setMaximized(true)}
                    >
                      Max
                    </button>
                    <button
                      type="button"
                      className="hb-btn hb-btn-ghost hb-btn-sm"
                      onClick={disconnect}
                    >
                      Stop
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="hb-btn hb-btn-primary hb-btn-sm"
                    onClick={() => setWanted(true)}
                  >
                    Start
                  </button>
                )}
              </div>
            )}
          </div>
          {!maximized && error && (
            <p className="text-[0.65rem] text-danger mt-1">{error}</p>
          )}
          {menuOpen && (
            <div className={maximized ? 'hb-view-max-menu' : 'hb-view-menu'}>
              <p className="text-[0.65rem] text-mute truncate">
                <span className={link}>{connStateLabel(conn)}</span>
                {stats.screen ? ` · ${stats.screen}` : ''}
                {` · ${QUALITY_OPTIONS.find((q) => q.id === preset)?.label || 'Auto'}`}
                {zoom > 1.05 ? ` · ${zoom.toFixed(1)}×` : ''}
              </p>
              {error && <p className="text-[0.65rem] text-danger">{error}</p>}
              <div className="hb-view-menu-controls">{controls}</div>
            </div>
          )}
        </div>
      </div>

      <div
        ref={wrapRef}
        className={`hb-view-stage flex-1 min-h-0 relative outline-none ${control === 'touch' ? 'touch' : 'mouse'}`}
        data-hb-no-ptr="1"
        tabIndex={0}
        role="application"
        aria-label="Remote laptop screen"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={onWheel}
        onKeyDown={(e) => onKey(e, 'down')}
        onKeyUp={(e) => onKey(e, 'up')}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onContextMenu={(e) => e.preventDefault()}
      >
        {!wanted && (
          <div className="hb-view-idle">
            <p className="text-xs text-mute">Stream this laptop’s screen</p>
            <p className="text-[0.65rem] text-mute mt-1 max-w-[16rem]">
              Touch = trackpad · Point = tap to aim · Pinch to zoom
            </p>
            <button
              type="button"
              className="hb-btn hb-btn-primary hb-btn-sm mt-2"
              onClick={() => setWanted(true)}
            >
              Start
            </button>
          </div>
        )}
        <canvas ref={canvasRef} className="hb-view-canvas" />
        {wanted && cursorOn && (
          <div ref={cursorElRef} className="hb-view-cursor" aria-hidden>
            <span className="hb-view-cursor-ring" />
            <span className="hb-view-cursor-dot" />
          </div>
        )}
        {wanted && holdPulse && <div className="hb-view-hold" aria-hidden />}
        {wanted && live && (
          <div className="hb-view-fab" onPointerDown={(e) => e.stopPropagation()}>
            <button
              type="button"
              className="hb-view-fab-btn"
              aria-label="Zoom out"
              onClick={() => applyZoom(zoomRef.current / 1.25)}
            >
              −
            </button>
            <button
              type="button"
              className="hb-view-fab-btn"
              aria-label="Fit screen"
              onClick={() => {
                zoomRef.current = 1
                panRef.current = { x: 0, y: 0 }
                setZoom(1)
                schedulePaintRef.current()
                bumpZoomRef.current(1)
              }}
            >
              Fit
            </button>
            <button
              type="button"
              className="hb-view-fab-btn"
              aria-label="Zoom in"
              onClick={() => applyZoom(zoomRef.current * 1.25)}
            >
              +
            </button>
          </div>
        )}
        {wanted && hint && live && (
          <div className="hb-view-hint" onPointerDown={(e) => e.stopPropagation()}>
            <p>
              {control === 'touch' ? (
                <>
                  <strong>Touch</strong> — drag moves the PC cursor · tap = left click · hold = right
                  click · pinch zooms · two-finger drag pans
                </>
              ) : (
                <>
                  <strong>Point</strong> — tap where you want the cursor · hold = right click · pinch
                  zooms
                </>
              )}
            </p>
            <button type="button" className="hb-btn hb-btn-ghost hb-btn-sm" onClick={dismissHint}>
              Got it
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
