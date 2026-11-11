import { invoke } from "@tauri-apps/api/core";
import { loadConfig, type PresenceConfig } from "./config";

export type PresenceMood =
  | "idle"
  | "thinking"
  | "happy"
  | "alert"
  | "working"
  | "listening";

export type PresenceActor = {
  id: string;
  kind: "human" | "ai";
  name: string;
  label: string;
  mood: PresenceMood;
  bubble: string;
  peerIp?: string;
  lastSeen: number;
};

export type PresenceChatMsg = {
  id: string;
  from: "operator" | "ai" | "system";
  actorId?: string;
  actorName?: string;
  text: string;
  at: number;
};

export type PresenceSnapshot = {
  actors: PresenceActor[];
  chat: PresenceChatMsg[];
  windowWanted: boolean;
  guidance?: string;
};

function cfg(): PresenceConfig {
  return loadConfig();
}

async function viaRustSnapshot(): Promise<PresenceSnapshot | null> {
  try {
    return await invoke<PresenceSnapshot>("presence_snapshot");
  } catch {
    return null;
  }
}

async function viaHttpSnapshot(): Promise<PresenceSnapshot> {
  const { baseUrl, token } = cfg();
  if (!token) throw new Error("Missing presence token");
  const res = await fetch(
    `${baseUrl}/api/presence/ui?k=${encodeURIComponent(token)}`,
  );
  if (!res.ok) throw new Error(`Couldn't reach Home Base (${res.status})`);
  return (await res.json()) as PresenceSnapshot;
}

export async function fetchPresence(): Promise<PresenceSnapshot> {
  const native = await viaRustSnapshot();
  if (native) return native;
  return viaHttpSnapshot();
}

export async function sendOperatorChat(text: string): Promise<PresenceChatMsg> {
  try {
    const data = await invoke<{ message: PresenceChatMsg }>(
      "presence_chat_send",
      { text },
    );
    return data.message;
  } catch {
    /* browser / vite preview fallback */
  }
  const { baseUrl, token } = cfg();
  const res = await fetch(
    `${baseUrl}/api/presence/ui/chat?k=${encodeURIComponent(token)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    },
  );
  if (!res.ok) throw new Error(`Couldn't send (${res.status})`);
  const data = (await res.json()) as { message: PresenceChatMsg };
  return data.message;
}
