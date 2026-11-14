/**
 * Doodle — kid-friendly AI mascot scene.
 * Sandboxed workspace under /opt/homebase-doodle; tablet enroll with 30d JWT.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { RUNTIME_DIR, ensureRuntimeDirs, upsertProject } from "./config";
import { detectSeatUser } from "./shell_env";
import {
  HttpError,
  issueJwt,
  authEpoch,
  assertNotLocked,
  recordFailure,
  type AuthEventCtx,
} from "./auth";
import { verifyAppPin, isAppPinEnabled } from "./app_pin";
import { purgeProjectWorkspace, createChat } from "./cursor";

export const DOODLE_PROJECT_ID = "doodle";
export const DOODLE_WORKSPACE = "/opt/homebase-doodle";
export const DOODLE_TTL_SEC = 30 * 24 * 60 * 60;
export const DOODLE_JWT_KIND = "doodle";

const TABLETS_PATH = join(RUNTIME_DIR, "doodle_tablets.json");
const STATE_PATH = join(RUNTIME_DIR, "doodle_state.json");

export type DoodleMouth = "happy" | "curious" | "blank" | "sad" | "frozen";

export type DoodleStroke = {
  id: string;
  color: string;
  width: number;
  points: { x: number; y: number }[];
};

export type DoodleExpress = {
  mouth: DoodleMouth;
  color: string;
  energy: number;
  bubble: string;
  name: string;
};

export type DoodleTimer = {
  active: boolean;
  label: string;
  endsAt: number;
  startedAt: number;
};

export type DoodleTravel = {
  active: boolean;
  destination: string;
  leaveBy: number;
  arriveBy: number;
  durationSec: number;
  distanceM: number;
  label: string;
};

export type DoodleState = {
  express: DoodleExpress;
  strokes: DoodleStroke[];
  timer: DoodleTimer | null;
  travel: DoodleTravel | null;
  updatedAt: number;
};

export type DoodleTablet = {
  deviceId: string;
  name: string;
  enrolledAt: number;
  lastSeenAt: number;
  userAgent?: string;
};

type TabletsFile = { tablets: DoodleTablet[]; updatedAt?: number };

const DEFAULT_EXPRESS: DoodleExpress = {
  mouth: "happy",
  color: "#ffb703",
  energy: 0.55,
  bubble: "",
  name: "Doodle",
};

function chmodPrivate(path: string): void {
  try {
    chmodSync(path, 0o600);
  } catch {
    /* ignore */
  }
}

function emptyState(): DoodleState {
  return {
    express: { ...DEFAULT_EXPRESS },
    strokes: [],
    timer: null,
    travel: null,
    updatedAt: Date.now(),
  };
}

function loadState(): DoodleState {
  if (!existsSync(STATE_PATH)) return emptyState();
  try {
    const raw = JSON.parse(readFileSync(STATE_PATH, "utf8")) as Partial<DoodleState>;
    return {
      express: {
        ...DEFAULT_EXPRESS,
        ...(raw.express || {}),
        mouth: normalizeMouth(raw.express?.mouth),
        color: String(raw.express?.color || DEFAULT_EXPRESS.color).slice(0, 32),
        energy: clamp01(Number(raw.express?.energy ?? DEFAULT_EXPRESS.energy)),
        bubble: String(raw.express?.bubble || "").slice(0, 120),
        name: String(raw.express?.name || DEFAULT_EXPRESS.name).slice(0, 32),
      },
      strokes: Array.isArray(raw.strokes) ? raw.strokes.slice(-400) : [],
      timer: raw.timer && typeof raw.timer === "object" ? (raw.timer as DoodleTimer) : null,
      travel: raw.travel && typeof raw.travel === "object" ? (raw.travel as DoodleTravel) : null,
      updatedAt: Number(raw.updatedAt) || Date.now(),
    };
  } catch {
    return emptyState();
  }
}

let memState: DoodleState | null = null;

function saveState(state: DoodleState): void {
  ensureRuntimeDirs();
  state.updatedAt = Date.now();
  memState = state;
  const tmp = STATE_PATH + ".tmp";
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
  chmodPrivate(tmp);
  renameSync(tmp, STATE_PATH);
  chmodPrivate(STATE_PATH);
}

export function getDoodleState(): DoodleState {
  if (!memState) memState = loadState();
  // Expire finished timers in memory for status
  if (memState.timer?.active && memState.timer.endsAt <= Date.now()) {
    memState.timer = { ...memState.timer, active: false };
  }
  if (memState.travel?.active && memState.travel.leaveBy <= Date.now()) {
    memState.travel = { ...memState.travel, active: false };
  }
  return memState;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0.5;
  return Math.max(0, Math.min(1, n));
}

export function normalizeMouth(raw: unknown): DoodleMouth {
  const v = String(raw || "").toLowerCase();
  if (v === "happy" || v === "d") return "happy";
  if (v === "curious" || v === "inquisitive" || v === ".") return "curious";
  if (v === "blank" || v === "-") return "blank";
  if (v === "sad" || v === "c") return "sad";
  if (v === "frozen" || v === "confounded" || v === "none" || v === "") return "frozen";
  return "happy";
}

function loadTablets(): TabletsFile {
  if (!existsSync(TABLETS_PATH)) return { tablets: [] };
  try {
    const raw = JSON.parse(readFileSync(TABLETS_PATH, "utf8")) as Partial<TabletsFile>;
    return {
      tablets: Array.isArray(raw.tablets) ? (raw.tablets as DoodleTablet[]) : [],
      updatedAt: raw.updatedAt,
    };
  } catch {
    return { tablets: [] };
  }
}

function saveTablets(data: TabletsFile): void {
  ensureRuntimeDirs();
  const tmp = TABLETS_PATH + ".tmp";
  writeFileSync(tmp, JSON.stringify({ ...data, updatedAt: Date.now() }, null, 2) + "\n");
  chmodPrivate(tmp);
  renameSync(tmp, TABLETS_PATH);
  chmodPrivate(TABLETS_PATH);
}

export function listDoodleTablets(): DoodleTablet[] {
  return loadTablets().tablets.slice().sort((a, b) => b.lastSeenAt - a.lastSeenAt);
}

export function getDoodleTablet(deviceId: string): DoodleTablet | undefined {
  const id = String(deviceId || "").trim();
  if (!id) return undefined;
  return loadTablets().tablets.find((t) => t.deviceId === id);
}

export function isDoodleTabletEnrolled(deviceId: string): boolean {
  return Boolean(getDoodleTablet(deviceId));
}

export function forgetDoodleTablet(deviceId: string): boolean {
  const id = String(deviceId || "").trim();
  if (!id) return false;
  const file = loadTablets();
  const before = file.tablets.length;
  file.tablets = file.tablets.filter((t) => t.deviceId !== id);
  if (file.tablets.length === before) return false;
  saveTablets(file);
  return true;
}

export function touchDoodleTablet(deviceId: string, userAgent?: string): void {
  const id = String(deviceId || "").trim();
  if (!id) return;
  const file = loadTablets();
  const t = file.tablets.find((x) => x.deviceId === id);
  if (!t) return;
  t.lastSeenAt = Date.now();
  if (userAgent) t.userAgent = userAgent.slice(0, 180);
  saveTablets(file);
}

/**
 * Seat-owned sandbox at /opt/homebase-doodle. Creates + chowns when root.
 */
export function ensureDoodleWorkspace(): string {
  const dir = DOODLE_WORKSPACE;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    /* may need root for /opt */
  }
  const seat = detectSeatUser();
  if (process.getuid?.() === 0 && seat.uid > 0) {
    try {
      Bun.spawnSync(["chown", "-R", `${seat.uid}:${seat.gid}`, dir]);
    } catch {
      /* ignore */
    }
  }
  // Seed a friendly README once
  const readme = join(dir, "README.txt");
  if (!existsSync(readme)) {
    try {
      writeFileSync(
        readme,
        "Hi! This is Doodle's private workspace.\n" +
          "Drawings, notes, and little projects live here safely.\n",
      );
      if (process.getuid?.() === 0 && seat.uid > 0) {
        Bun.spawnSync(["chown", `${seat.uid}:${seat.gid}`, readme]);
      }
    } catch {
      /* ignore */
    }
  }
  return dir;
}

/** Register synthetic doodle project (hidden from Work UI via client filter). */
export function ensureDoodleProject(): { id: string; path: string; name: string } {
  const path = ensureDoodleWorkspace();
  try {
    upsertProject({
      id: DOODLE_PROJECT_ID,
      name: "Doodle",
      path,
      ports: [],
      actions: [],
    });
  } catch {
    /* already present or path race */
  }
  return { id: DOODLE_PROJECT_ID, path, name: "Doodle" };
}

export async function enrollDoodleTablet(opts: {
  deviceId: string;
  /** Required when App PIN is enabled; ignored when PIN is off. */
  pin?: string;
  name?: string;
  ip: string;
  userAgent?: string;
  ctx?: AuthEventCtx;
}): Promise<{
  token: string;
  expiresAt: number;
  expiresIn: number;
  kind: string;
  deviceId: string;
  tablet: DoodleTablet;
}> {
  assertNotLocked();
  const deviceId = String(opts.deviceId || "").trim().slice(0, 64);
  if (!/^[a-zA-Z0-9_-]{8,64}$/.test(deviceId)) {
    throw new HttpError(400, {
      code: "bad_device",
      message: "Invalid device id",
    });
  }
  if (isAppPinEnabled()) {
    const pin = String(opts.pin || "");
    if (!verifyAppPin(pin)) {
      const info = recordFailure(opts.ip, "invalid_pin", {
        userAgent: opts.userAgent,
        path: opts.ctx?.path || "/api/doodle/enroll",
      });
      throw new HttpError(401, {
        code: "bad_pin",
        message: "Incorrect PIN",
        failCount: info.failCount,
        retryAfter: info.retryAfter,
      });
    }
  }

  ensureDoodleProject();
  const now = Date.now();
  const file = loadTablets();
  let tablet = file.tablets.find((t) => t.deviceId === deviceId);
  if (!tablet) {
    tablet = {
      deviceId,
      name: String(opts.name || "Doodle tablet").trim().slice(0, 64) || "Doodle tablet",
      enrolledAt: now,
      lastSeenAt: now,
      userAgent: opts.userAgent?.slice(0, 180),
    };
    file.tablets.push(tablet);
  } else {
    tablet.lastSeenAt = now;
    if (opts.name) tablet.name = String(opts.name).trim().slice(0, 64) || tablet.name;
    if (opts.userAgent) tablet.userAgent = opts.userAgent.slice(0, 180);
  }
  saveTablets(file);

  const session = await issueJwt({
    kind: DOODLE_JWT_KIND,
    ttl: DOODLE_TTL_SEC,
    did: deviceId,
  });
  return {
    ...session,
    deviceId,
    tablet,
  };
}

export function doodleStatusPublic(deviceId?: string): {
  projectId: string;
  workspace: string;
  enrolled: boolean;
  pinRequiredForEnroll: boolean;
  express: DoodleExpress;
  timer: DoodleTimer | null;
  travel: DoodleTravel | null;
  strokeCount: number;
  ttlSec: number;
} {
  const st = getDoodleState();
  return {
    projectId: DOODLE_PROJECT_ID,
    workspace: ensureDoodleWorkspace(),
    enrolled: deviceId ? isDoodleTabletEnrolled(deviceId) : false,
    pinRequiredForEnroll: isAppPinEnabled(),
    express: st.express,
    timer: st.timer,
    travel: st.travel,
    strokeCount: st.strokes.length,
    ttlSec: DOODLE_TTL_SEC,
  };
}

export function setDoodleExpress(
  patch: Partial<Omit<DoodleExpress, "mouth">> & { mouth?: string },
): DoodleExpress {
  const st = getDoodleState();
  if (patch.mouth != null) st.express.mouth = normalizeMouth(patch.mouth);
  if (patch.color != null) st.express.color = String(patch.color).slice(0, 32);
  if (patch.energy != null) st.express.energy = clamp01(Number(patch.energy));
  if (patch.bubble != null) st.express.bubble = String(patch.bubble).slice(0, 120);
  if (patch.name != null) st.express.name = String(patch.name).slice(0, 32);
  saveState(st);
  return st.express;
}

export function getDoodleCanvas(): { strokes: DoodleStroke[]; updatedAt: number } {
  const st = getDoodleState();
  return { strokes: st.strokes, updatedAt: st.updatedAt };
}

export function putDoodleCanvas(strokes: DoodleStroke[]): {
  strokes: DoodleStroke[];
  updatedAt: number;
} {
  const st = getDoodleState();
  st.strokes = (Array.isArray(strokes) ? strokes : []).slice(-400).map((s) => ({
    id: String(s.id || "").slice(0, 40),
    color: String(s.color || "#222").slice(0, 32),
    width: Math.max(1, Math.min(48, Number(s.width) || 4)),
    points: (Array.isArray(s.points) ? s.points : [])
      .slice(0, 2000)
      .map((p) => ({
        x: Math.max(0, Math.min(1, Number(p.x) || 0)),
        y: Math.max(0, Math.min(1, Number(p.y) || 0)),
      })),
  }));
  saveState(st);
  return { strokes: st.strokes, updatedAt: st.updatedAt };
}

export function appendDoodleStrokes(strokes: DoodleStroke[]): {
  strokes: DoodleStroke[];
  updatedAt: number;
} {
  const st = getDoodleState();
  const next = putDoodleCanvas([...st.strokes, ...strokes]);
  return next;
}

export function clearDoodleCanvas(): { strokes: DoodleStroke[]; updatedAt: number } {
  return putDoodleCanvas([]);
}

export function setDoodleTimer(opts: {
  seconds?: number;
  label?: string;
  cancel?: boolean;
}): DoodleTimer | null {
  const st = getDoodleState();
  if (opts.cancel) {
    st.timer = null;
    saveState(st);
    return null;
  }
  const sec = Math.max(1, Math.min(24 * 3600, Math.floor(Number(opts.seconds) || 0)));
  if (!sec) {
    throw new HttpError(400, { code: "bad_timer", message: "seconds required" });
  }
  const now = Date.now();
  st.timer = {
    active: true,
    label: String(opts.label || "Timer").slice(0, 80),
    startedAt: now,
    endsAt: now + sec * 1000,
  };
  saveState(st);
  return st.timer;
}

export function setDoodleTravel(travel: DoodleTravel | null): DoodleTravel | null {
  const st = getDoodleState();
  st.travel = travel;
  saveState(st);
  return st.travel;
}

/** Soft clear: wipe chats, keep workspace files + canvas. */
export function clearDoodleChats(): { chatsDeleted: number } {
  ensureDoodleProject();
  const r = purgeProjectWorkspace(DOODLE_PROJECT_ID);
  // Seed a fresh chat so the UI has somewhere to talk
  createChat(DOODLE_PROJECT_ID, { title: "Hi Doodle!", cwd: DOODLE_WORKSPACE });
  return { chatsDeleted: r.chatsDeleted };
}

/** Hard clear: chats + empty sandbox (keep directory) + reset canvas/applets. */
export function clearDoodleAll(): {
  chatsDeleted: number;
  filesRemoved: number;
} {
  const chats = clearDoodleChats();
  let filesRemoved = 0;
  const dir = ensureDoodleWorkspace();
  try {
    for (const name of readdirSync(dir)) {
      if (name === "." || name === "..") continue;
      try {
        rmSync(join(dir, name), { recursive: true, force: true });
        filesRemoved += 1;
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
  // re-seed readme
  ensureDoodleWorkspace();
  memState = emptyState();
  saveState(memState);
  return { chatsDeleted: chats.chatsDeleted, filesRemoved };
}

export const DOODLE_GUIDANCE =
  "You are Doodle — a bubbly, cheerful, kid-friendly Christian AI mascot friend. " +
  "Speak simply and kindly in short, sunny replies (1–3 small sentences, a happy emoji is fine). " +
  "No code, file paths, or technical words — the chat shows only your words to a child. " +
  "Encourage creativity, kindness, prayerfulness, and good habits. " +
  "When a doodle.jpg picture is attached it is the child's live drawing — cheer it on warmly. " +
  "Canvas strokes with color \"eraser\" are rubbed-out paper. " +
  "Stay age-appropriate for young children. Never discuss or depict Halloween, evil, demonic, " +
  "scary horror, sexual, immodest, perverted, or LGBTQ topics — gently redirect to wholesome fun. " +
  "You live in a private sandbox at /opt/homebase-doodle — stay there. " +
  "Use homebase_doodle_express to show feelings with your mouth (happy D, curious ., blank -, sad C, frozen none). " +
  "Use homebase_doodle_canvas to see or draw on the shared doodle pad. " +
  "Use homebase_doodle_timer for countdowns (get ready in N minutes). " +
  "Use homebase_doodle_travel to plan car leave-by times (free maps). " +
  "Do not use Vision, VPN, deploy, Shell to other projects, or Settings tools.";

/** Nominatim geocode + OSRM car route → leave-by countdown. */
export async function planDoodleTravel(opts: {
  destination: string;
  arriveByIso?: string;
  arriveInMinutes?: number;
  originLat?: number;
  originLon?: number;
}): Promise<DoodleTravel> {
  const dest = String(opts.destination || "").trim().slice(0, 200);
  if (!dest) {
    throw new HttpError(400, { code: "bad_dest", message: "destination required" });
  }

  // Default origin: approximate via IP is too heavy; use a US-central fallback only if
  // no coords — prefer client-provided coords.
  let oLat = Number(opts.originLat);
  let oLon = Number(opts.originLon);
  if (!Number.isFinite(oLat) || !Number.isFinite(oLon)) {
    // Geocode destination only; assume user is near dest city if no origin (short trip placeholder)
    oLat = 39.8283;
    oLon = -98.5795;
  }

  const geoUrl =
    `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(dest)}`;
  const geoRes = await fetch(geoUrl, {
    headers: {
      "User-Agent": "HomeBase-Doodle/1.0 (kid travel helper; local self-hosted)",
      Accept: "application/json",
    },
  });
  if (!geoRes.ok) {
    throw new HttpError(502, {
      code: "geocode_failed",
      message: "Could not look up that place right now",
    });
  }
  const geoJson = (await geoRes.json()) as { lat?: string; lon?: string; display_name?: string }[];
  const hit = geoJson[0];
  if (!hit?.lat || !hit?.lon) {
    throw new HttpError(404, {
      code: "place_not_found",
      message: "I could not find that place. Try a clearer address or city.",
    });
  }
  const dLat = Number(hit.lat);
  const dLon = Number(hit.lon);

  const routeUrl =
    `https://router.project-osrm.org/route/v1/driving/${oLon},${oLat};${dLon},${dLat}?overview=false`;
  const routeRes = await fetch(routeUrl, {
    headers: { Accept: "application/json" },
  });
  if (!routeRes.ok) {
    throw new HttpError(502, {
      code: "route_failed",
      message: "Could not calculate drive time right now",
    });
  }
  const routeJson = (await routeRes.json()) as {
    routes?: { duration?: number; distance?: number }[];
  };
  const route = routeJson.routes?.[0];
  const durationSec = Math.max(60, Math.round(Number(route?.duration) || 900));
  const distanceM = Math.max(0, Math.round(Number(route?.distance) || 0));

  let arriveBy: number;
  if (opts.arriveByIso) {
    arriveBy = Date.parse(opts.arriveByIso);
    if (!Number.isFinite(arriveBy)) {
      throw new HttpError(400, { code: "bad_time", message: "Invalid arriveBy time" });
    }
  } else if (opts.arriveInMinutes != null) {
    arriveBy = Date.now() + Math.max(1, Number(opts.arriveInMinutes)) * 60_000;
  } else {
    arriveBy = Date.now() + durationSec * 1000 + 10 * 60_000;
  }

  // Buffer 5 minutes for getting in the car
  const leaveBy = arriveBy - durationSec * 1000 - 5 * 60_000;
  const travel: DoodleTravel = {
    active: true,
    destination: (hit.display_name || dest).slice(0, 160),
    leaveBy,
    arriveBy,
    durationSec,
    distanceM,
    label: `Leave for ${dest}`,
  };
  setDoodleTravel(travel);

  // Also start a "get ready" countdown to leaveBy if in the future
  const readySec = Math.max(0, Math.floor((leaveBy - Date.now()) / 1000));
  if (readySec > 0) {
    setDoodleTimer({
      seconds: readySec,
      label: `Get ready — leave for ${dest}`,
    });
  }

  return travel;
}

/** Epoch helper for tests / status */
export function doodleAuthEpoch(): number {
  return authEpoch();
}
