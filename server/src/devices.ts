/**
 * Named, trusted devices for the Security page.
 * New/unknown devices are flagged until Dan names and marks them trusted.
 */
import {
  chmodSync,
  existsSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { TRUSTED_DEVICES_PATH, ensureRuntimeDirs } from "./config";
import { normalizeIp } from "./geo";
import type { SourceAttribution, SourceClass } from "./source_attr";

export type TrustedDevice = {
  id: string;
  name: string;
  trusted: boolean;
  ip: string;
  userAgent?: string;
  class: SourceClass;
  wgPeerName?: string;
  connectorId?: string;
  connectorLabel?: string;
  firstSeenAt: number;
  lastSeenAt: number;
  seenCount: number;
};

type DevicesFile = { devices: TrustedDevice[]; updatedAt?: number };

function chmodPrivate(path: string): void {
  try {
    chmodSync(path, 0o600);
  } catch {
    /* ignore */
  }
}

function load(): DevicesFile {
  if (!existsSync(TRUSTED_DEVICES_PATH)) return { devices: [] };
  try {
    const raw = JSON.parse(readFileSync(TRUSTED_DEVICES_PATH, "utf8")) as Partial<DevicesFile>;
    const devices = Array.isArray(raw.devices) ? (raw.devices as TrustedDevice[]) : [];
    return { devices, updatedAt: raw.updatedAt };
  } catch {
    return { devices: [] };
  }
}

function save(data: DevicesFile): void {
  ensureRuntimeDirs();
  const tmp = TRUSTED_DEVICES_PATH + ".tmp";
  writeFileSync(tmp, JSON.stringify({ ...data, updatedAt: Date.now() }, null, 2) + "\n");
  chmodPrivate(tmp);
  renameSync(tmp, TRUSTED_DEVICES_PATH);
  chmodPrivate(TRUSTED_DEVICES_PATH);
}

export function deviceFingerprint(opts: {
  ip: string;
  userAgent?: string;
  wgPeerName?: string;
  connectorId?: string;
}): string {
  const ip = normalizeIp(opts.ip || "") || "unknown";
  const ua = (opts.userAgent || "").slice(0, 120);
  const wg = opts.wgPeerName || "";
  const conn = opts.connectorId || "";
  return createHash("sha256")
    .update(`v1|${ip}|${ua}|${wg}|${conn}`)
    .digest("hex")
    .slice(0, 16);
}

export function listDevices(): TrustedDevice[] {
  return load().devices.slice().sort((a, b) => b.lastSeenAt - a.lastSeenAt);
}

export function getDevice(id: string): TrustedDevice | undefined {
  return load().devices.find((d) => d.id === id);
}

export function updateDevice(
  id: string,
  patch: { name?: string; trusted?: boolean },
): TrustedDevice | undefined {
  const file = load();
  const dev = file.devices.find((d) => d.id === id);
  if (!dev) return undefined;
  if (typeof patch.name === "string") dev.name = patch.name.trim().slice(0, 64) || dev.name;
  if (typeof patch.trusted === "boolean") dev.trusted = patch.trusted;
  save(file);
  return dev;
}

/** Record a sighting. Returns the device and whether this is the first time we have seen it. */
export function observeDevice(opts: {
  ip: string;
  userAgent?: string;
  attr: SourceAttribution;
}): { device: TrustedDevice; firstSeen: boolean } {
  const id = deviceFingerprint({
    ip: opts.ip,
    userAgent: opts.userAgent,
    wgPeerName: opts.attr.wgPeer?.name,
    connectorId: opts.attr.connector?.id,
  });
  const file = load();
  const now = Date.now();
  let dev = file.devices.find((d) => d.id === id);
  let firstSeen = false;
  if (!dev) {
    firstSeen = true;
    const defaultName =
      opts.attr.connector?.label ||
      opts.attr.wgPeer?.name ||
      opts.attr.presence?.name ||
      (opts.attr.class === "lan" ? `LAN ${opts.ip}` : `Device ${id.slice(0, 6)}`);
    dev = {
      id,
      name: defaultName.slice(0, 64),
      trusted: false,
      ip: normalizeIp(opts.ip) || "unknown",
      userAgent: (opts.userAgent || "").slice(0, 180) || undefined,
      class: opts.attr.class,
      wgPeerName: opts.attr.wgPeer?.name,
      connectorId: opts.attr.connector?.id,
      connectorLabel: opts.attr.connector?.label,
      firstSeenAt: now,
      lastSeenAt: now,
      seenCount: 1,
    };
    file.devices.push(dev);
  } else {
    dev.lastSeenAt = now;
    dev.seenCount = (dev.seenCount || 1) + 1;
    dev.ip = normalizeIp(opts.ip) || dev.ip;
    if (opts.userAgent) dev.userAgent = opts.userAgent.slice(0, 180);
    dev.class = opts.attr.class;
    if (opts.attr.wgPeer?.name) dev.wgPeerName = opts.attr.wgPeer.name;
    if (opts.attr.connector?.id) dev.connectorId = opts.attr.connector.id;
    if (opts.attr.connector?.label) dev.connectorLabel = opts.attr.connector.label;
  }
  save(file);
  return { device: dev, firstSeen };
}

export function newDeviceId(): string {
  return randomBytes(8).toString("hex");
}
