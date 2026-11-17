/**
 * Isolated Home Base Chrome workspace for AI / MCP.
 *
 * One shared Chrome profile under `.runtime/browser/profile` (not the operator's
 * personal Chrome). Control is CDP Input/Page — not Vision XTest — so bots never
 * get the whole desktop.
 *
 * Display preference (keeps the human's desktop free):
 *   1. Xvfb virtual display (separate X session under the hood)
 *   2. Chrome --headless=new (no window on seat)
 *   3. Seat DISPLAY only as last resort
 *
 * Humans watch/take control via Chat Browser dock (CDP screencast), not the seat UI.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { RUNTIME_DIR, ensureRuntimeDirs } from "./config";
import { detectSeatUser } from "./shell_env";
import { appendTrace } from "./trace";
import { discoverSessionType, discoverWaylandEnv, discoverX11Env } from "./view";

const BROWSER_ROOT = join(RUNTIME_DIR, "browser");
const PROFILE_DIR = join(BROWSER_ROOT, "profile");
const SHOTS_DIR = join(BROWSER_ROOT, "shots");
const MAX_SHOTS = 8;
const DEFAULT_URL = "about:blank";
const WINDOW_W = 1280;
const WINDOW_H = 900;

export const BROWSER_GUIDANCE =
  "Isolated Home Base Chrome (homebase_browser_*): one shared profile under " +
  ".runtime/browser/profile — not the operator's personal Chrome. " +
  "Default loop (token-cheap): homebase_browser_observe → click/fill by ref → observe again. " +
  "Use homebase_browser_screenshot only when you need pixels (layout/CAPTCHA/visual). " +
  "homebase_browser_fill({ref|label, text}) beats click+type. homebase_browser_wait for text/url. " +
  "For logins/CAPTCHA/2FA: ask_human / ask_secret (never put secrets in chat). " +
  "For outbound email: homebase_browser_propose_email (Approve/Deny — never click Send yourself). " +
  "Humans: Take control → click field → type overlay. Safer than Vision. Prefer browser tools for web UI.";

export type BrowserController = "agent" | "human";

type CdpPending = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
};

type CdpEventHandler = (method: string, params: unknown, sessionId?: string) => void;

class CdpClient {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, CdpPending>();
  private eventHandler: CdpEventHandler | null = null;

  setEventHandler(handler: CdpEventHandler | null): void {
    this.eventHandler = handler;
  }

  async connect(url: string): Promise<void> {
    await this.close();
    this.ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      const ws = this.ws!;
      const t = setTimeout(() => reject(new Error("CDP connect timeout")), 12_000);
      ws.addEventListener("open", () => {
        clearTimeout(t);
        resolve();
      });
      ws.addEventListener("error", () => {
        clearTimeout(t);
        reject(new Error("CDP WebSocket error"));
      });
      ws.addEventListener("message", (ev) => this.onMessage(String(ev.data)));
      ws.addEventListener("close", () => {
        for (const [, p] of this.pending) {
          p.reject(new Error("CDP connection closed"));
        }
        this.pending.clear();
        this.ws = null;
      });
    });
  }

  private onMessage(raw: string): void {
    let msg: {
      id?: number;
      result?: unknown;
      error?: { message?: string };
      method?: string;
      params?: unknown;
      sessionId?: string;
    };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.id != null) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) {
        p.reject(new Error(msg.error.message || "CDP error"));
      } else {
        p.resolve(msg.result);
      }
      return;
    }
    if (msg.method && this.eventHandler) {
      this.eventHandler(msg.method, msg.params, msg.sessionId);
    }
  }

  async send(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<unknown> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("CDP not connected");
    }
    const id = this.nextId++;
    const payload: Record<string, unknown> = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return await new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 20_000);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(t);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(t);
          reject(e);
        },
      });
      this.ws!.send(JSON.stringify(payload));
    });
  }

  async close(): Promise<void> {
    for (const [, p] of this.pending) {
      p.reject(new Error("CDP closed"));
    }
    this.pending.clear();
    this.eventHandler = null;
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
  }

  get connected(): boolean {
    return Boolean(this.ws && this.ws.readyState === WebSocket.OPEN);
  }
}

type BrowserClient = {
  id: number;
  send: (payload: string | Buffer | Uint8Array) => void;
};

export type BrowserDisplayMode = "xvfb" | "headless" | "seat";

type SessionState = {
  proc: ChildProcess;
  xvfbProc: ChildProcess | null;
  port: number;
  binary: string;
  startedAt: number;
  url: string;
  cdp: CdpClient;
  pageSessionId: string | null;
  targetId: string | null;
  viewportW: number;
  viewportH: number;
  screencastOn: boolean;
  displayMode: BrowserDisplayMode;
  display: string | null;
};

let session: SessionState | null = null;
let starting: Promise<SessionState> | null = null;
let controller: BrowserController = "agent";
let askHuman: {
  id: string;
  prompt: string;
  createdAt: number;
} | null = null;
type SecretPending = {
  id: string;
  label: string;
  prompt: string;
  kind: "password" | "text";
  pressEnter: boolean;
  createdAt: number;
  resolve: (r: {
    ok: boolean;
    cancelled?: boolean;
    charsTyped?: number;
    error?: string;
  }) => void;
  timer: ReturnType<typeof setTimeout>;
};
let secretPending: SecretPending | null = null;
type EmailPending = {
  id: string;
  to: string;
  subject: string;
  body: string;
  createdAt: number;
  resolve: (r: {
    ok: boolean;
    cancelled?: boolean;
    sent?: boolean;
    error?: string;
    url?: string | null;
  }) => void;
  timer: ReturnType<typeof setTimeout>;
};
let emailPending: EmailPending | null = null;
let nextClientId = 1;
const browserClients = new Map<number, BrowserClient>();
let lastFrameJpeg: Buffer | null = null;
let lastFrameAt = 0;
/** Last observe() refs → CSS-pixel centers for click/fill by ref. */
let lastObserveRefs = new Map<
  string,
  { px: number; py: number; name: string; role: string; tag: string }
>();

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function clearObserveRefs(): void {
  lastObserveRefs = new Map();
}

function ensureDirs(): void {
  ensureRuntimeDirs();
  for (const d of [BROWSER_ROOT, PROFILE_DIR, SHOTS_DIR]) {
    try {
      mkdirSync(d, { recursive: true, mode: 0o700 });
    } catch {
      /* ignore */
    }
  }
  const seat = detectSeatUser();
  if (process.getuid?.() === 0 && seat.uid > 0) {
    try {
      Bun.spawnSync(["chown", "-R", `${seat.uid}:${seat.gid}`, BROWSER_ROOT]);
    } catch {
      /* ignore */
    }
  }
}

function findChromium(): string | null {
  for (const name of [
    "google-chrome-stable",
    "google-chrome",
    "chromium-browser",
    "chromium",
    "brave-browser",
  ]) {
    const p = Bun.which(name);
    if (p) return p;
  }
  return null;
}

function wrapSeat(
  cmd: string[],
  opts: {
    display?: string;
    xauthority?: string;
    /** Virtual/headless: do not inherit seat Wayland (avoids leaking onto the desktop). */
    isolated?: boolean;
  } = {},
): { cmd: string[]; env: Record<string, string> } {
  const seatX = discoverX11Env();
  const seat = detectSeatUser();
  const uid = seat.uid;
  const gid = seat.gid;
  const { waylandDisplay, runtimeDir } = discoverWaylandEnv(uid);
  const sessionType = discoverSessionType(uid);
  let out = cmd;
  if (typeof process.getuid === "function" && process.getuid() === 0 && uid !== 0) {
    const setpriv = Bun.which("setpriv");
    if (setpriv) {
      out = [
        setpriv,
        `--reuid=${uid}`,
        `--regid=${gid}`,
        "--init-groups",
        "--",
        ...cmd,
      ];
    } else {
      const runuser = Bun.which("runuser");
      if (!runuser) throw new Error("setpriv/runuser required to launch Chrome as seat user");
      out = [runuser, "-u", seat.name, "--", ...cmd];
    }
  }
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    DISPLAY:
      opts.display ||
      seatX.display ||
      process.env.DISPLAY ||
      ":0",
    HOME: seat.home,
    USER: seat.name,
    LOGNAME: seat.name,
    XDG_RUNTIME_DIR: runtimeDir,
    DBUS_SESSION_BUS_ADDRESS:
      process.env.DBUS_SESSION_BUS_ADDRESS || `unix:path=${runtimeDir}/bus`,
  };
  if (opts.isolated) {
    env.XDG_SESSION_TYPE = "x11";
    delete env.WAYLAND_DISPLAY;
    // Xvfb needs no cookie; clear seat XAUTHORITY so we don't confuse auth.
    if (opts.xauthority) env.XAUTHORITY = opts.xauthority;
    else delete env.XAUTHORITY;
  } else {
    env.XAUTHORITY =
      opts.xauthority || seatX.xauthority || process.env.XAUTHORITY || "";
    env.XDG_SESSION_TYPE = sessionType === "unknown" ? "wayland" : sessionType;
    if (waylandDisplay) env.WAYLAND_DISPLAY = waylandDisplay;
  }
  return { cmd: out, env };
}

function findFreeDisplayNum(): Promise<number> {
  // Prefer high display numbers to avoid clashing with seat :0/:1 and common VNC.
  const candidates: number[] = [];
  for (let n = 90; n <= 119; n++) candidates.push(n);
  for (let n = 50; n <= 79; n++) candidates.push(n);
  return new Promise((resolve, reject) => {
    const tryNext = (i: number) => {
      if (i >= candidates.length) {
        reject(new Error("No free X display number for Xvfb"));
        return;
      }
      const n = candidates[i]!;
      const lock = `/tmp/.X${n}-lock`;
      if (existsSync(lock)) {
        tryNext(i + 1);
        return;
      }
      const srv = createServer();
      srv.once("error", () => {
        try {
          srv.close();
        } catch {
          /* ignore */
        }
        tryNext(i + 1);
      });
      // X11 TCP port = 6000 + display (rarely used); also avoid if something listens.
      srv.listen(6000 + n, "127.0.0.1", () => {
        srv.close(() => resolve(n));
      });
    };
    tryNext(0);
  });
}

async function startXvfb(): Promise<{
  proc: ChildProcess;
  display: string;
}> {
  const xvfb = Bun.which("Xvfb");
  if (!xvfb) throw new Error("Xvfb not found");
  const num = await findFreeDisplayNum();
  const display = `:${num}`;
  const cmd = [
    xvfb,
    display,
    "-screen",
    "0",
    `${WINDOW_W}x${WINDOW_H}x24`,
    "-nolisten",
    "tcp",
    "-ac",
  ];
  // Run Xvfb as seat user when homebased is root (same UID as Chrome).
  const wrapped = wrapSeat(cmd, { display, isolated: true });
  const proc = spawn(wrapped.cmd[0]!, wrapped.cmd.slice(1), {
    env: wrapped.env,
    stdio: "ignore",
    detached: false,
  });
  const deadline = Date.now() + 8_000;
  let ready = false;
  while (Date.now() < deadline) {
    if (proc.exitCode != null) {
      throw new Error(`Xvfb exited early (code ${proc.exitCode})`);
    }
    if (existsSync(`/tmp/.X${num}-lock`) || existsSync(`/tmp/.X11-unix/X${num}`)) {
      ready = true;
      break;
    }
    await Bun.sleep(100);
  }
  if (!ready) {
    killProc(proc);
    throw new Error("Xvfb failed to become ready");
  }
  // Brief settle for the server socket.
  await Bun.sleep(150);
  return { proc, display };
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port =
        addr && typeof addr === "object" ? addr.port : 0;
      srv.close((err) => {
        if (err) reject(err);
        else if (!port) reject(new Error("no free port"));
        else resolve(port);
      });
    });
    srv.on("error", reject);
  });
}

async function waitForDebugger(port: number, timeoutMs = 15_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let lastErr = "waiting";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(1500),
      });
      if (res.ok) {
        const body = (await res.json()) as { webSocketDebuggerUrl?: string };
        if (body.webSocketDebuggerUrl) return body.webSocketDebuggerUrl;
      }
      lastErr = `HTTP ${res.status}`;
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
    await Bun.sleep(200);
  }
  throw new Error(`Chrome DevTools not ready on :${port} (${lastErr})`);
}

async function attachPage(cdp: CdpClient): Promise<{
  pageSessionId: string;
  targetId: string;
}> {
  const targets = (await cdp.send("Target.getTargets")) as {
    targetInfos?: { targetId: string; type: string; url: string }[];
  };
  let page = (targets.targetInfos || []).find((t) => t.type === "page");
  if (!page) {
    const created = (await cdp.send("Target.createTarget", {
      url: DEFAULT_URL,
    })) as { targetId: string };
    page = { targetId: created.targetId, type: "page", url: DEFAULT_URL };
  }
  const attached = (await cdp.send("Target.attachToTarget", {
    targetId: page.targetId,
    flatten: true,
  })) as { sessionId: string };
  const sid = attached.sessionId;
  await cdp.send("Page.enable", {}, sid);
  await cdp.send("Runtime.enable", {}, sid);
  await cdp.send("Network.enable", {}, sid);
  return { pageSessionId: sid, targetId: page.targetId };
}

async function refreshViewport(state: SessionState): Promise<void> {
  if (!state.pageSessionId) return;
  try {
    const metrics = (await state.cdp.send(
      "Page.getLayoutMetrics",
      {},
      state.pageSessionId,
    )) as {
      cssVisualViewport?: { clientWidth?: number; clientHeight?: number };
      cssLayoutViewport?: { clientWidth?: number; clientHeight?: number };
      layoutViewport?: { clientWidth?: number; clientHeight?: number };
    };
    const vv = metrics.cssVisualViewport || metrics.cssLayoutViewport || metrics.layoutViewport;
    const w = Math.floor(Number(vv?.clientWidth || 0));
    const h = Math.floor(Number(vv?.clientHeight || 0));
    if (w > 0 && h > 0) {
      state.viewportW = w;
      state.viewportH = h;
    }
  } catch {
    /* keep previous */
  }
}

async function currentUrl(state: SessionState): Promise<string> {
  if (!state.pageSessionId) return state.url;
  try {
    const evaled = (await state.cdp.send(
      "Runtime.evaluate",
      { expression: "location.href", returnByValue: true },
      state.pageSessionId,
    )) as { result?: { value?: string } };
    const u = String(evaled.result?.value || "").trim();
    if (u) {
      state.url = u;
      return u;
    }
  } catch {
    /* ignore */
  }
  return state.url;
}

function pruneShots(dir: string): void {
  try {
    const files = readdirSync(dir)
      .filter((f) => f.startsWith("shot-") && f.endsWith(".jpg"))
      .map((f) => ({ f, p: join(dir, f) }))
      .sort((a, b) => b.f.localeCompare(a.f));
    for (const row of files.slice(MAX_SHOTS)) {
      try {
        unlinkSync(row.p);
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
}

function killProc(proc: ChildProcess): void {
  try {
    proc.kill("SIGTERM");
  } catch {
    /* ignore */
  }
  setTimeout(() => {
    try {
      if (!proc.killed) proc.kill("SIGKILL");
    } catch {
      /* ignore */
    }
  }, 2500);
}

function broadcastBrowser(msg: Record<string, unknown>): void {
  const raw = JSON.stringify(msg);
  for (const client of browserClients.values()) {
    try {
      client.send(raw);
    } catch {
      /* ignore */
    }
  }
}

function statusPayload(): Record<string, unknown> {
  const running = Boolean(session?.cdp.connected && session.proc.exitCode == null);
  return {
    ok: true,
    running,
    platform: process.platform,
    chromium: findChromium(),
    profileDir: PROFILE_DIR,
    shotsDir: SHOTS_DIR,
    port: running ? session!.port : null,
    url: running ? session!.url : null,
    viewport: running
      ? { width: session!.viewportW, height: session!.viewportH }
      : null,
    startedAt: running ? session!.startedAt : null,
    displayMode: running ? session!.displayMode : null,
    display: running ? session!.display : null,
    controller,
    askPending: askHuman
      ? { id: askHuman.id, prompt: askHuman.prompt, createdAt: askHuman.createdAt }
      : null,
    secretPending: secretPending
      ? {
          id: secretPending.id,
          label: secretPending.label,
          prompt: secretPending.prompt,
          kind: secretPending.kind,
          createdAt: secretPending.createdAt,
        }
      : null,
    emailPending: emailPending
      ? {
          id: emailPending.id,
          to: emailPending.to,
          subject: emailPending.subject,
          body: emailPending.body,
          createdAt: emailPending.createdAt,
        }
      : null,
    viewers: browserClients.size,
    guidance: BROWSER_GUIDANCE,
  };
}

function emitStatus(): void {
  broadcastBrowser({ type: "status", ...statusPayload() });
}

function assertAgentControl(): void {
  if (secretPending) {
    throw new Error(
      `Waiting on secure input: ${secretPending.label} — human must submit/cancel the secret card.`,
    );
  }
  if (emailPending) {
    throw new Error(
      `Waiting on email approval: ${emailPending.subject.slice(0, 80)} — human must Approve/Deny.`,
    );
  }
  if (askHuman) {
    throw new Error(
      `Waiting on human: ${askHuman.prompt.slice(0, 120)} — call resumes after Done in Chat.`,
    );
  }
  if (controller === "human") {
    throw new Error("Human has control in Chat Browser dock — wait for Release.");
  }
}

async function stopScreencast(state: SessionState): Promise<void> {
  if (!state.screencastOn || !state.pageSessionId) return;
  try {
    await state.cdp.send("Page.stopScreencast", {}, state.pageSessionId);
  } catch {
    /* ignore */
  }
  state.screencastOn = false;
}

async function ensureScreencast(state: SessionState): Promise<void> {
  if (!state.pageSessionId || state.screencastOn) return;
  if (browserClients.size === 0) return;
  try {
    await state.cdp.send(
      "Page.startScreencast",
      {
        format: "jpeg",
        quality: 55,
        maxWidth: 1280,
        maxHeight: 900,
        everyNthFrame: 1,
      },
      state.pageSessionId,
    );
    state.screencastOn = true;
  } catch (e) {
    appendTrace(
      "warn",
      `browser screencast start failed: ${e instanceof Error ? e.message : String(e)}`,
      "browser",
    );
  }
}

function wireCdpEvents(state: SessionState): void {
  state.cdp.setEventHandler((method, params, sid) => {
    if (method !== "Page.screencastFrame") return;
    if (sid && state.pageSessionId && sid !== state.pageSessionId) return;
    const p = params as {
      data?: string;
      sessionId?: number;
      metadata?: { deviceWidth?: number; deviceHeight?: number };
    };
    if (!p?.data) return;
    const jpeg = Buffer.from(p.data, "base64");
    lastFrameJpeg = jpeg;
    lastFrameAt = Date.now();
    const w = Math.floor(Number(p.metadata?.deviceWidth || state.viewportW));
    const h = Math.floor(Number(p.metadata?.deviceHeight || state.viewportH));
    if (w > 0) state.viewportW = w;
    if (h > 0) state.viewportH = h;
    broadcastBrowser({
      type: "frame",
      data: p.data,
      width: state.viewportW,
      height: state.viewportH,
      url: state.url,
      at: lastFrameAt,
    });
    const ackId = p.sessionId;
    if (ackId != null && state.pageSessionId) {
      void state.cdp
        .send(
          "Page.screencastFrameAck",
          { sessionId: ackId },
          state.pageSessionId,
        )
        .catch(() => {});
    }
  });
}

async function stopSession(reason: string): Promise<void> {
  const cur = session;
  session = null;
  starting = null;
  lastFrameJpeg = null;
  lastFrameAt = 0;
  if (askHuman) {
    askHuman = null;
  }
  if (secretPending) {
    clearTimeout(secretPending.timer);
    secretPending.resolve({
      ok: false,
      cancelled: true,
      error: "Browser session closed",
    });
    secretPending = null;
  }
  if (emailPending) {
    clearTimeout(emailPending.timer);
    emailPending.resolve({
      ok: false,
      cancelled: true,
      error: "Browser session closed",
    });
    emailPending = null;
  }
  clearObserveRefs();
  controller = "agent";
  if (!cur) {
    emitStatus();
    return;
  }
  try {
    await stopScreencast(cur);
  } catch {
    /* ignore */
  }
  try {
    await cur.cdp.close();
  } catch {
    /* ignore */
  }
  killProc(cur.proc);
  if (cur.xvfbProc) killProc(cur.xvfbProc);
  appendTrace("info", `browser session stopped (${reason})`, "browser");
  emitStatus();
}

function chromeBaseArgs(port: number, url: string): string[] {
  return [
    `--user-data-dir=${PROFILE_DIR}`,
    `--remote-debugging-port=${port}`,
    "--remote-debugging-address=127.0.0.1",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-sync",
    "--disable-background-networking",
    "--disable-dev-shm-usage",
    `--window-size=${WINDOW_W},${WINDOW_H}`,
    "--class=HomeBaseBrowser",
    "--name=Home Base Browser",
    url,
  ];
}

async function attachLaunchedChrome(opts: {
  proc: ChildProcess;
  xvfbProc: ChildProcess | null;
  port: number;
  binary: string;
  url: string;
  displayMode: BrowserDisplayMode;
  display: string | null;
}): Promise<SessionState> {
  const wsUrl = await waitForDebugger(opts.port);
  const cdp = new CdpClient();
  await cdp.connect(wsUrl);
  const page = await attachPage(cdp);
  const state: SessionState = {
    proc: opts.proc,
    xvfbProc: opts.xvfbProc,
    port: opts.port,
    binary: opts.binary,
    startedAt: Date.now(),
    url: opts.url,
    cdp,
    pageSessionId: page.pageSessionId,
    targetId: page.targetId,
    viewportW: WINDOW_W,
    viewportH: WINDOW_H - 80,
    screencastOn: false,
    displayMode: opts.displayMode,
    display: opts.display,
  };
  wireCdpEvents(state);
  if (opts.url && opts.url !== DEFAULT_URL) {
    try {
      await navigateOn(state, opts.url);
    } catch {
      await Bun.sleep(400);
    }
  }
  await refreshViewport(state);
  await currentUrl(state);
  await ensureScreencast(state);
  return state;
}

async function tryLaunchXvfb(
  binary: string,
  port: number,
  url: string,
): Promise<SessionState> {
  const xvfb = await startXvfb();
  const cmd = [binary, ...chromeBaseArgs(port, url)];
  const wrapped = wrapSeat(cmd, { display: xvfb.display, isolated: true });
  const proc = spawn(wrapped.cmd[0]!, wrapped.cmd.slice(1), {
    env: wrapped.env,
    stdio: "ignore",
    detached: false,
  });
  proc.on("exit", () => {
    if (session?.proc === proc) void stopSession("chrome-exit");
  });
  xvfb.proc.on("exit", () => {
    if (session?.xvfbProc === xvfb.proc) void stopSession("xvfb-exit");
  });
  try {
    return await attachLaunchedChrome({
      proc,
      xvfbProc: xvfb.proc,
      port,
      binary,
      url,
      displayMode: "xvfb",
      display: xvfb.display,
    });
  } catch (e) {
    killProc(proc);
    killProc(xvfb.proc);
    throw e;
  }
}

async function tryLaunchHeadless(
  binary: string,
  port: number,
  url: string,
): Promise<SessionState> {
  const cmd = [
    binary,
    "--headless=new",
    "--ozone-platform=headless",
    ...chromeBaseArgs(port, url),
  ];
  // Headless still wants a DISPLAY on some builds; point at a dummy if none.
  const seatDisplay = discoverX11Env().display || process.env.DISPLAY || "";
  const wrapped = wrapSeat(cmd, {
    display: seatDisplay || ":0",
    isolated: true,
  });
  const proc = spawn(wrapped.cmd[0]!, wrapped.cmd.slice(1), {
    env: wrapped.env,
    stdio: "ignore",
    detached: false,
  });
  proc.on("exit", () => {
    if (session?.proc === proc) void stopSession("chrome-exit");
  });
  try {
    return await attachLaunchedChrome({
      proc,
      xvfbProc: null,
      port,
      binary,
      url,
      displayMode: "headless",
      display: null,
    });
  } catch (e) {
    killProc(proc);
    throw e;
  }
}

async function tryLaunchSeat(
  binary: string,
  port: number,
  url: string,
): Promise<SessionState> {
  const { display } = discoverX11Env();
  if (!display && !process.env.DISPLAY) {
    throw new Error("No seat DISPLAY available for Chrome fallback");
  }
  const cmd = [binary, ...chromeBaseArgs(port, url)];
  const wrapped = wrapSeat(cmd, { isolated: false });
  const proc = spawn(wrapped.cmd[0]!, wrapped.cmd.slice(1), {
    env: wrapped.env,
    stdio: "ignore",
    detached: false,
  });
  proc.on("exit", () => {
    if (session?.proc === proc) void stopSession("chrome-exit");
  });
  try {
    return await attachLaunchedChrome({
      proc,
      xvfbProc: null,
      port,
      binary,
      url,
      displayMode: "seat",
      display: wrapped.env.DISPLAY || display || null,
    });
  } catch (e) {
    killProc(proc);
    throw e;
  }
}

async function launchSession(initialUrl?: string): Promise<SessionState> {
  if (process.platform !== "linux") {
    throw new Error("Isolated Chrome requires Linux");
  }
  ensureDirs();
  const binary = findChromium();
  if (!binary) {
    throw new Error(
      "Chrome/Chromium not found. Install google-chrome-stable or chromium.",
    );
  }

  const url = (initialUrl || DEFAULT_URL).trim() || DEFAULT_URL;
  const errors: string[] = [];

  // 1) Xvfb virtual display — preferred (desktop stays free).
  if (Bun.which("Xvfb")) {
    try {
      const port = await findFreePort();
      const state = await tryLaunchXvfb(binary, port, url);
      appendTrace(
        "info",
        `browser session started mode=xvfb display=${state.display} port=${port} binary=${binary}`,
        "browser",
      );
      emitStatus();
      return state;
    } catch (e) {
      errors.push(`xvfb: ${e instanceof Error ? e.message : String(e)}`);
    }
  } else {
    errors.push("xvfb: Xvfb not installed");
  }

  // 2) Headless — no window on seat.
  try {
    const port = await findFreePort();
    const state = await tryLaunchHeadless(binary, port, url);
    appendTrace(
      "info",
      `browser session started mode=headless port=${port} binary=${binary}`,
      "browser",
    );
    emitStatus();
    return state;
  } catch (e) {
    errors.push(`headless: ${e instanceof Error ? e.message : String(e)}`);
  }

  // 3) Seat DISPLAY — last resort only.
  try {
    const port = await findFreePort();
    const state = await tryLaunchSeat(binary, port, url);
    appendTrace(
      "warn",
      `browser session started mode=seat display=${state.display} port=${port} (fallback)`,
      "browser",
    );
    emitStatus();
    return state;
  } catch (e) {
    errors.push(`seat: ${e instanceof Error ? e.message : String(e)}`);
  }

  throw new Error(
    `Could not start isolated Chrome (${errors.join("; ")}). Install xvfb + chrome, or ensure a seat DISPLAY.`,
  );
}

async function navigateOn(state: SessionState, url: string): Promise<void> {
  clearObserveRefs();
  if (!state.pageSessionId) throw new Error("no page session");
  await state.cdp.send("Page.navigate", { url }, state.pageSessionId);
  await Bun.sleep(350);
  await refreshViewport(state);
  await currentUrl(state);
}

async function ensureSession(opts: { url?: string } = {}): Promise<SessionState> {
  if (session?.cdp.connected && session.proc.exitCode == null) {
    if (opts.url) await navigateOn(session, String(opts.url).trim());
    return session;
  }
  if (starting) return starting;
  starting = (async () => {
    if (session) await stopSession("relaunch");
    const next = await launchSession(opts.url);
    session = next;
    return next;
  })();
  try {
    return await starting;
  } finally {
    starting = null;
  }
}

function resolvePoint(
  state: SessionState,
  args: {
    x?: number;
    y?: number;
    px?: number;
    py?: number;
  },
): { x: number; y: number } {
  const hasNorm = args.x != null && args.y != null;
  const hasPx = args.px != null && args.py != null;
  if (hasPx) {
    return { x: Number(args.px), y: Number(args.py) };
  }
  if (hasNorm) {
    const nx = Math.max(0, Math.min(1, Number(args.x)));
    const ny = Math.max(0, Math.min(1, Number(args.y)));
    return {
      x: nx * state.viewportW,
      y: ny * state.viewportH,
    };
  }
  throw new Error("Provide x,y (0..1) or px,py");
}

const KEY_MAP: Record<string, { key: string; code: string; text?: string; windowsVirtualKeyCode?: number }> = {
  enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 },
  return: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 },
  escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  esc: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
  backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
  delete: { key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 },
  space: { key: " ", code: "Space", text: " ", windowsVirtualKeyCode: 32 },
  up: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
  down: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
  left: { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 },
  right: { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 },
  home: { key: "Home", code: "Home", windowsVirtualKeyCode: 36 },
  end: { key: "End", code: "End", windowsVirtualKeyCode: 35 },
  pageup: { key: "PageUp", code: "PageUp", windowsVirtualKeyCode: 33 },
  pagedown: { key: "PageDown", code: "PageDown", windowsVirtualKeyCode: 34 },
  ctrl: { key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17 },
  control: { key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17 },
  alt: { key: "Alt", code: "AltLeft", windowsVirtualKeyCode: 18 },
  shift: { key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16 },
  meta: { key: "Meta", code: "MetaLeft", windowsVirtualKeyCode: 91 },
  super: { key: "Meta", code: "MetaLeft", windowsVirtualKeyCode: 91 },
  cmd: { key: "Meta", code: "MetaLeft", windowsVirtualKeyCode: 91 },
};

function resolveKey(name: string): {
  key: string;
  code: string;
  text?: string;
  windowsVirtualKeyCode?: number;
} {
  const raw = String(name || "").trim();
  if (!raw) throw new Error("key required");
  const lower = raw.toLowerCase();
  if (KEY_MAP[lower]) return KEY_MAP[lower]!;
  if (raw.length === 1) {
    const upper = raw.toUpperCase();
    const isLetter = /^[a-z]$/i.test(raw);
    return {
      key: raw,
      code: isLetter ? `Key${upper}` : raw,
      text: raw,
      windowsVirtualKeyCode: isLetter ? upper.charCodeAt(0) : raw.charCodeAt(0),
    };
  }
  if (/^f([1-9]|1[0-2])$/i.test(raw)) {
    const n = raw.slice(1);
    return { key: `F${n}`, code: `F${n}`, windowsVirtualKeyCode: 111 + Number(n) };
  }
  return { key: raw, code: raw };
}

export function browserStatus(): Record<string, unknown> {
  ensureDirs();
  return statusPayload();
}

export function browserViewerCount(): number {
  return browserClients.size;
}

export async function browserHubConnect(client: {
  send: (payload: string | Buffer | Uint8Array) => void;
}): Promise<{ id: number }> {
  const id = nextClientId++;
  const row: BrowserClient = { id, send: client.send };
  (client as { __browserId?: number }).__browserId = id;
  browserClients.set(id, row);
  try {
    client.send(JSON.stringify({ type: "hello", ...statusPayload() }));
  } catch {
    /* ignore */
  }
  if (lastFrameJpeg) {
    try {
      client.send(
        JSON.stringify({
          type: "frame",
          data: lastFrameJpeg.toString("base64"),
          width: session?.viewportW || WINDOW_W,
          height: session?.viewportH || WINDOW_H,
          url: session?.url || null,
          at: lastFrameAt,
        }),
      );
    } catch {
      /* ignore */
    }
  }
  if (session) void ensureScreencast(session);
  emitStatus();
  return { id };
}

export async function browserHubDisconnect(client: {
  send: (payload: string | Buffer | Uint8Array) => void;
  __browserId?: number;
}): Promise<void> {
  const id = client.__browserId;
  if (id != null) browserClients.delete(id);
  if (browserClients.size === 0 && session) {
    await stopScreencast(session);
  }
  emitStatus();
}

export async function browserHubHandleMessage(
  _client: { send: (payload: string | Buffer | Uint8Array) => void },
  msg: Record<string, unknown>,
): Promise<void> {
  const type = String(msg.type || "");
  if (type === "ping") {
    broadcastBrowser({ type: "pong", at: Date.now() });
    return;
  }
  if (type === "status") {
    emitStatus();
  }
}

export async function browserTakeControl(): Promise<Record<string, unknown>> {
  if (!session?.cdp.connected) {
    throw new Error("Isolated Chrome is not running");
  }
  controller = "human";
  emitStatus();
  return { ok: true, ...statusPayload() };
}

export async function browserReleaseControl(): Promise<Record<string, unknown>> {
  controller = "agent";
  emitStatus();
  return { ok: true, ...statusPayload() };
}

/** Agent/MCP: pause for human (login etc). Blocks until Done/Cancel via ask resolve. */
export async function browserAskHuman(opts: {
  prompt: string;
  agentId?: string;
}): Promise<Record<string, unknown>> {
  const prompt = String(opts.prompt || "").trim();
  if (!prompt) throw new Error("prompt required");
  if (askHuman) {
    throw new Error("Already waiting on a human assist — finish or cancel that first.");
  }
  await ensureSession();
  controller = "human";
  const { requestApproval } = await import("./approvals");
  const id = `browser-${Date.now().toString(36)}`;
  askHuman = { id, prompt, createdAt: Date.now() };
  emitStatus();
  const result = await requestApproval({
    kind: "browser_assist",
    tool: "homebase_browser_ask_human",
    detail: prompt,
    agentId: opts.agentId,
  });
  askHuman = null;
  if (result.permission === "allow") {
    controller = "agent";
    emitStatus();
    return {
      ok: true,
      done: true,
      prompt,
      hint: "Human finished — continue with screenshot → act.",
    };
  }
  controller = "agent";
  emitStatus();
  return {
    ok: false,
    done: false,
    cancelled: true,
    prompt,
    error: result.agent_message || "Human cancelled or timed out",
  };
}

/** Resolve ask-human from Chat UI (also used by approvals resolve path). */
export function browserClearAskPending(): void {
  askHuman = null;
  emitStatus();
}

/**
 * Grok-style secure secret card: human types password/key in Chat (masked).
 * Value is typed into the focused Chrome field via CDP and never returned,
 * logged, or stored in chat history.
 */
export async function browserAskSecret(opts: {
  label?: string;
  prompt?: string;
  kind?: string;
  pressEnter?: boolean;
}): Promise<Record<string, unknown>> {
  const label = String(opts.label || "Secret").trim().slice(0, 80) || "Secret";
  const prompt = String(
    opts.prompt ||
      "Enter the value securely. It is typed into Isolated Chrome and never kept in chat.",
  )
    .trim()
    .slice(0, 400);
  const kind = String(opts.kind || "password").toLowerCase() === "text" ? "text" : "password";
  const pressEnter = opts.pressEnter !== false;
  if (secretPending) {
    throw new Error("Already waiting on a secure secret — finish or cancel that first.");
  }
  await ensureSession();

  const { cursorSubscriberCount, broadcastAllCursor } = await import("./cursor");
  const listeners = cursorSubscriberCount() + browserClients.size;
  if (listeners === 0) {
    return {
      ok: false,
      cancelled: true,
      error: "Denied — open Chat to submit the secure secret card",
    };
  }

  const id = `bsec-${Date.now().toString(36)}`;
  const createdAt = Date.now();
  appendTrace("info", `browser secret requested label=${label} kind=${kind}`, "browser");

  const result = await new Promise<{
    ok: boolean;
    cancelled?: boolean;
    charsTyped?: number;
    error?: string;
  }>((resolve) => {
    const timer = setTimeout(() => {
      if (secretPending?.id === id) {
        secretPending = null;
        emitStatus();
        void broadcastAllCursor({
          type: "browser-secret-ack",
          id,
          ok: false,
          timedOut: true,
        });
        resolve({
          ok: false,
          cancelled: true,
          error: "Secure input timed out",
        });
      }
    }, 560_000);
    secretPending = {
      id,
      label,
      prompt,
      kind,
      pressEnter,
      createdAt,
      resolve: (r) => {
        clearTimeout(timer);
        resolve(r);
      },
      timer,
    };
    emitStatus();
    void broadcastAllCursor({
      type: "browser-secret-request",
      id,
      label,
      prompt,
      kind,
      pressEnter,
      createdAt: createdAt / 1000,
    });
  });

  return {
    ...result,
    label,
    kind,
    hint: result.ok
      ? "Secret typed into Chrome (not stored). Continue with screenshot."
      : undefined,
  };
}

/** Chat WS: inject secret into focused field. Value is never logged. */
export async function browserResolveSecret(
  id: string,
  secret: string,
): Promise<Record<string, unknown>> {
  const pending = secretPending;
  if (!pending || (id && pending.id !== id)) {
    return { ok: false, error: "No matching secure secret request" };
  }
  const value = String(secret ?? "");
  if (!value) return { ok: false, error: "secret required" };

  try {
    const state = await ensureSession();
    if (!state.pageSessionId) throw new Error("no page session");
    const inserted = await insertTextIntoFocused(state, value);
    const charsTyped = inserted.chars;
    if (pending.pressEnter) {
      const k = resolveKey("Enter");
      const sid = state.pageSessionId!;
      await state.cdp.send(
        "Input.dispatchKeyEvent",
        {
          type: "rawKeyDown",
          key: k.key,
          code: k.code,
          windowsVirtualKeyCode: k.windowsVirtualKeyCode,
          nativeVirtualKeyCode: k.windowsVirtualKeyCode,
        },
        sid,
      );
      await state.cdp.send(
        "Input.dispatchKeyEvent",
        {
          type: "keyUp",
          key: k.key,
          code: k.code,
          windowsVirtualKeyCode: k.windowsVirtualKeyCode,
          nativeVirtualKeyCode: k.windowsVirtualKeyCode,
        },
        sid,
      );
    }
    clearTimeout(pending.timer);
    secretPending = null;
    emitStatus();
    pending.resolve({ ok: true, charsTyped });
    appendTrace(
      "info",
      `browser secret typed label=${pending.label} chars=${charsTyped}`,
      "browser",
    );
    return { ok: true, charsTyped, label: pending.label };
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    clearTimeout(pending.timer);
    secretPending = null;
    emitStatus();
    pending.resolve({ ok: false, error: err });
    return { ok: false, error: err };
  }
}

export function browserDenySecret(id?: string): Record<string, unknown> {
  const pending = secretPending;
  if (!pending || (id && pending.id !== id)) {
    return { ok: false, error: "No matching secure secret request" };
  }
  clearTimeout(pending.timer);
  secretPending = null;
  emitStatus();
  pending.resolve({
    ok: false,
    cancelled: true,
    error: "Denied by user",
  });
  appendTrace("info", `browser secret denied label=${pending.label}`, "browser");
  return { ok: true, denied: true, label: pending.label };
}

export async function browserOpen(opts: {
  url?: string;
  reset?: boolean;
} = {}): Promise<Record<string, unknown>> {
  if (opts.reset) {
    await stopSession("reset");
    ensureDirs();
    try {
      rmSync(PROFILE_DIR, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    ensureDirs();
  }
  const state = await ensureSession({ url: opts.url });
  return {
    ok: true,
    running: true,
    url: await currentUrl(state),
    port: state.port,
    profileDir: PROFILE_DIR,
    viewport: { width: state.viewportW, height: state.viewportH },
    controller,
    displayMode: state.displayMode,
    display: state.display,
    reset: Boolean(opts.reset),
    hint: "Use homebase_browser_screenshot then click/type. Profile is isolated to Home Base. Human can watch in Chat Browser dock.",
  };
}

export async function browserClose(): Promise<Record<string, unknown>> {
  await stopSession("close");
  return { ok: true, running: false };
}

export async function browserNavigate(opts: {
  url: string;
}): Promise<Record<string, unknown>> {
  assertAgentControl();
  const url = String(opts.url || "").trim();
  if (!url) throw new Error("url required");
  const state = await ensureSession();
  await navigateOn(state, url);
  emitStatus();
  return {
    ok: true,
    url: await currentUrl(state),
    viewport: { width: state.viewportW, height: state.viewportH },
  };
}

export async function browserScreenshot(opts: {
  quality?: number;
  fullPage?: boolean;
} = {}): Promise<Record<string, unknown>> {
  const state = await ensureSession();
  if (!state.pageSessionId) throw new Error("no page session");
  await refreshViewport(state);
  const quality = Math.max(
    30,
    Math.min(90, Math.floor(Number(opts.quality ?? 72))),
  );
  const result = (await state.cdp.send(
    "Page.captureScreenshot",
    {
      format: "jpeg",
      quality,
      fromSurface: true,
      captureBeyondViewport: Boolean(opts.fullPage),
    },
    state.pageSessionId,
  )) as { data?: string };
  if (!result.data) throw new Error("empty screenshot");
  const jpeg = Buffer.from(result.data, "base64");
  ensureDirs();
  const stamp = Date.now();
  const path = join(SHOTS_DIR, `shot-${stamp}.jpg`);
  const latest = join(SHOTS_DIR, "latest.jpg");
  writeFileSync(path, jpeg, { mode: 0o600 });
  try {
    writeFileSync(latest, jpeg, { mode: 0o600 });
    chmodSync(latest, 0o600);
  } catch {
    /* ignore */
  }
  pruneShots(SHOTS_DIR);
  const href = await currentUrl(state);
  return {
    ok: true,
    path,
    latest,
    bytes: jpeg.length,
    width: state.viewportW,
    height: state.viewportH,
    url: href,
    hint:
      "Pixels only — prefer homebase_browser_observe for refs/text (cheaper). " +
      "If you Read this image, click with x,y 0..1 or ref from a prior observe.",
  };
}

type FocusProbe = {
  editable: boolean;
  tag: string;
  role: string;
  type: string;
  name: string;
  valueLen: number;
};

async function probeFocusedEditable(state: SessionState): Promise<FocusProbe> {
  const empty: FocusProbe = {
    editable: false,
    tag: "",
    role: "",
    type: "",
    name: "",
    valueLen: 0,
  };
  if (!state.pageSessionId) return empty;
  try {
    const result = (await state.cdp.send(
      "Runtime.evaluate",
      {
        expression: `(() => {
          const el = document.activeElement;
          if (!el) return { editable: false, tag: '', role: '', type: '', name: '', valueLen: 0 };
          const tag = String(el.tagName || '').toLowerCase();
          const role = String(el.getAttribute('role') || '');
          const type = String((el.getAttribute && el.getAttribute('type')) || el.type || '').toLowerCase();
          const name = String(
            el.getAttribute('aria-label') ||
              el.getAttribute('name') ||
              el.getAttribute('placeholder') ||
              ''
          ).slice(0, 80);
          const isCe = el.isContentEditable === true || String(el.getAttribute('contenteditable') || '') === 'true';
          const editable =
            isCe ||
            tag === 'textarea' ||
            tag === 'input' ||
            role === 'textbox' ||
            role === 'searchbox' ||
            role === 'combobox';
          let valueLen = 0;
          try {
            if (typeof el.value === 'string') valueLen = el.value.length;
            else if (isCe) valueLen = String(el.innerText || '').length;
          } catch (_) {}
          return { editable: !!editable, tag, role, type, name, valueLen };
        })()`,
        returnByValue: true,
      },
      state.pageSessionId,
    )) as { result?: { value?: FocusProbe } };
    const v = result?.result?.value;
    if (!v || typeof v !== "object") return empty;
    return {
      editable: Boolean(v.editable),
      tag: String(v.tag || ""),
      role: String(v.role || ""),
      type: String(v.type || ""),
      name: String(v.name || ""),
      valueLen: Math.max(0, Math.floor(Number(v.valueLen) || 0)),
    };
  } catch {
    return empty;
  }
}

/** Insert text into the focused Chrome field (insertText + char fallback). */
async function insertTextIntoFocused(
  state: SessionState,
  text: string,
): Promise<{ chars: number; focus: FocusProbe }> {
  if (!state.pageSessionId) throw new Error("no page session");
  const sid = state.pageSessionId;
  const focusBefore = await probeFocusedEditable(state);
  try {
    await state.cdp.send("Input.insertText", { text }, sid);
  } catch {
    /* fall through to char events */
  }
  let focusAfter = await probeFocusedEditable(state);
  const grew =
    focusAfter.valueLen > focusBefore.valueLen ||
    (focusBefore.editable && text.length > 0);
  if (!grew && text.length > 0) {
    for (const ch of text) {
      if (ch === "\n") {
        const k = resolveKey("Enter");
        await state.cdp.send(
          "Input.dispatchKeyEvent",
          {
            type: "rawKeyDown",
            key: k.key,
            code: k.code,
            windowsVirtualKeyCode: k.windowsVirtualKeyCode,
            nativeVirtualKeyCode: k.windowsVirtualKeyCode,
          },
          sid,
        );
        await state.cdp.send(
          "Input.dispatchKeyEvent",
          {
            type: "keyUp",
            key: k.key,
            code: k.code,
            windowsVirtualKeyCode: k.windowsVirtualKeyCode,
            nativeVirtualKeyCode: k.windowsVirtualKeyCode,
          },
          sid,
        );
        continue;
      }
      await state.cdp.send(
        "Input.dispatchKeyEvent",
        {
          type: "keyDown",
          key: ch,
          text: ch,
          unmodifiedText: ch,
        },
        sid,
      );
      await state.cdp.send(
        "Input.dispatchKeyEvent",
        {
          type: "char",
          key: ch,
          text: ch,
          unmodifiedText: ch,
        },
        sid,
      );
      await state.cdp.send(
        "Input.dispatchKeyEvent",
        {
          type: "keyUp",
          key: ch,
          text: ch,
          unmodifiedText: ch,
        },
        sid,
      );
    }
    focusAfter = await probeFocusedEditable(state);
  }
  return { chars: text.length, focus: focusAfter };
}

export async function browserClick(opts: {
  x?: number;
  y?: number;
  px?: number;
  py?: number;
  /** Element ref from homebase_browser_observe (e.g. "e3"). */
  ref?: string;
  button?: string | number;
  clickCount?: number;
  /** When true, skip agent-control gate (Chat takeover). */
  asHuman?: boolean;
}): Promise<Record<string, unknown>> {
  if (!opts.asHuman) assertAgentControl();
  else if (controller !== "human") {
    throw new Error("Take control in Chat before sending human input");
  }
  const state = await ensureSession();
  if (!state.pageSessionId) throw new Error("no page session");
  await refreshViewport(state);
  const refKey = opts.ref != null ? String(opts.ref).trim() : "";
  if (refKey) {
    const hit = lastObserveRefs.get(refKey);
    if (!hit) {
      throw new Error(
        `Unknown ref "${refKey}" — call homebase_browser_observe first (refs reset on navigate).`,
      );
    }
    opts = { ...opts, px: hit.px, py: hit.py, x: undefined, y: undefined };
  }
  const pt = resolvePoint(state, opts);
  const buttonRaw = opts.button;
  const button =
    buttonRaw === 1 || buttonRaw === "middle"
      ? "middle"
      : buttonRaw === 2 || buttonRaw === "right"
        ? "right"
        : "left";
  const clickCount = Math.max(1, Math.min(3, Math.floor(Number(opts.clickCount ?? 1))));
  const sid = state.pageSessionId;
  await state.cdp.send(
    "Input.dispatchMouseEvent",
    { type: "mouseMoved", x: pt.x, y: pt.y },
    sid,
  );
  await state.cdp.send(
    "Input.dispatchMouseEvent",
    {
      type: "mousePressed",
      x: pt.x,
      y: pt.y,
      button,
      clickCount,
    },
    sid,
  );
  await state.cdp.send(
    "Input.dispatchMouseEvent",
    {
      type: "mouseReleased",
      x: pt.x,
      y: pt.y,
      button,
      clickCount,
    },
    sid,
  );
  // Let the page settle focus (Gmail compose chips, etc.).
  await sleep(80);
  const focus = await probeFocusedEditable(state);
  return {
    ok: true,
    x: pt.x,
    y: pt.y,
    button,
    viewport: { width: state.viewportW, height: state.viewportH },
    focus,
    openTypeOverlay: Boolean(opts.asHuman && focus.editable),
  };
}

export async function browserType(opts: {
  text: string;
  asHuman?: boolean;
  pressEnter?: boolean;
}): Promise<Record<string, unknown>> {
  if (!opts.asHuman) assertAgentControl();
  else if (controller !== "human") {
    throw new Error("Take control in Chat before sending human input");
  }
  const text = String(opts.text ?? "");
  if (!text) throw new Error("text required");
  const state = await ensureSession();
  if (!state.pageSessionId) throw new Error("no page session");
  const focusBefore = await probeFocusedEditable(state);
  if (!focusBefore.editable) {
    throw new Error(
      "No editable field focused in Chrome — click an input in the preview first, then type.",
    );
  }
  const inserted = await insertTextIntoFocused(state, text);
  if (opts.pressEnter) {
    const k = resolveKey("Enter");
    const sid = state.pageSessionId;
    await state.cdp.send(
      "Input.dispatchKeyEvent",
      {
        type: "rawKeyDown",
        key: k.key,
        code: k.code,
        windowsVirtualKeyCode: k.windowsVirtualKeyCode,
        nativeVirtualKeyCode: k.windowsVirtualKeyCode,
      },
      sid,
    );
    await state.cdp.send(
      "Input.dispatchKeyEvent",
      {
        type: "keyUp",
        key: k.key,
        code: k.code,
        windowsVirtualKeyCode: k.windowsVirtualKeyCode,
        nativeVirtualKeyCode: k.windowsVirtualKeyCode,
      },
      sid,
    );
  }
  return {
    ok: true,
    chars: inserted.chars,
    focus: inserted.focus,
    pressEnter: Boolean(opts.pressEnter),
  };
}

export async function browserKey(opts: {
  key: string;
  action?: string;
  asHuman?: boolean;
}): Promise<Record<string, unknown>> {
  if (!opts.asHuman) assertAgentControl();
  else if (controller !== "human") {
    throw new Error("Take control in Chat before sending human input");
  }
  const state = await ensureSession();
  if (!state.pageSessionId) throw new Error("no page session");
  const k = resolveKey(opts.key);
  const action = String(opts.action || "press").toLowerCase();
  const sid = state.pageSessionId;
  const base = {
    key: k.key,
    code: k.code,
    windowsVirtualKeyCode: k.windowsVirtualKeyCode,
    nativeVirtualKeyCode: k.windowsVirtualKeyCode,
    text: k.text,
    unmodifiedText: k.text,
  };
  if (action === "down") {
    await state.cdp.send(
      "Input.dispatchKeyEvent",
      { type: "keyDown", ...base },
      sid,
    );
  } else if (action === "up") {
    await state.cdp.send(
      "Input.dispatchKeyEvent",
      { type: "keyUp", ...base },
      sid,
    );
  } else {
    await state.cdp.send(
      "Input.dispatchKeyEvent",
      { type: k.text ? "keyDown" : "rawKeyDown", ...base },
      sid,
    );
    if (k.text) {
      await state.cdp.send(
        "Input.dispatchKeyEvent",
        { type: "char", ...base },
        sid,
      );
    }
    await state.cdp.send(
      "Input.dispatchKeyEvent",
      { type: "keyUp", ...base },
      sid,
    );
  }
  return { ok: true, key: k.key, action };
}

export async function browserHotkey(opts: {
  keys: string[];
  asHuman?: boolean;
}): Promise<Record<string, unknown>> {
  if (!opts.asHuman) assertAgentControl();
  else if (controller !== "human") {
    throw new Error("Take control in Chat before sending human input");
  }
  const keys = (opts.keys || []).map((k) => String(k));
  if (!keys.length) throw new Error("keys required");
  const state = await ensureSession();
  if (!state.pageSessionId) throw new Error("no page session");
  const sid = state.pageSessionId;
  const resolved = keys.map(resolveKey);
  const modifiers = {
    alt: false,
    ctrl: false,
    meta: false,
    shift: false,
  };
  const isMod = (k: string) =>
    ["Control", "Alt", "Shift", "Meta"].includes(k);
  // Press modifiers first, then non-mod, reverse on release.
  for (const k of resolved) {
    if (k.key === "Control") modifiers.ctrl = true;
    if (k.key === "Alt") modifiers.alt = true;
    if (k.key === "Shift") modifiers.shift = true;
    if (k.key === "Meta") modifiers.meta = true;
    const modBits =
      (modifiers.alt ? 1 : 0) |
      (modifiers.ctrl ? 2 : 0) |
      (modifiers.meta ? 4 : 0) |
      (modifiers.shift ? 8 : 0);
    await state.cdp.send(
      "Input.dispatchKeyEvent",
      {
        type: isMod(k.key) ? "keyDown" : k.text ? "keyDown" : "rawKeyDown",
        key: k.key,
        code: k.code,
        windowsVirtualKeyCode: k.windowsVirtualKeyCode,
        nativeVirtualKeyCode: k.windowsVirtualKeyCode,
        text: isMod(k.key) ? undefined : k.text,
        unmodifiedText: isMod(k.key) ? undefined : k.text,
        modifiers: modBits,
      },
      sid,
    );
  }
  for (const k of [...resolved].reverse()) {
    if (k.key === "Control") modifiers.ctrl = false;
    if (k.key === "Alt") modifiers.alt = false;
    if (k.key === "Shift") modifiers.shift = false;
    if (k.key === "Meta") modifiers.meta = false;
    const modBits =
      (modifiers.alt ? 1 : 0) |
      (modifiers.ctrl ? 2 : 0) |
      (modifiers.meta ? 4 : 0) |
      (modifiers.shift ? 8 : 0);
    await state.cdp.send(
      "Input.dispatchKeyEvent",
      {
        type: "keyUp",
        key: k.key,
        code: k.code,
        windowsVirtualKeyCode: k.windowsVirtualKeyCode,
        nativeVirtualKeyCode: k.windowsVirtualKeyCode,
        modifiers: modBits,
      },
      sid,
    );
  }
  return { ok: true, keys };
}

export async function browserScroll(opts: {
  deltaX?: number;
  deltaY?: number;
  x?: number;
  y?: number;
  px?: number;
  py?: number;
  asHuman?: boolean;
}): Promise<Record<string, unknown>> {
  if (!opts.asHuman) assertAgentControl();
  else if (controller !== "human") {
    throw new Error("Take control in Chat before sending human input");
  }
  const state = await ensureSession();
  if (!state.pageSessionId) throw new Error("no page session");
  await refreshViewport(state);
  let x = state.viewportW / 2;
  let y = state.viewportH / 2;
  try {
    const pt = resolvePoint(state, opts);
    x = pt.x;
    y = pt.y;
  } catch {
    /* center */
  }
  const deltaX = Number(opts.deltaX ?? 0);
  const deltaY = Number(opts.deltaY ?? 0);
  await state.cdp.send(
    "Input.dispatchMouseEvent",
    {
      type: "mouseWheel",
      x,
      y,
      deltaX,
      deltaY,
    },
    state.pageSessionId,
  );
  return { ok: true, x, y, deltaX, deltaY };
}

/**
 * Cheap structured "see" for models: interactive refs + focus + text excerpt.
 * Prefer this over screenshot unless pixels are required.
 */
export async function browserObserve(opts: {
  maxElements?: number;
  textMax?: number;
  shot?: boolean;
  quality?: number;
} = {}): Promise<Record<string, unknown>> {
  assertAgentControl();
  const state = await ensureSession();
  if (!state.pageSessionId) throw new Error("no page session");
  await refreshViewport(state);
  const maxElements = Math.max(
    5,
    Math.min(80, Math.floor(Number(opts.maxElements ?? 40))),
  );
  const textMax = Math.max(
    200,
    Math.min(8000, Math.floor(Number(opts.textMax ?? 2500))),
  );
  const sid = state.pageSessionId;

  const evaluated = (await state.cdp.send(
    "Runtime.evaluate",
    {
      expression: `(() => {
        const maxE = ${maxElements};
        const textMax = ${textMax};
        const vw = window.innerWidth || 1;
        const vh = window.innerHeight || 1;
        const isVisible = (el) => {
          const r = el.getBoundingClientRect();
          if (r.width < 2 || r.height < 2) return false;
          if (r.bottom < 0 || r.right < 0 || r.top > vh || r.left > vw) return false;
          const st = window.getComputedStyle(el);
          if (st.visibility === 'hidden' || st.display === 'none' || Number(st.opacity) === 0) return false;
          return true;
        };
        const roleOf = (el) => {
          const explicit = el.getAttribute('role');
          if (explicit) return explicit;
          const tag = el.tagName.toLowerCase();
          if (tag === 'a') return 'link';
          if (tag === 'button') return 'button';
          if (tag === 'input') {
            const t = (el.getAttribute('type') || 'text').toLowerCase();
            if (t === 'submit' || t === 'button') return 'button';
            if (t === 'checkbox') return 'checkbox';
            if (t === 'radio') return 'radio';
            return 'textbox';
          }
          if (tag === 'textarea') return 'textbox';
          if (tag === 'select') return 'combobox';
          if (el.isContentEditable) return 'textbox';
          return tag;
        };
        const nameOf = (el) => {
          const bits = [
            el.getAttribute('aria-label'),
            el.getAttribute('placeholder'),
            el.getAttribute('name'),
            el.getAttribute('title'),
            el.innerText,
            el.textContent,
            el.value,
          ];
          for (const b of bits) {
            const s = String(b || '').replace(/\\s+/g, ' ').trim();
            if (s) return s.slice(0, 80);
          }
          return '';
        };
        const sel = 'a[href], button, input:not([type=hidden]), textarea, select, [role=button], [role=link], [role=tab], [role=menuitem], [role=textbox], [role=checkbox], [role=switch], [contenteditable=true], [g_editable=true]';
        const nodes = [...document.querySelectorAll(sel)].filter(isVisible);
        // Prefer named / actionable; drop empty generic divs.
        const scored = nodes.map((el, i) => {
          const name = nameOf(el);
          const role = roleOf(el);
          const r = el.getBoundingClientRect();
          const score = (name ? 2 : 0) + (role === 'textbox' || role === 'button' || role === 'link' ? 1 : 0);
          return { el, name, role, r, score, i };
        }).filter((x) => x.name || x.role === 'textbox' || x.role === 'button' || x.role === 'link' || x.role === 'tab');
        scored.sort((a, b) => b.score - a.score || a.i - b.i);
        const picked = scored.slice(0, maxE);
        const elements = picked.map((x, idx) => {
          const ref = 'e' + (idx + 1);
          const cx = x.r.left + x.r.width / 2;
          const cy = x.r.top + x.r.height / 2;
          let value = '';
          try {
            if (typeof x.el.value === 'string') value = String(x.el.value).slice(0, 120);
          } catch (_) {}
          return {
            ref,
            role: x.role,
            name: x.name,
            tag: String(x.el.tagName || '').toLowerCase(),
            x: Math.max(0, Math.min(1, cx / vw)),
            y: Math.max(0, Math.min(1, cy / vh)),
            px: Math.round(cx),
            py: Math.round(cy),
            value: value || undefined,
          };
        });
        const ae = document.activeElement;
        let focus = null;
        if (ae) {
          const fr = ae.getBoundingClientRect();
          focus = {
            tag: String(ae.tagName || '').toLowerCase(),
            role: roleOf(ae),
            name: nameOf(ae).slice(0, 80),
            editable: !!(ae.isContentEditable || ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA'),
            x: Math.max(0, Math.min(1, (fr.left + fr.width / 2) / vw)),
            y: Math.max(0, Math.min(1, (fr.top + fr.height / 2) / vh)),
          };
        }
        const text = String(document.body && document.body.innerText || '')
          .replace(/\\s+/g, ' ')
          .trim()
          .slice(0, textMax);
        return {
          title: document.title || '',
          url: location.href,
          elements,
          focus,
          text,
        };
      })()`,
      returnByValue: true,
    },
    sid,
  )) as {
    result?: {
      value?: {
        title?: string;
        url?: string;
        elements?: Array<{
          ref: string;
          role: string;
          name: string;
          tag: string;
          x: number;
          y: number;
          px: number;
          py: number;
          value?: string;
        }>;
        focus?: Record<string, unknown> | null;
        text?: string;
      };
    };
  };

  const v = evaluated?.result?.value;
  if (!v) throw new Error("observe failed — page not ready");
  clearObserveRefs();
  for (const el of v.elements || []) {
    lastObserveRefs.set(el.ref, {
      px: el.px,
      py: el.py,
      name: el.name,
      role: el.role,
      tag: el.tag,
    });
  }
  if (v.url) state.url = String(v.url);

  const out: Record<string, unknown> = {
    ok: true,
    url: v.url || (await currentUrl(state)),
    title: v.title || "",
    focus: v.focus || null,
    elements: (v.elements || []).map(({ px: _px, py: _py, ...rest }) => rest),
    text: v.text || "",
    elementCount: (v.elements || []).length,
    hint:
      "Act with homebase_browser_click({ref}) or homebase_browser_fill({ref|label, text}). " +
      "Re-observe after acts. Screenshot only if you need pixels.",
  };
  if (opts.shot) {
    const shot = await browserScreenshot({
      quality: opts.quality != null ? Number(opts.quality) : 55,
    });
    out.shot = { path: shot.path, latest: shot.latest, bytes: shot.bytes };
  }
  return out;
}

/** Wait until URL/text appears (or timeout). Avoids blind sleeps. */
export async function browserWait(opts: {
  text?: string;
  urlIncludes?: string;
  timeoutMs?: number;
}): Promise<Record<string, unknown>> {
  assertAgentControl();
  const text = opts.text != null ? String(opts.text) : "";
  const urlIncludes =
    opts.urlIncludes != null ? String(opts.urlIncludes) : "";
  if (!text && !urlIncludes) {
    throw new Error("Provide text and/or urlIncludes");
  }
  const timeoutMs = Math.max(
    500,
    Math.min(60_000, Math.floor(Number(opts.timeoutMs ?? 12_000))),
  );
  const state = await ensureSession();
  if (!state.pageSessionId) throw new Error("no page session");
  const sid = state.pageSessionId;
  const start = Date.now();
  let lastUrl = "";
  while (Date.now() - start < timeoutMs) {
    const href = await currentUrl(state);
    lastUrl = href;
    let textOk = !text;
    let urlOk = !urlIncludes || href.includes(urlIncludes);
    if (text) {
      const ev = (await state.cdp.send(
        "Runtime.evaluate",
        {
          expression: `(() => {
            const needle = ${JSON.stringify(text)};
            const hay = String(document.body && document.body.innerText || '');
            return hay.includes(needle);
          })()`,
          returnByValue: true,
        },
        sid,
      )) as { result?: { value?: boolean } };
      textOk = Boolean(ev?.result?.value);
    }
    if (textOk && urlOk) {
      return {
        ok: true,
        matched: true,
        url: href,
        waitedMs: Date.now() - start,
        hint: "Condition met — call observe next.",
      };
    }
    await sleep(280);
  }
  return {
    ok: false,
    matched: false,
    url: lastUrl,
    waitedMs: Date.now() - start,
    error: "wait timed out",
  };
}

/**
 * Fill an input by observe ref or accessible label (clear → type → optional Enter).
 * Preferred over click + type for forms.
 */
export async function browserFill(opts: {
  ref?: string;
  label?: string;
  text: string;
  pressEnter?: boolean;
  clear?: boolean;
}): Promise<Record<string, unknown>> {
  assertAgentControl();
  const text = String(opts.text ?? "");
  const refKey = opts.ref != null ? String(opts.ref).trim() : "";
  const label = opts.label != null ? String(opts.label).trim() : "";
  if (!refKey && !label) {
    throw new Error("Provide ref (from observe) or label (aria/placeholder/name)");
  }
  const state = await ensureSession();
  if (!state.pageSessionId) throw new Error("no page session");
  await refreshViewport(state);
  const sid = state.pageSessionId;

  if (refKey) {
    const hit = lastObserveRefs.get(refKey);
    if (!hit) {
      throw new Error(
        `Unknown ref "${refKey}" — call homebase_browser_observe first.`,
      );
    }
    await browserClick({ px: hit.px, py: hit.py, clickCount: 1 });
    await sleep(60);
  } else {
    const focused = (await state.cdp.send(
      "Runtime.evaluate",
      {
        expression: `(() => {
          const needle = ${JSON.stringify(label.toLowerCase())};
          const nodes = [...document.querySelectorAll('input, textarea, [contenteditable=true], [role=textbox], [g_editable=true]')];
          const match = nodes.find((el) => {
            const blob = [
              el.getAttribute('aria-label'),
              el.getAttribute('placeholder'),
              el.getAttribute('name'),
              el.getAttribute('title'),
            ].join(' ').toLowerCase();
            return blob.includes(needle);
          });
          if (!match) return { ok: false };
          match.focus();
          try { match.click(); } catch (_) {}
          return { ok: true, tag: match.tagName };
        })()`,
        returnByValue: true,
      },
      sid,
    )) as { result?: { value?: { ok?: boolean } } };
    if (!focused?.result?.value?.ok) {
      throw new Error(`No field matching label "${label}"`);
    }
    await sleep(60);
  }

  const focus = await probeFocusedEditable(state);
  if (!focus.editable) {
    throw new Error(
      "Target did not become editable — observe and pick a textbox ref.",
    );
  }
  if (opts.clear !== false) {
    await browserHotkey({ keys: ["ctrl", "a"] });
    await sleep(30);
    await browserKey({ key: "Backspace" });
    await sleep(30);
  }
  const inserted = await insertTextIntoFocused(state, text);
  if (opts.pressEnter) {
    await browserKey({ key: "Enter" });
  }
  return {
    ok: true,
    chars: inserted.chars,
    ref: refKey || undefined,
    label: label || undefined,
    pressEnter: Boolean(opts.pressEnter),
    focus: inserted.focus,
    hint: "Call homebase_browser_observe to verify.",
  };
}

/**
 * Grok-style outbound email card: human Approves / Denies (can edit fields).
 * On Approve, fills Gmail compose in Isolated Chrome and clicks Send.
 */
export async function browserProposeEmail(opts: {
  to: string;
  subject: string;
  body: string;
}): Promise<Record<string, unknown>> {
  const to = String(opts.to || "")
    .trim()
    .slice(0, 320);
  const subject = String(opts.subject || "")
    .trim()
    .slice(0, 200);
  const body = String(opts.body || "")
    .trim()
    .slice(0, 8000);
  if (!to) throw new Error("to required");
  if (!subject) throw new Error("subject required");
  if (!body) throw new Error("body required");
  if (emailPending) {
    throw new Error("Already waiting on an email approval — finish or cancel that first.");
  }
  if (secretPending) {
    throw new Error("Finish the secure input card before proposing email.");
  }
  await ensureSession();

  const { cursorSubscriberCount, broadcastAllCursor } = await import("./cursor");
  const listeners = cursorSubscriberCount() + browserClients.size;
  if (listeners === 0) {
    return {
      ok: false,
      cancelled: true,
      error: "Denied — open Chat to Approve/Deny the email card",
    };
  }

  const id = `bmail-${Date.now().toString(36)}`;
  const createdAt = Date.now();
  appendTrace(
    "info",
    `browser email proposed to=${to} subject=${subject.slice(0, 60)}`,
    "browser",
  );

  const result = await new Promise<{
    ok: boolean;
    cancelled?: boolean;
    sent?: boolean;
    error?: string;
    url?: string | null;
  }>((resolve) => {
    const timer = setTimeout(() => {
      if (emailPending?.id === id) {
        emailPending = null;
        emitStatus();
        void broadcastAllCursor({
          type: "browser-email-ack",
          id,
          ok: false,
          timedOut: true,
        });
        resolve({
          ok: false,
          cancelled: true,
          error: "Email approval timed out",
        });
      }
    }, 560_000);
    emailPending = {
      id,
      to,
      subject,
      body,
      createdAt,
      resolve: (r) => {
        clearTimeout(timer);
        resolve(r);
      },
      timer,
    };
    emitStatus();
    void broadcastAllCursor({
      type: "browser-email-request",
      id,
      to,
      subject,
      body,
      createdAt: createdAt / 1000,
    });
  });

  return {
    ...result,
    to,
    subject,
    hint: result.ok && result.sent
      ? "Email sent via Isolated Chrome Gmail. Continue with screenshot if needed."
      : undefined,
  };
}

async function evalBool(
  state: SessionState,
  expression: string,
): Promise<boolean> {
  if (!state.pageSessionId) return false;
  try {
    const r = (await state.cdp.send(
      "Runtime.evaluate",
      { expression, returnByValue: true },
      state.pageSessionId,
    )) as { result?: { value?: boolean } };
    return Boolean(r?.result?.value);
  } catch {
    return false;
  }
}

async function waitForGmailCompose(
  state: SessionState,
  timeoutMs = 12_000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ready = await evalBool(
      state,
      `(() => {
        const to = document.querySelector('input[aria-label="To recipients"], input[aria-label*="To recipients"], textarea[name="to"]');
        const sub = document.querySelector('input[name="subjectbox"]');
        const body = document.querySelector('div[aria-label="Message Body"][contenteditable="true"], div[g_editable="true"][contenteditable="true"]');
        return !!(to && sub && body);
      })()`,
    );
    if (ready) return;
    await sleep(300);
  }
  throw new Error("Gmail compose UI did not appear in time");
}

async function gmailHasRecipient(state: SessionState, to: string): Promise<boolean> {
  const needle = JSON.stringify(to.toLowerCase());
  return evalBool(
    state,
    `(() => {
      const to = ${needle};
      const chips = [...document.querySelectorAll('[email], [data-hovercard-id], span[data-hovercard-id]')];
      if (chips.some((c) => String(c.getAttribute('email') || c.getAttribute('data-hovercard-id') || '').toLowerCase() === to)) return true;
      const blob = String(document.body && document.body.innerText || '').toLowerCase();
      return blob.includes(to);
    })()`,
  );
}

async function fillAndSendGmail(opts: {
  to: string;
  subject: string;
  body: string;
}): Promise<{ ok: boolean; url?: string | null; error?: string }> {
  // Sending must not be blocked by human takeover.
  controller = "agent";
  clearObserveRefs();
  const state = await ensureSession();
  if (!state.pageSessionId) throw new Error("no page session");
  const sid = state.pageSessionId;

  await navigateOn(
    state,
    "https://mail.google.com/mail/u/0/#inbox?compose=new",
  );
  emitStatus();
  await waitForGmailCompose(state);

  // --- To (chip): focus → clear → insertText → Enter → verify ---
  const toFocused = await evalBool(
    state,
    `(() => {
      const el = document.querySelector('input[aria-label="To recipients"], input[aria-label*="To recipients"], textarea[name="to"]');
      if (!el) return false;
      el.focus();
      try { el.click(); } catch (_) {}
      return document.activeElement === el;
    })()`,
  );
  if (!toFocused) throw new Error("Could not focus Gmail To field");
  await sleep(80);
  await browserHotkey({ keys: ["ctrl", "a"] });
  await browserKey({ key: "Backspace" });
  await insertTextIntoFocused(state, opts.to);
  await browserKey({ key: "Enter" });
  await sleep(450);
  if (!(await gmailHasRecipient(state, opts.to))) {
    // Retry once: sometimes first Enter opens a contact picker.
    await insertTextIntoFocused(state, opts.to);
    await browserKey({ key: "Enter" });
    await sleep(450);
  }
  if (!(await gmailHasRecipient(state, opts.to))) {
    throw new Error(
      `Gmail To chip missing for ${opts.to} — not sending (fix propose_email fill).`,
    );
  }

  // --- Subject ---
  await state.cdp.send(
    "Runtime.evaluate",
    {
      expression: `(() => {
        const el = document.querySelector('input[name="subjectbox"], input[aria-label="Subject"]');
        if (!el) return false;
        el.focus();
        const proto = HTMLInputElement.prototype;
        const desc = Object.getOwnPropertyDescriptor(proto, 'value');
        const val = ${JSON.stringify(opts.subject)};
        if (desc && desc.set) desc.set.call(el, val); else el.value = val;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`,
      returnByValue: true,
    },
    sid,
  );
  await sleep(100);

  // --- Body: prepend above signature ---
  await state.cdp.send(
    "Runtime.evaluate",
    {
      expression: `(() => {
        const bodyEl =
          document.querySelector('div[aria-label="Message Body"][contenteditable="true"]') ||
          document.querySelector('div[g_editable="true"][contenteditable="true"]');
        if (!bodyEl) return false;
        const bodyVal = ${JSON.stringify(opts.body)};
        const existing = bodyEl.innerHTML || '';
        const intro = bodyVal
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/\\n/g, '<br>');
        const keepSig = /Best,|Daniel Barba|developdan\\.com/i.test(existing);
        bodyEl.focus();
        bodyEl.innerHTML = keepSig
          ? intro + '<br><br>' + existing
          : intro + (existing ? '<br><br>' + existing : '');
        bodyEl.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`,
      returnByValue: true,
    },
    sid,
  );
  await sleep(250);

  // Final recipient check — never Send with empty To.
  if (!(await gmailHasRecipient(state, opts.to))) {
    throw new Error("Recipient lost before send — aborted");
  }

  await browserHotkey({ keys: ["ctrl", "Enter"] });
  await sleep(1600);

  // If Gmail still shows the recipient error dialog, surface it.
  const errDialog = await evalBool(
    state,
    `(() => {
      const t = String(document.body && document.body.innerText || '');
      return t.includes('Please specify at least one recipient');
    })()`,
  );
  if (errDialog) {
    throw new Error("Gmail rejected send: missing recipient");
  }

  const href = await currentUrl(state);
  emitStatus();
  return { ok: true, url: href };
}

/** Chat WS: approve (optionally edited) email → send via Gmail in Isolated Chrome. */
export async function browserResolveEmail(
  id: string,
  edits?: { to?: string; subject?: string; body?: string },
): Promise<Record<string, unknown>> {
  const pending = emailPending;
  if (!pending || (id && pending.id !== id)) {
    return { ok: false, error: "No matching email approval request" };
  }
  const to = String(edits?.to ?? pending.to).trim();
  const subject = String(edits?.subject ?? pending.subject).trim();
  const body = String(edits?.body ?? pending.body).trim();
  if (!to || !subject || !body) {
    return { ok: false, error: "to, subject, and body are required" };
  }

  clearTimeout(pending.timer);
  emailPending = null;
  emitStatus();

  try {
    const sent = await fillAndSendGmail({ to, subject, body });
    pending.resolve({
      ok: true,
      sent: true,
      url: sent.url ?? null,
    });
    appendTrace(
      "info",
      `browser email sent to=${to} subject=${subject.slice(0, 60)}`,
      "browser",
    );
    const { broadcastAllCursor } = await import("./cursor");
    void broadcastAllCursor({
      type: "browser-email-ack",
      id: pending.id,
      ok: true,
      sent: true,
      to,
      subject,
    });
    return { ok: true, sent: true, to, subject, url: sent.url };
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    pending.resolve({ ok: false, error: err });
    const { broadcastAllCursor } = await import("./cursor");
    void broadcastAllCursor({
      type: "browser-email-ack",
      id: pending.id,
      ok: false,
      error: err,
    });
    return { ok: false, error: err };
  }
}

export function browserDenyEmail(id?: string): Record<string, unknown> {
  const pending = emailPending;
  if (!pending || (id && pending.id !== id)) {
    return { ok: false, error: "No matching email approval request" };
  }
  clearTimeout(pending.timer);
  emailPending = null;
  emitStatus();
  pending.resolve({
    ok: false,
    cancelled: true,
    error: "Denied by user",
  });
  appendTrace(
    "info",
    `browser email denied subject=${pending.subject.slice(0, 60)}`,
    "browser",
  );
  return { ok: true, denied: true, subject: pending.subject };
}

/** Test helper: clear in-memory session without requiring Chrome. */
export async function __resetBrowserSessionForTests(): Promise<void> {
  await stopSession("test-reset");
}
