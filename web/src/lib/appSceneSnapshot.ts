import type { AppArea, Tab } from './types'
import type { WorkItem } from './uiPrefs'
import { parseAppPath, serializeAppPath } from './appRoutes'

const SNAP_KEY = 'hb-app-scene-snap'
const SCROLL_KEY = 'hb-app-scene-scroll'

const VALID_AREAS: AppArea[] = [
  'home',
  'homework',
  'access',
  'agent',
  'vision',
  'usage',
  'contingency',
  'settings',
]

const VALID_TABS: Tab[] = ['apps', 'work', 'shell', 'files', 'view', 'cursor', 'logs']
const VALID_WORK: WorkItem[] = ['apps', 'shell', 'files', 'git', 'chat']

/** Nav + workspace scene that must survive PinLock remounts and mid-lock refresh. */
export type AppSceneSnapshot = {
  area: AppArea
  tab: Tab
  workItem: WorkItem
  selectedId: string
}

export type SceneScrollMap = Partial<Record<AppArea, number>>

function normalizePath(pathname: string): string {
  const raw = (pathname.split('?')[0] || '/').replace(/\/+$/, '')
  return raw || '/'
}

export function parseAppSceneSnapshot(raw: unknown): AppSceneSnapshot | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  if (!(VALID_AREAS as string[]).includes(o.area as string)) return null
  if (!(VALID_TABS as string[]).includes(o.tab as string)) return null
  if (!(VALID_WORK as string[]).includes(o.workItem as string)) return null
  if (typeof o.selectedId !== 'string') return null
  return {
    area: o.area as AppArea,
    tab: o.tab as Tab,
    workItem: o.workItem as WorkItem,
    selectedId: o.selectedId,
  }
}

export function readAppSceneSnapshot(): AppSceneSnapshot | null {
  try {
    const raw = sessionStorage.getItem(SNAP_KEY)
    if (!raw) return null
    return parseAppSceneSnapshot(JSON.parse(raw))
  } catch {
    return null
  }
}

export function writeAppSceneSnapshot(snap: AppSceneSnapshot): void {
  try {
    sessionStorage.setItem(SNAP_KEY, JSON.stringify(snap))
  } catch {
    /* ignore */
  }
}

export function readSceneScrollMap(): SceneScrollMap {
  try {
    const raw = sessionStorage.getItem(SCROLL_KEY)
    if (!raw) return {}
    const o = JSON.parse(raw) as Record<string, unknown>
    if (!o || typeof o !== 'object') return {}
    const out: SceneScrollMap = {}
    for (const area of VALID_AREAS) {
      const n = o[area]
      if (typeof n === 'number' && Number.isFinite(n) && n >= 0) out[area] = n
    }
    return out
  } catch {
    return {}
  }
}

export function writeSceneScroll(area: AppArea, top: number): void {
  try {
    const prev = readSceneScrollMap()
    const next = { ...prev, [area]: Math.max(0, top) }
    sessionStorage.setItem(SCROLL_KEY, JSON.stringify(next))
  } catch {
    /* ignore */
  }
}

export function readSceneScroll(area: AppArea): number {
  return readSceneScrollMap()[area] ?? 0
}

/**
 * Choose the path AuthedApp should hydrate from.
 *
 * The head script stores `window.__HB_PATH` once at first paint for SSR/deep-link
 * hydrate. After client-side `history.pushState`, that value goes stale. Prefer the
 * live URL whenever it is a real deep link; only fall back to bootPath when live
 * is `/` (Next may briefly report `/` while the boot script still has the deep link).
 */
export function resolveLandingPath(bootPath: string | null | undefined, pathname: string): string {
  const live = normalizePath(pathname)
  const boot = bootPath != null && bootPath !== '' ? normalizePath(bootPath) : null
  if (live !== '/') return live
  if (boot && boot !== '/') return boot
  return live
}

export type BootstrapPrefs = {
  lastArea: AppArea
  lastTab: Tab
  workItem: WorkItem
  selectedId: string
}

export type BootstrapResult =
  | { kind: 'ok'; loc: AppSceneSnapshot; canonical: string }
  | { kind: 'notfound'; path: string; selectedId: string }

/**
 * Resolve area/tab/workItem for a cold AuthedApp boot (or first provider hydrate).
 * Snapshot fills selectedId and, when the URL is `/`, reinforces last-area restore.
 */
export function resolveBootstrapScene(
  landedPath: string,
  prefs: BootstrapPrefs,
  snapshot: AppSceneSnapshot | null,
): BootstrapResult {
  const path = normalizePath(landedPath)
  const selectedId = snapshot?.selectedId || prefs.selectedId || ''
  const parsed = parseAppPath(path)
  if (parsed.kind === 'notfound') {
    return { kind: 'notfound', path: parsed.path, selectedId }
  }

  let loc = parsed.loc
  if (path === '/') {
    // Soft-home: restore last scene (and snapshot when present).
    loc = {
      area: snapshot?.area || prefs.lastArea,
      tab: snapshot?.tab || prefs.lastTab,
      workItem: snapshot?.workItem || prefs.workItem,
    }
  } else if (path === '/work' || path === '/homework') {
    loc = {
      ...parsed.loc,
      workItem: snapshot?.workItem || prefs.workItem,
    }
  }

  const scene: AppSceneSnapshot = {
    area: loc.area,
    tab: loc.tab,
    workItem: loc.workItem,
    selectedId,
  }
  return { kind: 'ok', loc: scene, canonical: serializeAppPath(loc) }
}

/**
 * History writer must not push AuthedApp defaults over a live deep link or snapshot
 * before bootstrap has applied.
 */
export function shouldWriteHistory(opts: {
  routesReady: boolean
  bootstrapped: boolean
  notFound: boolean
  area: AppArea
  tab: Tab
  workItem: WorkItem
  currentPath: string
}): { write: boolean; path: string } {
  if (!opts.routesReady || !opts.bootstrapped || opts.notFound) {
    return { write: false, path: normalizePath(opts.currentPath) }
  }
  const path = serializeAppPath({
    area: opts.area,
    tab: opts.tab,
    workItem: opts.workItem,
  })
  const current = normalizePath(opts.currentPath)
  if (current === path) return { write: false, path }
  return { write: true, path }
}

/** Mimic PinLock moving children between fragment and frozen div → remount. */
export function sceneAfterAuthedRemount(
  providerScene: AppSceneSnapshot,
  bootstrapped: boolean,
): AppSceneSnapshot {
  // State lifted above PinLock survives remount; no re-defaulting.
  if (bootstrapped) return providerScene
  return providerScene
}
