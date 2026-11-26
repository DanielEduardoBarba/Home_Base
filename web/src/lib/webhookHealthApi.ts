/**
 * Job webhook health + default callback URL helpers.
 * Kept out of api.ts so that protected client file stays untouched.
 */
import { getCsrfToken } from './auth'

export type WebhookHealthRow = {
  jobId: string
  projectId: string
  jobStatus: string
  callbackUrlRedacted?: string
  callbackAuthExpected: boolean
  webhookDelivered?: boolean
  webhookSentAt?: number
  webhookAttempts?: number
  webhookLastStatusCode?: number
  webhookLastAttemptAt?: number
  webhookError?: string
  failed: boolean
  pending: boolean
  startedAt: number
  finishedAt?: number
}

export type DefaultCallbackUrlMeta = {
  configured: boolean
  urlRedacted: string | null
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
      typeof payload === 'string'
        ? payload
        : payload != null
          ? JSON.stringify(payload)
          : String(detail)
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

export function fetchWebhookHealth(limit = 40): Promise<{
  rows: WebhookHealthRow[]
  hasFailures: boolean
}> {
  return request(`/api/webhooks/health?limit=${encodeURIComponent(String(limit))}`)
}

export function sendWebhookTestPing(callbackUrl?: string): Promise<{
  ok: boolean
  urlRedacted?: string
  statusCode?: number
  error?: string
  at: number
}> {
  return request('/api/webhooks/test-ping', {
    method: 'POST',
    body: JSON.stringify(callbackUrl ? { callbackUrl } : {}),
  })
}

export function fetchDefaultCallbackUrl(): Promise<DefaultCallbackUrlMeta> {
  return request('/api/callback-url')
}

export function setDefaultCallbackUrl(url: string): Promise<DefaultCallbackUrlMeta> {
  return request('/api/callback-url', {
    method: 'POST',
    body: JSON.stringify({ url }),
  })
}

export function clearDefaultCallbackUrl(): Promise<DefaultCallbackUrlMeta> {
  return request('/api/callback-url', { method: 'DELETE' })
}
