/**
 * Persist last attached PTY session ids per project so Shell/Work can reattach
 * after leaving the pane or reloading, while the server-side PTY is still alive.
 */
const KEY = 'hb-shell-attach'
const LEGACY_KEY = 'hb-shell-attach'
const MAX_AGE_MS = 12 * 60 * 60 * 1000

type Slot = { ids: string[]; at: number }
type Stored = { projectId: string; ids: string[]; at: number }

function readMap(): Record<string, Slot> {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, Slot>
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeMap(map: Record<string, Slot>): void {
  localStorage.setItem(KEY, JSON.stringify(map))
}

/** One-time lift of the old single-slot sessionStorage value. */
function migrateLegacy(): void {
  try {
    const raw = sessionStorage.getItem(LEGACY_KEY)
    if (!raw) return
    sessionStorage.removeItem(LEGACY_KEY)
    const parsed = JSON.parse(raw) as Stored
    if (!parsed?.projectId || !Array.isArray(parsed.ids) || !parsed.ids.length) return
    const map = readMap()
    if (!map[parsed.projectId]) {
      map[parsed.projectId] = { ids: parsed.ids, at: parsed.at || Date.now() }
      writeMap(map)
    }
  } catch {
    /* ignore */
  }
}

export function writeShellAttach(projectId: string, ids: string[]): void {
  if (!projectId) return
  try {
    const map = readMap()
    const clean = ids.filter((id) => typeof id === 'string' && id.length > 0)
    if (!clean.length) delete map[projectId]
    else map[projectId] = { ids: clean, at: Date.now() }
    writeMap(map)
  } catch {
    /* ignore */
  }
}

export function clearShellAttach(projectId?: string): void {
  try {
    if (!projectId) {
      localStorage.removeItem(KEY)
      return
    }
    const map = readMap()
    delete map[projectId]
    writeMap(map)
  } catch {
    /* ignore */
  }
}

export function readShellAttach(projectId: string): string[] | null {
  if (!projectId) return null
  try {
    migrateLegacy()
    const slot = readMap()[projectId]
    if (!slot || !Array.isArray(slot.ids) || !slot.ids.length) return null
    if (Date.now() - (slot.at || 0) > MAX_AGE_MS) return null
    return slot.ids.filter((id) => typeof id === 'string' && id.length > 0)
  } catch {
    return null
  }
}
