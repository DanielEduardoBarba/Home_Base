const TOKEN_KEY = 'homebase_jwt'
const EXP_KEY = 'homebase_jwt_exp'
const REASON_KEY = 'hb_auth_reason'

export type AuthLostReason = 'expired' | 'signed_out' | 'unauthorized' | 'stale_session'

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY)
}

export function getExpiresAt(): number | null {
  const raw = localStorage.getItem(EXP_KEY)
  if (!raw) return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

export function setSession(token: string, expiresAt: number): void {
  localStorage.setItem(TOKEN_KEY, token.trim())
  localStorage.setItem(EXP_KEY, String(expiresAt))
  try {
    sessionStorage.removeItem(REASON_KEY)
  } catch {
    /* ignore */
  }
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY)
  localStorage.removeItem(EXP_KEY)
  // Clear legacy shared-secret storage
  localStorage.removeItem('homebase_token')
}

/** Clear session and notify the app shell (optional reason for Login copy). */
export function clearSession(reason?: AuthLostReason): void {
  clearToken()
  if (reason) {
    try {
      sessionStorage.setItem(REASON_KEY, reason)
    } catch {
      /* ignore */
    }
  }
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
  const token = getToken()
  if (!token) return false
  const exp = getExpiresAt()
  if (exp != null && exp * 1000 <= Date.now() + 5_000) {
    clearSession('expired')
    return false
  }
  return true
}

/** Schedule proactive expiry → clearSession('expired'). Returns cleanup. */
export function watchSessionExpiry(): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  const arm = () => {
    if (timer) clearTimeout(timer)
    if (!getToken()) return
    const exp = getExpiresAt()
    if (exp == null) return
    const ms = exp * 1000 - Date.now() - 5_000
    if (ms <= 0) {
      clearSession('expired')
      return
    }
    timer = setTimeout(() => clearSession('expired'), Math.min(ms, 2_147_000_000))
  }
  arm()
  const onStorage = (e: StorageEvent) => {
    if (e.key === TOKEN_KEY || e.key === EXP_KEY) arm()
  }
  window.addEventListener('storage', onStorage)
  return () => {
    if (timer) clearTimeout(timer)
    window.removeEventListener('storage', onStorage)
  }
}
