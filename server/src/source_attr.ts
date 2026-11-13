/**
 * Attribute a request to a WireGuard peer, named MCP connector, or presence
 * actor, and classify it for the Security log.
 */
import { normalizeIp } from "./geo";

export const SOURCE_CLASSES = [
  "known_grok_bot",
  "known_vpn_device",
  "lan",
  "unknown_external",
] as const;

export type SourceClass = (typeof SOURCE_CLASSES)[number];

export const SOURCE_CLASS_LABEL: Record<SourceClass, string> = {
  known_grok_bot: "Known Grok Bot",
  known_vpn_device: "Known VPN device",
  lan: "LAN",
  unknown_external: "Unknown / external",
};

export type SourceAttribution = {
  ip: string;
  class: SourceClass;
  classLabel: string;
  wgPeer?: { id: string; name: string; address: string; publicKeyLabel: string };
  connector?: { id: string; label: string };
  presence?: { id: string; kind: string; name: string };
  lan: boolean;
};

function isLanIp(ip: string): boolean {
  const n = normalizeIp(ip);
  if (!n || n === "unknown") return false;
  if (n === "127.0.0.1" || n === "::1" || n === "localhost") return true;
  if (n.startsWith("192.168.") || n.startsWith("10.") || n.startsWith("169.254.")) {
    return true;
  }
  const m = n.match(/^172\.(\d+)\./);
  if (m) {
    const o = Number(m[1]);
    if (o >= 16 && o <= 31) return true;
  }
  const lower = n.toLowerCase();
  if (lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe80:")) {
    return true;
  }
  return false;
}

function ipFromCidr(addr: string): string {
  return normalizeIp((addr || "").split("/")[0]);
}

function lookupWgPeer(ip: string): SourceAttribution["wgPeer"] {
  try {
    // Lazy import — wireguard pulls a lot of system helpers.
    const { listClientRecords } = require("./wireguard") as typeof import("./wireguard");
    const n = normalizeIp(ip);
    for (const c of listClientRecords()) {
      if (ipFromCidr(c.address) === n) {
        return {
          id: c.id,
          name: c.name,
          address: c.address,
          publicKeyLabel: (c.publicKey || "").slice(0, 8),
        };
      }
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

function lookupConnector(
  ip: string,
  hint?: { id?: string; label?: string },
): SourceAttribution["connector"] {
  if (hint?.id || hint?.label) {
    return { id: hint.id || "", label: hint.label || hint.id || "MCP client" };
  }
  try {
    const { listMcpTokens } = require("./mcp_server") as typeof import("./mcp_server");
    const n = normalizeIp(ip);
    for (const t of listMcpTokens()) {
      const lastIp = (t as { lastUsedIp?: string }).lastUsedIp;
      if (lastIp && normalizeIp(lastIp) === n) {
        return { id: t.id, label: t.label };
      }
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

function lookupPresence(ip: string): SourceAttribution["presence"] {
  try {
    const { listPresence } = require("./presence") as typeof import("./presence");
    const n = normalizeIp(ip);
    const actors = listPresence();
    const hit =
      actors.find((a) => a.kind === "ai" && a.peerIp && normalizeIp(a.peerIp) === n) ||
      actors.find((a) => a.peerIp && normalizeIp(a.peerIp) === n);
    if (hit) return { id: hit.id, kind: hit.kind, name: hit.name || hit.label || hit.id };
  } catch {
    /* ignore */
  }
  return undefined;
}

export function classifySource(opts: {
  ip?: string;
  connectorId?: string;
  connectorLabel?: string;
  source?: string;
}): SourceAttribution {
  const ip = normalizeIp(opts.ip || "") || "unknown";
  const wgPeer = ip !== "unknown" ? lookupWgPeer(ip) : undefined;
  const connector = lookupConnector(ip, {
    id: opts.connectorId,
    label: opts.connectorLabel,
  });
  const presence = ip !== "unknown" ? lookupPresence(ip) : undefined;
  const lan = isLanIp(ip);

  let cls: SourceClass = "unknown_external";
  const looksBot =
    Boolean(connector) ||
    presence?.kind === "ai" ||
    opts.source === "mcp" ||
    /mcp|grok|bot/i.test(opts.connectorLabel || presence?.name || "");
  if (looksBot && (connector || presence?.kind === "ai" || opts.connectorId)) {
    cls = "known_grok_bot";
  } else if (wgPeer) {
    cls = "known_vpn_device";
  } else if (lan) {
    cls = "lan";
  } else if (looksBot && opts.source === "mcp" && ip !== "unknown") {
    // MCP from an address we have not yet bound to a named connector.
    cls = "unknown_external";
  }

  return {
    ip,
    class: cls,
    classLabel: SOURCE_CLASS_LABEL[cls],
    wgPeer,
    connector,
    presence,
    lan,
  };
}

export function attributionSummary(attr: SourceAttribution): string {
  const bits = [attr.classLabel];
  if (attr.connector?.label) bits.push(attr.connector.label);
  if (attr.wgPeer?.name) bits.push(`VPN ${attr.wgPeer.name}`);
  if (attr.presence?.name && attr.presence.name !== attr.connector?.label) {
    bits.push(attr.presence.name);
  }
  if (attr.ip && attr.ip !== "unknown") bits.push(attr.ip);
  return bits.join(" · ");
}
