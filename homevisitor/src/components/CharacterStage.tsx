import type { PresenceActor } from "../lib/api";
import { GrokBlob } from "./GrokBlob";

function isLocalIp(ip?: string): boolean {
  if (!ip) return false;
  return (
    ip === "127.0.0.1" ||
    ip === "::1" ||
    ip === "localhost" ||
    ip.startsWith("127.")
  );
}

function displayName(a: PresenceActor): string {
  if (a.kind === "human" && isLocalIp(a.peerIp)) return "You";
  if (a.kind === "human" && (/remote/i.test(a.name) || a.name === "Remote user"))
    return "Person";
  return a.name || (a.kind === "ai" ? "AI" : "Human");
}

export function CharacterStage({
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
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-6 text-center">
        <div className="hb-bob-soft opacity-40">
          <svg viewBox="0 0 80 80" width="88" height="88" aria-hidden>
            <circle cx="40" cy="40" r="26" fill="#243049" />
            <rect x="32" y="36" width="5" height="10" rx="2.5" fill="#111" />
            <rect x="43" y="36" width="5" height="10" rx="2.5" fill="#111" />
          </svg>
        </div>
        <p className="mt-4 text-[15px] font-semibold tracking-tight text-white/90">
          Waiting
        </p>
        <p className="mt-1 max-w-[220px] text-[12px] leading-relaxed text-white/40">
          People and AI characters appear here when they connect.
        </p>
      </div>
    );
  }

  const selected =
    actors.find((a) => a.id === selectedId) ||
    actors.find((a) => a.kind === "ai") ||
    actors[0]!;

  const others = actors.filter((a) => a.id !== selected.id);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-4">
        <button
          type="button"
          className="group flex flex-col items-center gap-2 outline-none"
          onClick={() => onSelect(selected.id)}
        >
          <GrokBlob actor={selected} size={128} selected />
          <div className="text-center">
            <p className="text-[15px] font-semibold tracking-tight text-white/95">
              {displayName(selected)}
            </p>
            <p className="mt-0.5 text-[11px] font-medium uppercase tracking-wide text-white/35">
              {selected.kind === "human" ? "Human" : "AI"}
              {selected.mood ? ` · ${selected.mood}` : ""}
            </p>
          </div>
        </button>

        {selected.bubble ? (
          <p className="max-w-[260px] rounded-2xl bg-white/[0.06] px-3.5 py-2.5 text-center text-[13px] leading-snug text-white/80 transition">
            {selected.bubble}
          </p>
        ) : (
          <p className="max-w-[240px] text-center text-[12px] text-white/30">
            {selected.kind === "ai"
              ? "Waiting for an expression…"
              : "Signed in"}
          </p>
        )}
      </div>

      {others.length > 0 ? (
        <div className="flex items-end justify-center gap-3 overflow-x-auto px-3 pb-1 pt-2 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {others.map((a) => (
            <button
              key={a.id}
              type="button"
              onClick={() => onSelect(a.id)}
              className="flex shrink-0 flex-col items-center gap-1 rounded-2xl px-1.5 py-1 outline-none transition hover:bg-white/[0.04]"
              title={displayName(a)}
            >
              <GrokBlob actor={a} size={52} />
              <span className="max-w-[64px] truncate text-[10px] text-white/45">
                {displayName(a)}
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
