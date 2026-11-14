import { describe, expect, test } from "bun:test";
import {
  actorDrivesPresenceWindow,
  effectivePresenceMood,
  isLocalPeerIp,
  isRemotePeerIp,
  PRESENCE_ACTIVE_MS,
  type PresenceActor,
} from "../../src/presence";
import { listHostIpv4Addresses } from "../../src/network";

function actor(
  partial: Partial<PresenceActor> & Pick<PresenceActor, "id" | "kind">,
): PresenceActor {
  return {
    name: "t",
    label: "t",
    mood: "idle",
    moodExplicit: false,
    bubble: "",
    form: "pill",
    color: "#fff",
    energy: 0.5,
    lastSeen: Date.now(),
    ...partial,
  };
}

describe("presence seat-local detection", () => {
  test("loopback is local", () => {
    expect(isLocalPeerIp("127.0.0.1")).toBe(true);
    expect(isLocalPeerIp("::1")).toBe(true);
    expect(isLocalPeerIp("localhost")).toBe(true);
    expect(isRemotePeerIp("127.0.0.1")).toBe(false);
  });

  test("this host's bound IPv4 addresses are local (LAN self-browse)", () => {
    const hosts = listHostIpv4Addresses();
    expect(hosts.length).toBeGreaterThan(0);
    for (const ip of hosts) {
      expect(isLocalPeerIp(ip)).toBe(true);
      expect(
        actorDrivesPresenceWindow(actor({ id: "h", kind: "human", peerIp: ip })),
      ).toBe(false);
    }
  });

  test("other LAN / VPN client addresses are remote", () => {
    const hosts = new Set(listHostIpv4Addresses());
    // Pick a private IP that is not this host
    const candidates = ["192.168.0.50", "10.6.0.2", "10.8.0.9"];
    const remote = candidates.find((ip) => !hosts.has(ip));
    expect(remote).toBeTruthy();
    expect(isRemotePeerIp(remote!)).toBe(true);
    expect(
      actorDrivesPresenceWindow(
        actor({ id: "h", kind: "human", peerIp: remote! }),
      ),
    ).toBe(true);
    expect(
      actorDrivesPresenceWindow(
        actor({ id: "a", kind: "ai", peerIp: remote! }),
      ),
    ).toBe(true);
  });

  test("AI with unknown peer still drives the window", () => {
    expect(
      actorDrivesPresenceWindow(
        actor({ id: "a", kind: "ai", peerIp: "unknown" }),
      ),
    ).toBe(true);
    expect(
      actorDrivesPresenceWindow(actor({ id: "a", kind: "ai" })),
    ).toBe(true);
  });

  test("human with unknown peer does not drive the window", () => {
    expect(
      actorDrivesPresenceWindow(
        actor({ id: "h", kind: "human", peerIp: "unknown" }),
      ),
    ).toBe(false);
  });
});

describe("presence effective mood", () => {
  test("recent activity without expression → active", () => {
    const now = Date.now();
    const a = actor({
      id: "ai1",
      kind: "ai",
      mood: "idle",
      moodExplicit: false,
      lastSeen: now - 5_000,
    });
    expect(effectivePresenceMood(a, now)).toBe("active");
  });

  test("stale activity without expression → idle", () => {
    const now = Date.now();
    const a = actor({
      id: "ai1",
      kind: "ai",
      mood: "idle",
      moodExplicit: false,
      lastSeen: now - PRESENCE_ACTIVE_MS - 1,
    });
    expect(effectivePresenceMood(a, now)).toBe("idle");
  });

  test("explicit expression wins over activity window", () => {
    const now = Date.now();
    const a = actor({
      id: "ai1",
      kind: "ai",
      mood: "thinking",
      moodExplicit: true,
      lastSeen: now,
    });
    expect(effectivePresenceMood(a, now)).toBe("thinking");
  });
});
