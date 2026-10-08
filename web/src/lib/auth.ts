const TOKEN_KEY = 'homebase_jwt'
const EXP_KEY = 'homebase_jwt_exp'

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
}

/** @deprecated use setSession */
export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token.trim())
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY)
  localStorage.removeItem(EXP_KEY)
  // Clear legacy shared-secret storage
  localStorage.removeItem('homebase_token')
}

export function isSessionValid(): boolean {
  const token = getToken()
  if (!token) return false
  const exp = getExpiresAt()
  if (exp != null && exp * 1000 <= Date.now() + 5_000) {
    clearToken()
    return false
  }
  return true
}
