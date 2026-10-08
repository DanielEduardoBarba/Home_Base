import { getToken } from './auth'
import type { FsEntry, NotificationItem, Project, Session } from './types'

/**
 * Same-origin paths only — identical in dev and prod:
 * - prod: FastAPI serves SPA + API on :80
 * - dev: Vite (:3080) proxies /api and /ws → uvicorn (:8080)
 * Never hardcode host/port here.
 */

function authHeaders(): HeadersInit {
  const token = getToken()
  return token ? { Authorization: `Bearer ${token}` } : {}
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(),
      ...(init?.headers || {}),
    },
  })
  if (!res.ok) {
    let detail: unknown = res.statusText
    try {
      detail = await res.json()
    } catch {
      /* ignore */
    }
    const err = new Error(
      typeof detail === 'object' && detail && 'detail' in detail
        ? JSON.stringify((detail as { detail: unknown }).detail)
        : String(detail),
    ) as Error & { status?: number; detail?: unknown }
    err.status = res.status
    err.detail = typeof detail === 'object' && detail && 'detail' in detail
      ? (detail as { detail: unknown }).detail
      : detail
    throw err
  }
  return res.json() as Promise<T>
}

export function wsUrl(path: string): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const token = encodeURIComponent(getToken() || '')
  const sep = path.includes('?') ? '&' : '?'
  return `${proto}//${location.host}${path}${sep}token=${token}`
}

export const api = {
  health: () =>
    request<{
      ok: boolean
      cursorConfigured: boolean
      tokenConfigured: boolean
      model: string
    }>('/api/health'),
  login: async (token: string) => {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) {
      const err = new Error(JSON.stringify(body.detail || body)) as Error & {
        status?: number
        detail?: unknown
      }
      err.status = res.status
      err.detail = body.detail || body
      throw err
    }
    return body as { ok: boolean }
  },
  lockout: () =>
    request<{ locked: boolean; retryAfter: number; failCount: number }>('/api/lockout'),
  projects: () => request<{ projects: Project[] }>('/api/projects'),
  project: (id: string) => request<Project>(`/api/projects/${id}`),
  action: (id: string, actionId: string, extraArgs: string[] = []) =>
    request<{ type?: string; session?: Session }>(`/api/projects/${id}/action`, {
      method: 'POST',
      body: JSON.stringify({ actionId, extraArgs }),
    }),
  stop: (id: string) =>
    request<{ killedSessions: string[] }>(`/api/projects/${id}/stop`, { method: 'POST' }),
  logs: (id: string, lines = 200) =>
    request<{ path: string; exists: boolean; text: string }>(
      `/api/projects/${id}/logs?lines=${lines}`,
    ),
  sessions: (project?: string) =>
    request<{ sessions: Session[] }>(
      project ? `/api/sessions?project=${project}` : '/api/sessions',
    ),
  killSession: (sessionId: string) =>
    request<{ ok: boolean }>(`/api/sessions/${sessionId}`, { method: 'DELETE' }),
  resetCursor: (id: string) =>
    request<{ ok: boolean }>(`/api/cursor/${id}/reset`, { method: 'POST' }),
  fsList: (id: string, path = '') =>
    request<{ path: string; entries: FsEntry[] }>(
      `/api/projects/${id}/fs?path=${encodeURIComponent(path)}`,
    ),
  fsRead: (id: string, path: string) =>
    request<{ path: string; content: string; language: string; size: number }>(
      `/api/projects/${id}/fs/read?path=${encodeURIComponent(path)}`,
    ),
  fsWrite: (id: string, path: string, content: string) =>
    request<{ ok: boolean }>(`/api/projects/${id}/fs/write`, {
      method: 'PUT',
      body: JSON.stringify({ path, content }),
    }),
  notifications: (opts: {
    offset?: number
    limit?: number
    unreadOnly?: boolean
    history?: boolean
  } = {}) => {
    const q = new URLSearchParams()
    if (opts.offset != null) q.set('offset', String(opts.offset))
    if (opts.limit != null) q.set('limit', String(opts.limit))
    if (opts.unreadOnly) q.set('unreadOnly', 'true')
    if (opts.history) q.set('history', 'true')
    return request<{
      total: number
      unread: number
      offset: number
      limit: number
      items: NotificationItem[]
    }>(`/api/notifications?${q}`)
  },
  markRead: (ids: string[] = [], all = false) =>
    request<{ marked: number }>('/api/notifications/read', {
      method: 'POST',
      body: JSON.stringify({ ids, all }),
    }),
  clearRead: () => request<{ removed: number }>('/api/notifications/read', { method: 'DELETE' }),
}
