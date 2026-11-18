/**
 * Length-prefixed JSON IPC framing (4-byte BE size + UTF-8 body).
 *
 * Critical: hdr+body must be written as one buffer, and writers must be
 * serialized. Split/racy writes corrupt the stream and surface as Bun's
 * "JSON Parse error: Expected '}'" on the reader (seen during rapid
 * Cursor onDelta + tool_req traffic).
 */

export type Json = Record<string, unknown>;

export type ByteReader = {
  read: () => Promise<{ done: boolean; value?: Uint8Array }>;
};

/** JSON.stringify that survives BigInt / circular / Error values. */
export function safeJsonStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_key, v) => {
    if (typeof v === "bigint") return v.toString();
    if (typeof v === "function" || typeof v === "symbol") return undefined;
    if (v instanceof Error) {
      return { name: v.name, message: v.message };
    }
    if (v && typeof v === "object") {
      if (seen.has(v as object)) return "[Circular]";
      seen.add(v as object);
    }
    return v;
  });
}

/** Encode one IPC frame (header + body) as a single buffer. */
export function encodeFrame(obj: unknown): Buffer {
  let body: Buffer;
  try {
    body = Buffer.from(safeJsonStringify(obj), "utf8");
  } catch (e) {
    body = Buffer.from(
      JSON.stringify({
        type: "error",
        error: `ipc encode failed: ${e instanceof Error ? e.message : String(e)}`,
      }),
      "utf8",
    );
  }
  const frame = Buffer.allocUnsafe(4 + body.length);
  frame.writeUInt32BE(body.length, 0);
  body.copy(frame, 4);
  return frame;
}

export async function readExact(
  reader: ByteReader,
  n: number,
  buf: { cur: Uint8Array },
): Promise<Uint8Array> {
  while (buf.cur.length < n) {
    const { done, value } = await reader.read();
    if (done || !value) throw new Error("ipc EOF");
    const next = new Uint8Array(buf.cur.length + value.length);
    next.set(buf.cur);
    next.set(value, buf.cur.length);
    buf.cur = next;
  }
  const out = buf.cur.slice(0, n);
  buf.cur = buf.cur.slice(n);
  return out;
}

export async function readFrame(
  reader: ByteReader,
  buf: { cur: Uint8Array },
): Promise<Json> {
  const hdr = await readExact(reader, 4, buf);
  const n = new DataView(hdr.buffer, hdr.byteOffset, hdr.byteLength).getUint32(
    0,
    false,
  );
  if (n <= 0 || n > 64 * 1024 * 1024) throw new Error(`ipc bad size ${n}`);
  const data = await readExact(reader, n, buf);
  const text = Buffer.from(data).toString("utf8");
  try {
    return JSON.parse(text) as Json;
  } catch (e) {
    const tip = text.slice(0, 120).replace(/\s+/g, " ");
    const why = e instanceof Error ? e.message : String(e);
    throw new Error(`ipc JSON parse failed (${why}) near: ${tip}`);
  }
}

/** Sink for framed IPC. writeAll only ever passes Buffer chunks (never string). */
type WritableSink = {
  write: (data: Uint8Array) => number | boolean | Promise<number | void> | void;
};

async function writeAll(sink: WritableSink, frame: Buffer): Promise<void> {
  let offset = 0;
  while (offset < frame.length) {
    const chunk = frame.subarray(offset);
    const result = sink.write(chunk);
    if (typeof result === "number") {
      // Bun FileSink: bytes written (0 can mean "accept whole chunk").
      offset += result > 0 ? result : chunk.length;
      continue;
    }
    if (result && typeof (result as Promise<unknown>).then === "function") {
      const awaited = await (result as Promise<number | void>);
      if (typeof awaited === "number" && awaited > 0) {
        offset += awaited;
      } else {
        offset += chunk.length;
      }
      continue;
    }
    // Node-style boolean / void — treat as full accept.
    offset += chunk.length;
  }
}

/**
 * Serializes framed writes so concurrent send() callers cannot interleave
 * bytes on a pipe (which breaks length-prefix framing).
 */
export class FramedWriter {
  private chain: Promise<void> = Promise.resolve();
  private readonly sink: WritableSink;

  constructor(sink: WritableSink) {
    this.sink = sink;
  }

  /** Enqueue a frame; returns a promise that settles when that frame is written. */
  send(obj: unknown): Promise<void> {
    const frame = encodeFrame(obj);
    const done = this.chain.then(() => writeAll(this.sink, frame));
    // Keep the chain alive after failures so later messages still flow.
    this.chain = done.catch(() => undefined);
    return done;
  }

  /** Fire-and-forget (errors swallowed into the chain). */
  sendFire(obj: unknown): void {
    void this.send(obj).catch(() => undefined);
  }
}
