import { clearToken, getToken } from './auth'
import type { FsEntry, NotificationItem, Project, Session, TraceLine } from './types'

/**
 * Same-origin paths only — identical in dev and prod:
 * - prod: FastAPI serves SPA + API on :8888
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
    // Expired / invalid JWT → drop local session so UI can re-login cleanly
    if (res.status === 401) {
      const code =
        typeof err.detail === 'object' && err.detail && 'code' in err.detail
          ? String((err.detail as { code?: string }).code || '')
          : ''
      if (code === 'expired' || code === 'invalid_token' || code === 'missing_token') {
        clearToken()
      }
    }
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

type SessionResponse = {
  ok: boolean
  token: string
  expiresAt: number
  expiresIn: number
  shareConsumed?: boolean
}

export const api = {
  health: () =>
    request<{
      ok: boolean
      cursorConfigured: boolean
      passwordSet: boolean
      tokenConfigured: boolean
      model: string
      jwtTtlSec: number
    }>('/api/health'),
  authStatus: () =>
    request<{
      passwordSet: boolean
      jwtTtlSec: number
      lockout: { locked: boolean; retryAfter: number; failCount: number }
    }>('/api/auth/status'),
  login: async (password: string) => {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
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
    return body as SessionResponse
  },
  setPassword: (password: string, currentPassword?: string) =>
    request<SessionResponse>('/api/auth/password', {
      method: 'POST',
      body: JSON.stringify({
        password,
        ...(currentPassword ? { currentPassword } : {}),
      }),
    }),
  shareRedeem: async (shareId: string) => {
    const res = await fetch('/api/share/redeem', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shareId }),
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
    return body as SessionResponse
  },
  shareStatus: () =>
    request<{
      active: boolean
      consumed: boolean
      expiresIn: number
      shareId: string | null
      hostname: string
    }>('/api/share/status'),
  shareReveal: (port: number, protocol: string) =>
    request<{
      shareId: string
      loginUrl: string
      expiresIn: number
      hostname: string
      port: number
    }>('/api/share/reveal', {
      method: 'POST',
      body: JSON.stringify({ port, protocol }),
    }),
  shareHide: () =>
    request<{ ok: boolean; active: boolean }>('/api/share/hide', { method: 'POST' }),
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
  resetCursor: (id: string, chatId = 'default') =>
    request<{ ok: boolean }>(
      `/api/cursor/${id}/reset?chatId=${encodeURIComponent(chatId)}`,
      { method: 'POST' },
    ),
  cursorModels: () =>
    request<{
      configured: boolean
      default: string
      models: { id: string; displayName: string; description: string }[]
      error?: string
    }>('/api/cursor/models'),
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
  trace: (limit = 300, afterId = 0) =>
    request<{ items: TraceLine[]; lastId: number; max: number }>(
      `/api/trace?limit=${limit}&afterId=${afterId}`,
    ),
}
