import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LOGIN_ENV_PROBE,
  applySeatEnvForAgents,
  clearLoginEnvCache,
  discoverToolBins,
  enrichPtyEnv,
  loginEnvForSeat,
  pickNvmVersion,
} from "../../src/shell_env";

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

describe("seat toolchain PATH", () => {
  test("login probe sources nvm instead of a bare env dump", () => {
    expect(LOGIN_ENV_PROBE).toContain(".nvm/nvm.sh");
    expect(LOGIN_ENV_PROBE).not.toBe("env -0");
  });

  test("pickNvmVersion prefers the alias major", () => {
    expect(pickNvmVersion(["v22.1.0", "v24.14.1", "v20.0.0"], "24")).toBe("v24.14.1");
    expect(pickNvmVersion(["v22.1.0", "v24.14.1"], "node")).toBe("v24.14.1");
    expect(pickNvmVersion(["v22.1.0", "v24.0.1", "v24.14.1"], "v24.0.1")).toBe("v24.0.1");
  });

  test("discoverToolBins finds the default nvm node bin", () => {
    const home = mkdtempSync(join(tmpdir(), "hb-tools-"));
    try {
      const nodeBin = join(home, ".nvm/versions/node/v24.14.1/bin");
      mkdirSync(nodeBin, { recursive: true });
      mkdirSync(join(home, ".nvm/alias"), { recursive: true });
      mkdirSync(join(home, ".nvm/versions/node/v22.1.0/bin"), { recursive: true });
      writeFileSync(join(home, ".nvm/alias/default"), "24\n");
      mkdirSync(join(home, ".local/bin"), { recursive: true });
      const bins = discoverToolBins(home);
      expect(bins[0]).toBe(nodeBin);
      expect(bins).toContain(join(home, ".local/bin"));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("login env puts nvm node bin on PATH when the seat has nvm", () => {
    clearLoginEnvCache();
    const env = loginEnvForSeat();
    const nodeBin = discoverToolBins(env.HOME || "").find((b) =>
      b.includes("/.nvm/versions/node/"),
    );
    if (!nodeBin) return;
    expect(env.PATH?.split(":")[0]).toBe(nodeBin);
  });
});

describe("applySeatEnvForAgents", () => {
  test("is idempotent and injects safe.directory when running as root", () => {
    const uid = typeof process.getuid === "function" ? process.getuid() : -1;
    if (uid !== 0) {
      const skipped = applySeatEnvForAgents();
      expect(skipped.applied).toBe(false);
      return;
    }
    const beforeHome = process.env.HOME;
    const first = applySeatEnvForAgents();
    expect(first.applied).toBe(true);
    expect(process.env.HOME).toBeTruthy();
    expect(process.env.HOME).not.toBe("/root");
    expect(process.env.GIT_CONFIG_KEY_0 || process.env.GIT_CONFIG_KEY_1).toBe(
      "safe.directory",
    );
    const count = Number(process.env.GIT_CONFIG_COUNT || "0");
    const second = applySeatEnvForAgents();
    expect(second.applied).toBe(true);
    expect(Number(process.env.GIT_CONFIG_COUNT || "0")).toBe(count);
    // Restore for other tests in this process when possible.
    if (beforeHome) process.env.HOME = beforeHome;
  });
});
