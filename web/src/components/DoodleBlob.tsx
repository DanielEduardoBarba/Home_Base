'use client'

export type DoodleMouth = 'happy' | 'curious' | 'blank' | 'sad' | 'frozen'

export type DoodleExpressView = {
  mouth?: DoodleMouth
  color?: string
  energy?: number
  bubble?: string
  name?: string
}

function eyes(mouth: DoodleMouth, energy: number) {
  const blink = mouth === 'blank' && energy < 0.3
  const think = mouth === 'curious' || mouth === 'frozen'
  const sad = mouth === 'sad'
  const happy = mouth === 'happy'

  const eyeH = blink ? 2 : mouth === 'frozen' ? 14 : think ? 10 : happy ? 11 : 12
  const eyeY = blink ? 48 : mouth === 'frozen' ? 40 : sad ? 46 : 44
  const gap = mouth === 'frozen' ? 10 : 8
  const lean = think ? -2 : 0
  const opacity = Math.max(0.75, 0.85 + energy * 0.15)

  return (
    <g opacity={opacity} transform={`translate(${lean},0)`}>
      <rect x={40 - gap - 3} y={eyeY} width={6} height={eyeH} rx={2.5} fill="#111" />
      <rect x={40 + gap - 3} y={eyeY} width={6} height={eyeH} rx={2.5} fill="#111" />
    </g>
  )
}

/** Mouth glyphs: D happy · . curious · - blank · C sad · none frozen */
function mouthPath(mouth: DoodleMouth) {
  switch (mouth) {
    case 'happy':
      // Capital D on its side ≈ smile bowl
      return (
        <path
          d="M32 58 Q40 70 48 58"
          fill="none"
          stroke="#111"
          strokeWidth="2.6"
          strokeLinecap="round"
        />
      )
    case 'curious':
      return <circle cx="40" cy="62" r="2.2" fill="#111" />
    case 'blank':
      return (
        <path
          d="M34 62 H46"
          fill="none"
          stroke="#111"
          strokeWidth="2.4"
          strokeLinecap="round"
        />
      )
    case 'sad':
      // C-shaped frown
      return (
        <path
          d="M48 64 Q40 54 32 64"
          fill="none"
          stroke="#111"
          strokeWidth="2.6"
          strokeLinecap="round"
        />
      )
    case 'frozen':
    default:
      return null
  }
}

/**
 * Grok-style circle blob with kid mouth expressions for the Doodle mascot.
 */
export function DoodleBlob({
  express,
  size = 120,
}: {
  express?: DoodleExpressView | null
  size?: number
}) {
  const mouth = express?.mouth || 'happy'
  const color = express?.color || '#4ecdc4'
  const energy = Math.max(0, Math.min(1, express?.energy ?? 0.55))
  const bubble = (express?.bubble || '').trim()
  const name = express?.name || 'Doodle'
  const scale = 0.92 + energy * 0.12
  const bounce =
    mouth === 'happy'
      ? 'hb-doodle-bob-happy'
      : mouth === 'curious'
        ? 'hb-doodle-bob-think'
        : mouth === 'sad'
          ? 'hb-doodle-bob-sad'
          : mouth === 'frozen'
            ? 'hb-doodle-bob-frozen'
            : ''

  return (
    <div className="hb-doodle-mascot relative flex flex-col items-center">
      {bubble ? (
        <div className="hb-doodle-bubble" role="status">
          {bubble}
        </div>
      ) : null}
      <div
        className={`relative flex items-center justify-center ${bounce}`}
        style={{
          width: size,
          height: size,
          transform: `scale(${scale})`,
          transition: 'transform 280ms cubic-bezier(.2,.8,.2,1)',
          filter: 'drop-shadow(0 6px 16px rgba(0,0,0,.22))',
        }}
        aria-label={name}
      >
        <svg viewBox="0 0 80 80" width={size} height={size} aria-hidden>
          <circle cx="40" cy="40" r="28" fill={color} />
          {eyes(mouth, energy)}
          {mouthPath(mouth)}
        </svg>
      </div>
      <p className="hb-doodle-name">{name}</p>
    </div>
  )
}
