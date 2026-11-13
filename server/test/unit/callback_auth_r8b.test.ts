import { afterAll, afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "hb-callback-auth-r8b-"));
const runtime = join(root, ".runtime");
mkdirSync(runtime, { recursive: true });
process.env.HOMEBASE_HOME = root;
process.env.HOMEBASE_RUNTIME = runtime;
delete process.env.HOMEBASE_CALLBACK_AUTH;

const { RUNTIME_DIR } = await import("../../src/config");
const jobs = await import("../../src/cursor_jobs");
const callbacks = await import("../../src/cursor_callbacks");
const vault = await import("../../src/secrets_vault");
const { recordActivity } = await import("../../src/activity_audit");
const { appendDaily, readDailyLogs } = await import("../../src/logging");
const { appendTrace, listTrace, setTraceMirrorConsole } = await import(
  "../../src/trace"
);
const { pushNotification, listNotifications } = await import(
  "../../src/notifications"
);
const { log } = await import("../../src/console_log");
const { redactSecrets, redactDeep } = await import("../../src/redact");
const { buildHomebaseTools } = await import("../../src/homebase_tools");

setTraceMirrorConsole(false);

function envIsolated(): boolean {
  return RUNTIME_DIR.startsWith(root);
}
const describeIso = envIsolated() ? describe : describe.skip;

const DUMMY = "Bearer r8b-dummy-callback-token-XYZ123-unique";
const DUMMY_NEEDLE = "r8b-dummy-callback-token-XYZ123";

type Tab = {
  id: string;
  title: string;
  cwd: string;
  running: boolean;
  messages: Array<{ id: string; role: string; text: string; at: number }>;
};

function makeHarness() {
  const workspaces = new Map<string, { tabs: Tab[]; activeId: string }>();
  let tabSeq = 0;
  const releases = new Map<string, () => void>();

  const createChat = (projectId: string, opts: { title?: string; cwd?: string } = {}) => {
    const tab: Tab = {
      id: `chat-${++tabSeq}`,
      title: String(opts.title || "New chat"),
      cwd: String(opts.cwd || ""),
      running: false,
      messages: [],
    };
    const ws = workspaces.get(projectId) || { tabs: [], activeId: "" };
    ws.tabs.push(tab);
    ws.activeId = tab.id;
    workspaces.set(projectId, ws);
    return tab;
  };

  const runner = async (
    projectId: string,
    opts: { chatId: string; prompt: string; onStarted?: () => void },
  ) => {
    const ws = workspaces.get(projectId) || { tabs: [], activeId: "" };
    const tab = ws.tabs.find((t) => t.id === opts.chatId);
    if (!tab) throw new Error(`chat not found: ${opts.chatId}`);
    tab.messages.push({
      id: `u-${opts.chatId}`,
      role: "user",
      text: opts.prompt,
      at: Date.now(),
    });
    tab.running = true;
    opts.onStarted?.();
    await new Promise<void>((resolve) => {
      releases.set(opts.chatId, () => {
        tab.running = false;
        tab.messages.push({
          id: `a-${opts.chatId}`,
          role: "assistant",
          text: "done\nnone",
          at: Date.now(),
        });
        resolve();
      });
    });
  };

  jobs._setCursorJobDepsForTests({
    runner: runner as never,
    configured: () => true,
    getProject: (id: string) =>
      id === "demo" ? { path: join(root, "demo") } : undefined,
    createChat: createChat as never,
    workspace: (projectId: string) =>
      workspaces.get(projectId) || { tabs: [], activeId: "" },
    validateModel: async () => undefined,
    lastRunError: () => undefined,
  });

  return {
    release: (chatId: string) => releases.get(chatId)?.(),
  };
}

function walkFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walkFiles(p));
    else out.push(p);
  }
  return out;
}

function plaintextHits(needle: string, dir = RUNTIME_DIR): string[] {
  const hits: string[] = [];
  for (const file of walkFiles(dir)) {
    try {
      const buf = readFileSync(file);
      if (buf.includes(needle) || buf.toString("utf8").includes(needle)) {
        hits.push(file);
      }
    } catch {
      /* ignore unreadable */
    }
  }
  return hits;
}

function mockFetchCapture() {
  const calls: Array<{
    url: string;
    headers: Record<string, string>;
    body: unknown;
  }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = String(input);
    const headers: Record<string, string> = {};
    const raw = init?.headers;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      for (const [k, v] of Object.entries(raw as Record<string, string>)) {
        headers[k.toLowerCase()] = String(v);
      }
    }
    let body: unknown = init?.body;
    try {
      body = JSON.parse(String(init?.body || "null"));
    } catch {
      /* keep raw */
    }
    calls.push({ url, headers, body });
    return new Response("ok", { status: 200 });
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

async function waitUntil(pred: () => boolean, ms: number, label: string) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return;
    await Bun.sleep(25);
  }
  throw new Error(`timed out waiting for ${label}`);
}

afterAll(() => {
  jobs._resetCursorJobsForTests();
  jobs._setCursorJobDepsForTests(null);
  vault._setCallbackAuthForTests(undefined);
  try {
    vault.clearCallbackAuth();
  } catch {
    /* ignore */
  }
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describeIso("1.20.3b callback auth (R8b)", () => {
  afterEach(() => {
    jobs._resetCursorJobsForTests();
    jobs._setCursorJobDepsForTests(null);
    vault._setCallbackAuthForTests(undefined);
    delete process.env.HOMEBASE_CALLBACK_AUTH;
  });

  test("redactSecrets and redactDeep cover callbackAuth / Bearer / keys", () => {
    const raw = `callbackAuth=${DUMMY} authorization: ${DUMMY} token=hb_mcp_abcDEF123`;
    const out = redactSecrets(raw);
    expect(out).not.toContain(DUMMY_NEEDLE);
    expect(out).not.toContain("hb_mcp_abcDEF123");
    const deep = redactDeep({
      callbackAuth: DUMMY,
      authorization: DUMMY,
      token: "secret-token-value",
      nested: { apiKey: "sk-live-abcdef", prompt: "hello" },
    }) as Record<string, unknown>;
    expect(JSON.stringify(deep)).not.toContain(DUMMY_NEEDLE);
    expect(deep.callbackAuth).toBe("[redacted]");
    expect(deep.nested).toEqual({ apiKey: "[redacted]", prompt: "hello" });
  });

  test("MCP homebase_cursor_job does not write the dummy token in plaintext anywhere under runtime", async () => {
    const h = makeHarness();
    const { calls, restore } = mockFetchCapture();
    try {
      recordActivity({
        source: "mcp",
        kind: "tool",
        summary: "homebase_cursor_job (projectId, prompt, callbackUrl, callbackAuth)",
        detail: {
          tool: "homebase_cursor_job",
          argKeys: ["projectId", "prompt", "callbackUrl", "callbackAuth"],
          // If a future path logged values, redaction must still catch it:
          args: { callbackAuth: DUMMY, callbackUrl: "http://127.0.0.1:9/r8b" },
        },
      });
      appendDaily("mcp_tool", {
        tool: "homebase_cursor_job",
        callbackAuth: DUMMY,
        authorization: DUMMY,
      });
      appendTrace("info", `job start callbackAuth=${DUMMY}`, "mcp");
      log("info", `authorization: ${DUMMY}`, {
        source: "mcp",
        fields: { callbackAuth: DUMMY },
      });
      pushNotification("job started", `auth ${DUMMY}`, {
        meta: { callbackAuth: DUMMY },
      });

      const tools = buildHomebaseTools("demo", false, {}, "mcp");
      const cursorJobTool = tools.homebase_cursor_job;
      expect(cursorJobTool).toBeTruthy();
      const result = await cursorJobTool!.execute({
        projectId: "demo",
        prompt: "R8b dummy-token grep job",
        callbackUrl: "http://127.0.0.1:9/r8b-mcp",
        callbackAuth: DUMMY,
        waitMs: 0,
      });
      const text = JSON.stringify(result);
      expect(text).not.toContain(DUMMY_NEEDLE);
      const job = jobs.listCursorJobs(5)[0];
      expect(job).toBeTruthy();
      expect(job!.callbackAuthExpected).toBe(true);
      expect(existsSync(callbacks.PENDING_CALLBACKS_PATH)).toBe(true);
      expect(statSync(callbacks.PENDING_CALLBACKS_PATH).mode & 0o777).toBe(0o600);
      expect(plaintextHits(DUMMY_NEEDLE)).toEqual([]);

      h.release(job!.chatId);
      await waitUntil(
        () => jobs.getCursorJob(job!.id)?.status === "done",
        4_000,
        "mcp job done",
      );
      await waitUntil(() => calls.length >= 1, 4_000, "mcp webhook");
      expect(calls[0]?.headers.authorization).toBe(DUMMY);
      expect(existsSync(callbacks.PENDING_CALLBACKS_PATH)).toBe(false);

      const daily = JSON.stringify(readDailyLogs(50));
      expect(daily).not.toContain(DUMMY_NEEDLE);
      const traces = listTrace(300).items.map((t) => t.message).join("\n");
      expect(traces).not.toContain(DUMMY_NEEDLE);
      const notes = JSON.stringify(listNotifications({ limit: 20 }));
      expect(notes).not.toContain(DUMMY_NEEDLE);
      expect(plaintextHits(DUMMY_NEEDLE)).toEqual([]);
    } finally {
      restore();
    }
  });

  test("restart (module reload) delivers interrupted callback with exact auth and removes the record", async () => {
    const { calls, restore } = mockFetchCapture();
    try {
      callbacks.persistPendingCallback({
        jobId: "job-restart-1",
        projectId: "demo",
        callbackUrl: "http://127.0.0.1:9/interrupted",
        startedAt: Date.now(),
        auth: DUMMY,
      });
      expect(existsSync(callbacks.PENDING_CALLBACKS_PATH)).toBe(true);
      expect(plaintextHits(DUMMY_NEEDLE)).toEqual([]);

      jobs._forgetInMemoryJobsForTests();
      expect(jobs.listCursorJobs()).toEqual([]);

      const reloaded = await import(
        `../../src/cursor_jobs.ts?restart=${Date.now()}`
      );
      const stats = await reloaded.recoverInterruptedCallbacks();
      expect(stats.recovered).toBe(1);
      expect(stats.expired).toBe(0);
      expect(stats.lost).toBe(0);

      await waitUntil(() => calls.length >= 1, 4_000, "interrupted webhook");
      expect(calls[0]?.headers.authorization).toBe(DUMMY);
      expect(calls[0]?.url).toBe("http://127.0.0.1:9/interrupted");
      const payload = calls[0]?.body as {
        type?: string;
        job?: { id?: string; status?: string; summary?: string };
      };
      expect(payload.type).toBe("homebase.cursor_job");
      expect(payload.job?.id).toBe("job-restart-1");
      expect(payload.job?.status).toBe("interrupted");
      expect(payload.job?.summary).toBe(callbacks.INTERRUPTED_SUMMARY);

      expect(existsSync(callbacks.PENDING_CALLBACKS_PATH)).toBe(false);
      const listed = reloaded.listCursorJobs(10);
      expect(listed.some((j: { id: string }) => j.id === "job-restart-1")).toBe(
        true,
      );
      const rec = listed.find((j: { id: string }) => j.id === "job-restart-1");
      expect(rec?.status).toBe("interrupted");
      expect(rec?.callbackAuthExpected).toBe(true);
      expect(JSON.stringify(listed)).not.toContain(DUMMY_NEEDLE);
      expect(plaintextHits(DUMMY_NEEDLE)).toEqual([]);
    } finally {
      restore();
    }
  });

  test("expired pending records (>24h) are logged and not delivered", async () => {
    const { calls, restore } = mockFetchCapture();
    try {
      callbacks.persistPendingCallback({
        jobId: "job-expired-1",
        projectId: "demo",
        callbackUrl: "http://127.0.0.1:9/expired",
        startedAt: Date.now() - 25 * 60 * 60 * 1000,
        auth: DUMMY,
      });
      const stats = await jobs.recoverInterruptedCallbacks();
      expect(stats.expired).toBe(1);
      expect(stats.recovered).toBe(0);
      expect(calls.length).toBe(0);
      expect(existsSync(callbacks.PENDING_CALLBACKS_PATH)).toBe(false);
      const traces = listTrace(300).items.map((t) => t.message).join("\n");
      expect(traces).toMatch(/job-expired-1/);
      expect(traces).toMatch(/expired after 24h/);
      expect(traces).not.toContain(DUMMY_NEEDLE);
    } finally {
      restore();
    }
  });

  test("decrypt failure with hasAuth records a lost-callback entry and does not POST unauthenticated", async () => {
    const { calls, restore } = mockFetchCapture();
    try {
      callbacks._writePendingRecordsForTests([
        {
          jobId: "job-lost-1",
          projectId: "demo",
          callbackUrl: "http://127.0.0.1:9/lost",
          startedAt: Date.now(),
          hasAuth: true,
          authEnc: "not-a-valid-ciphertext",
        },
      ]);
      const stats = await jobs.recoverInterruptedCallbacks();
      expect(stats.lost).toBe(1);
      expect(stats.recovered).toBe(0);
      expect(calls.length).toBe(0);
      expect(existsSync(callbacks.PENDING_CALLBACKS_PATH)).toBe(false);
      const listed = jobs.listCursorJobs(10);
      const rec = listed.find((j) => j.id === "job-lost-1");
      expect(rec).toBeTruthy();
      expect(rec?.status).toBe("error");
      expect(rec?.callbackAuthExpected).toBe(true);
      expect(rec?.webhookError).toMatch(/could not be decrypted/i);
      expect(rec?.summary).toBe(callbacks.INTERRUPTED_SUMMARY);
      const traces = listTrace(300).items.map((t) => t.message).join("\n");
      expect(traces).toMatch(/failed to decrypt auth/);
    } finally {
      restore();
    }
  });

  test("pending record without auth still notifies on restart (no Authorization header)", async () => {
    const { calls, restore } = mockFetchCapture();
    try {
      callbacks.persistPendingCallback({
        jobId: "job-noauth-1",
        projectId: "demo",
        callbackUrl: "http://127.0.0.1:9/noauth",
        startedAt: Date.now(),
      });
      const stats = await jobs.recoverInterruptedCallbacks();
      expect(stats.recovered).toBe(1);
      await waitUntil(() => calls.length >= 1, 4_000, "noauth webhook");
      expect(calls[0]?.headers.authorization).toBeUndefined();
      const payload = calls[0]?.body as { job?: { status?: string } };
      expect(payload.job?.status).toBe("interrupted");
      expect(existsSync(callbacks.PENDING_CALLBACKS_PATH)).toBe(false);
    } finally {
      restore();
    }
  });
});
