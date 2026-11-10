import { api } from './api'

/** Best-effort human activity breadcrumbs (never blocks UI). */
export function logActivity(
  kind: string,
  summary: string,
  detail?: Record<string, unknown>,
): void {
  void api.logActivity(kind, summary, detail).catch(() => undefined)
}

export function presenceHeartbeat(opts?: {
  area?: string
  tab?: string
  label?: string
}): void {
  void api.presenceHeartbeat(opts).catch(() => undefined)
}
