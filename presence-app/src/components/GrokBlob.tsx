import type { PresenceActor, PresenceForm, PresenceMood } from "../lib/api";

const FORMS: PresenceForm[] = [
  "pill",
  "cloud",
  "drop",
  "circle",
  "hex",
  "diamond",
  "soft",
  "cluster",
];

function hash(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h;
}

export function resolveForm(actor: PresenceActor): PresenceForm {
  if (actor.form && FORMS.includes(actor.form)) return actor.form;
  if (actor.kind === "human") return "circle";
  return FORMS[hash(actor.id) % FORMS.length]!;
}

export function resolveColor(actor: PresenceActor): string {
  if (actor.color) return actor.color;
  return actor.kind === "human" ? "#4da3ff" : "#7c5cff";
}

function eyes(mood: PresenceMood, energy: number) {
  const blink = mood === "idle" && energy < 0.35;
  const think = mood === "thinking" || mood === "working";
  const alert = mood === "alert";
  const happy = mood === "happy";
  const listen = mood === "listening";

  const eyeH = blink ? 2 : alert ? 14 : think ? 10 : happy ? 11 : 12;
  const eyeY = blink ? 48 : alert ? 40 : 44;
  const gap = alert ? 10 : 8;
  const lean = think ? -2 : listen ? 2 : 0;
  const opacity = Math.max(0.75, 0.85 + energy * 0.15);

  return (
    <g opacity={opacity} transform={`translate(${lean},0)`}>
      <rect
        x={40 - gap - 3}
        y={eyeY}
        width={6}
        height={eyeH}
        rx={2.5}
        fill="#111"
      />
      <rect
        x={40 + gap - 3}
        y={eyeY}
        width={6}
        height={eyeH}
        rx={2.5}
        fill="#111"
      />
      {happy ? (
        <path
          d="M34 62 Q40 68 46 62"
          fill="none"
          stroke="#111"
          strokeWidth="2.2"
          strokeLinecap="round"
          opacity="0.35"
        />
      ) : null}
    </g>
  );
}

function bodyPath(form: PresenceForm): string {
  switch (form) {
    case "pill":
      return "M18 40 h44 a14 14 0 0 1 0 28 H18 a14 14 0 0 1 0-28 z";
    case "cloud":
      return "M22 52c0-8 6-14 14-14 2-7 10-12 18-10 7 2 12 9 11 16 7 1 12 7 11 14-1 8-8 13-16 13H28c-8 0-14-6-14-13 0-5 3-10 8-12z";
    case "drop":
      return "M40 16 C40 16 18 42 18 54 a22 22 0 0 0 44 0 C62 42 40 16 40 16z";
    case "hex":
      return "M40 14 L62 28 L62 52 L40 66 L18 52 L18 28 Z";
    case "diamond":
      return "M40 12 L66 40 L40 68 L14 40 Z";
    case "soft":
      return "M24 28c10-14 32-14 40 2 8 14 2 34-12 40-16 7-34-2-38-18-3-12 2-18 10-24z";
    case "cluster":
      return ""; // drawn as circles
    case "circle":
    default:
      return "";
  }
}

export function GrokBlob({
  actor,
  size = 96,
  selected = false,
}: {
  actor: PresenceActor;
  size?: number;
  selected?: boolean;
}) {
  const form = resolveForm(actor);
  const color = resolveColor(actor);
  const energy = Math.max(0, Math.min(1, actor.energy ?? 0.4));
  const mood = actor.mood || "idle";
  const bounce =
    mood === "happy"
      ? "hb-bob-happy"
      : mood === "thinking" || mood === "working"
        ? "hb-bob-think"
        : mood === "alert"
          ? "hb-bob-alert"
          : energy > 0.55
            ? "hb-bob-soft"
            : "";

  const scale = 0.92 + energy * 0.12;

  return (
    <div
      className={`relative flex items-center justify-center ${bounce}`}
      style={{
        width: size,
        height: size,
        transform: `scale(${scale})`,
        transition: "transform 280ms cubic-bezier(.2,.8,.2,1)",
        filter: selected
          ? "drop-shadow(0 8px 18px rgba(0,0,0,.35))"
          : "drop-shadow(0 4px 12px rgba(0,0,0,.22))",
      }}
    >
      <svg viewBox="0 0 80 80" width={size} height={size} aria-hidden>
        {form === "circle" ? (
          <circle cx="40" cy="40" r="28" fill={color} />
        ) : form === "cluster" ? (
          <g>
            <circle cx="28" cy="36" r="14" fill={color} opacity="0.95" />
            <circle cx="50" cy="32" r="12" fill="#fff" opacity="0.92" />
            <circle cx="44" cy="50" r="13" fill="#3ecf8e" opacity="0.9" />
          </g>
        ) : (
          <path d={bodyPath(form)} fill={color} />
        )}
        {form === "cluster" ? (
          <g>
            <rect x="24" y="32" width="4" height="9" rx="2" fill="#111" />
            <rect x="32" y="32" width="4" height="9" rx="2" fill="#111" />
          </g>
        ) : (
          eyes(mood, energy)
        )}
      </svg>
    </div>
  );
}
