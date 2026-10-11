/**
 * Persist last attached PTY session ids so Shell/Work can reattach after reload
 * while the server-side PTY is still alive (detach ≠ kill).
 */
const KEY = 'hb-shell-attach'

type Stored = { projectId: string; ids: string[]; at: number }

export function writeShellAttach(projectId: string, ids: string[]): void {
  try {
    if (!projectId || !ids.length) {
      sessionStorage.removeItem(KEY)
      return
    }
    const payload: Stored = { projectId, ids, at: Date.now() }
    sessionStorage.setItem(KEY, JSON.stringify(payload))
  } catch {
    /* ignore */
  }
}

export function clearShellAttach(): void {
  try {
    sessionStorage.removeItem(KEY)
  } catch {
    /* ignore */
  }
}

export function readShellAttach(projectId: string): string[] | null {
  try {
    const raw = sessionStorage.getItem(KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Stored
    if (!parsed || parsed.projectId !== projectId) return null
    if (!Array.isArray(parsed.ids) || !parsed.ids.length) return null
    // Stale after 12h — PTYs rarely outlive that usefully in the UI.
    if (Date.now() - (parsed.at || 0) > 12 * 60 * 60 * 1000) return null
    return parsed.ids.filter((id) => typeof id === 'string' && id.length > 0)
  } catch {
    return null
  }
}
