import type { PresenceActor, PresenceMood } from "../lib/api";

const MOOD_HINT: Record<PresenceMood, string> = {
  idle: "Idle",
  thinking: "Thinking",
  happy: "Happy",
  alert: "Needs you",
  working: "Working",
  listening: "Listening",
};

function Avatar({ actor, size = 40 }: { actor: PresenceActor; size?: number }) {
  const isAi = actor.kind === "ai";
  const ring =
    actor.mood === "alert"
      ? "ring-hb-warn"
      : actor.mood === "thinking" || actor.mood === "working"
        ? isAi
          ? "ring-hb-ai"
          : "ring-hb-human"
        : "ring-transparent";

  return (
    <div
      className={`relative flex items-center justify-center rounded-full ring-2 ${ring}`}
      style={{ width: size, height: size }}
      aria-hidden
    >
      <div
        className={`flex h-full w-full items-center justify-center rounded-full text-[13px] font-bold ${
          isAi
            ? "bg-[#22184a] text-[#cbb8ff]"
            : "bg-[#12304a] text-[#8ed0ff]"
        }`}
      >
        {(actor.name || "?").trim().slice(0, 1).toUpperCase()}
      </div>
      <span
        className={`absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-hb-panel ${
          actor.mood === "alert"
            ? "bg-hb-warn"
            : actor.mood === "idle"
              ? "bg-hb-mute"
              : "bg-hb-ok"
        }`}
      />
    </div>
  );
}

export function ActorStrip({
  actors,
  selectedId,
  onSelect,
}: {
  actors: PresenceActor[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  if (actors.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-hb-line bg-hb-panel/60 px-3 py-6 text-center">
        <p className="text-xs font-medium text-hb-text">No one remoted in</p>
        <p className="mt-1 text-[11px] leading-relaxed text-hb-mute">
          Web GUI sessions and MCP AIs (Grok bots) appear here automatically.
        </p>
      </div>
    );
  }

  return (
    <div className="flex gap-2 overflow-x-auto pb-0.5 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {actors.map((a) => {
        const selected = a.id === selectedId;
        const isAi = a.kind === "ai";
        return (
          <button
            key={a.id}
            type="button"
            onClick={() => onSelect(a.id)}
            className={`flex min-w-[108px] max-w-[140px] flex-1 flex-col items-center gap-1.5 rounded-2xl border px-2.5 py-2.5 text-left transition ${
              selected
                ? isAi
                  ? "border-hb-ai/60 bg-[#1a1433]"
                  : "border-hb-human/60 bg-[#102033]"
                : "border-hb-line bg-hb-panel hover:border-hb-line/90 hover:bg-hb-panel2"
            }`}
          >
            <Avatar actor={a} />
            <span className="w-full truncate text-center text-[11px] font-semibold text-hb-text">
              {a.name}
            </span>
            <span className="w-full truncate text-center text-[10px] text-hb-mute">
              {isAi ? "AI" : "Human"} · {MOOD_HINT[a.mood] || a.mood}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function FocusBubble({ actor }: { actor: PresenceActor | null }) {
  if (!actor) return null;
  const isAi = actor.kind === "ai";
  return (
    <div
      className={`rounded-2xl border px-3 py-2.5 ${
        isAi ? "border-[#3a2f6e]/80 bg-[#16102a]/80" : "border-[#1e4a6e]/80 bg-[#0e1c2c]/80"
      }`}
    >
      <div className="flex items-start gap-2.5">
        <Avatar actor={actor} size={36} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <p className="truncate text-xs font-semibold text-hb-text">{actor.name}</p>
            <p className="shrink-0 text-[10px] text-hb-mute">
              {MOOD_HINT[actor.mood] || actor.mood}
            </p>
          </div>
          <p className="mt-1 text-[12px] leading-snug text-hb-text/90">
            {actor.bubble ||
              (isAi
                ? "Waiting for an expression…"
                : "Viewing Home Base")}
          </p>
          {(actor.label || actor.peerIp) && (
            <p className="mt-1 truncate text-[10px] text-hb-mute">
              {[actor.label, actor.peerIp].filter(Boolean).join(" · ")}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
