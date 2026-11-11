/**
 * Per-request MCP actor context (AsyncLocalStorage) so presence tools share
 * the same actor id + peer IP as the /mcp connection.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export type McpRequestContext = {
  actorId: string;
  actorLabel: string;
  peerIp?: string;
};

export const mcpRequestContext = new AsyncLocalStorage<McpRequestContext>();

export function getMcpRequestContext(): McpRequestContext | undefined {
  return mcpRequestContext.getStore();
}

export function mcpPresenceActorId(override?: string): string {
  const raw = String(override || "").trim();
  if (raw) return raw.slice(0, 64);
  const ctx = getMcpRequestContext();
  if (ctx?.actorId) return `mcp:${ctx.actorId}`.slice(0, 64);
  return "mcp-default";
}

export function mcpPresencePeerIp(): string | undefined {
  const ctx = getMcpRequestContext();
  const ip = ctx?.peerIp ? String(ctx.peerIp).trim() : "";
  return ip || undefined;
}
