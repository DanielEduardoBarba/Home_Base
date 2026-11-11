import { useEffect, useRef, useState, type FormEvent } from "react";
import type { PresenceChatMsg } from "../lib/api";
import { sendOperatorChat } from "../lib/api";

export function ChatPane({
  messages,
  onSent,
  enabled,
}: {
  messages: PresenceChatMsg[];
  onSent: () => void;
  enabled: boolean;
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
    if (!t || busy || !enabled) return;
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
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl bg-white/[0.03]">
      <div className="chat-selectable flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3 py-3">
        {messages.length === 0 ? (
          <div className="m-auto max-w-[220px] py-6 text-center">
            <p className="text-[13px] font-medium text-white/80">Chat</p>
            <p className="mt-1 text-[12px] leading-relaxed text-white/40">
              Message remoted AIs. They answer here.
            </p>
          </div>
        ) : (
          messages.map((m) => (
            <div
              key={m.id}
              className={`flex ${
                m.from === "operator"
                  ? "justify-end"
                  : m.from === "ai"
                    ? "justify-start"
                    : "justify-center"
              }`}
            >
              <div
                className={`max-w-[85%] rounded-2xl px-3 py-2 text-[12px] leading-snug ${
                  m.from === "operator"
                    ? "rounded-br-md bg-[#2a6fdb] text-white"
                    : m.from === "ai"
                      ? "rounded-bl-md bg-white/[0.08] text-white/90"
                      : "bg-transparent text-white/40"
                }`}
              >
                {m.from === "ai" ? (
                  <>
                    <span className="font-semibold text-[#cbb8ff]">
                      {m.actorName || "AI"}
                    </span>
                    <span className="text-white/35"> · </span>
                    {m.text}
                  </>
                ) : (
                  m.text
                )}
              </div>
            </div>
          ))
        )}
        <div ref={endRef} />
      </div>
      <form
        onSubmit={onSubmit}
        className="flex gap-2 border-t border-white/5 px-2.5 py-2.5"
      >
        <input
          className="min-w-0 flex-1 rounded-xl bg-white/[0.06] px-3 py-2 text-[13px] text-white outline-none placeholder:text-white/30 focus:bg-white/[0.09]"
          placeholder={enabled ? "Message…" : "Waiting for connection…"}
          value={text}
          maxLength={500}
          disabled={busy || !enabled}
          onChange={(e) => setText(e.target.value)}
        />
        <button
          type="submit"
          disabled={busy || !text.trim() || !enabled}
          className="rounded-xl bg-white px-3.5 text-[13px] font-semibold text-[#0b1220] disabled:opacity-30"
        >
          Send
        </button>
      </form>
      {err ? <p className="px-3 pb-2 text-[11px] text-red-300">{err}</p> : null}
    </section>
  );
}
