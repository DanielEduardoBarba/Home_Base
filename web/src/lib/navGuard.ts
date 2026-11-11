/** In-app navigation blockers (e.g. unsaved file edits). */

type LeaveBlocker = () => boolean | Promise<boolean>

const blockers = new Set<LeaveBlocker>()

export function registerLeaveBlocker(fn: LeaveBlocker): () => void {
  blockers.add(fn)
  return () => {
    blockers.delete(fn)
  }
}

/** Returns false when the user cancels leaving a dirty view. */
export async function confirmNavigation(): Promise<boolean> {
  for (const fn of [...blockers]) {
    if (!(await fn())) return false
  }
  return true
}
