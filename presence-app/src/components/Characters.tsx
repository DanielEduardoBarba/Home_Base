import type { PresenceActor } from "../lib/api";

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 1).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

function isLocalIp(ip?: string): boolean {
  if (!ip) return false;
  return (
    ip === "127.0.0.1" ||
    ip === "::1" ||
    ip === "localhost" ||
    ip.startsWith("127.")
  );
}

export function humanTitle(actor: PresenceActor): string {
  if (actor.kind !== "human") return actor.name;
  if (isLocalIp(actor.peerIp)) return "You";
  if (/remote/i.test(actor.name) || actor.name === "Remote user") {
    return actor.peerIp ? `Person · ${actor.peerIp}` : "Person";
  }
  return actor.name;
}

export function humanSubtitle(actor: PresenceActor): string {
  if (actor.kind !== "human") return actor.label;
  if (isLocalIp(actor.peerIp)) {
    return actor.label.replace(/^Web GUI/, "This browser") || "Signed in here";
  }
  const where = actor.label || "Web";
  return actor.peerIp ? `${where}` : where;
}

function Avatar({ actor }: { actor: PresenceActor }) {
  const human = actor.kind === "human";
  return (
    <div
      className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-[13px] font-semibold ${
        human
          ? "bg-[#2a6fdb]/20 text-[#8ec0ff] ring-1 ring-[#2a6fdb]/35"
          : "bg-[#7c5cff]/18 text-[#cbb8ff] ring-1 ring-[#7c5cff]/35"
      }`}
      aria-hidden
    >
      {initials(humanTitle(actor))}
    </div>
  );
}

export function PeopleList({
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
      <div className="rounded-2xl bg-white/[0.03] px-4 py-8 text-center">
        <p className="text-[13px] font-medium text-white/85">No one here yet</p>
        <p className="mt-1 text-[12px] leading-relaxed text-white/40">
          People who sign in, and AI bots on MCP, show up here.
        </p>
      </div>
    );
  }

  return (
    <ul className="space-y-1.5">
      {actors.map((a) => {
        const selected = a.id === selectedId;
        const human = a.kind === "human";
        return (
          <li key={a.id}>
            <button
              type="button"
              onClick={() => onSelect(a.id)}
              className={`flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-left transition ${
                selected ? "bg-white/[0.08]" : "bg-transparent hover:bg-white/[0.04]"
              }`}
            >
              <Avatar actor={a} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-[13px] font-semibold text-white/95">
                    {humanTitle(a)}
                  </span>
                  <span
                    className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
                      human
                        ? "bg-[#2a6fdb]/20 text-[#9ec5ff]"
                        : "bg-[#7c5cff]/20 text-[#cbb8ff]"
                    }`}
                  >
                    {human ? "Human" : "AI"}
                  </span>
                </div>
                <p className="mt-0.5 truncate text-[11px] text-white/40">
                  {human
                    ? humanSubtitle(a)
                    : a.bubble || a.label || "AI"}
                </p>
              </div>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export function FocusLine({ actor }: { actor: PresenceActor | null }) {
  if (!actor) return null;
  if (actor.kind === "human") {
    return (
      <p className="px-1 text-[12px] leading-snug text-white/50">
        {isLocalIp(actor.peerIp)
          ? "You're signed in to Home Base in a browser."
          : actor.bubble ||
            `Someone is using Home Base${actor.peerIp ? ` from ${actor.peerIp}` : ""}.`}
      </p>
    );
  }
  if (!actor.bubble) return null;
  return (
    <p className="px-1 text-[12px] leading-snug text-white/55">
      <span className="font-medium text-white/80">{actor.name}</span>
      {" — "}
      {actor.bubble}
    </p>
  );
}
