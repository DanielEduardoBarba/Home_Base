import { api } from './api'
import { hasSession } from './auth'

/** Best-effort human activity breadcrumbs (never blocks UI). */
export function logActivity(
  kind: string,
  summary: string,
  detail?: Record<string, unknown>,
): void {
  if (!hasSession()) return
  void api.logActivity(kind, summary, detail).catch(() => undefined)
}

export function presenceHeartbeat(opts?: {
  area?: string
  tab?: string
  label?: string
}): void {
  if (!hasSession()) return
  void api.presenceHeartbeat(opts).catch(() => undefined)
}
