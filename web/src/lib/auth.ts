const TOKEN_KEY = 'homebase_jwt'
const EXP_KEY = 'homebase_jwt_exp'
const REASON_KEY = 'hb_auth_reason'

export type AuthLostReason = 'expired' | 'signed_out' | 'unauthorized' | 'stale_session'

/** In-memory only — the JWT lives in an HttpOnly cookie and is not readable by JS. */
let csrfToken: string | null = null
let expiresAtMem: number | null = null
let sessionPresent = false

const sessionPollers = new Set<() => void>()
let authLostSent = false

/**
 * Drop any 1.20.0 localStorage JWTs. Must run on first load after upgrade so a
 * leftover token is never reused; the user signs in once with password or PIN.
 * Returns true if a legacy token was present.
 */
export function migrateLegacyLocalSession(): boolean {
  let had = false
  try {
    had = Boolean(
      localStorage.getItem(TOKEN_KEY) ||
        localStorage.getItem(EXP_KEY) ||
        localStorage.getItem('homebase_token'),
    )
    localStorage.removeItem(TOKEN_KEY)
    localStorage.removeItem(EXP_KEY)
    localStorage.removeItem('homebase_token')
  } catch {
    /* private mode */
  }
  return had
}

export function getCsrfToken(): string | null {
  return csrfToken
}

export function hasSession(): boolean {
  if (!sessionPresent) return false
  if (expiresAtMem != null && expiresAtMem * 1000 <= Date.now() + 5_000) {
    clearSession('expired')
    return false
  }
  return true
}

export function getExpiresAt(): number | null {
  return expiresAtMem
}

/** Register a timer/poller that must stop on sign-out or any 401. */
export function registerSessionPoller(stop: () => void): () => void {
  sessionPollers.add(stop)
  return () => {
    sessionPollers.delete(stop)
    stop()
  }
}

export function stopAllSessionPollers(): void {
  for (const stop of [...sessionPollers]) {
    try {
      stop()
    } catch {
      /* ignore */
    }
  }
  sessionPollers.clear()
}

export function setSession(session: { expiresAt: number; csrfToken: string }): void {
  csrfToken = session.csrfToken
  expiresAtMem = session.expiresAt
  sessionPresent = true
  authLostSent = false
  try {
    sessionStorage.removeItem(REASON_KEY)
  } catch {
    /* ignore */
  }
  // Belt and suspenders: never leave a JWT in localStorage after login.
  migrateLegacyLocalSession()
}

function clearMemory(): void {
  csrfToken = null
  expiresAtMem = null
  sessionPresent = false
  try {
    localStorage.removeItem(TOKEN_KEY)
    localStorage.removeItem(EXP_KEY)
    localStorage.removeItem('homebase_token')
  } catch {
    /* ignore */
  }
}

/** Clear in-memory session and notify the app shell (optional reason for Login copy). */
export function clearSession(reason?: AuthLostReason): void {
  const hadSession = sessionPresent || Boolean(
    typeof localStorage !== 'undefined' &&
      (localStorage.getItem(TOKEN_KEY) || localStorage.getItem('homebase_token')),
  )
  clearMemory()
  stopAllSessionPollers()
  if (reason) {
    try {
      sessionStorage.setItem(REASON_KEY, reason)
    } catch {
      /* ignore */
    }
  }
  // Redirect / notify the shell once — repeat 401s must not retrigger login churn.
  if (!hadSession && authLostSent) return
  authLostSent = true
  window.dispatchEvent(
    new CustomEvent('hb-auth-lost', { detail: { reason: reason || 'unauthorized' } }),
  )
}

export function takeAuthLostReason(): AuthLostReason | '' {
  try {
    const r = (sessionStorage.getItem(REASON_KEY) || '') as AuthLostReason | ''
    sessionStorage.removeItem(REASON_KEY)
    return r
  } catch {
    return ''
  }
}

export function isSessionValid(): boolean {
  return hasSession()
}

/** Schedule proactive expiry → clearSession('expired'). Returns cleanup. */
export function watchSessionExpiry(): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  const arm = () => {
    if (timer) clearTimeout(timer)
    if (!sessionPresent) return
    const exp = expiresAtMem
    if (exp == null) return
    const ms = exp * 1000 - Date.now() - 5_000
    if (ms <= 0) {
      clearSession('expired')
      return
    }
    timer = setTimeout(() => clearSession('expired'), Math.min(ms, 2_147_000_000))
  }
  arm()
  return () => {
    if (timer) clearTimeout(timer)
  }
}
