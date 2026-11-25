import { describe, expect, test } from "bun:test";
import { resolveWebglBind } from "../../src/unity_webgl_bind";

describe("resolveWebglBind (HB-U-02)", () => {
  test("HB_WEBGL_BIND wins when set", () => {
    expect(
      resolveWebglBind({
        env: { HB_WEBGL_BIND: "10.6.0.99" },
        wg0Ipv4: "10.6.0.1",
      }),
    ).toBe("10.6.0.99");
  });

  test("allows explicit 0.0.0.0 override via HB_WEBGL_BIND", () => {
    expect(
      resolveWebglBind({
        env: { HB_WEBGL_BIND: "0.0.0.0" },
        wg0Ipv4: "10.6.0.1",
      }),
    ).toBe("0.0.0.0");
  });

  test("uses wg0 IPv4 when env unset", () => {
    expect(
      resolveWebglBind({
        env: {},
        wg0Ipv4: "10.6.0.1",
      }),
    ).toBe("10.6.0.1");
  });

  test("falls back to 127.0.0.1 when no wg0", () => {
    expect(
      resolveWebglBind({
        env: {},
        wg0Ipv4: null,
      }),
    ).toBe("127.0.0.1");
  });

  test("ignores blank HB_WEBGL_BIND and falls through", () => {
    expect(
      resolveWebglBind({
        env: { HB_WEBGL_BIND: "  " },
        wg0Ipv4: null,
      }),
    ).toBe("127.0.0.1");
  });

  test("never returns 0.0.0.0 without explicit env", () => {
    const host = resolveWebglBind({ env: {}, wg0Ipv4: null });
    expect(host).not.toBe("0.0.0.0");
    expect(host).toBe("127.0.0.1");
  });
});
