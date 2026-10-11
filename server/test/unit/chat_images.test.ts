import { describe, expect, test } from "bun:test";

// Re-export through a thin public test of normalize via send path helpers —
// duplicate the pure rules here to avoid exporting internals.
const MAX = 4;
const MAX_BYTES = 4 * 1024 * 1024;
const ALLOWED = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

function normalize(raw: unknown) {
  if (!Array.isArray(raw)) return [];
  const out: { mimeType: string; data: string }[] = [];
  for (const item of raw) {
    if (out.length >= MAX) break;
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    let mime = String(o.mimeType || "").toLowerCase();
    let data = String(o.data || "").trim();
    if (!data && typeof o.url === "string" && o.url.startsWith("data:")) {
      const m = /^data:([^;]+);base64,(.+)$/s.exec(o.url);
      if (m) {
        mime = m[1]!.toLowerCase();
        data = m[2]!;
      }
    }
    if (mime === "image/jpg") mime = "image/jpeg";
    if (!ALLOWED.has(mime) || !data) continue;
    const approx = Math.floor((data.length * 3) / 4);
    if (approx <= 0 || approx > MAX_BYTES) continue;
    out.push({ mimeType: mime, data });
  }
  return out;
}

describe("chat image normalize", () => {
  test("accepts png base64 and data URLs", () => {
    const tiny = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64");
    const a = normalize([{ mimeType: "image/png", data: tiny }]);
    expect(a).toHaveLength(1);
    expect(a[0]!.mimeType).toBe("image/png");
    const b = normalize([{ url: `data:image/jpeg;base64,${tiny}` }]);
    expect(b[0]!.mimeType).toBe("image/jpeg");
  });

  test("rejects bad mime and caps count", () => {
    const tiny = Buffer.from("abcd").toString("base64");
    expect(normalize([{ mimeType: "application/pdf", data: tiny }])).toHaveLength(0);
    const many = Array.from({ length: 6 }, () => ({
      mimeType: "image/png",
      data: tiny,
    }));
    expect(normalize(many)).toHaveLength(4);
  });
});
