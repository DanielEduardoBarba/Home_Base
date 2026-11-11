import { useEffect, useRef, useState, type FormEvent } from "react";
import type { PresenceChatMsg } from "../lib/api";
import { sendOperatorChat } from "../lib/api";

function timeLabel(at: number): string {
  try {
    return new Date(at).toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

export function ChatPane({
  messages,
  onSent,
}: {
  messages: PresenceChatMsg[];
  onSent: () => void;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true);
    setErr("");
    try {
      await sendOperatorChat(t);
      setText("");
      onSent();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : String(ex));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-hb-line bg-hb-panel">
      <div className="flex items-center justify-between border-b border-hb-line/70 px-3 py-1.5">
        <p className="text-[11px] font-semibold text-hb-text">Chat</p>
        <p className="text-[10px] text-hb-mute">You ↔ remoted AIs</p>
      </div>
      <div className="chat-selectable flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto px-2.5 py-2">
        {messages.length === 0 ? (
          <div className="m-auto max-w-[240px] px-2 py-4 text-center">
            <p className="text-[12px] font-medium text-hb-text">Quiet so far</p>
            <p className="mt-1 text-[11px] leading-relaxed text-hb-mute">
              Message MCP agents here. They reply with presence chat tools.
            </p>
          </div>
        ) : (
          messages.map((m) => (
            <div
              key={m.id}
              className={`flex flex-col gap-0.5 ${
                m.from === "operator"
                  ? "items-end"
                  : m.from === "ai"
                    ? "items-start"
                    : "items-center"
              }`}
            >
              <div
                className={`max-w-[88%] rounded-2xl px-2.5 py-1.5 text-[11px] leading-snug ${
                  m.from === "operator"
                    ? "rounded-br-md bg-[#1a3355] text-hb-text"
                    : m.from === "ai"
                      ? "rounded-bl-md bg-[#241a45] text-hb-text"
                      : "bg-transparent text-hb-mute"
                }`}
              >
                {m.from === "ai" ? (
                  <>
                    <span className="font-semibold text-hb-ai">
                      {m.actorName || "AI"}
                    </span>
                    <span className="text-hb-mute"> · </span>
                    {m.text}
                  </>
                ) : m.from === "operator" ? (
                  m.text
                ) : (
                  m.text
                )}
              </div>
              {m.from !== "system" ? (
                <span className="px-1 text-[9px] text-hb-mute/80">
                  {timeLabel(m.at)}
                </span>
              ) : null}
            </div>
          ))
        )}
        <div ref={endRef} />
      </div>
      <form
        onSubmit={onSubmit}
        className="flex gap-1.5 border-t border-hb-line p-2"
      >
        <input
          className="min-w-0 flex-1 rounded-xl border border-hb-line bg-hb-panel2 px-3 py-2 text-xs text-hb-text outline-none placeholder:text-hb-mute focus:border-hb-sky"
          placeholder="Message remoted AIs…"
          value={text}
          maxLength={500}
          disabled={busy}
          onChange={(e) => setText(e.target.value)}
        />
        <button
          type="submit"
          disabled={busy || !text.trim()}
          className="rounded-xl bg-hb-sky px-3.5 text-xs font-bold text-[#041018] disabled:opacity-40"
        >
          Send
        </button>
      </form>
      {err ? <p className="px-2 pb-1.5 text-[10px] text-red-400">{err}</p> : null}
    </section>
  );
}
