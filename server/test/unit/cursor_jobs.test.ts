import { afterEach, describe, expect, test } from "bun:test";
import {
  _resetCursorJobsForTests,
  _setCursorJobDepsForTests,
  getCursorJob,
  listCursorJobs,
  projectHasActiveCursorJob,
  startCursorJob,
  type CursorJobRunOpts,
} from "../../src/cursor_jobs";

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
  const releases = new Map<string, () => void>();
  const startedChats: string[] = [];
  let failStart = false;
  let kickoffDelayMs = 0;

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
    await new Promise<void>((resolve) => {
      releases.set(opts.chatId, resolve);
    });
    tab.messages.push({
      id: `a-${opts.chatId}`,
      role: "assistant",
      text: "Job finished.\nTests: pass\nCommit abcdef1 on development_grok\nnone",
      at: Date.now(),
    });
    tab.running = false;
  };

  _setCursorJobDepsForTests({
    configured: () => true,
    getProject: (id) => (id === "demo" ? { path: "/tmp/demo-project" } : undefined),
    createChat: createChat as never,
    workspace: workspace as never,
    runner,
  });

  return {
    startedChats,
    workspace,
    setFailStart(v: boolean) {
      failStart = v;
    },
    setKickoffDelay(ms: number) {
      kickoffDelayMs = ms;
    },
    release(chatId: string) {
      const fn = releases.get(chatId);
      if (!fn) throw new Error(`no release gate for ${chatId}`);
      fn();
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
});
