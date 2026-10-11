import { describe, expect, test } from "bun:test";
import {
  buildClientConf,
  buildServerConf,
  dnsFromLanHost,
  lanCidrFromHost,
  nextClientAddress,
  parseCidr,
  parseServerConf,
  sanitizeClientId,
  sanitizeIface,
} from "../../src/wireguard";

describe("wireguard helpers", () => {
  test("sanitizeIface accepts wg0", () => {
    expect(sanitizeIface("wg0")).toBe("wg0");
  });

  test("sanitizeIface rejects path tricks", () => {
    expect(() => sanitizeIface("../evil")).toThrow();
    expect(() => sanitizeIface("wg 0")).toThrow();
  });

  test("sanitizeClientId normalizes", () => {
    expect(sanitizeClientId("My Phone!")).toBe("my-phone");
  });

  test("parseCidr / lan helpers", () => {
    expect(parseCidr("10.6.0.0/24")).toEqual({
      a: 10,
      b: 6,
      c: 0,
      d: 0,
      prefix: 24,
    });
    expect(lanCidrFromHost("192.168.0.201")).toBe("192.168.0.0/24");
    expect(dnsFromLanHost("192.168.0.201")).toBe("192.168.0.1");
  });

  test("nextClientAddress skips used hosts", () => {
    expect(nextClientAddress("10.6.0.0/24", [])).toBe("10.6.0.2/32");
    expect(
      nextClientAddress("10.6.0.0/24", ["10.6.0.2/32", "10.6.0.3/32"]),
    ).toBe("10.6.0.4/32");
  });

  test("buildServerConf includes peer and NAT", () => {
    const conf = buildServerConf({
      serverPrivateKey: "SERVERPRIV",
      serverAddress: "10.6.0.1/24",
      listenPort: 51820,
      outboundIface: "wlp1s0",
      iface: "wg0",
      peers: [
        {
          publicKey: "CLIENTPUB",
          address: "10.6.0.2/32",
          name: "phone",
        },
      ],
    });
    expect(conf).toContain("PrivateKey = SERVERPRIV");
    expect(conf).toContain("ListenPort = 51820");
    expect(conf).toContain("PublicKey = CLIENTPUB");
    expect(conf).toContain("AllowedIPs = 10.6.0.2/32");
    expect(conf).toContain("-o wlp1s0 -j MASQUERADE");
    expect(conf).toContain("# phone");
  });

  test("buildClientConf includes endpoint and LAN allowed", () => {
    const conf = buildClientConf({
      clientPrivateKey: "CLIENTPRIV",
      clientAddress: "10.6.0.2/32",
      dns: "192.168.0.1",
      serverPublicKey: "SERVERPUB",
      endpoint: "1.2.3.4:51820",
      vpnCidr: "10.6.0.0/24",
      lanCidr: "192.168.0.0/24",
    });
    expect(conf).toContain("PrivateKey = CLIENTPRIV");
    expect(conf).toContain("Endpoint = 1.2.3.4:51820");
    expect(conf).toContain("AllowedIPs = 10.6.0.0/24, 192.168.0.0/24");
    expect(conf).toContain("PersistentKeepalive = 25");
  });

  test("parseServerConf round-trips peers", () => {
    const text = buildServerConf({
      serverPrivateKey: "SERVERPRIV",
      serverAddress: "10.6.0.1/24",
      listenPort: 51820,
      outboundIface: "eth0",
      iface: "wg0",
      peers: [
        { publicKey: "AAA", address: "10.6.0.2/32", name: "iphone" },
        { publicKey: "BBB", address: "10.6.0.3/32" },
      ],
    });
    const parsed = parseServerConf(text);
    expect(parsed.privateKey).toBe("SERVERPRIV");
    expect(parsed.listenPort).toBe(51820);
    expect(parsed.peers).toHaveLength(2);
    expect(parsed.peers[0]?.comment).toBe("iphone");
    expect(parsed.peers[0]?.publicKey).toBe("AAA");
  });
});
