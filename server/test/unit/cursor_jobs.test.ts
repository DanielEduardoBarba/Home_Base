import { afterEach, describe, expect, test } from "bun:test";
import {
  formatUnknownModelError,
  parseAgentModelsCliOutput,
  trimAgentError,
} from "../../src/cursor";
import {
  _resetCursorJobsForTests,
  _setCursorJobDepsForTests,
  evaluateIdleJobOutcome,
  getCursorJob,
  listCursorJobs,
  projectHasActiveCursorJob,
  redactCallbackSecrets,
  resolveCallbackAuth,
  startCursorJob,
  type CursorJobRunOpts,
} from "../../src/cursor_jobs";
import { listTrace, setTraceMirrorConsole } from "../../src/trace";
import { _setCallbackAuthForTests } from "../../src/secrets_vault";

setTraceMirrorConsole(false);

type Tab = {
  id: string;
  title: string;
  cwd: string;
  running: boolean;
  messages: Array<{
    id: string;
    role: string;
    text: string;
    at: number;
    source?: string;
    sourceLabel?: string;
    model?: string;
    jobId?: string;
  }>;
};

type Ws = { tabs: Tab[] };

function makeHarness() {
  const workspaces = new Map<string, Ws>();
  let tabSeq = 0;
  const releases = new Map<string, () => void | Promise<void>>();
  const startedChats: string[] = [];
  const lastErrors = new Map<string, string>();
  let failStart = false;
  let failAfterStart: string | null = null;
  let emptyAssistant = false;
  let kickoffDelayMs = 0;
  let knownModels: string[] | null = ["auto", "composer-2.5", "composer-2.5-fast"];

  const createChat = (projectId: string, opts: { title?: string; cwd?: string } = {}) => {
    const tab: Tab = {
      id: `chat-${++tabSeq}`,
      title: String(opts.title || "New chat"),
      cwd: String(opts.cwd || ""),
      running: false,
      messages: [],
    };
    const ws = workspaces.get(projectId) || { tabs: [] };
    ws.tabs.push(tab);
    workspaces.set(projectId, ws);
    return tab;
  };

  const workspace = (projectId: string) => workspaces.get(projectId) || { tabs: [] };

  const runner = async (projectId: string, opts: CursorJobRunOpts) => {
    if (kickoffDelayMs > 0) await Bun.sleep(kickoffDelayMs);
    if (failStart) throw new Error("simulated start failure");
    const ws = workspace(projectId);
    const tab = ws.tabs.find((t) => t.id === opts.chatId);
    if (!tab) throw new Error(`chat not found: ${opts.chatId}`);
    tab.messages.push({
      id: `u-${opts.chatId}`,
      role: "user",
      text: opts.prompt,
      at: Date.now(),
      source: opts.source,
      sourceLabel: opts.sourceLabel,
      model: opts.model,
      jobId: opts.jobId,
    });
    tab.running = true;
    opts.onStarted?.();
    startedChats.push(opts.chatId);
    await new Promise<void>((resolve, reject) => {
      releases.set(opts.chatId, async () => {
        if (failAfterStart) {
          const msg = failAfterStart;
          lastErrors.set(`${projectId}::${opts.chatId}`, msg);
          tab.running = false;
          reject(new Error(msg));
          return;
        }
        if (!emptyAssistant) {
          tab.messages.push({
            id: `a-${opts.chatId}`,
            role: "assistant",
            text: "Job finished.\nTests: pass\nCommit abcdef1 on development_grok\nnone",
            at: Date.now(),
          });
        }
        tab.running = false;
        resolve();
      });
    });
  };

  _setCursorJobDepsForTests({
    configured: () => true,
    getProject: (id) => (id === "demo" ? { path: "/tmp/demo-project" } : undefined),
    createChat: createChat as never,
    workspace: workspace as never,
    runner,
    validateModel: async (model) => {
      const id = String(model || "").trim();
      if (!id || id === "auto") return;
      if (knownModels == null) return;
      if (knownModels.includes(id)) return;
      throw new Error(formatUnknownModelError(id, knownModels));
    },
    lastRunError: (projectId, chatId) => lastErrors.get(`${projectId}::${chatId}`),
  });

  return {
    startedChats,
    workspace,
    setFailStart(v: boolean) {
      failStart = v;
    },
    setFailAfterStart(msg: string | null) {
      failAfterStart = msg;
    },
    setEmptyAssistant(v: boolean) {
      emptyAssistant = v;
    },
    setKnownModels(ids: string[] | null) {
      knownModels = ids;
    },
    setKickoffDelay(ms: number) {
      kickoffDelayMs = ms;
    },
    async release(chatId: string) {
      const fn = releases.get(chatId);
      if (!fn) throw new Error(`no release gate for ${chatId}`);
      await fn();
    },
  };
}

async function waitUntil(
  pred: () => boolean,
  timeoutMs = 4_000,
  label = "condition",
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await Bun.sleep(25);
  }
  throw new Error(`timed out waiting for ${label}`);
}

afterEach(() => {
  _resetCursorJobsForTests();
  _setCursorJobDepsForTests(null);
  _setCallbackAuthForTests(undefined);
});

describe("homebase_cursor_job kickoff", () => {
  test("MCP-submitted prompt starts a job, reports status, and finishes", async () => {
    const h = makeHarness();
    const job = await startCursorJob({
      projectId: "demo",
      prompt: "Please fix the bug",
      waitMs: 0,
      source: "mcp",
    });
    expect(job.status).toBe("running");
    expect(job.chatId).toBeTruthy();
    expect(h.startedChats).toContain(job.chatId);
    expect(h.workspace("demo").tabs[0]?.running).toBe(true);
    const userMsg = h.workspace("demo").tabs[0]?.messages.find((m) => m.role === "user");
    expect(userMsg).toBeTruthy();
    expect(userMsg?.source).toBe("mcp");
    expect(userMsg?.jobId).toBe(job.id);
    expect(userMsg?.model).toBeTruthy();

    const mid = getCursorJob(job.id);
    expect(mid?.status).toBe("running");
    expect(mid?.id).toBe(job.id);
    expect(listCursorJobs(5).some((j) => j.id === job.id && j.status === "running")).toBe(
      true,
    );

    h.release(job.chatId);
    await waitUntil(() => getCursorJob(job.id)?.status === "done", 4_000, "job done");
    const done = getCursorJob(job.id);
    expect(done?.status).toBe("done");
    expect(done?.finishedAt).toBeGreaterThan(0);
    expect(done?.summary).toMatch(/Job finished/);
    expect(h.workspace("demo").tabs[0]?.running).toBe(false);
  });

  test("MCP sourceLabel is stored on the kickoff user message", async () => {
    const h = makeHarness();
    const job = await startCursorJob({
      projectId: "demo",
      prompt: "labeled bot job",
      waitMs: 0,
      source: "mcp",
      sourceLabel: "devcon1-developer",
    });
    const userMsg = h.workspace("demo").tabs[0]?.messages.find((m) => m.role === "user");
    expect(userMsg?.source).toBe("mcp");
    expect(userMsg?.sourceLabel).toBe("devcon1-developer");
    expect(userMsg?.jobId).toBe(job.id);
    h.release(job.chatId);
    await waitUntil(() => getCursorJob(job.id)?.status === "done", 4_000, "job done");
  });

  test("second job on the same project is refused with a clear error", async () => {
    const h = makeHarness();
    const first = await startCursorJob({
      projectId: "demo",
      prompt: "First job",
      waitMs: 0,
    });
    expect(first.status).toBe("running");
    expect(projectHasActiveCursorJob("demo")?.id).toBe(first.id);

    let err = "";
    try {
      await startCursorJob({
        projectId: "demo",
        prompt: "Second job",
        waitMs: 0,
      });
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
    }
    expect(err).toMatch(/already has an active Home Base job/i);
    expect(err).toContain(first.id);
    expect(err).toMatch(/status=running/);

    h.release(first.chatId);
    await waitUntil(() => getCursorJob(first.id)?.status === "done", 4_000, "first done");
    // After the first settles, a new job on the same project is allowed.
    const second = await startCursorJob({
      projectId: "demo",
      prompt: "Second job after first finished",
      waitMs: 0,
    });
    expect(second.status).toBe("running");
    expect(second.id).not.toBe(first.id);
    h.release(second.chatId);
    await waitUntil(() => getCursorJob(second.id)?.status === "done", 4_000, "second done");
  });

  test("status and overlap checks do not mark a job done before the chat starts", async () => {
    const h = makeHarness();
    h.setKickoffDelay(250);
    const pending = startCursorJob({
      projectId: "demo",
      prompt: "Slow kickoff",
      waitMs: 0,
    });

    // While kickoff is delayed, a second start must still see an active job
    // (queued) rather than treating "chat not running yet" as finished.
    await Bun.sleep(40);
    let overlap = "";
    try {
      await startCursorJob({
        projectId: "demo",
        prompt: "Should be blocked",
        waitMs: 0,
      });
    } catch (e) {
      overlap = e instanceof Error ? e.message : String(e);
    }
    expect(overlap).toMatch(/already has an active Home Base job/i);
    expect(overlap).toMatch(/status=queued/);

    const job = await pending;
    expect(job.status).toBe("running");
    expect(getCursorJob(job.id)?.status).toBe("running");
    h.release(job.chatId);
    await waitUntil(() => getCursorJob(job.id)?.status === "done", 4_000, "delayed job done");
  });

  test("a runner that never starts the chat fails the job instead of silently finishing", async () => {
    const h = makeHarness();
    h.setFailStart(true);
    const job = await startCursorJob({
      projectId: "demo",
      prompt: "This should error",
      waitMs: 0,
    });
    expect(job.status).toBe("error");
    expect(job.error).toMatch(/simulated start failure/);
    expect(h.startedChats).toHaveLength(0);
  });

  test("non-zero exit after kickoff marks the job error (not done)", async () => {
    const h = makeHarness();
    h.setFailAfterStart("cursor-agent exited 1: Unknown model composer-1");
    const job = await startCursorJob({
      projectId: "demo",
      prompt: "Should fail after start",
      waitMs: 0,
    });
    expect(job.status).toBe("running");
    await h.release(job.chatId);
    await waitUntil(() => getCursorJob(job.id)?.status === "error", 4_000, "job error");
    const done = getCursorJob(job.id);
    expect(done?.status).toBe("error");
    expect(done?.error).toMatch(/exited 1|Unknown model/i);
    expect(done?.summary || "").toBe("");
  });

  test("empty assistant output marks the job error (not done)", async () => {
    const h = makeHarness();
    h.setEmptyAssistant(true);
    const job = await startCursorJob({
      projectId: "demo",
      prompt: "Silent finish",
      waitMs: 0,
    });
    await h.release(job.chatId);
    await waitUntil(() => getCursorJob(job.id)?.status === "error", 4_000, "empty output error");
    const done = getCursorJob(job.id);
    expect(done?.status).toBe("error");
    expect(done?.error).toMatch(/no assistant output/i);
  });

  test("unknown model is rejected up front with valid ids", async () => {
    const h = makeHarness();
    let err = "";
    try {
      await startCursorJob({
        projectId: "demo",
        prompt: "bad model",
        model: "composer-1",
        waitMs: 0,
      });
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
    }
    expect(err).toMatch(/Unknown Cursor model "composer-1"/);
    expect(err).toMatch(/auto/);
    expect(err).toMatch(/composer-2\.5/);
    expect(h.startedChats).toHaveLength(0);
  });

  test("model auto is accepted and can finish done", async () => {
    const h = makeHarness();
    const job = await startCursorJob({
      projectId: "demo",
      prompt: "Use auto",
      model: "auto",
      waitMs: 0,
    });
    expect(job.status).toBe("running");
    expect(job.model).toBe("auto");
    await h.release(job.chatId);
    await waitUntil(() => getCursorJob(job.id)?.status === "done", 4_000, "auto done");
    expect(getCursorJob(job.id)?.status).toBe("done");
  });
});

describe("cursor job model / error helpers", () => {
  test("parseAgentModelsCliOutput reads id before dash", () => {
    const ids = parseAgentModelsCliOutput(
      "Available models\n\nauto - Auto (default)\ncomposer-2.5 - Composer 2.5\n",
    );
    expect(ids).toEqual(["auto", "composer-2.5"]);
  });

  test("trimAgentError redacts secrets and caps length", () => {
    const out = trimAgentError(
      "fail CURSOR_API_KEY=secret-value-here and Bearer abcdefghijklmnop",
      200,
    );
    expect(out).not.toMatch(/secret-value-here/);
    expect(out).toMatch(/CURSOR_API_KEY=\*\*\*/i);
    expect(out.length).toBeLessThanOrEqual(200);
  });

  test("evaluateIdleJobOutcome: error / empty / ok", () => {
    expect(evaluateIdleJobOutcome({ summary: "", lastError: "boom" })).toEqual({
      status: "error",
      error: "boom",
    });
    expect(evaluateIdleJobOutcome({ summary: "" }).status).toBe("error");
    expect(evaluateIdleJobOutcome({ summary: "ok" })).toEqual({ status: "done" });
  });

  test("resolveCallbackAuth: param wins over vault; env is ignored", () => {
    const prev = process.env.HOMEBASE_CALLBACK_AUTH;
    try {
      process.env.HOMEBASE_CALLBACK_AUTH = "Bearer from-env-ignored";
      _setCallbackAuthForTests("Bearer from-vault");
      expect(resolveCallbackAuth(undefined)).toBe("Bearer from-vault");
      expect(resolveCallbackAuth("")).toBe("Bearer from-vault");
      expect(resolveCallbackAuth("Bearer from-param")).toBe("Bearer from-param");
      _setCallbackAuthForTests(null);
      expect(resolveCallbackAuth(undefined)).toBeUndefined();
      // env must not be used for delivery even when the vault is empty
      expect(resolveCallbackAuth("")).toBeUndefined();
    } finally {
      _setCallbackAuthForTests(undefined);
      if (prev !== undefined) process.env.HOMEBASE_CALLBACK_AUTH = prev;
      else delete process.env.HOMEBASE_CALLBACK_AUTH;
    }
  });

  test("redactCallbackSecrets strips exact auth values", () => {
    const secret = "Bearer super-secret-callback-key";
    const out = redactCallbackSecrets(
      `webhook failed Authorization: ${secret}`,
      secret,
    );
    expect(out).not.toContain("super-secret-callback-key");
    expect(out).not.toContain(secret);
    expect(out).toMatch(/\[redacted\]|Authorization=\*\*\*|Bearer \*\*\*/i);
  });
});

describe("homebase_cursor_job webhook auth", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.HOMEBASE_CALLBACK_AUTH;
  });

  function mockFetchCapture() {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const headers: Record<string, string> = {};
      const raw = init?.headers;
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        for (const [k, v] of Object.entries(raw as Record<string, string>)) {
          headers[k.toLowerCase()] = String(v);
        }
      }
      calls.push({ url, headers });
      return new Response("ok", { status: 200 });
    }) as typeof fetch;
    return calls;
  }

  test("sends Authorization header when callbackAuth is set", async () => {
    const h = makeHarness();
    const calls = mockFetchCapture();
    const secret = "Bearer param-secret-xyz";
    const job = await startCursorJob({
      projectId: "demo",
      prompt: "webhook with param auth",
      waitMs: 0,
      callbackUrl: "http://127.0.0.1:9/webhook-param",
      callbackAuth: secret,
    });
    expect(JSON.stringify(job)).not.toContain("param-secret-xyz");
    expect((job as { callbackAuth?: string }).callbackAuth).toBeUndefined();

    h.release(job.chatId);
    await waitUntil(() => getCursorJob(job.id)?.status === "done", 4_000, "param auth done");
    await waitUntil(() => calls.length >= 1, 4_000, "webhook fetch");

    expect(calls[0]?.headers.authorization).toBe(secret);
    const status = getCursorJob(job.id);
    const listed = listCursorJobs(10);
    const blob = JSON.stringify({ status, listed });
    expect(blob).not.toContain("param-secret-xyz");
    expect((status as { callbackAuth?: string } | null)?.callbackAuth).toBeUndefined();
    expect(status?.callbackAuthExpected).toBe(true);
    const traces = listTrace(300).items.map((t) => t.message).join("\n");
    expect(traces).not.toContain("param-secret-xyz");
  });

  test("uses Settings vault default when param omitted; env is ignored", async () => {
    const h = makeHarness();
    const calls = mockFetchCapture();
    process.env.HOMEBASE_CALLBACK_AUTH = "Bearer env-secret-abc";
    _setCallbackAuthForTests("Bearer vault-secret-abc");
    const job = await startCursorJob({
      projectId: "demo",
      prompt: "webhook with vault auth",
      waitMs: 0,
      callbackUrl: "http://127.0.0.1:9/webhook-vault",
    });
    h.release(job.chatId);
    await waitUntil(() => getCursorJob(job.id)?.status === "done", 4_000, "vault auth done");
    await waitUntil(() => calls.length >= 1, 4_000, "webhook fetch");
    expect(calls[0]?.headers.authorization).toBe("Bearer vault-secret-abc");
    expect(calls[0]?.headers.authorization).not.toBe("Bearer env-secret-abc");
    expect(JSON.stringify(getCursorJob(job.id))).not.toContain("vault-secret-abc");
    expect(JSON.stringify(listCursorJobs(5))).not.toContain("vault-secret-abc");
  });

  test("callbackAuth param overrides vault default (and env)", async () => {
    const h = makeHarness();
    const calls = mockFetchCapture();
    process.env.HOMEBASE_CALLBACK_AUTH = "Bearer env-should-not-win";
    _setCallbackAuthForTests("Bearer vault-should-not-win");
    const job = await startCursorJob({
      projectId: "demo",
      prompt: "webhook param overrides vault",
      waitMs: 0,
      callbackUrl: "http://127.0.0.1:9/webhook-override",
      callbackAuth: "Bearer param-wins-999",
    });
    h.release(job.chatId);
    await waitUntil(() => getCursorJob(job.id)?.status === "done", 4_000, "override done");
    await waitUntil(() => calls.length >= 1, 4_000, "webhook fetch");
    expect(calls[0]?.headers.authorization).toBe("Bearer param-wins-999");
    expect(calls[0]?.headers.authorization).not.toBe("Bearer vault-should-not-win");
    const blob = JSON.stringify({
      status: getCursorJob(job.id),
      list: listCursorJobs(5),
      traces: listTrace(300).items,
    });
    expect(blob).not.toContain("param-wins-999");
    expect(blob).not.toContain("vault-should-not-win");
    expect(blob).not.toContain("env-should-not-win");
  });
});
