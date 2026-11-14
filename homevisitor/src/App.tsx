import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { CharacterStage } from "./components/CharacterStage";
import { PeopleList } from "./components/Characters";
import { ChatPane } from "./components/ChatPane";
import { TitleBar } from "./components/TitleBar";
import {
  fetchPresence,
  type PresenceActor,
  type PresenceChatMsg,
} from "./lib/api";
import { loadConfig, saveConfig, type PresenceConfig } from "./lib/config";

type Face = "stage" | "details";

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
  const [face, setFace] = useState<Face>("stage");

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
        /* vite-only preview */
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

  // Prefer showing an alerting AI on the stage front.
  useEffect(() => {
    const alert = actors.find((a) => a.mood === "alert" && a.kind === "ai");
    if (alert && face === "stage") setSelectedId(alert.id);
  }, [actors, face]);

  const humans = actors.filter((a) => a.kind === "human").length;
  const ais = actors.filter((a) => a.kind === "ai").length;
  const connected = Boolean(cfg.token) && !error;
  const subtitle = error
    ? "Can't reach Home Base"
    : !cfg.token
      ? "Not connected"
      : actors.length === 0
        ? "Waiting…"
        : [
            humans ? `${humans} ${humans === 1 ? "person" : "people"}` : null,
            ais ? `${ais} AI` : null,
          ]
            .filter(Boolean)
            .join(" · ");

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
      <TitleBar subtitle={subtitle} live={connected && actors.length > 0} />
      <main className="flex min-h-0 flex-1 flex-col">
        {showSetup ? (
          <section className="m-3 space-y-3 rounded-2xl bg-white/[0.04] p-4">
            <div>
              <h2 className="text-[14px] font-semibold text-white/95">
                Connect
              </h2>
              <p className="mt-1 text-[12px] leading-relaxed text-white/45">
                Usually filled in automatically.
              </p>
            </div>
            <label className="block text-[11px] text-white/45">
              Home Base URL
              <input
                className="mt-1 w-full rounded-xl bg-white/[0.06] px-3 py-2.5 text-[13px] text-white outline-none focus:bg-white/[0.09]"
                value={draftBase}
                onChange={(e) => setDraftBase(e.target.value)}
                placeholder="http://127.0.0.1:8080"
              />
            </label>
            <label className="block text-[11px] text-white/45">
              Token
              <input
                className="mt-1 w-full rounded-xl bg-white/[0.06] px-3 py-2.5 font-mono text-[12px] text-white outline-none focus:bg-white/[0.09]"
                value={draftToken}
                onChange={(e) => setDraftToken(e.target.value)}
              />
            </label>
            <button
              type="button"
              className="w-full rounded-xl bg-white py-2.5 text-[13px] font-semibold text-[#0b1220]"
              onClick={saveSetup}
            >
              Connect
            </button>
          </section>
        ) : face === "stage" ? (
          <>
            <CharacterStage
              actors={actors}
              selectedId={selectedId}
              onSelect={setSelectedId}
            />
            <div className="flex items-center justify-center gap-4 px-3 pb-3 pt-1">
              <button
                type="button"
                className="rounded-full bg-white/[0.08] px-4 py-2 text-[12px] font-semibold text-white/85 transition hover:bg-white/[0.12]"
                onClick={() => setFace("details")}
              >
                Details
              </button>
              {error ? (
                <span className="text-[11px] text-red-300/90">{error}</span>
              ) : null}
            </div>
          </>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col gap-2.5 p-3">
            <div className="flex items-center justify-between gap-2">
              <button
                type="button"
                className="rounded-full px-2.5 py-1.5 text-[12px] font-semibold text-white/70 hover:bg-white/[0.06] hover:text-white"
                onClick={() => setFace("stage")}
              >
                ← Characters
              </button>
              <button
                type="button"
                className="text-[11px] text-white/30 hover:text-white/55"
                onClick={() => setShowSetup(true)}
              >
                Settings
              </button>
            </div>
            <div className="max-h-[38%] min-h-[100px] overflow-y-auto">
              <PeopleList
                actors={actors}
                selectedId={selectedId}
                onSelect={setSelectedId}
              />
            </div>
            <ChatPane
              messages={chat}
              onSent={() => void tick()}
              enabled={connected}
            />
            {error ? (
              <p className="text-center text-[11px] text-red-300/90">{error}</p>
            ) : null}
          </div>
        )}
      </main>
    </div>
  );
}
