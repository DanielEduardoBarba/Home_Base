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

export async function fetchPresence(): Promise<PresenceSnapshot> {
  const { baseUrl, token } = cfg();
  if (!token) throw new Error("Missing presence token");
  const res = await fetch(
    `${baseUrl}/api/presence/ui?k=${encodeURIComponent(token)}`,
  );
  if (!res.ok) throw new Error(`presence ${res.status}`);
  return (await res.json()) as PresenceSnapshot;
}

export async function sendOperatorChat(text: string): Promise<PresenceChatMsg> {
  const { baseUrl, token } = cfg();
  const res = await fetch(
    `${baseUrl}/api/presence/ui/chat?k=${encodeURIComponent(token)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    },
  );
  if (!res.ok) throw new Error(`chat ${res.status}`);
  const data = (await res.json()) as { message: PresenceChatMsg };
  return data.message;
}
