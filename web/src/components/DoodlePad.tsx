'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

export type DoodleStroke = {
  id: string
  color: string
  width: number
  points: { x: number; y: number }[]
}

const COLORS = ['#222222', '#e74c3c', '#3498db', '#2ecc71', '#f1c40f', '#9b59b6', '#ffffff']

function uid(): string {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function drawStrokes(
  ctx: CanvasRenderingContext2D,
  strokes: DoodleStroke[],
  w: number,
  h: number,
) {
  ctx.clearRect(0, 0, w, h)
  ctx.fillStyle = '#f7f4ee'
  ctx.fillRect(0, 0, w, h)
  for (const s of strokes) {
    if (!s.points.length) continue
    ctx.strokeStyle = s.color
    ctx.lineWidth = s.width
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.beginPath()
    s.points.forEach((p, i) => {
      const x = p.x * w
      const y = p.y * h
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    })
    ctx.stroke()
  }
}

/**
 * Kid-friendly doodle canvas. Coordinates normalized 0..1 for server sync.
 */
export function DoodlePad({
  strokes,
  onChange,
  className = '',
}: {
  strokes: DoodleStroke[]
  onChange: (strokes: DoodleStroke[]) => void
  className?: string
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const [color, setColor] = useState(COLORS[0]!)
  const [width, setWidth] = useState(6)
  const drawing = useRef<DoodleStroke | null>(null)
  const strokesRef = useRef(strokes)
  strokesRef.current = strokes

  const resize = useCallback(() => {
    const canvas = canvasRef.current
    const wrap = wrapRef.current
    if (!canvas || !wrap) return
    const rect = wrap.getBoundingClientRect()
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    const w = Math.max(1, Math.floor(rect.width))
    const h = Math.max(1, Math.floor(rect.height))
    canvas.width = Math.floor(w * dpr)
    canvas.height = Math.floor(h * dpr)
    canvas.style.width = `${w}px`
    canvas.style.height = `${h}px`
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    drawStrokes(ctx, strokesRef.current, w, h)
  }, [])

  useEffect(() => {
    resize()
    const ro = new ResizeObserver(() => resize())
    if (wrapRef.current) ro.observe(wrapRef.current)
    window.addEventListener('resize', resize)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', resize)
    }
  }, [resize])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const rect = canvas.getBoundingClientRect()
    drawStrokes(ctx, strokes, rect.width, rect.height)
  }, [strokes])

  function posFromEvent(e: React.PointerEvent): { x: number; y: number } | null {
    const canvas = canvasRef.current
    if (!canvas) return null
    const rect = canvas.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return null
    return {
      x: Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height)),
    }
  }

  function onPointerDown(e: React.PointerEvent) {
    const p = posFromEvent(e)
    if (!p) return
    ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
    drawing.current = { id: uid(), color, width, points: [p] }
  }

  function onPointerMove(e: React.PointerEvent) {
    if (!drawing.current) return
    const p = posFromEvent(e)
    if (!p) return
    drawing.current.points.push(p)
    const live = [...strokesRef.current, drawing.current]
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const rect = canvas.getBoundingClientRect()
    drawStrokes(ctx, live, rect.width, rect.height)
  }

  function endStroke() {
    if (!drawing.current) return
    const done = drawing.current
    drawing.current = null
    if (done.points.length < 1) return
    onChange([...strokesRef.current, done])
  }

  function undo() {
    if (!strokes.length) return
    onChange(strokes.slice(0, -1))
  }

  /** Export PNG data URL for chat attach. */
  function exportPng(): string | null {
    const canvas = canvasRef.current
    if (!canvas) return null
    try {
      return canvas.toDataURL('image/png')
    } catch {
      return null
    }
  }

  // Expose export via dataset for parent (optional)
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    ;(el as HTMLElement & { __exportPng?: () => string | null }).__exportPng = exportPng
  })

  return (
    <div className={`hb-doodle-pad ${className}`} ref={wrapRef} data-hb-no-ptr="1">
      <div className="hb-doodle-palette" role="toolbar" aria-label="Colors">
        {COLORS.map((c) => (
          <button
            key={c}
            type="button"
            className="hb-doodle-swatch"
            data-on={color === c ? '1' : '0'}
            style={{ background: c, borderColor: c === '#ffffff' ? '#ccc' : c }}
            aria-label={`Color ${c}`}
            onClick={() => setColor(c)}
          />
        ))}
        <button
          type="button"
          className="hb-btn hb-btn-ghost hb-btn-sm"
          onClick={undo}
          disabled={!strokes.length}
        >
          Undo
        </button>
        <label className="hb-doodle-width">
          <span className="sr-only">Brush</span>
          <input
            type="range"
            min={2}
            max={24}
            value={width}
            onChange={(e) => setWidth(Number(e.target.value))}
          />
        </label>
      </div>
      <canvas
        ref={canvasRef}
        className="hb-doodle-canvas"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endStroke}
        onPointerCancel={endStroke}
      />
    </div>
  )
}

export function exportDoodlePadPng(wrap: HTMLElement | null): string | null {
  if (!wrap) return null
  const fn = (wrap as HTMLElement & { __exportPng?: () => string | null }).__exportPng
  return fn ? fn() : null
}
