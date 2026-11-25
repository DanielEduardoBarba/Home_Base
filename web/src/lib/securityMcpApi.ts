/**
 * MCP lockout Settings helpers. Kept out of api.ts so protected client files
 * stay untouched; same-origin fetch + CSRF as the main client.
 */
import { getCsrfToken } from './auth'

export type McpLockoutSource = {
  source: string
  failCount: number
  lockedUntil: number
  locked: boolean
  retryAfter: number
  threshold: number
}

export type SecurityStatusExtended = {
  lockout: { failCount: number; locked: boolean; retryAfter: number; threshold: number }
  mcpLockout: { failCount: number; locked: boolean; retryAfter: number; threshold: number; ip: string }
  mcpLockouts: McpLockoutSource[]
  devices: unknown[]
  stats: { files: number; bytes: number; headCount: number }
}

function csrfHeaders(method: string): HeadersInit {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  const csrf = getCsrfToken()
  const m = method.toUpperCase()
  if (csrf && m !== 'GET' && m !== 'HEAD' && m !== 'OPTIONS') {
    headers['X-CSRF-Token'] = csrf
  }
  return headers
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const method = init?.method || 'GET'
  const res = await fetch(path, {
    ...init,
    credentials: 'include',
    headers: {
      ...csrfHeaders(method),
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
    const payload =
      typeof detail === 'object' && detail && 'detail' in detail
        ? (detail as { detail: unknown }).detail
        : detail
    const message =
      typeof payload === 'string' ? payload : payload != null ? JSON.stringify(payload) : String(detail)
    const err = new Error(message) as Error & { status?: number; detail?: unknown }
    err.status = res.status
    err.detail =
      typeof detail === 'object' && detail && 'detail' in detail
        ? (detail as { detail: unknown }).detail
        : detail
    throw err
  }
  return (await res.json()) as T
}

export function fetchSecurityStatus(): Promise<SecurityStatusExtended> {
  return request<SecurityStatusExtended>('/api/security/status')
}

export function clearMcpLockout(opts: {
  source?: string
  all?: boolean
  password?: string
  pin?: string
}): Promise<{
  ok: boolean
  method: string
  sourcesCleared: number
  sources: string[]
  emailed: boolean
  emailGap?: string
}> {
  return request('/api/security/mcp-lockout/clear', {
    method: 'POST',
    body: JSON.stringify(opts),
  })
}
