import { describe, expect, test } from "bun:test";
import { enrichPtyEnv } from "../../src/shell_env";

describe("enrichPtyEnv", () => {
  test("forces UTF-8 + xterm when systemd-like env is C/dumb", () => {
    const out = enrichPtyEnv({ LANG: "C", TERM: "dumb", PATH: "/bin" });
    expect(out.LANG).toMatch(/utf-?8/i);
    expect(out.LC_CTYPE).toMatch(/utf-?8/i);
    expect(out.TERM).toBe("xterm-256color");
    expect(out.COLORTERM).toBe("truecolor");
  });

  test("keeps an existing UTF-8 LANG", () => {
    const out = enrichPtyEnv({ LANG: "en_US.UTF-8", TERM: "xterm-256color" });
    expect(out.LANG).toBe("en_US.UTF-8");
    expect(out.LC_CTYPE).toBe("en_US.UTF-8");
    expect(out.TERM).toBe("xterm-256color");
  });
});
