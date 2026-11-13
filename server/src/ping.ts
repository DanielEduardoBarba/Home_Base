/**
 * Lightweight Home Base liveness probe for MCP bots.
 * Never opens a chat or starts a cursor job.
 */
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { readVersion } from "./config";
import { cursorConfigured, getWorkspace } from "./cursor";
import { listCursorJobs } from "./cursor_jobs";
import { loadCursorApiKey } from "./secrets_vault";

/**
 * Uptime must track the homebased process, not the first dynamic import of this
 * module (MCP tools `await import("./ping")` only when first called).
 */
function uptimeSecNow(): number {
  return Math.max(0, Math.floor(process.uptime()));
}

export type CursorProbe = {
  apiKeyConfigured: boolean;
  apiKeyError?: string;
  cli: {
    ok: boolean;
    path?: string;
    version?: string;
    error?: string;
  };
};

function probeCliBinary(
  candidates: string[],
): { ok: boolean; path?: string; version?: string; error?: string } {
  for (const bin of candidates) {
    if (bin.includes("/") && !existsSync(bin)) continue;
    const r = spawnSync(bin, ["--version"], {
      encoding: "utf8",
      timeout: 8_000,
      env: { ...process.env },
    });
    const out = `${r.stdout || ""}${r.stderr || ""}`.trim();
    if (r.status === 0 && out && !/not found|No such file/i.test(out)) {
      return {
        ok: true,
        path: bin,
        version: out.split("\n")[0]?.slice(0, 120),
      };
    }
    if (r.error && (r.error as NodeJS.ErrnoException).code === "ENOENT") {
      continue;
    }
    if (bin.includes("/") || r.status !== null) {
      // Tried a concrete path or got a non-ENOENT failure — keep looking
      // unless this looks like a real version response failure with binary present.
      if (existsSync(bin) || !bin.includes("/")) {
        return {
          ok: false,
          path: bin,
          error: (out || r.error?.message || `${bin} --version failed`).slice(
            0,
            240,
          ),
        };
      }
    }
  }
  return {
    ok: false,
    error:
      "Cursor agent/CLI not found (tried cursor-agent, agent). Install Cursor agent on this laptop.",
  };
}

export function probeCursorStack(): CursorProbe {
  const key =
    (loadCursorApiKey() || process.env.CURSOR_API_KEY || "").trim() || "";
  const apiKeyConfigured = Boolean(key) || cursorConfigured();
  const cli = probeCliBinary([
    process.env.HOMEBASE_CURSOR_AGENT || "",
    "/home/daniel/.local/bin/cursor-agent",
    `${process.env.HOME || ""}/.local/bin/cursor-agent`,
    "/home/daniel/.local/bin/agent",
    `${process.env.HOME || ""}/.local/bin/agent`,
    "cursor-agent",
    "agent",
  ].filter(Boolean));

  return {
    apiKeyConfigured,
    apiKeyError: apiKeyConfigured
      ? undefined
      : "Cursor API key not configured in Home Base Settings",
    cli,
  };
}

export type HomebasePingResult = {
  ok: true;
  homebase: "up";
  version: string;
  uptimeSec: number;
  cursor: CursorProbe;
  jobs: {
    id: string;
    projectId: string;
    status: string;
    startedAt: number;
  }[];
  /** Diagnostic counts — ping must not change these. */
  counts: {
    chatsSample: number;
    jobsTotal: number;
    jobsActive: number;
  };
};

/**
 * Read-only ping. Does not create chats, start jobs, or touch Vision.
 */
export function homebasePing(): HomebasePingResult {
  const jobs = listCursorJobs(50);
  const active = jobs.filter(
    (j) => j.status === "queued" || j.status === "running",
  );

  // Sample chat counts across known project ids from jobs + homebase default.
  // getWorkspace is read-only for existing files and does not create chats.
  let chatsSample = 0;
  const seen = new Set<string>();
  for (const j of jobs) {
    if (seen.has(j.projectId)) continue;
    seen.add(j.projectId);
    try {
      chatsSample += getWorkspace(j.projectId).tabs.length;
    } catch {
      /* ignore */
    }
  }
  if (!seen.has("homebase")) {
    try {
      chatsSample += getWorkspace("homebase").tabs.length;
    } catch {
      /* ignore */
    }
  }

  const cursor = probeCursorStack();

  return {
    ok: true,
    homebase: "up",
    version: readVersion(),
    uptimeSec: uptimeSecNow(),
    cursor,
    jobs: active.map((j) => ({
      id: j.id,
      projectId: j.projectId,
      status: j.status,
      startedAt: j.startedAt,
    })),
    counts: {
      chatsSample,
      jobsTotal: jobs.length,
      jobsActive: active.length,
    },
  };
}

/** Test helper — process uptime seconds used by ping. */
export function pingUptimeSec(): number {
  return uptimeSecNow();
}
