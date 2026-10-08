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

type QualityPreset = 'auto' | 'lan' | 'vpn'

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

/**
 * View — live laptop screen. Connect is explicit; leaving the tab disconnects.
 * Maximize hides chrome/nav; a top tab opens a mini menu to exit / change opts.
 */
export function ViewTab() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const connRef = useRef<WsReconnectHandle | null>(null)
  const bitmapRef = useRef<ImageBitmap | null>(null)
  const paintRectRef = useRef({ x: 0, y: 0, w: 0, h: 0 })
  const capturingRef = useRef(false)
  const lastPointerRef = useRef(0)
  const rafRef = useRef(0)
  const presetRef = useRef<QualityPreset>('auto')

  const [wanted, setWanted] = useState(false)
  const [conn, setConn] = useState<WsConnState>('offline')
  const [error, setError] = useState('')
  const [preset, setPreset] = useState<QualityPreset>('auto')
  const [stats, setStats] = useState({ fps: 0, kbps: 0, quality: 0, screen: '' })
  const [focused, setFocused] = useState(false)
  const [maximized, setMaximized] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [probe, setProbe] = useState('')
  const fpsCount = useRef(0)
  const fpsT0 = useRef(performance.now())

  presetRef.current = preset

  useEffect(() => {
    void api
      .viewStatus()
      .then((s) => {
        if (s.ok) setProbe(`${s.screenW}×${s.screenH} · ${s.display}`)
        else setProbe(s.error || 'display unavailable')
      })
      .catch((e) => setProbe(e instanceof Error ? e.message : String(e)))
  }, [])

  useEffect(() => {
    document.documentElement.classList.toggle('hb-view-max', maximized)
    if (!maximized) setMenuOpen(false)
    return () => document.documentElement.classList.remove('hb-view-max')
  }, [maximized])

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
      const scale = Math.min(cw / bmp.width, ch / bmp.height)
      const dw = bmp.width * scale
      const dh = bmp.height * scale
      const dx = (cw - dw) / 2
      const dy = (ch - dh) / 2
      paintRectRef.current = { x: dx, y: dy, w: dw, h: dh }
      ctx.imageSmoothingEnabled = true
      ctx.imageSmoothingQuality = 'medium'
      ctx.drawImage(bmp, dx, dy, dw, dh)
    }

    const schedulePaint = () => {
      if (!rafRef.current) rafRef.current = requestAnimationFrame(paint)
    }

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
          if (p !== 'auto') ws.send(JSON.stringify({ type: 'config', ...PRESETS[p] }))
        },
        onMessage: (ev) => {
          if (disposed) return
          if (typeof ev.data === 'string') {
            try {
              const msg = JSON.parse(ev.data) as Record<string, unknown>
              if (msg.type === 'hello') {
                setStats((s) => ({
                  ...s,
                  screen: `${msg.screenW}×${msg.screenH}`,
                  quality: Number(msg.quality) || s.quality,
                }))
              } else if (msg.type === 'config') {
                setStats((s) => ({ ...s, quality: Number(msg.quality) || s.quality }))
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
      stopConn()
      bitmapRef.current?.close()
      bitmapRef.current = null
      document.documentElement.classList.remove('hb-view-max')
    }
  }, [wanted])

  useEffect(() => {
    const ws = connRef.current?.getSocket()
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    if (preset === 'auto') return
    ws.send(JSON.stringify({ type: 'config', ...PRESETS[preset] }))
  }, [preset])

  function disconnect() {
    setWanted(false)
    setMaximized(false)
    setMenuOpen(false)
    setError('')
  }

  function connect() {
    setError('')
    setWanted(true)
  }

  function normFromClient(clientX: number, clientY: number): { x: number; y: number } | null {
    const wrap = wrapRef.current
    const rect = paintRectRef.current
    if (!wrap || rect.w < 1 || rect.h < 1) return null
    const bounds = wrap.getBoundingClientRect()
    const lx = clientX - bounds.left
    const ly = clientY - bounds.top
    if (lx < rect.x || ly < rect.y || lx > rect.x + rect.w || ly > rect.y + rect.h) return null
    return {
      x: (lx - rect.x) / rect.w,
      y: (ly - rect.y) / rect.h,
    }
  }

  function sendPointer(
    action: string,
    clientX: number,
    clientY: number,
    button = 0,
    deltaY = 0,
  ) {
    if (!wanted) return
    const n = normFromClient(clientX, clientY)
    if (!n) return
    const ws = connRef.current?.getSocket()
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    const now = performance.now()
    if (action === 'move' && now - lastPointerRef.current < 16) return
    lastPointerRef.current = now
    ws.send(
      JSON.stringify({
        type: 'pointer',
        action,
        x: n.x,
        y: n.y,
        button,
        deltaY,
      }),
    )
  }

  function onPointerDown(e: PointerEvent) {
    if (!wanted) return
    capturingRef.current = true
    ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
    wrapRef.current?.focus()
    setFocused(true)
    sendPointer('down', e.clientX, e.clientY, e.button)
    e.preventDefault()
  }

  function onPointerMove(e: PointerEvent) {
    if (!wanted) return
    if (!capturingRef.current && e.pointerType === 'mouse') {
      sendPointer('move', e.clientX, e.clientY, e.button)
      return
    }
    if (capturingRef.current) {
      sendPointer('move', e.clientX, e.clientY, e.button)
      e.preventDefault()
    }
  }

  function onPointerUp(e: PointerEvent) {
    if (!wanted) return
    sendPointer('up', e.clientX, e.clientY, e.button)
    capturingRef.current = false
    e.preventDefault()
  }

  function onWheel(e: WheelEvent) {
    if (!wanted) return
    sendPointer('wheel', e.clientX, e.clientY, 0, e.deltaY)
    e.preventDefault()
  }

  function onKey(e: KeyboardEvent, action: 'down' | 'up') {
    if (!wanted || !focused) return
    if (e.key === 'Escape' && maximized && action === 'down') {
      setMaximized(false)
      e.preventDefault()
      return
    }
    if (e.key === 'Tab') e.preventDefault()
    e.preventDefault()
    const ws = connRef.current?.getSocket()
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(
      JSON.stringify({
        type: 'key',
        action,
        key: e.key,
        code: e.code,
      }),
    )
  }

  const link =
    conn === 'live' ? 'text-ok' : conn === 'reconnecting' || conn === 'connecting' ? 'text-amber' : 'text-danger'
  const live = wanted && conn === 'live'

  const qualitySelect = (
    <select
      className="hb-select"
      aria-label="Stream quality"
      value={preset}
      onChange={(e) => setPreset(e.target.value as QualityPreset)}
    >
      <option value="auto">Auto</option>
      <option value="lan">LAN</option>
      <option value="vpn">VPN</option>
    </select>
  )

  return (
    <div className={`h-full flex flex-col min-h-0 ${maximized ? '' : 'hb-with-nav'}`}>
      {!maximized && (
        <div className="hb-chrome shrink-0">
          <div className="hb-chrome-inner space-y-2">
            <div className="flex flex-wrap items-center gap-2 justify-between">
              <div className="min-w-0">
                <h1 className="text-sm font-semibold tracking-tight">View</h1>
                <p className="text-xs text-mute truncate">
                  {wanted ? (
                    <>
                      <span className={link}>{connStateLabel(conn)}</span>
                      {stats.screen ? ` · ${stats.screen}` : ''}
                      {stats.fps > 0 ? ` · ${stats.fps.toFixed(0)} fps` : ''}
                      {stats.kbps > 0 ? ` · ${stats.kbps.toFixed(0)} kb/s` : ''}
                    </>
                  ) : (
                    <>Disconnected{probe ? ` · ${probe}` : ''}</>
                  )}
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0 flex-wrap justify-end">
                {qualitySelect}
                {wanted ? (
                  <>
                    <button
                      type="button"
                      className="hb-btn hb-btn-ghost text-xs"
                      onClick={() => setMaximized(true)}
                      disabled={!live}
                    >
                      Maximize
                    </button>
                    <button type="button" className="hb-btn hb-btn-ghost text-xs" onClick={disconnect}>
                      Disconnect
                    </button>
                  </>
                ) : (
                  <button type="button" className="hb-btn hb-btn-primary text-xs" onClick={connect}>
                    Connect
                  </button>
                )}
              </div>
            </div>
            {error && <p className="text-xs text-danger">{error}</p>}
            {live && !focused && (
              <p className="text-xs text-mute">Tap the screen to control · keyboard when focused</p>
            )}
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
            View
            <span className={`hb-view-max-dot ${live ? 'ok' : 'warn'}`} />
          </button>
          {menuOpen && (
            <div className="hb-view-max-menu hb-surface">
              <p className="text-xs text-mute truncate px-1">
                <span className={link}>{connStateLabel(conn)}</span>
                {stats.screen ? ` · ${stats.screen}` : ''}
                {stats.fps > 0 ? ` · ${stats.fps.toFixed(0)} fps` : ''}
              </p>
              {error && <p className="text-xs text-danger px-1">{error}</p>}
              <div className="flex flex-wrap items-center gap-2">
                {qualitySelect}
                <button
                  type="button"
                  className="hb-btn hb-btn-ghost text-xs"
                  onClick={() => {
                    setMaximized(false)
                    setMenuOpen(false)
                  }}
                >
                  Exit max
                </button>
                <button
                  type="button"
                  className="hb-btn hb-btn-ghost text-xs"
                  onClick={disconnect}
                >
                  Disconnect
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      <div
        ref={wrapRef}
        className="hb-view-stage flex-1 min-h-0 relative outline-none"
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
            <p className="text-sm text-mute">Connect to stream this laptop’s screen</p>
            <button type="button" className="hb-btn hb-btn-primary text-sm mt-3" onClick={connect}>
              Connect
            </button>
          </div>
        )}
        <canvas ref={canvasRef} className="hb-view-canvas" />
      </div>
    </div>
  )
}
