import { describe, expect, test } from "bun:test";
import { accessHosts, pickAdvertiseHost, projectLanEnv } from "../../src/network";

describe("advertiseHost", () => {
  test("prefers LAN 192.168 over WireGuard", () => {
    const host = pickAdvertiseHost([
      { iface: "wlp1s0", ip: "192.168.0.201" },
      { iface: "wg0", ip: "10.6.0.1" },
    ]);
    expect(host).toBe("192.168.0.201");
  });

  test("falls back to WireGuard when no LAN", () => {
    expect(pickAdvertiseHost([{ iface: "wg0", ip: "10.6.0.1" }])).toBe("10.6.0.1");
  });

  test("HOMEBASE_ADVERTISE_HOST override wins", () => {
    expect(
      pickAdvertiseHost(
        [
          { iface: "wlp1s0", ip: "192.168.0.201" },
          { iface: "wg0", ip: "10.6.0.1" },
        ],
        "10.8.0.1",
      ),
    ).toBe("10.8.0.1");
  });

  test("projectLanEnv sets Expo packager + API on advertise host", () => {
    const prev = process.env.HOMEBASE_ADVERTISE_HOST;
    process.env.HOMEBASE_ADVERTISE_HOST = "192.168.0.201";
    try {
      const env = projectLanEnv([
        { id: "api", port: 4200 },
        { id: "web", port: 3200 },
        { id: "expo", port: 8200 },
      ]);
      expect(env.REACT_NATIVE_PACKAGER_HOSTNAME).toBe("192.168.0.201");
      expect(env.EXPO_PUBLIC_API_URL).toBe("http://192.168.0.201:4200/api/v1");
      expect(env.HOSTNAME).toBe("0.0.0.0");
    } finally {
      if (prev !== undefined) process.env.HOMEBASE_ADVERTISE_HOST = prev;
      else delete process.env.HOMEBASE_ADVERTISE_HOST;
    }
  });

  test("accessHosts exposes separate LAN and VPN URLs", () => {
    const access = accessHosts(8888);
    expect(access.port).toBe(8888);
    if (access.vpnHost) {
      expect(access.urls.vpn).toBe(`http://${access.vpnHost}:8888/`);
    }
    if (access.lanHost) {
      expect(access.urls.lan).toBe(`http://${access.lanHost}:8888/`);
    }
  });
});
