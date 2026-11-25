/**
 * Higher-level Unity ops for MCP tools (status, bridge, logs, preview, screenshot).
 */
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { loadProjects, looksLikeUnityWorkspace, type Project } from "./config";
import { runAction, stopProject } from "./process";
import { resolveSeatHome } from "./unity_paths";
import { resolveWebglBind } from "./unity_webgl_bind";
import {
  bridgeStatus,
  editorsStatus,
  hubStatus,
  licenseStatus,
  redactUnityText,
  unityStatus,
} from "./unity";
import {
  callProjectUnityBridge,
  callUnityBridge,
  projectBridgePort,
  UNITY_BRIDGE_TOOL_CATALOG,
} from "./unity_bridge";
import { getUnityJob, listUnityJobs, startUnityJob } from "./unity_jobs";

function projectOrError(projectId: string): Project | { error: string } {
  const p = loadProjects().get(String(projectId || "").trim());
  if (!p) return { error: "project not found" };
  return p;
}

function editorLockState(projectPath: string): {
  locked: boolean;
  pids: number[];
} {
  const pids: number[] = [];
  try {
    const out = spawnSync("pgrep", ["-af", "Unity"], {
      encoding: "utf8",
      timeout: 5_000,
    });
    const lines = (out.stdout || "").split("\n").filter(Boolean);
    for (const line of lines) {
      if (!line.includes("-projectPath")) continue;
      if (!line.includes(projectPath)) continue;
      const pid = Number(line.trim().split(/\s+/)[0]);
      if (pid > 1) pids.push(pid);
    }
  } catch {
    /* ignore */
  }
  return { locked: pids.length > 0, pids };
}

export async function unityProjectStatus(projectId: string): Promise<Record<string, unknown>> {
  const global = await unityStatus();
  const project = loadProjects().get(String(projectId || "").trim());
  if (!project) {
    return { ...global, ok: false, error: "project not found" };
  }
  const port = projectBridgePort(project);
  const bridge = await bridgeStatus(port);
  const lock = editorLockState(project.path);
  const webgl = (project.ports || []).find((p) => p.id === "webgl");
  const bind = resolveWebglBind();
  const bindHost = bind === "0.0.0.0" ? "127.0.0.1" : bind;
  const outDir = join(project.path, "Builds/WebGL");
  let buildSize = 0;
  if (existsSync(outDir)) {
    try {
      const walk = (p: string) => {
        for (const name of readdirSync(p)) {
          const full = join(p, name);
          const st = statSync(full);
          if (st.isDirectory()) walk(full);
          else buildSize += st.size;
        }
      };
      walk(outDir);
    } catch {
      /* ignore */
    }
  }
  const jobs = listUnityJobs(5).filter((j) => j.projectId === project.id);
  return {
    ok: global.ok,
    hub: global.hub,
    editors: global.editors,
    license: global.license,
    checks: global.checks,
    project: {
      id: project.id,
      path: project.path,
      isUnity: looksLikeUnityWorkspace(project.path),
      bridgePort: port,
      bridgeReachable: bridge.reachable,
      editorLock: lock,
      webglPort: webgl?.port ?? null,
      webglUrl:
        webgl?.port != null ? `http://${bindHost}:${webgl.port}/` : null,
      lastWebglBuild: {
        outDir,
        exists: existsSync(outDir),
        sizeBytes: buildSize,
      },
      recentJobs: jobs,
    },
  };
}

export async function unityGlobalStatus(): Promise<Record<string, unknown>> {
  const s = await unityStatus();
  const editors = editorsStatus();
  const iosReady = editors.editors.some((e) =>
    e.modules.some((m) => m.id === "ios" && m.installed),
  );
  return {
    ...s,
    modules: {
      webglReady: editors.webglReady,
      iosReady,
    },
    hub: hubStatus(),
    license: licenseStatus(),
  };
}

export async function unityBridgeControl(opts: {
  projectId: string;
  action: "start" | "stop" | "status";
}): Promise<Record<string, unknown>> {
  const project = projectOrError(opts.projectId);
  if ("error" in project) return { ok: false, error: project.error };
  const port = projectBridgePort(project);
  const lock = editorLockState(project.path);

  if (opts.action === "status") {
    const bridge = await bridgeStatus(port);
    let ping: unknown = null;
    if (bridge.reachable) {
      ping = await callUnityBridge({ port, tool: "ping", timeoutMs: 5_000 });
    }
    return {
      ok: true,
      projectId: project.id,
      port,
      reachable: bridge.reachable,
      editorLock: lock,
      ping,
    };
  }

  if (opts.action === "stop") {
    try {
      if ((project.actions || []).some((a) => a.id === "stop")) {
        await runAction(project, "stop");
      } else {
        stopProject(project);
      }
    } catch (e) {
      return {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
        editorLock: editorLockState(project.path),
      };
    }
    return {
      ok: true,
      projectId: project.id,
      stopped: true,
      editorLock: editorLockState(project.path),
      reachable: (await bridgeStatus(port)).reachable,
    };
  }

  // start — refuse if another project's Editor holds a different path on same port,
  // but allow idempotent start for this project.
  if (lock.locked) {
    const bridge = await bridgeStatus(port);
    if (bridge.reachable) {
      return {
        ok: true,
        projectId: project.id,
        alreadyRunning: true,
        port,
        editorLock: lock,
        reachable: true,
      };
    }
  }

  try {
    if (!(project.actions || []).some((a) => a.id === "editor")) {
      return { ok: false, error: "project has no editor (bridge) action" };
    }
    const started = await runAction(project, "editor");
    // Give bridge a moment; status reports reachability.
    const bridge = await bridgeStatus(port);
    return {
      ok: true,
      projectId: project.id,
      started: true,
      port,
      reachable: bridge.reachable,
      editorLock: editorLockState(project.path),
      session: started,
    };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      editorLock: editorLockState(project.path),
    };
  }
}

export async function unityListTools(projectId: string): Promise<Record<string, unknown>> {
  const project = projectOrError(projectId);
  if ("error" in project) return { ok: false, error: project.error };
  const port = projectBridgePort(project);
  const bridge = await bridgeStatus(port);
  let live: unknown = null;
  if (bridge.reachable) {
    const r = await callUnityBridge({
      port,
      tool: "manage_tools",
      args: { action: "list_groups" },
      timeoutMs: 15_000,
    });
    live = r.ok ? r.result : { error: r.error };
  }
  return {
    ok: true,
    projectId: project.id,
    port,
    bridgeReachable: bridge.reachable,
    catalog: UNITY_BRIDGE_TOOL_CATALOG,
    live,
    note: "Use homebase_unity_call {projectId, tool, args} to invoke any catalog tool via the bridge.",
  };
}

export function unityLogTail(opts: {
  projectId: string;
  source?: "editor" | "webgl" | "bridge";
  lines?: number;
}): Record<string, unknown> {
  const project = projectOrError(opts.projectId);
  if ("error" in project) return { ok: false, error: project.error };
  const home = resolveSeatHome();
  const lines = Math.min(500, Math.max(1, Number(opts.lines) || 80));
  const source = opts.source || "editor";
  const editorLog = join(home, ".config/unity3d/Editor.log");
  const webglLog = join(home, ".cache/homebase-unity/webgl-build.log");
  const bridgeLog = join(home, ".cache/homebase-unity/bridge.log");
  const altEditor = join(home, ".local/share/unity3d/Editor.log");
  let path =
    source === "webgl"
      ? webglLog
      : source === "bridge"
        ? bridgeLog
        : editorLog;
  if (source === "editor" && !existsSync(path) && existsSync(altEditor)) {
    path = altEditor;
  }
  if (!existsSync(path)) {
    return {
      ok: true,
      projectId: project.id,
      source,
      path,
      exists: false,
      text: "",
    };
  }
  try {
    const text = readFileSync(path, "utf8");
    const tail = text.split("\n").slice(-lines).join("\n");
    return {
      ok: true,
      projectId: project.id,
      source,
      path,
      exists: true,
      text: redactUnityText(tail),
    };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      path,
    };
  }
}

export function unityPreviewStatus(projectId: string): Record<string, unknown> {
  const project = projectOrError(projectId);
  if ("error" in project) return { ok: false, error: project.error };
  const webgl = (project.ports || []).find((p) => p.id === "webgl");
  const bind = resolveWebglBind();
  const bindHost = bind === "0.0.0.0" ? "127.0.0.1" : bind;
  const outDir = join(project.path, "Builds/WebGL");
  const indexHtml = join(outDir, "index.html");
  return {
    ok: true,
    projectId: project.id,
    port: webgl?.port ?? null,
    bind,
    url:
      webgl?.port != null ? `http://${bindHost}:${webgl.port}/` : null,
    buildExists: existsSync(indexHtml),
    outDir,
  };
}

export async function unityScreenshot(opts: {
  projectId: string;
}): Promise<Record<string, unknown>> {
  const project = projectOrError(opts.projectId);
  if ("error" in project) return { ok: false, error: project.error };
  const home = resolveSeatHome();
  const outDir = join(home, ".cache/homebase-unity/shots");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `${project.id}-${Date.now()}.png`);

  // Prefer live bridge camera screenshot when reachable.
  const port = projectBridgePort(project);
  const bridge = await bridgeStatus(port);
  if (bridge.reachable) {
    const r = await callProjectUnityBridge({
      projectId: project.id,
      tool: "manage_camera",
      args: {
        action: "screenshot",
        screenshot_file_name: outPath,
      },
      timeoutMs: 60_000,
    });
    if (r.ok) {
      // Coplay may write under Assets/ or a temp path — prefer reported path.
      const result = (r.result || {}) as Record<string, unknown>;
      const reported =
        String(result.path || result.file || result.screenshotPath || "") ||
        outPath;
      let b64: string | null = null;
      const file = existsSync(reported)
        ? reported
        : existsSync(outPath)
          ? outPath
          : null;
      if (file) {
        try {
          const buf = readFileSync(file);
          // Cap thumbnail payload
          if (buf.length <= 200_000) b64 = buf.toString("base64");
        } catch {
          /* ignore */
        }
      }
      return {
        ok: true,
        projectId: project.id,
        source: "bridge",
        path: file,
        base64: b64,
        result: r.result,
      };
    }
  }

  // Fallback: note that WebGL iframe screenshot isn't available headless here.
  return {
    ok: false,
    error:
      "Screenshot needs a running Editor bridge (manage_camera). Start with homebase_unity_bridge action=start, then retry.",
    projectId: project.id,
    bridgeReachable: bridge.reachable,
  };
}

export {
  callProjectUnityBridge,
  getUnityJob,
  listUnityJobs,
  startUnityJob,
};
