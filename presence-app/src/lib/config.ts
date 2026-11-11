/**
 * Connection to Home Base presence API.
 * Prefer env injected by homebased when spawning; fall back to query / localStorage.
 */

const LS_BASE = "hb_presence_base";
const LS_TOKEN = "hb_presence_token";

export type PresenceConfig = {
  baseUrl: string;
  token: string;
};

function fromQuery(): Partial<PresenceConfig> {
  try {
    const q = new URLSearchParams(window.location.search);
    const base = q.get("base") || q.get("url") || "";
    const token = q.get("k") || q.get("token") || "";
    return {
      baseUrl: base ? base.replace(/\/+$/, "") : undefined,
      token: token || undefined,
    };
  } catch {
    return {};
  }
}

export function loadConfig(): PresenceConfig {
  const q = fromQuery();
  const envBase = (import.meta.env.VITE_HOMEBASE_URL as string | undefined)?.trim();
  const envToken = (import.meta.env.VITE_HOMEBASE_PRESENCE_TOKEN as string | undefined)?.trim();
  const baseUrl =
    q.baseUrl ||
    envBase ||
    localStorage.getItem(LS_BASE) ||
    "http://127.0.0.1:8080";
  const token =
    q.token || envToken || localStorage.getItem(LS_TOKEN) || "";
  return {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    token,
  };
}

export function saveConfig(cfg: PresenceConfig): void {
  localStorage.setItem(LS_BASE, cfg.baseUrl.replace(/\/+$/, ""));
  localStorage.setItem(LS_TOKEN, cfg.token);
}
