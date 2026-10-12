/**
 * Home Access — durable panel of buttons / toggles / sliders / gauges that
 * trip scripts, HTTP hooks, or short-lived WebSocket messages on the server.
 * State lives under HOMEBASE_HOME/.runtime so it survives --deploy.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { RUNTIME_DIR, ensureRuntimeDirs } from "./config";
import { HttpError } from "./auth";
import { appendTrace } from "./trace";

export type AccessWidgetKind = "button" | "toggle" | "slider" | "gauge";
export type AccessHookType = "script" | "http" | "websocket" | "static";

export type AccessHook = {
  type: AccessHookType;
  /** shell command; {{value}} / {{on}} substituted */
  command?: string;
  cwd?: string;
  timeoutMs?: number;
  /** HTTP */
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  bodyTemplate?: string;
  /** WebSocket — connect, send, wait for one frame (or timeout), close */
  wsUrl?: string;
  wsMessage?: string;
  /** Gauge / poll helpers */
  pollMs?: number;
  /** Dot-path into JSON response for numeric/string value (e.g. "result.temp") */
  valuePath?: string;
  /** Dot-path into JSON for gauge subtitle / detail string */
  detailPath?: string;
};

export type AccessWidget = {
  id: string;
  kind: AccessWidgetKind;
  label: string;
  description?: string;
  /** Section heading in the Access grid (e.g. IoT, People, Network) */
  group?: string;
  order: number;
  /** toggle: boolean; slider/gauge: number; optional display string */
  value?: boolean | number | string | null;
  /** Optional subtitle under gauge readout (from detailPath) */
  detail?: string;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  hook: AccessHook;
  updatedAt: number;
  lastResult?: {
    ok: boolean;
    at: number;
    stdout?: string;
    stderr?: string;
    status?: number;
    error?: string;
  };
};

type Store = {
  version: 1;
  widgets: AccessWidget[];
};

const STORE_PATH = () => join(RUNTIME_DIR, "home_access.json");

function emptyStore(): Store {
  return { version: 1, widgets: [] };
}

function readStore(): Store {
  ensureRuntimeDirs();
  const path = STORE_PATH();
  if (!existsSync(path)) return emptyStore();
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Store;
    if (!raw || !Array.isArray(raw.widgets)) return emptyStore();
    return { version: 1, widgets: raw.widgets };
  } catch {
    return emptyStore();
  }
}

function writeStore(store: Store): void {
  ensureRuntimeDirs();
  mkdirSync(RUNTIME_DIR, { recursive: true });
  const path = STORE_PATH();
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2) + "\n");
  try {
    chmodSync(tmp, 0o600);
  } catch {
    /* ignore */
  }
  renameSync(tmp, path);
  try {
    chmodSync(path, 0o600);
  } catch {
    /* ignore */
  }
}

function subst(template: string, value: unknown): string {
  const on =
    value === true || value === "true" || value === 1 || value === "1"
      ? "1"
      : "0";
  const v = value == null ? "" : String(value);
  return template
    .replaceAll("{{value}}", v)
    .replaceAll("{{on}}", on)
    .replaceAll("{{json}}", JSON.stringify(value ?? null));
}

function pickPath(data: unknown, path?: string): unknown {
  if (!path) return data;
  let cur: unknown = data;
  for (const part of path.split(".").filter(Boolean)) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function normalizeKind(raw: unknown): AccessWidgetKind {
  const k = String(raw || "").toLowerCase();
  if (k === "button" || k === "toggle" || k === "slider" || k === "gauge") {
    return k;
  }
  throw new HttpError(400, "kind must be button|toggle|slider|gauge");
}

function normalizeHook(raw: unknown): AccessHook {
  const h = (raw && typeof raw === "object" ? raw : {}) as AccessHook;
  const type = String(h.type || "static").toLowerCase() as AccessHookType;
  if (!["script", "http", "websocket", "static"].includes(type)) {
    throw new HttpError(400, "hook.type must be script|http|websocket|static");
  }
  const hook: AccessHook = { type };
  if (h.command) hook.command = String(h.command);
  if (h.cwd) hook.cwd = String(h.cwd);
  if (h.timeoutMs != null) hook.timeoutMs = Math.max(500, Number(h.timeoutMs) || 30_000);
  if (h.url) hook.url = String(h.url);
  if (h.method) hook.method = String(h.method).toUpperCase();
  if (h.headers && typeof h.headers === "object") {
    hook.headers = Object.fromEntries(
      Object.entries(h.headers).map(([k, v]) => [String(k), String(v)]),
    );
  }
  if (h.bodyTemplate != null) hook.bodyTemplate = String(h.bodyTemplate);
  if (h.wsUrl) hook.wsUrl = String(h.wsUrl);
  if (h.wsMessage != null) hook.wsMessage = String(h.wsMessage);
  if (h.pollMs != null) hook.pollMs = Math.max(0, Number(h.pollMs) || 0);
  if (h.valuePath) hook.valuePath = String(h.valuePath);
  if (h.detailPath) hook.detailPath = String(h.detailPath);
  return hook;
}

export function listAccessWidgets(): AccessWidget[] {
  const groupRank = (g?: string) => {
    const key = String(g || "").toLowerCase();
    if (key === "network") return 0;
    if (key === "iot") return 1;
    if (key === "people") return 2;
    if (key === "meta") return 3;
    if (!key) return 9;
    return 5;
  };
  return [...readStore().widgets].sort(
    (a, b) =>
      groupRank(a.group) - groupRank(b.group) ||
      String(a.group || "").localeCompare(String(b.group || "")) ||
      a.order - b.order ||
      a.label.localeCompare(b.label),
  );
}

export function getAccessWidget(id: string): AccessWidget | null {
  return readStore().widgets.find((w) => w.id === id) || null;
}

export function upsertAccessWidget(
  input: Partial<AccessWidget> & { kind?: string; label?: string },
): AccessWidget {
  const store = readStore();
  const id = String(input.id || randomBytes(8).toString("hex"));
  const existing = store.widgets.find((w) => w.id === id);
  const kind = normalizeKind(input.kind || existing?.kind || "button");
  const label = String(input.label ?? existing?.label ?? "Control").trim() || "Control";
  const hook = normalizeHook(input.hook ?? existing?.hook ?? { type: "static" });
  const widget: AccessWidget = {
    id,
    kind,
    label,
    description:
      input.description != null
        ? String(input.description)
        : existing?.description,
    group:
      input.group != null
        ? String(input.group)
        : existing?.group,
    order:
      input.order != null
        ? Number(input.order)
        : existing?.order ?? store.widgets.length,
    value:
      input.value !== undefined
        ? (input.value as AccessWidget["value"])
        : existing?.value ??
          (kind === "toggle" ? false : kind === "slider" || kind === "gauge" ? 0 : null),
    detail:
      input.detail != null
        ? String(input.detail)
        : existing?.detail,
    min: input.min != null ? Number(input.min) : existing?.min ?? (kind === "slider" || kind === "gauge" ? 0 : undefined),
    max: input.max != null ? Number(input.max) : existing?.max ?? (kind === "slider" || kind === "gauge" ? 100 : undefined),
    step: input.step != null ? Number(input.step) : existing?.step ?? (kind === "slider" ? 1 : undefined),
    unit: input.unit != null ? String(input.unit) : existing?.unit,
    hook,
    updatedAt: Date.now(),
    lastResult: existing?.lastResult,
  };
  if (existing) {
    store.widgets = store.widgets.map((w) => (w.id === id ? widget : w));
  } else {
    store.widgets.push(widget);
  }
  writeStore(store);
  return widget;
}

export function deleteAccessWidget(id: string): boolean {
  const store = readStore();
  const next = store.widgets.filter((w) => w.id !== id);
  if (next.length === store.widgets.length) return false;
  store.widgets = next;
  writeStore(store);
  return true;
}

async function runScript(
  hook: AccessHook,
  value: unknown,
): Promise<{ ok: boolean; stdout: string; stderr: string; error?: string }> {
  const command = subst(String(hook.command || "").trim(), value);
  if (!command) return { ok: false, stdout: "", stderr: "", error: "hook.command required" };
  const cwd = hook.cwd?.trim() || process.env.HOME || RUNTIME_DIR;
  const timeoutMs = hook.timeoutMs ?? 30_000;
  try {
    const proc = Bun.spawn(["bash", "-lc", command], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        HOMEBASE_ACCESS_VALUE: value == null ? "" : String(value),
      },
    });
    const timer = setTimeout(() => {
      try {
        proc.kill();
      } catch {
        /* ignore */
      }
    }, timeoutMs);
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(timer);
    return {
      ok: code === 0,
      stdout: stdout.slice(0, 8_000),
      stderr: stderr.slice(0, 4_000),
      error: code === 0 ? undefined : `exit ${code}`,
    };
  } catch (e) {
    return {
      ok: false,
      stdout: "",
      stderr: "",
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

async function runHttp(
  hook: AccessHook,
  value: unknown,
): Promise<{
  ok: boolean;
  stdout: string;
  status?: number;
  error?: string;
  parsed?: unknown;
}> {
  const url = subst(String(hook.url || "").trim(), value);
  if (!url) return { ok: false, stdout: "", error: "hook.url required" };
  const method = (hook.method || (hook.bodyTemplate != null ? "POST" : "GET")).toUpperCase();
  const headers: Record<string, string> = {
    accept: "application/json, text/plain, */*",
    ...(hook.headers || {}),
  };
  let body: string | undefined;
  if (hook.bodyTemplate != null && method !== "GET" && method !== "HEAD") {
    body = subst(hook.bodyTemplate, value);
    if (!headers["content-type"] && !headers["Content-Type"]) {
      headers["content-type"] = "application/json";
    }
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), hook.timeoutMs ?? 15_000);
  try {
    const res = await fetch(url, { method, headers, body, signal: ac.signal });
    const text = (await res.text()).slice(0, 8_000);
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* plain */
    }
    return {
      ok: res.ok,
      stdout: text,
      status: res.status,
      error: res.ok ? undefined : `HTTP ${res.status}`,
      parsed,
    };
  } catch (e) {
    return {
      ok: false,
      stdout: "",
      error: e instanceof Error ? e.message : String(e),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function runWebsocket(
  hook: AccessHook,
  value: unknown,
): Promise<{ ok: boolean; stdout: string; error?: string }> {
  const url = subst(String(hook.wsUrl || "").trim(), value);
  if (!url) return { ok: false, stdout: "", error: "hook.wsUrl required" };
  const message = subst(String(hook.wsMessage ?? "{{json}}"), value);
  const timeoutMs = hook.timeoutMs ?? 8_000;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: { ok: boolean; stdout: string; error?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      resolve(result);
    };
    const timer = setTimeout(
      () => finish({ ok: true, stdout: "", error: "timeout waiting for ws reply" }),
      timeoutMs,
    );
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      clearTimeout(timer);
      resolve({
        ok: false,
        stdout: "",
        error: e instanceof Error ? e.message : String(e),
      });
      return;
    }
    ws.addEventListener("open", () => {
      try {
        ws.send(message);
      } catch (e) {
        finish({
          ok: false,
          stdout: "",
          error: e instanceof Error ? e.message : String(e),
        });
      }
      // Buttons that fire-and-forget: resolve shortly if no reply.
      setTimeout(() => {
        if (!settled) finish({ ok: true, stdout: "" });
      }, Math.min(1500, timeoutMs));
    });
    ws.addEventListener("message", (ev) => {
      const data =
        typeof ev.data === "string"
          ? ev.data
          : Buffer.from(ev.data as ArrayBuffer).toString("utf8");
      finish({ ok: true, stdout: data.slice(0, 8_000) });
    });
    ws.addEventListener("error", () => {
      finish({ ok: false, stdout: "", error: "websocket error" });
    });
  });
}

function coerceWidgetValue(
  widget: AccessWidget,
  raw: unknown,
): boolean | number | string | null {
  if (widget.kind === "toggle") {
    if (typeof raw === "boolean") return raw;
    if (raw === "true" || raw === 1 || raw === "1" || raw === "on") return true;
    if (raw === "false" || raw === 0 || raw === "0" || raw === "off") return false;
    return !widget.value;
  }
  if (widget.kind === "slider" || widget.kind === "gauge") {
    const n = Number(raw);
    if (!Number.isFinite(n)) return Number(widget.value) || 0;
    const min = widget.min ?? 0;
    const max = widget.max ?? 100;
    return Math.min(max, Math.max(min, n));
  }
  return raw == null ? null : String(raw);
}

function applyGaugeFromParsed(widget: AccessWidget, parsed: unknown): void {
  if (widget.kind !== "gauge" || parsed == null) return;
  const picked = pickPath(parsed, widget.hook.valuePath);
  if (picked != null) widget.value = coerceWidgetValue(widget, picked);
  if (widget.hook.detailPath) {
    const detail = pickPath(parsed, widget.hook.detailPath);
    if (detail != null) widget.detail = String(detail);
  }
}

export async function invokeAccessWidget(
  id: string,
  opts: { value?: unknown } = {},
): Promise<AccessWidget> {
  const store = readStore();
  const idx = store.widgets.findIndex((w) => w.id === id);
  if (idx < 0) throw new HttpError(404, "widget not found");
  const widget = store.widgets[idx]!;
  if (widget.kind === "gauge" && opts.value === undefined) {
    // refresh only
  } else if (opts.value !== undefined || widget.kind === "button" || widget.kind === "toggle") {
    widget.value = coerceWidgetValue(
      widget,
      opts.value !== undefined ? opts.value : widget.value,
    );
  }

  const value = widget.value;
  let result: AccessWidget["lastResult"];

  if (widget.hook.type === "static") {
    result = { ok: true, at: Date.now(), stdout: String(value ?? "") };
  } else if (widget.hook.type === "script") {
    const r = await runScript(widget.hook, value);
    result = { ok: r.ok, at: Date.now(), stdout: r.stdout, stderr: r.stderr, error: r.error };
    if (widget.kind === "gauge" && r.ok && r.stdout.trim()) {
      try {
        applyGaugeFromParsed(widget, JSON.parse(r.stdout));
      } catch {
        const n = Number(r.stdout.trim());
        if (Number.isFinite(n)) widget.value = coerceWidgetValue(widget, n);
      }
    }
  } else if (widget.hook.type === "http") {
    const r = await runHttp(widget.hook, value);
    result = {
      ok: r.ok,
      at: Date.now(),
      stdout: r.stdout,
      status: r.status,
      error: r.error,
    };
    if (widget.kind === "gauge" && r.parsed != null) {
      applyGaugeFromParsed(widget, r.parsed);
    }
  } else if (widget.hook.type === "websocket") {
    const r = await runWebsocket(widget.hook, value);
    result = { ok: r.ok, at: Date.now(), stdout: r.stdout, error: r.error };
    if (widget.kind === "gauge" && r.stdout.trim()) {
      try {
        applyGaugeFromParsed(widget, JSON.parse(r.stdout));
      } catch {
        const n = Number(r.stdout.trim());
        if (Number.isFinite(n)) widget.value = coerceWidgetValue(widget, n);
      }
    }
  } else {
    result = { ok: false, at: Date.now(), error: "unknown hook type" };
  }

  widget.lastResult = result;
  widget.updatedAt = Date.now();
  store.widgets[idx] = widget;
  writeStore(store);
  appendTrace(
    result?.ok ? "info" : "warn",
    `home-access ${widget.kind} "${widget.label}" → ${result?.ok ? "ok" : result?.error || "fail"}`,
    "home-access",
  );
  return widget;
}
