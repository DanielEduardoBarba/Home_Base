import type { AuthLostReason } from './auth'

export const SESSION_AUTH_CODES: Record<string, AuthLostReason> = {
  expired: 'expired',
  invalid_token: 'unauthorized',
  missing_token: 'unauthorized',
  stale_session: 'stale_session',
  invalid_kind: 'unauthorized',
  share_token: 'unauthorized',
}

export function formatWait(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  if (s <= 0) return 'a moment'
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  if (d > 0) return h > 0 ? `${d}d ${h} hr` : `${d}d`
  if (h > 0) return m > 0 ? `${h} hr ${m} min` : `${h} hr`
  if (m > 0) return `${m} min`
  return `${r}s`
}

export type AuthErrorKind = 'wrong_credentials' | 'locked_out' | 'session' | 'server' | 'network'

export type ParsedAuthError = {
  kind: AuthErrorKind
  status?: number
  code: string
  serverMessage: string
  headline: string
  statusLine: string
  retryAfter: number
  failCount?: number
  remainingAttempts?: number
  sessionReason?: AuthLostReason
}

function asDetail(err: unknown): { status?: number; detail?: unknown; message?: string } {
  const e = err as { status?: number; detail?: unknown; message?: string }
  return { status: e?.status, detail: e?.detail, message: e?.message }
}

function parsePayload(detail: unknown): {
  message?: string
  code?: string
  retryAfter?: number
  failCount?: number
  remainingAttempts?: number
} {
  if (detail == null) return {}
  if (typeof detail === 'string') {
    try {
      return parsePayload(JSON.parse(detail))
    } catch {
      return { message: detail }
    }
  }
  if (typeof detail === 'object') {
    const d = detail as Record<string, unknown>
    return {
      message: typeof d.message === 'string' ? d.message : undefined,
      code: typeof d.code === 'string' ? d.code : undefined,
      retryAfter: Number(d.retryAfter || 0) || 0,
      failCount: typeof d.failCount === 'number' ? d.failCount : undefined,
      remainingAttempts:
        typeof d.remainingAttempts === 'number' ? d.remainingAttempts : undefined,
    }
  }
  return {}
}

export function parseAuthError(
  err: unknown,
  opts?: { surface?: 'pin' | 'login' },
): ParsedAuthError {
  const surface = opts?.surface || 'login'
  const { status, detail, message } = asDetail(err)
  const payload = parsePayload(detail)
  const serverMessage =
    payload.message ||
    (typeof message === 'string' && !message.startsWith('{') ? message : '') ||
    'Request failed'
  const code = payload.code || ''
  const retryAfter = payload.retryAfter || 0
  const remainingAttempts = payload.remainingAttempts
  const failCount = payload.failCount
  const sessionReason = code ? SESSION_AUTH_CODES[code] : undefined
  const statusLine = status
    ? `HTTP ${status}${serverMessage ? ` · ${serverMessage}` : ''}`
    : serverMessage

  if (status == null && (err instanceof TypeError || /network|failed to fetch/i.test(String(message)))) {
    return {
      kind: 'network',
      code: 'network',
      serverMessage: 'Network error',
      headline: "Can't reach the server (network error).",
      statusLine: 'Network error',
      retryAfter: 0,
    }
  }

  if (retryAfter > 0 || status === 429 || code === 'auth_lockout' || code === 'mcp_lockout') {
    const wait = formatWait(retryAfter || 0)
    const headline =
      surface === 'pin'
        ? `Too many attempts. Try again in ${wait}, or sign in with your password.`
        : `Too many attempts. Try again in ${wait}.`
    return {
      kind: 'locked_out',
      status,
      code: code || 'auth_lockout',
      serverMessage,
      headline,
      statusLine,
      retryAfter,
      failCount,
      remainingAttempts: 0,
    }
  }

  if (sessionReason || code === 'expired' || code === 'stale_session') {
    const headline =
      code === 'stale_session'
        ? 'Password changed — please sign in with your password.'
        : 'Session expired, please sign in with your password.'
    return {
      kind: 'session',
      status,
      code,
      serverMessage,
      headline,
      statusLine,
      retryAfter: 0,
      sessionReason: sessionReason || 'expired',
    }
  }

  if (status && status >= 500) {
    return {
      kind: 'server',
      status,
      code: code || 'server_error',
      serverMessage,
      headline: `Server error. ${statusLine}`,
      statusLine,
      retryAfter: 0,
    }
  }

  let headline = serverMessage
  if (code === 'bad_pin' || surface === 'pin') {
    headline =
      remainingAttempts && remainingAttempts > 0
        ? `Incorrect PIN. ${remainingAttempts} attempt${remainingAttempts === 1 ? '' : 's'} left.`
        : 'Incorrect PIN.'
  } else if (code === 'invalid_password' || surface === 'login') {
    headline =
      remainingAttempts && remainingAttempts > 0
        ? `Invalid password. ${remainingAttempts} attempt${remainingAttempts === 1 ? '' : 's'} left.`
        : serverMessage || 'Invalid password'
  }

  return {
    kind: 'wrong_credentials',
    status,
    code,
    serverMessage,
    headline,
    statusLine,
    retryAfter: 0,
    failCount,
    remainingAttempts,
  }
}
