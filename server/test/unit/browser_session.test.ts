import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(tmpdir(), `hb-browser-${process.pid}-${Date.now()}`);
mkdirSync(root, { recursive: true });
process.env.HOMEBASE_HOME = root;
process.env.HOMEBASE_RUNTIME = join(root, ".runtime");

const browser = await import("../../src/browser_session");

afterAll(async () => {
  await browser.__resetBrowserSessionForTests();
  if (existsSync(root)) rmSync(root, { recursive: true, force: true });
});

describe("browser_session status (no Chrome required)", () => {
  test("status reports not running and isolated paths", () => {
    const st = browser.browserStatus();
    expect(st.ok).toBe(true);
    expect(st.running).toBe(false);
    expect(st.controller).toBe("agent");
    expect(st.askPending).toBe(null);
    expect(st.displayMode).toBe(null);
    expect(String(st.profileDir)).toContain(".runtime/browser/profile");
    expect(String(st.shotsDir)).toContain(".runtime/browser/shots");
    expect(String(st.guidance)).toContain("homebase_browser_");
    expect(String(st.guidance)).toContain("ask_human");
    expect(String(st.guidance)).toContain("propose_email");
    expect(String(st.guidance)).toContain("observe");
    expect(st.emailPending).toBe(null);
  });

  test("close when idle is ok", async () => {
    const r = await browser.browserClose();
    expect(r.ok).toBe(true);
    expect(r.running).toBe(false);
  });

  test("viewer count starts at zero", () => {
    expect(browser.browserViewerCount()).toBe(0);
  });

  test("hub connect/disconnect tracks viewers", async () => {
    const sent: string[] = [];
    const client = {
      send: (payload: string | Buffer | Uint8Array) => {
        sent.push(typeof payload === "string" ? payload : String(payload));
      },
    };
    await browser.browserHubConnect(client);
    expect(browser.browserViewerCount()).toBe(1);
    expect(sent.some((s) => s.includes('"type":"hello"'))).toBe(true);
    await browser.browserHubDisconnect(
      client as { send: typeof client.send; __browserId?: number },
    );
    expect(browser.browserViewerCount()).toBe(0);
  });

  test("take-control without session fails", async () => {
    await expect(browser.browserTakeControl()).rejects.toThrow(/not running/i);
  });

  test("release-control when idle is ok", async () => {
    const r = await browser.browserReleaseControl();
    expect(r.ok).toBe(true);
    expect(r.controller).toBe("agent");
  });
});

const live = process.env.HB_BROWSER_LIVE === "1";

describe.skipIf(!live)("browser_session live Chrome (HB_BROWSER_LIVE=1)", () => {
  test("opens on virtual display and screenshots", async () => {
    const opened = await browser.browserOpen({ url: "about:blank" });
    expect(opened.ok).toBe(true);
    expect(opened.running).toBe(true);
    expect(["xvfb", "headless", "seat"]).toContain(String(opened.displayMode ?? browser.browserStatus().displayMode));
    const shot = await browser.browserScreenshot({ quality: 50 });
    expect(shot.ok).toBe(true);
    expect(String(shot.path)).toContain(".runtime/browser/shots");
    expect(existsSync(String(shot.path))).toBe(true);

    await browser.browserTakeControl();
    expect(browser.browserStatus().controller).toBe("human");
    await expect(browser.browserClick({ x: 0.5, y: 0.5 })).rejects.toThrow(/Human has control/i);
    await browser.browserClick({ x: 0.5, y: 0.5, asHuman: true });
    await browser.browserReleaseControl();
    expect(browser.browserStatus().controller).toBe("agent");

    await browser.browserClose();
    expect(browser.browserStatus().running).toBe(false);
  }, 60_000);
});
