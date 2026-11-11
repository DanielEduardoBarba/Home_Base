import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ActorStrip, FocusBubble } from "./components/Characters";
import { ChatPane } from "./components/ChatPane";
import { TitleBar } from "./components/TitleBar";
import {
  fetchPresence,
  type PresenceActor,
  type PresenceChatMsg,
} from "./lib/api";
import { loadConfig, saveConfig, type PresenceConfig } from "./lib/config";

export function App() {
  const [actors, setActors] = useState<PresenceActor[]>([]);
  const [chat, setChat] = useState<PresenceChatMsg[]>([]);
  const [error, setError] = useState("");
  const [cfg, setCfg] = useState<PresenceConfig>(() => loadConfig());
  const [showSetup, setShowSetup] = useState(() => !loadConfig().token);
  const [draftBase, setDraftBase] = useState(cfg.baseUrl);
  const [draftToken, setDraftToken] = useState(cfg.token);
  const [booted, setBooted] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const boot = await invoke<{ baseUrl: string; token: string }>(
          "get_boot_config",
        );
        if (cancelled) return;
        if (boot?.token) {
          const next = {
            baseUrl: (boot.baseUrl || "http://127.0.0.1:8080").replace(
              /\/+$/,
              "",
            ),
            token: boot.token,
          };
          saveConfig(next);
          setCfg(next);
          setDraftBase(next.baseUrl);
          setDraftToken(next.token);
          setShowSetup(false);
        }
      } catch {
        /* browser / vite-only preview */
      } finally {
        if (!cancelled) setBooted(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const tick = useCallback(async () => {
    try {
      const snap = await fetchPresence();
      setActors(snap.actors || []);
      setChat(snap.chat || []);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    if (!booted || !cfg.token) return;
    void tick();
    const id = setInterval(() => void tick(), 1500);
    return () => clearInterval(id);
  }, [booted, cfg.token, cfg.baseUrl, tick]);

  useEffect(() => {
    if (actors.length === 0) {
      setSelectedId(null);
      return;
    }
    if (selectedId && actors.some((a) => a.id === selectedId)) return;
    const alert = actors.find((a) => a.mood === "alert");
    const ai = actors.find((a) => a.kind === "ai");
    setSelectedId((alert || ai || actors[0]).id);
  }, [actors, selectedId]);

  const selected = useMemo(
    () => actors.find((a) => a.id === selectedId) || null,
    [actors, selectedId],
  );

  const active = actors.length > 0;
  const humans = actors.filter((a) => a.kind === "human").length;
  const ais = actors.filter((a) => a.kind === "ai").length;
  const status = error
    ? "Connection error"
    : !cfg.token
      ? "Needs connection"
      : active
        ? [
            humans ? `${humans} human${humans === 1 ? "" : "s"}` : null,
            ais ? `${ais} AI${ais === 1 ? "" : "s"}` : null,
          ]
            .filter(Boolean)
            .join(" · ")
        : "Waiting for remotes";

  function saveSetup() {
    const next = {
      baseUrl: draftBase.trim().replace(/\/+$/, "") || "http://127.0.0.1:8080",
      token: draftToken.trim(),
    };
    saveConfig(next);
    setCfg(next);
    setShowSetup(false);
  }

  return (
    <div className="flex h-full flex-col">
      <TitleBar status={status} active={active} count={actors.length} />
      <main className="flex min-h-0 flex-1 flex-col gap-2.5 p-3">
        {showSetup ? (
          <section className="space-y-2.5 rounded-2xl border border-hb-line bg-hb-panel p-3.5">
            <h2 className="text-sm font-semibold text-hb-text">Connect</h2>
            <p className="text-[11px] leading-relaxed text-hb-mute">
              Homebased usually injects URL + token when it opens this window.
              Paste them only if you launched Presence manually.
            </p>
            <label className="block text-[11px] text-hb-mute">
              Home Base URL
              <input
                className="mt-1 w-full rounded-xl border border-hb-line bg-hb-panel2 px-2.5 py-2 text-xs text-hb-text"
                value={draftBase}
                onChange={(e) => setDraftBase(e.target.value)}
                placeholder="http://127.0.0.1:8080"
              />
            </label>
            <label className="block text-[11px] text-hb-mute">
              Presence token
              <input
                className="mt-1 w-full rounded-xl border border-hb-line bg-hb-panel2 px-2.5 py-2 font-mono text-xs text-hb-text"
                value={draftToken}
                onChange={(e) => setDraftToken(e.target.value)}
                placeholder="from .runtime/presence_ui_token"
              />
            </label>
            <button
              type="button"
              className="w-full rounded-xl bg-hb-sky py-2.5 text-xs font-bold text-[#041018]"
              onClick={saveSetup}
            >
              Save & connect
            </button>
          </section>
        ) : (
          <>
            <ActorStrip
              actors={actors}
              selectedId={selectedId}
              onSelect={setSelectedId}
            />
            <FocusBubble actor={selected} />
            <ChatPane messages={chat} onSent={() => void tick()} />
            <div className="flex items-center justify-between gap-2 px-0.5">
              <button
                type="button"
                className="text-[10px] text-hb-mute hover:text-hb-sky"
                onClick={() => setShowSetup(true)}
              >
                Connection
              </button>
              {error ? (
                <span className="truncate text-[10px] text-red-400">{error}</span>
              ) : (
                <span className="text-[10px] text-hb-mute">Live · 1.5s</span>
              )}
            </div>
          </>
        )}
      </main>
    </div>
  );
}
