import { describe, expect, test } from "bun:test";
import {
  FramedWriter,
  encodeFrame,
  readFrame,
  safeJsonStringify,
  type ByteReader,
} from "../../src/ipc_framing";

function bufferReader(chunks: Uint8Array[]): ByteReader {
  let i = 0;
  return {
    read: async () => {
      if (i >= chunks.length) return { done: true };
      return { done: false, value: chunks[i++] };
    },
  };
}

describe("ipc_framing", () => {
  test("encodeFrame is a single buffer with BE length prefix", () => {
    const frame = encodeFrame({ type: "ping", n: 1 });
    expect(frame.readUInt32BE(0)).toBe(frame.length - 4);
    const body = JSON.parse(frame.subarray(4).toString("utf8"));
    expect(body).toEqual({ type: "ping", n: 1 });
  });

  test("safeJsonStringify handles circular + bigint", () => {
    const a: Record<string, unknown> = { n: 1n };
    a.self = a;
    const s = safeJsonStringify(a);
    expect(s).toContain("[Circular]");
    expect(s).toContain('"1"');
  });

  test("readFrame round-trips multiple messages", async () => {
    const a = encodeFrame({ type: "a", i: 1 });
    const b = encodeFrame({ type: "b", i: 2 });
    const buf = { cur: new Uint8Array(0) };
    const reader = bufferReader([a, b]);
    expect(await readFrame(reader, buf)).toEqual({ type: "a", i: 1 });
    expect(await readFrame(reader, buf)).toEqual({ type: "b", i: 2 });
  });

  test("FramedWriter serializes concurrent sends (no interleaved frames)", async () => {
    const written: Buffer[] = [];
    let releaseGate: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      releaseGate = r;
    });

    let writing = 0;
    let maxConcurrent = 0;
    // Slow first write so the second send queues behind it.
    const slowSink = {
      write: async (data: Uint8Array) => {
        writing++;
        maxConcurrent = Math.max(maxConcurrent, writing);
        await gate;
        written.push(Buffer.from(data));
        writing--;
        return data.length;
      },
    };

    const writer = new FramedWriter(slowSink);
    const p1 = writer.send({ type: "one", payload: "x".repeat(200) });
    const p2 = writer.send({ type: "two", payload: "y".repeat(200) });
    // Let both enqueue before releasing the first write.
    await Promise.resolve();
    releaseGate?.();
    await Promise.all([p1, p2]);

    expect(maxConcurrent).toBe(1);
    expect(written.length).toBe(2);

    const buf = { cur: new Uint8Array(0) };
    const concat = Buffer.concat(written);
    let offset = 0;
    const reader: ByteReader = {
      read: async () => {
        if (offset >= concat.length) return { done: true };
        const value = concat.subarray(offset);
        offset = concat.length;
        return { done: false, value };
      },
    };
    expect(await readFrame(reader, buf)).toMatchObject({ type: "one" });
    expect(await readFrame(reader, buf)).toMatchObject({ type: "two" });
  });

  test("split hdr/body writes would corrupt — encodeFrame prevents that shape", () => {
    // Historical bug: worker did out.write(hdr); out.write(data) while
    // concurrent onDelta raced. Document the safe shape: one buffer only.
    const frame = encodeFrame({ type: "delta", update: { text: "{" } });
    expect(frame.length).toBe(4 + frame.readUInt32BE(0));
  });

  // HB-49641-02: WritableSink is Uint8Array-only; writeAll must retry partials.
  test("FramedWriter retries partial numeric writes", async () => {
    const chunks: Uint8Array[] = [];
    let calls = 0;
    const partialSink = {
      write: (data: Uint8Array) => {
        calls++;
        if (data.length > 8) {
          chunks.push(data.subarray(0, 8));
          return 8;
        }
        chunks.push(data);
        return data.length;
      },
    };
    const writer = new FramedWriter(partialSink);
    await writer.send({ type: "partial", n: 42 });
    expect(calls).toBeGreaterThan(1);
    const concat = Buffer.concat(chunks.map((c) => Buffer.from(c)));
    expect(concat.readUInt32BE(0)).toBe(concat.length - 4);
    expect(JSON.parse(concat.subarray(4).toString("utf8"))).toEqual({
      type: "partial",
      n: 42,
    });
  });
});
