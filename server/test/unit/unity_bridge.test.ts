import { afterEach, describe, expect, test } from "bun:test";
import {
  callUnityBridge,
  decodeUnityFrameLength,
  encodeUnityFrame,
  startFakeUnityBridge,
} from "../../src/unity_bridge";

const fakes: { close: () => void }[] = [];

afterEach(() => {
  while (fakes.length) fakes.pop()?.close();
});

describe("unity framed TCP proxy", () => {
  test("encode/decode length header (8-byte BE)", () => {
    const frame = encodeUnityFrame("ping");
    expect(frame.length).toBe(8 + 4);
    expect(decodeUnityFrameLength(frame.subarray(0, 8))).toBe(4);
  });

  test("fake bridge handshake + ping", async () => {
    const fake = await startFakeUnityBridge();
    fakes.push(fake);
    const r = await callUnityBridge({
      port: fake.port,
      tool: "ping",
      timeoutMs: 5_000,
    });
    expect(r.ok).toBe(true);
    expect((r.result as { message?: string })?.message).toBe("pong");
  });

  test("fake bridge echoes tool calls", async () => {
    const fake = await startFakeUnityBridge({
      onCall: (tool, params) => ({ tool, params, ok: true }),
    });
    fakes.push(fake);
    const r = await callUnityBridge({
      port: fake.port,
      tool: "manage_scene",
      args: { action: "get_hierarchy" },
      timeoutMs: 5_000,
    });
    expect(r.ok).toBe(true);
    const result = r.result as { tool?: string; params?: { action?: string } };
    expect(result.tool).toBe("manage_scene");
    expect(result.params?.action).toBe("get_hierarchy");
  });
});
