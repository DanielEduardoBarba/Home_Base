'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChatImage } from '../lib/chatTypes'

export type DoodleStroke = {
  id: string
  color: string
  width: number
  points: { x: number; y: number }[]
}

const PAPER = '#fffdf7'

const COLORS: { c: string; name: string }[] = [
  { c: '#2b2140', name: 'Black' },
  { c: '#ff4d6d', name: 'Red' },
  { c: '#ff9f1c', name: 'Orange' },
  { c: '#ffd60a', name: 'Yellow' },
  { c: '#38c172', name: 'Green' },
  { c: '#3a86ff', name: 'Blue' },
  { c: '#8e5cf7', name: 'Purple' },
  { c: '#ff70c4', name: 'Pink' },
  { c: '#9c6644', name: 'Brown' },
]

const SIZES = [
  { w: 4, label: 'Thin' },
  { w: 10, label: 'Medium' },
  { w: 22, label: 'Fat' },
]

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
  ctx.fillStyle = PAPER
  ctx.fillRect(0, 0, w, h)
  for (const s of strokes) {
    if (!s.points.length) continue
    ctx.strokeStyle = s.color === 'eraser' ? PAPER : s.color
    ctx.fillStyle = ctx.strokeStyle
    ctx.lineWidth = s.width
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    if (s.points.length === 1) {
      const p = s.points[0]!
      ctx.beginPath()
      ctx.arc(p.x * w, p.y * h, s.width / 2, 0, Math.PI * 2)
      ctx.fill()
      continue
    }
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

type PadEl = HTMLElement & { __exportImage?: () => ChatImage | null }

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
  const areaRef = useRef<HTMLDivElement>(null)
  const [color, setColor] = useState(COLORS[0]!.c)
  const [width, setWidth] = useState(SIZES[1]!.w)
  const drawing = useRef<DoodleStroke | null>(null)
  const strokesRef = useRef(strokes)
  strokesRef.current = strokes

  const resize = useCallback(() => {
    const canvas = canvasRef.current
    const area = areaRef.current
    if (!canvas || !area) return
    const rect = area.getBoundingClientRect()
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
    if (areaRef.current) ro.observe(areaRef.current)
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

  function redrawLive() {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    const rect = canvas.getBoundingClientRect()
    const live = drawing.current ? [...strokesRef.current, drawing.current] : strokesRef.current
    drawStrokes(ctx, live, rect.width, rect.height)
  }

  function onPointerDown(e: React.PointerEvent) {
    const p = posFromEvent(e)
    if (!p) return
    ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
    drawing.current = { id: uid(), color, width: color === 'eraser' ? width * 2 : width, points: [p] }
    redrawLive()
  }

  function onPointerMove(e: React.PointerEvent) {
    if (!drawing.current) return
    const p = posFromEvent(e)
    if (!p) return
    drawing.current.points.push(p)
    redrawLive()
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

  /** Downscaled JPEG of the pad so the AI can see the drawing. */
  function exportImage(): ChatImage | null {
    const canvas = canvasRef.current
    if (!canvas || !strokesRef.current.length) return null
    try {
      const max = 768
      const scale = Math.min(1, max / Math.max(canvas.width, canvas.height))
      const out = document.createElement('canvas')
      out.width = Math.max(1, Math.round(canvas.width * scale))
      out.height = Math.max(1, Math.round(canvas.height * scale))
      const ctx = out.getContext('2d')
      if (!ctx) return null
      ctx.drawImage(canvas, 0, 0, out.width, out.height)
      const url = out.toDataURL('image/jpeg', 0.75)
      const data = url.split(',')[1] || ''
      if (!data) return null
      return { mimeType: 'image/jpeg', data, name: 'doodle.jpg', width: out.width, height: out.height }
    } catch {
      return null
    }
  }

  useEffect(() => {
    const el = wrapRef.current as PadEl | null
    if (el) el.__exportImage = exportImage
  })

  return (
    <div className={`hb-doodle-pad ${className}`} ref={wrapRef} data-hb-no-ptr="1">
      <div className="hb-doodle-palette" role="toolbar" aria-label="Crayons">
        <div className="hb-doodle-crayons">
          {COLORS.map(({ c, name }) => (
            <button
              key={c}
              type="button"
              className="hb-doodle-swatch"
              data-on={color === c ? '1' : '0'}
              style={{ background: c }}
              aria-label={name}
              aria-pressed={color === c}
              onClick={() => setColor(c)}
            />
          ))}
          <button
            type="button"
            className="hb-doodle-swatch hb-doodle-swatch--eraser"
            data-on={color === 'eraser' ? '1' : '0'}
            aria-label="Eraser"
            aria-pressed={color === 'eraser'}
            onClick={() => setColor('eraser')}
          >
            <svg viewBox="0 0 24 24" aria-hidden>
              <path d="M4 15 13 6l5 5-9 9H6z" fill="#ffb3c6" stroke="#7a4a63" strokeWidth="1.6" strokeLinejoin="round" />
              <path d="M9 20h11" stroke="#7a4a63" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        <div className="hb-doodle-tools">
          {SIZES.map((s) => (
            <button
              key={s.w}
              type="button"
              className="hb-doodle-size"
              data-on={width === s.w ? '1' : '0'}
              aria-label={`${s.label} brush`}
              aria-pressed={width === s.w}
              onClick={() => setWidth(s.w)}
            >
              <span
                style={{
                  width: Math.max(6, s.w * 0.9),
                  height: Math.max(6, s.w * 0.9),
                  background: color === 'eraser' ? '#c9b8d6' : color,
                }}
              />
            </button>
          ))}
          <button
            type="button"
            className="hb-doodle-undo"
            onClick={undo}
            disabled={!strokes.length}
            aria-label="Undo"
          >
            <svg viewBox="0 0 24 24" aria-hidden>
              <path
                d="M9 7 4 12l5 5M4.5 12H15a5 5 0 0 1 0 10h-2"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>
      </div>
      <div className="hb-doodle-canvas-area" ref={areaRef}>
        <canvas
          ref={canvasRef}
          className="hb-doodle-canvas"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endStroke}
          onPointerCancel={endStroke}
        />
      </div>
    </div>
  )
}

/** Snapshot of the pad inside `root` for attaching to a chat turn. */
export function exportDoodlePadImage(root: HTMLElement | null): ChatImage | null {
  const pad = root?.querySelector('.hb-doodle-pad') as PadEl | null
  return pad?.__exportImage ? pad.__exportImage() : null
}
