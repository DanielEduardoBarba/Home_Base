'use client'

import { useId } from 'react'

export type DoodleMouth = 'happy' | 'curious' | 'blank' | 'sad' | 'frozen'

export type DoodleExpressView = {
  mouth?: DoodleMouth
  color?: string
  energy?: number
  bubble?: string
  name?: string
}

const INK = '#3b2a4a'

function shade(hex: string, amt: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return hex
  const n = parseInt(m[1], 16)
  const ch = (v: number) => Math.max(0, Math.min(255, Math.round(v + amt * 255)))
  const r = ch((n >> 16) & 255)
  const g = ch((n >> 8) & 255)
  const b = ch(n & 255)
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`
}

function Eye({ cx, mouth }: { cx: number; mouth: DoodleMouth }) {
  const cy = mouth === 'sad' ? 47 : 45
  if (mouth === 'happy') {
    return (
      <g>
        <ellipse cx={cx} cy={cy} rx={6.4} ry={7.2} fill="#fff" />
        <ellipse cx={cx} cy={cy + 0.8} rx={4.6} ry={5.4} fill={INK} />
        <circle cx={cx - 1.6} cy={cy - 1.6} r={1.9} fill="#fff" />
        <circle cx={cx + 1.8} cy={cy + 2.4} r={0.9} fill="#fff" />
      </g>
    )
  }
  if (mouth === 'blank') {
    // Sleepy content arcs
    return (
      <path
        d={`M${cx - 5} ${cy} Q${cx} ${cy + 4} ${cx + 5} ${cy}`}
        fill="none"
        stroke={INK}
        strokeWidth="2.6"
        strokeLinecap="round"
      />
    )
  }
  const look = mouth === 'curious' ? 1.4 : 0
  const ry = mouth === 'frozen' ? 7.8 : 7
  return (
    <g>
      <ellipse cx={cx} cy={cy} rx={6.4} ry={ry} fill="#fff" />
      <ellipse cx={cx + look} cy={cy + 1} rx={mouth === 'frozen' ? 3.2 : 4.4} ry={mouth === 'frozen' ? 3.6 : 5} fill={INK} />
      <circle cx={cx - 1.4 + look} cy={cy - 1.2} r={1.7} fill="#fff" />
      {mouth === 'sad' ? (
        <path
          d={
            cx < 50
              ? `M${cx - 6} ${cy - 8} L${cx + 5} ${cy - 11}`
              : `M${cx - 5} ${cy - 11} L${cx + 6} ${cy - 8}`
          }
          stroke={INK}
          strokeWidth="1.8"
          strokeLinecap="round"
          opacity={0.6}
        />
      ) : null}
    </g>
  )
}

/** Mouth glyphs: D happy · . curious · - blank · C sad · none frozen */
function Mouth({ mouth }: { mouth: DoodleMouth }) {
  switch (mouth) {
    case 'happy':
      return (
        <g>
          <path d="M42 57 Q50 69 58 57 Z" fill={INK} />
          <path d="M45.5 62.5 Q50 66.5 54.5 62.5 Q50 60.5 45.5 62.5 Z" fill="#ff8fa3" />
        </g>
      )
    case 'curious':
      return <ellipse cx="51" cy="61" rx="2.8" ry="3.2" fill={INK} />
    case 'blank':
      return (
        <path d="M45 61 Q50 63 55 61" fill="none" stroke={INK} strokeWidth="2.4" strokeLinecap="round" />
      )
    case 'sad':
      return (
        <path d="M44 64 Q50 58 56 64" fill="none" stroke={INK} strokeWidth="2.6" strokeLinecap="round" />
      )
    case 'frozen':
    default:
      return null
  }
}

/**
 * Doodle mascot: squishy gumdrop buddy with sparkly eyes, blush, and a sprout.
 */
export function DoodleBlob({
  express,
  size = 120,
}: {
  express?: DoodleExpressView | null
  size?: number
}) {
  const uid = useId().replace(/:/g, '')
  const mouth = express?.mouth || 'happy'
  const color = express?.color || '#ffb703'
  const energy = Math.max(0, Math.min(1, express?.energy ?? 0.6))
  const bubble = (express?.bubble || '').trim()
  const name = express?.name || 'Doodle'
  const bounce =
    mouth === 'happy'
      ? 'hb-doodle-bob-happy'
      : mouth === 'curious'
        ? 'hb-doodle-bob-think'
        : mouth === 'sad'
          ? 'hb-doodle-bob-sad'
          : mouth === 'frozen'
            ? 'hb-doodle-bob-frozen'
            : 'hb-doodle-bob-calm'
  const light = shade(color, 0.22)
  const dark = shade(color, -0.16)

  return (
    <div className="hb-doodle-mascot relative flex flex-col items-center">
      {bubble ? (
        <div className="hb-doodle-bubble" role="status">
          {bubble}
        </div>
      ) : null}
      <div
        className={`hb-doodle-buddy relative ${bounce}`}
        style={{
          width: size,
          height: size,
          ['--hb-doodle-energy' as string]: String(0.6 + energy * 0.8),
        }}
        aria-label={`${name} feels ${mouth}`}
        role="img"
      >
        <svg viewBox="0 0 100 100" width={size} height={size} aria-hidden>
          <defs>
            <radialGradient id={`b${uid}`} cx="38%" cy="30%" r="75%">
              <stop offset="0%" stopColor={light} />
              <stop offset="70%" stopColor={color} />
              <stop offset="100%" stopColor={dark} />
            </radialGradient>
          </defs>
          <ellipse cx="50" cy="93" rx="26" ry="4" fill="rgba(60,40,90,.16)" />
          {/* Sprout */}
          <g className="hb-doodle-sprout">
            <path d="M50 22 Q49 15 51 10" stroke="#3aa655" strokeWidth="2.6" fill="none" strokeLinecap="round" />
            <path d="M51 12 Q58 5 64 9 Q58 15 51 12 Z" fill="#6bd27e" />
            <path d="M50 14 Q43 8 38 12 Q44 17 50 14 Z" fill="#8fe39c" />
          </g>
          {/* Feet */}
          <ellipse cx="38" cy="88" rx="8" ry="4.5" fill={dark} />
          <ellipse cx="62" cy="88" rx="8" ry="4.5" fill={dark} />
          {/* Body */}
          <path
            d="M50 20 C74 20 86 40 86 60 C86 78 70 88 50 88 C30 88 14 78 14 60 C14 40 26 20 50 20 Z"
            fill={`url(#b${uid})`}
          />
          {/* Little arms */}
          <ellipse className="hb-doodle-arm-l" cx="15" cy="62" rx="5" ry="7.5" fill={dark} transform="rotate(20 15 62)" />
          <ellipse className="hb-doodle-arm-r" cx="85" cy="62" rx="5" ry="7.5" fill={dark} transform="rotate(-20 85 62)" />
          {/* Shine */}
          <ellipse cx="34" cy="33" rx="9" ry="5" fill="#fff" opacity=".45" transform="rotate(-25 34 33)" />
          <circle cx="45" cy="28" r="2" fill="#fff" opacity=".55" />
          {/* Face */}
          <g className={mouth === 'blank' || mouth === 'frozen' ? undefined : 'hb-doodle-eyes'}>
            <Eye cx={38} mouth={mouth} />
            <Eye cx={62} mouth={mouth} />
          </g>
          <ellipse cx="29" cy="57" rx="5.5" ry="3.4" fill="#ff7aa2" opacity=".55" />
          <ellipse cx="71" cy="57" rx="5.5" ry="3.4" fill="#ff7aa2" opacity=".55" />
          <Mouth mouth={mouth} />
          {mouth === 'frozen' ? (
            <g fill={INK} opacity=".7">
              <circle cx="74" cy="30" r="1.6" />
              <path d="M70 22 q4-5 8 0 q0 3-4 4" fill="none" stroke={INK} strokeWidth="1.8" strokeLinecap="round" />
            </g>
          ) : null}
        </svg>
      </div>
      <p className="hb-doodle-name">{name}</p>
    </div>
  )
}
