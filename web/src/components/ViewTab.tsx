import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type WheelEvent } from 'react'
import { api, wsUrl } from '../lib/api'
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
const LS_HINT = 'hb-view-hint-v2'
const DEFAULT_AUTO_WIDTH = 1280

type QualityPreset = 'auto' | 'lan' | 'vpn'
type ControlMode = 'touch' | 'mouse'

type MonitorInfo = {
  index: number
  label: string
  left: number
  top: number
  width: number
  height: number
}

const PRESETS: Record<Exclude<QualityPreset, 'auto'>, { maxWidth: number; quality: number; fps: number }> = {
  lan: { maxWidth: 1600, quality: 62, fps: 16 },
  vpn: { maxWidth: 1024, quality: 42, fps: 8 },
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
    if (v === 'mouse' || v === 'touch') return v
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
  const controlRef = useRef<ControlMode>(loadControl())
  const monitorRef = useRef(loadMonitor())
  const zoomRef = useRef(1)
  const panRef = useRef({ x: 0, y: 0 })
  const screenRef = useRef({ w: 0, h: 0 })
  const monitorsRef = useRef<MonitorInfo[]>([])
  const cursorNormRef = useRef({ x: 0.5, y: 0.5 })
  const cursorShowRef = useRef(false)
  const schedulePaintRef = useRef<() => void>(() => {})
  const bumpZoomRef = useRef<(z: number) => void>(() => {})

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
  const [preset, setPreset] = useState<QualityPreset>('auto')
  const [control, setControl] = useState<ControlMode>(loadControl())
  const [monitor, setMonitor] = useState(loadMonitor())
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
  const [cursorOn, setCursorOn] = useState(false)
  const fpsCount = useRef(0)
  const fpsT0 = useRef(performance.now())
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
    if (!maximized) setMenuOpen(false)
    return () => document.documentElement.classList.remove('hb-view-max')
  }, [maximized])

  useEffect(() => {
    try {
      localStorage.setItem(LS_CONTROL, control)
    } catch {
      /* ignore */
    }
  }, [control])

  useEffect(() => {
    try {
      localStorage.setItem(LS_MONITOR, String(monitor))
    } catch {
      /* ignore */
    }
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

  function placeCursorEl() {
    const el = cursorElRef.current
    const r = paintRectRef.current
    if (!el) return
    if (!cursorShowRef.current || r.w < 1) {
      el.style.display = 'none'
      return
    }
    const n = cursorNormRef.current
    el.style.display = 'block'
    el.style.left = `${r.x + n.x * r.w}px`
    el.style.top = `${r.y + n.y * r.h}px`
  }

  function setCursorNorm(x: number, y: number, show = true) {
    cursorNormRef.current = { x: clamp(x, 0, 1), y: clamp(y, 0, 1) }
    cursorShowRef.current = show
    if (show && !cursorOn) setCursorOn(true)
    if (!show && cursorOn) setCursorOn(false)
    placeCursorEl()
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
      const base = Math.min(cw / bmp.width, ch / bmp.height)
      const z = zoomRef.current
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
        },
        onOpen: (ws) => {
          if (disposed) return
          ws.binaryType = 'arraybuffer'
          setError('')
          const p = presetRef.current
          const cfg: Record<string, unknown> = { type: 'config', monitor: monitorRef.current }
          if (p !== 'auto') Object.assign(cfg, PRESETS[p])
          ws.send(JSON.stringify(cfg))
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
                if (msg.screenW && msg.screenH) {
                  screenRef.current = { w: Number(msg.screenW), h: Number(msg.screenH) }
                }
                if (msg.type === 'hello') {
                  setStats((s) => ({
                    ...s,
                    screen: `${msg.screenW}×${msg.screenH}`,
                    quality: Number(msg.quality) || s.quality,
                  }))
                  const cx = Number(msg.cursorX)
                  const cy = Number(msg.cursorY)
                  if (Number.isFinite(cx) && Number.isFinite(cy) && cx >= 0 && cy >= 0) {
                    const mon =
                      monitorsRef.current.find((m) => m.index === monitorRef.current) ||
                      monitorsRef.current[0]
                    if (mon && mon.width > 0 && mon.height > 0) {
                      cursorNormRef.current = {
                        x: clamp((cx - mon.left) / mon.width, 0, 1),
                        y: clamp((cy - mon.top) / mon.height, 0, 1),
                      }
                    }
                  }
                  cursorShowRef.current = true
                  setCursorOn(true)
                  placeCursorEl()
                } else {
                  setStats((s) => ({ ...s, quality: Number(msg.quality) || s.quality }))
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
          if (!header) return
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
            .catch(() => ack())
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

  function normFromClient(clientX: number, clientY: number) {
    const wrap = wrapRef.current
    const rect = paintRectRef.current
    if (!wrap || rect.w < 1 || rect.h < 1) return null
    const bounds = wrap.getBoundingClientRect()
    const lx = clientX - bounds.left
    const ly = clientY - bounds.top
    if (lx < rect.x || ly < rect.y || lx > rect.x + rect.w || ly > rect.y + rect.h) return null
    return { x: (lx - rect.x) / rect.w, y: (ly - rect.y) / rect.h }
  }

  function sendWs(obj: Record<string, unknown>) {
    const ws = connRef.current?.getSocket()
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify(obj))
  }

  function sendAbs(action: string, clientX: number, clientY: number, button = 0, deltaY = 0) {
    if (!wanted) return
    const n = normFromClient(clientX, clientY)
    if (!n) return
    const now = performance.now()
    if (action === 'move' && now - lastPointerRef.current < 16) return
    lastPointerRef.current = now
    sendWs({ type: 'pointer', mode: 'abs', action, x: n.x, y: n.y, button, deltaY })
    setCursorNorm(n.x, n.y, true)
  }

  function sendRel(dxPx: number, dyPx: number) {
    if (!wanted) return
    const rect = paintRectRef.current
    const sw = screenRef.current.w || 1
    const sh = screenRef.current.h || 1
    if (rect.w < 1 || rect.h < 1) return
    const now = performance.now()
    if (now - lastPointerRef.current < 12) return
    lastPointerRef.current = now
    // 1:1 with on-screen remote pixels (zoom makes fine control natural)
    const dx = (dxPx * sw) / rect.w
    const dy = (dyPx * sh) / rect.h
    if (Math.abs(dx) < 0.2 && Math.abs(dy) < 0.2) return
    sendWs({ type: 'pointer', mode: 'rel', action: 'move', dx, dy })
    setCursorNorm(cursorNormRef.current.x + dx / sw, cursorNormRef.current.y + dy / sh, true)
  }

  function sendClick(button: number) {
    sendWs({ type: 'pointer', mode: 'rel', action: 'click', button })
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
        sendWs({ type: 'pointer', mode: controlRef.current === 'touch' ? 'rel' : 'abs', action: 'up', button: 0 })
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
      sendWs({
        type: 'pointer',
        mode: controlRef.current === 'touch' ? 'rel' : 'abs',
        action: 'up',
        button: 0,
      })
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
            sendWs({
              type: 'pointer',
              mode: 'rel',
              action: 'wheel',
              deltaY: dy * 1.6,
            })
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
      // Two-axis trackpad scroll → remote wheel at current cursor
      sendWs({
        type: 'pointer',
        mode: 'rel',
        action: 'wheel',
        deltaY: e.deltaY,
      })
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

  const controls = (
    <>
      {monitors.filter((m) => m.index > 0).length >= 2 && (
        <select
          className="hb-select hb-select-sm"
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
      )}
      <div className="hb-view-mode" role="group" aria-label="Control mode">
        <button
          type="button"
          className={`hb-view-mode-btn ${control === 'touch' ? 'on' : ''}`}
          aria-pressed={control === 'touch'}
          onClick={() => setControl('touch')}
        >
          Touch
        </button>
        <button
          type="button"
          className={`hb-view-mode-btn ${control === 'mouse' ? 'on' : ''}`}
          aria-pressed={control === 'mouse'}
          onClick={() => setControl('mouse')}
        >
          Mouse
        </button>
      </div>
      <select
        className="hb-select hb-select-sm"
        aria-label="Quality"
        value={preset}
        onChange={(e) => setPreset(e.target.value as QualityPreset)}
      >
        <option value="auto">Auto</option>
        <option value="lan">LAN</option>
        <option value="vpn">VPN</option>
      </select>
      {wanted ? (
        <>
          {!maximized && (
            <button
              type="button"
              className="hb-btn hb-btn-ghost hb-btn-sm"
              disabled={!live}
              onClick={() => setMaximized(true)}
            >
              Max
            </button>
          )}
          <button type="button" className="hb-btn hb-btn-ghost hb-btn-sm" onClick={disconnect}>
            Stop
          </button>
        </>
      ) : (
        <button type="button" className="hb-btn hb-btn-primary hb-btn-sm" onClick={() => setWanted(true)}>
          Start
        </button>
      )}
    </>
  )

  return (
    <div className={`h-full flex flex-col min-h-0 ${maximized ? '' : 'hb-with-nav'}`}>
      {!maximized && (
        <div className="hb-chrome shrink-0">
          <div className="hb-chrome-inner">
            <div className="flex items-center gap-2 justify-between">
              <div className="min-w-0">
                <p className="text-xs font-semibold tracking-tight">View</p>
                <p className="text-[0.65rem] text-mute truncate">
                  {wanted ? (
                    <>
                      <span className={link}>{connStateLabel(conn)}</span>
                      {stats.screen ? ` · ${stats.screen}` : ''}
                      {stats.fps > 0 ? ` · ${Math.round(stats.fps)}fps` : ''}
                      {zoom > 1.05 ? ` · ${zoom.toFixed(1)}×` : ''}
                    </>
                  ) : (
                    <>Off{probe ? ` · ${probe}` : ''}</>
                  )}
                </p>
              </div>
              <div className="flex items-center gap-1.5 shrink-0 flex-wrap justify-end">{controls}</div>
            </div>
            {error && <p className="text-[0.65rem] text-danger mt-1">{error}</p>}
          </div>
        </div>
      )}

      {maximized && (
        <div className="hb-view-maxbar shrink-0">
          <button
            type="button"
            className="hb-view-max-tab"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((o) => !o)}
          >
            <span className={`hb-view-max-dot ${live ? 'ok' : 'warn'}`} />
            Menu
          </button>
          {menuOpen && (
            <div className="hb-view-max-menu">
              <p className="text-[0.65rem] text-mute truncate">
                <span className={link}>{connStateLabel(conn)}</span>
                {stats.screen ? ` · ${stats.screen}` : ''}
                {zoom > 1.05 ? ` · ${zoom.toFixed(1)}×` : ''}
              </p>
              {error && <p className="text-[0.65rem] text-danger">{error}</p>}
              <div className="flex flex-wrap items-center gap-1.5">
                {controls}
                <button
                  type="button"
                  className="hb-btn hb-btn-ghost hb-btn-sm"
                  onClick={() => {
                    setMaximized(false)
                    setMenuOpen(false)
                  }}
                >
                  Exit
                </button>
              </div>
            </div>
          )}
        </div>
      )}

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
              Touch = trackpad · Mouse = point-to-click · Pinch to zoom
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
                  <strong>Mouse</strong> — tap where you want the cursor · hold = right click · pinch
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
