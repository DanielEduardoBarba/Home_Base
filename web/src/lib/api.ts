import { clearSession, getCsrfToken, type AuthLostReason } from './auth'
import type {
  AccessWidget,
  FsEntry,
  NotificationItem,
  Project,
  Session,
  TraceLine,
} from './types'

/**
 * Same-origin paths only — identical in dev and prod:
 * - prod: Bun serves SPA + API on :8888
 * - dev: Next (:3081 via scripts/dev.mjs) proxies /api and /ws → API (:8081)
 * Never hardcode host/port here.
 */

function authHeaders(method?: string): HeadersInit {
  const headers: Record<string, string> = {}
  const csrf = getCsrfToken()
  const m = (method || 'GET').toUpperCase()
  if (csrf && m !== 'GET' && m !== 'HEAD' && m !== 'OPTIONS') {
    headers['X-CSRF-Token'] = csrf
  }
  return headers
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(init?.method),
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
    err.detail = typeof detail === 'object' && detail && 'detail' in detail
      ? (detail as { detail: unknown }).detail
      : detail
    // Session 401s drop the local JWT. Credential errors (bad PIN / password) must not.
    if (res.status === 401) {
      const code =
        typeof err.detail === 'object' && err.detail && 'code' in err.detail
          ? String((err.detail as { code?: string }).code || '')
          : ''
      const reasons: Record<string, AuthLostReason> = {
        expired: 'expired',
        invalid_token: 'unauthorized',
        missing_token: 'unauthorized',
        stale_session: 'stale_session',
        invalid_kind: 'unauthorized',
        share_token: 'unauthorized',
      }
      if (code && reasons[code]) {
        clearSession(reasons[code])
      } else if (!code && code !== 'bad_pin') {
        const msg = String(
          typeof err.detail === 'object' && err.detail && 'message' in err.detail
            ? (err.detail as { message?: string }).message || ''
            : err.detail || '',
        )
        const credential = /invalid password|incorrect pin|bad_pin/i.test(msg)
        if (!credential) clearSession('unauthorized')
      }
    }
    // Server-side App PIN gate — tell PinLock to cover the UI, with the 423 copy.
    if (res.status === 423) {
      try {
        window.dispatchEvent(new CustomEvent('hb-pin-lock', { detail: err }))
      } catch {
        /* ignore */
      }
    }
    throw err
  }
  return res.json() as Promise<T>
}

export async function wsUrl(path: string): Promise<string> {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const minted = await request<{ ticket: string; expiresAt: number; expiresIn: number }>(
    '/api/ws-ticket',
    { method: 'POST' },
  )
  const sep = path.includes('?') ? '&' : '?'
  return `${proto}//${location.host}${path}${sep}ticket=${encodeURIComponent(minted.ticket)}`
}

type SessionResponse = {
  ok: boolean
  token?: string
  csrfToken: string
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
      model: string
      jwtTtlSec: number
      version?: string
      backup?: boolean
      displayName?: string
      lanHost?: string | null
      vpnHost?: string | null
      advertiseHost?: string | null
      port?: number
      urls?: { lan: string | null; vpn: string | null }
      wireguard?: {
        installed: boolean
        configured: boolean
        active: boolean
        iface: string | null
        host: string | null
      }
    }>('/api/health'),
  serverIdentity: () =>
    request<{
      displayName: string
      suggestedName: string
      ownerGuess: string
      customized: boolean
    }>('/api/server/identity'),
  setServerIdentity: (displayName: string) =>
    request<{
      ok: boolean
      displayName: string
      suggestedName: string
      ownerGuess: string
      customized: boolean
    }>('/api/server/identity', {
      method: 'POST',
      body: JSON.stringify({ displayName }),
    }),
  version: () => request<{ version: string; backup: boolean }>('/api/version'),
  viewStatus: () =>
    request<{
      ok: boolean
      display: string
      xauthority: boolean
      screenW: number
      screenH: number
      monitors?: {
        index: number
        label: string
        left: number
        top: number
        width: number
        height: number
      }[]
      clients: number
      error?: string
      fps?: number
      kbps?: number
    }>('/api/view/status'),
  systemStatus: () =>
    request<{
      wireguard: { id: string; unit: string; conf: string }[]
      homebasedUnit: string
      version: string
      backup: boolean
      lanHost?: string | null
      vpnHost?: string | null
      advertiseHost?: string | null
      port?: number
      urls?: { lan: string | null; vpn: string | null }
    }>('/api/system/status'),
  presenceHeartbeat: (body?: { area?: string; tab?: string; label?: string }) =>
    request<{ ok: boolean }>('/api/presence/heartbeat', {
      method: 'POST',
      body: JSON.stringify(body || {}),
    }),
  logActivity: (
    kind: string,
    summary: string,
    detail?: Record<string, unknown>,
  ) =>
    request<{ ok: boolean }>('/api/activity', {
      method: 'POST',
      body: JSON.stringify({ kind, summary, detail }),
    }),
  activityHistory: (opts?: {
    day?: string
    source?: string
    limit?: number
    offset?: number
  }) => {
    const q = new URLSearchParams()
    if (opts?.day) q.set('day', opts.day)
    if (opts?.source) q.set('source', opts.source)
    if (opts?.limit != null) q.set('limit', String(opts.limit))
    if (opts?.offset != null) q.set('offset', String(opts.offset))
    const qs = q.toString()
    return request<{
      day: string
      days: string[]
      total: number
      events: {
        at: number
        source: string
        kind: string
        summary: string
        actor?: string
        peerIp?: string
        detail?: Record<string, unknown>
      }[]
    }>(`/api/activity${qs ? `?${qs}` : ''}`)
  },
  clearActivityDay: (day: string) =>
    request<{ ok: boolean; removed: boolean }>('/api/activity', {
      method: 'DELETE',
      body: JSON.stringify({ day }),
    }),
  emailAlerts: () =>
    request<{
      enabled: boolean
      provider: 'resend' | 'smtp'
      to: string
      from: string
      smtpHost: string
      smtpPort: number
      smtpUser: string
      smtpSecure: boolean
      resendConfigured: boolean
      resendHint: string | null
      smtpPassConfigured: boolean
      ready: boolean
      updatedAt?: number
      scopes: { suspiciousAuth: true; aiAwayAccess: true }
      seat: {
        away: boolean
        reason: string
        idleMs: number | null
        locked: boolean
        detail?: string
      }
    }>('/api/email-alerts'),
  saveEmailAlerts: (body: {
    enabled?: boolean
    provider?: 'resend' | 'smtp'
    to?: string
    from?: string
    smtpHost?: string
    smtpPort?: number
    smtpUser?: string
    smtpSecure?: boolean
    resendApiKey?: string
    smtpPass?: string
  }) =>
    request<{ ok: boolean; ready: boolean; enabled: boolean }>('/api/email-alerts', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  testEmailAlerts: () =>
    request<{ ok: boolean }>('/api/email-alerts/test', { method: 'POST', body: '{}' }),
  clearEmailAlertSecrets: () =>
    request<{ ok: boolean }>('/api/email-alerts/secrets', { method: 'DELETE' }),
  mcpServerStatus: () =>
    request<{
      enabled: boolean
      allowMcpWorkspaceCreate: boolean
      allowMcpGitWrite: boolean
      allowMcpGithubRepos: boolean
      features: {
        projects: boolean
        notifications: boolean
        status: boolean
        homeAccess: boolean
        vision: boolean
        presence: boolean
      }
      featureMeta: {
        id:
          | 'projects'
          | 'notifications'
          | 'status'
          | 'homeAccess'
          | 'vision'
          | 'presence'
        label: string
        hint: string
        defaultOn: boolean
      }[]
      updatedAt?: number
      endpointPath: string
      url: string | null
      version: string
      tokenCount: number
      tokens: {
        id: string
        prefix: string
        label: string
        createdAt: number
        kind?: string
        lastUsedAt?: number
        lastUsedIp?: string
      }[]
      catalog: {
        allowed: {
          name: string
          description: string
          feature: string
        }[]
        disabled: {
          name: string
          description: string
          feature: string
        }[]
        humanOnly: string[]
        features: Record<string, boolean>
      }
      clientConfigs: { cursorMcpJson: string; genericUrl: string }
      grokGuide: string
    }>('/api/mcp-server'),
  setMcpServer: (body: {
    enabled?: boolean
    allowMcpWorkspaceCreate?: boolean
    allowMcpGitWrite?: boolean
    allowMcpGithubRepos?: boolean
    features?: Partial<{
      projects: boolean
      notifications: boolean
      status: boolean
      homeAccess: boolean
      vision: boolean
      presence: boolean
    }>
  }) =>
    request<{
      ok: boolean
      enabled: boolean
      features: {
        projects: boolean
        notifications: boolean
        status: boolean
        homeAccess: boolean
        vision: boolean
        presence: boolean
      }
      url: string | null
      tokenCount: number
      tokens: { id: string; prefix: string; label: string; createdAt: number }[]
      catalog: {
        allowed: { name: string; description: string; feature: string }[]
        disabled: { name: string; description: string; feature: string }[]
        humanOnly: string[]
      }
      clientConfigs: { cursorMcpJson: string; genericUrl: string }
      grokGuide: string
      endpointPath: string
    }>('/api/mcp-server', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  setMcpServerEnabled: (enabled: boolean) =>
    request<{
      ok: boolean
      enabled: boolean
      url: string | null
      tokenCount: number
      tokens: { id: string; prefix: string; label: string; createdAt: number }[]
      catalog: {
        allowed: { name: string; description: string; feature: string }[]
        disabled: { name: string; description: string; feature: string }[]
        humanOnly: string[]
      }
      clientConfigs: { cursorMcpJson: string; genericUrl: string }
      endpointPath: string
    }>('/api/mcp-server', {
      method: 'POST',
      body: JSON.stringify({ enabled }),
    }),
  mintMcpToken: (label?: string) =>
    request<{
      ok: boolean
      id: string
      token: string
      accessToken: string
      refreshToken: string
      prefix: string
      refreshPrefix: string
      label: string
      createdAt: number
      kind: 'connector'
      accessExpiresAt: number
      accessExpiresIn: number
      refreshExpiresAt: number
      tokens: {
        id: string
        prefix: string
        label: string
        createdAt: number
        kind?: string
        lastUsedAt?: number
        lastUsedIp?: string
      }[]
      clientConfigs: { cursorMcpJson: string; genericUrl: string }
      url: string | null
    }>('/api/mcp-server/tokens', {
      method: 'POST',
      body: JSON.stringify({ label: label || undefined }),
    }),
  rotateMcpToken: (id: string) =>
    request<{
      ok: boolean
      id: string
      token: string
      accessToken: string
      refreshToken: string
      prefix: string
      refreshPrefix: string
      label: string
      accessExpiresAt: number
      accessExpiresIn: number
    }>(`/api/mcp-server/tokens/${encodeURIComponent(id)}/rotate`, { method: 'POST', body: '{}' }),
  revokeMcpToken: (id: string) =>
    request<{
      ok: boolean
      tokens: { id: string; prefix: string; label: string; createdAt: number }[]
    }>(`/api/mcp-server/tokens/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  revokeAllMcpTokens: () =>
    request<{ ok: boolean; revoked: number; tokens: unknown[] }>(
      '/api/mcp-server/tokens/revoke-all',
      { method: 'POST', body: '{}' },
    ),
  securityEvents: (opts?: {
    source?: string
    event?: string
    ip?: string
    result?: string
    class?: string
    q?: string
    from?: string
    to?: string
    offset?: number
    limit?: number
  }) => {
    const q = new URLSearchParams()
    if (opts) {
      for (const [k, v] of Object.entries(opts)) {
        if (v != null && v !== '' && v !== 'all') q.set(k, String(v))
      }
    }
    const qs = q.toString()
    return request<{
      total: number
      offset: number
      limit: number
      days: string[]
      integrityOk: boolean
      integrityError?: string
      tamperedAt?: { day: string; line: number }
      events: {
        id: string
        ts: string
        event: string
        source: string
        ip: string
        result: string
        class: string
        classLabel: string
        userAgent?: string
        status?: number
        connectorLabel?: string
        wgPeerName?: string
        deviceId?: string
        deviceName?: string
        trusted?: boolean
        firstSeen?: boolean
        message?: string
        retryAfter?: number
        remainingAttempts?: number
        failCount?: number
        method?: string
        previousFailCount?: number
        previousLockedUntil?: number
        emailSent?: boolean
        emailGap?: string
      }[]
    }>(`/api/security/events${qs ? `?${qs}` : ''}`)
  },
  securityStatus: () =>
    request<{
      lockout: { failCount: number; locked: boolean; retryAfter: number; threshold: number; localSeatRecovery?: boolean }
      mcpLockout: { failCount: number; locked: boolean; retryAfter: number; threshold: number; ip: string }
      devices: {
        id: string
        name: string
        trusted: boolean
        ip: string
        userAgent?: string
        class: string
        wgPeerName?: string
        connectorLabel?: string
        firstSeenAt: number
        lastSeenAt: number
        seenCount: number
      }[]
      stats: { files: number; bytes: number; headCount: number }
    }>('/api/security/status'),
  updateSecurityDevice: (id: string, patch: { name?: string; trusted?: boolean }) =>
    request<{
      ok: boolean
      device: {
        id: string
        name: string
        trusted: boolean
        ip: string
        class: string
      }
    }>(`/api/security/devices/${encodeURIComponent(id)}`, {
      method: 'POST',
      body: JSON.stringify(patch),
    }),
  securityExportUrl: (opts?: Record<string, string>, format: 'csv' | 'json' = 'json') => {
    const q = new URLSearchParams({ format })
    if (opts) {
      for (const [k, v] of Object.entries(opts)) {
        if (v) q.set(k, v)
      }
    }
    return `/api/security/export?${q}`
  },
  restartHomebased: () =>
    request<{ ok: boolean; unit: string; active: boolean }>('/api/system/restart/homebased', {
      method: 'POST',
      body: '{}',
    }),
  restartWireguard: (iface?: string) =>
    request<{ ok: boolean; results: { ok: boolean; unit: string }[] }>(
      '/api/system/restart/wireguard',
      { method: 'POST', body: JSON.stringify({ iface: iface || null }) },
    ),
  wireguardStatus: () =>
    request<{
      installed: boolean
      configured: boolean
      active: boolean
      root: boolean
      managedByHomebase: boolean
      iface: string
      tools: { wg: boolean; wgQuick: boolean; iptables: boolean }
      state: {
        iface: string
        listenPort: number
        endpoint: string
        lanHost: string
        lanCidr: string
        dns: string
        vpnCidr: string
        serverAddress: string
      } | null
      clients: {
        id: string
        name: string
        address: string
        publicKey: string
        createdAt: number
        hasConfig: boolean
      }[]
      access: {
        lanHost: string | null
        vpnHost: string | null
        publicIp: string | null
        suggestedEndpoint: string | null
        outboundIface: string | null
        lanCidr: string | null
        dns: string
      }
      portForward: {
        proto: string
        wanPort: number
        lanIp: string | null
        lanPort: number
      }
      appStore: { ios: string; android: string }
      defaults: {
        iface: string
        listenPort: number
        vpnCidr: string
        serverAddress: string
      }
      interfaces: {
        id: string
        configured: boolean
        active: boolean
        enabled: boolean
        peersLive: {
          publicKey: string
          endpoint: string | null
          latestHandshake: string | null
          transfer: string | null
        }[]
      }[]
    }>('/api/wireguard/status'),
  wireguardInstall: () =>
    request<{ ok: boolean; tools: { wg: boolean; wgQuick: boolean } }>(
      '/api/wireguard/install',
      { method: 'POST', body: '{}' },
    ),
  wireguardSetup: (body: {
    endpoint?: string
    listenPort?: number
    clientName?: string
    force?: boolean
  }) =>
    request<{
      ok: boolean
      active: boolean
      message?: string
      client?: { id: string; name: string; address: string; config: string }
      portForward?: {
        proto: string
        wanPort: number
        lanIp: string
        lanPort: number
      }
    }>('/api/wireguard/setup', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  wireguardAdopt: (body: { iface?: string; endpoint?: string } = {}) =>
    request<{ ok: boolean }>('/api/wireguard/adopt', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  wireguardStart: (iface?: string) =>
    request<{ ok: boolean; active: boolean }>('/api/wireguard/start', {
      method: 'POST',
      body: JSON.stringify({ iface }),
    }),
  wireguardStop: (iface?: string) =>
    request<{ ok: boolean; active: boolean }>('/api/wireguard/stop', {
      method: 'POST',
      body: JSON.stringify({ iface }),
    }),
  wireguardRestartIface: (iface?: string) =>
    request<{ ok: boolean; active: boolean }>('/api/wireguard/restart', {
      method: 'POST',
      body: JSON.stringify({ iface }),
    }),
  wireguardAddClient: (body: { name?: string; rotateId?: string } = {}) =>
    request<{
      ok: boolean
      client: { id: string; name: string; address: string; config: string }
    }>('/api/wireguard/clients', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  wireguardClientConfig: (id: string) =>
    request<{
      ok: boolean
      client: { id: string; name: string; address: string; config: string }
    }>(`/api/wireguard/clients/${encodeURIComponent(id)}/config`),
  wireguardRemoveClient: (id: string) =>
    request<{ ok: boolean }>(`/api/wireguard/clients/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
  wireguardEndpoint: (endpoint: string) =>
    request<{ ok: boolean }>('/api/wireguard/endpoint', {
      method: 'POST',
      body: JSON.stringify({ endpoint }),
    }),
  wireguardUninstall: (opts: { removePackages?: boolean } = {}) =>
    request<{ ok: boolean }>('/api/wireguard/uninstall', {
      method: 'POST',
      body: JSON.stringify({ confirm: true, ...opts }),
    }),
  authStatus: () =>
    request<{
      passwordSet: boolean
      initialized: boolean
      canBootstrap: boolean
      jwtTtlSec: number
      lockout: { locked: boolean; retryAfter: number; failCount: number; threshold?: number; localSeatRecovery?: boolean }
      legal?: {
        version: string
        accepted: boolean
        acceptedVersion: string | null
        acceptedAt: number | null
      }
    }>('/api/auth/status'),
  legalStatus: () =>
    fetch('/api/legal')
      .then(async (res) => {
        const body = await res.json().catch(() => ({}))
        if (!res.ok) {
          const err = new Error(
            typeof body.detail === 'string' ? body.detail : 'Legal status failed',
          ) as Error & { status?: number }
          err.status = res.status
          throw err
        }
        return body as {
          version: string
          accepted: boolean
          acceptedVersion: string | null
          acceptedAt: number | null
        }
      }),
  acceptLegal: (version: string) =>
    fetch('/api/legal/accept', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version }),
    }).then(async (res) => {
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        const err = new Error(
          typeof body.detail === 'string'
            ? body.detail
            : JSON.stringify(body.detail || body),
        ) as Error & { status?: number; detail?: unknown }
        err.status = res.status
        err.detail = body.detail || body
        throw err
      }
      return body as {
        version: string
        accepted: boolean
        acceptedVersion: string | null
        acceptedAt: number | null
      }
    }),
  login: async (password: string) => {
    const res = await fetch('/api/login', {
      method: 'POST',
      credentials: 'include',
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
  /** First-time setup only (login page). Fails once initialized. */
  bootstrapPassword: async (password: string) => {
    const res = await fetch('/api/auth/bootstrap', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) {
      const err = new Error(
        typeof body.detail === 'string'
          ? body.detail
          : JSON.stringify(body.detail || body),
      ) as Error & { status?: number; detail?: unknown }
      err.status = res.status
      err.detail = body.detail || body
      throw err
    }
    return body as SessionResponse
  },
  /** Localhost Share tab — requires current password + session. */
  changePassword: (password: string, currentPassword: string) =>
    request<SessionResponse>('/api/auth/password', {
      method: 'POST',
      body: JSON.stringify({ password, currentPassword }),
    }),
  authSession: () =>
    fetch('/api/auth/session', { credentials: 'include' }).then(async (res) => {
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        return { authenticated: false as const }
      }
      return body as {
        authenticated: boolean
        expiresAt?: number
        expiresIn?: number
        csrfToken?: string
      }
    }),
  logout: () =>
    request<{ ok: boolean }>('/api/logout', { method: 'POST' }),
  wsTicket: () =>
    request<{ ticket: string; expiresAt: number; expiresIn: number }>('/api/ws-ticket', {
      method: 'POST',
    }),
  shareRedeem: async (shareId: string) => {
    const res = await fetch('/api/share/redeem', {
      method: 'POST',
      credentials: 'include',
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
  projects: () => request<{ projects: Project[] }>('/api/projects'),
  presets: () =>
    request<{ presets: { id: string; name: string }[] }>('/api/presets'),
  hostStat: (path: string) =>
    request<{ path: string; exists: boolean; isDirectory?: boolean; error?: string }>(
      `/api/fs/host-stat?path=${encodeURIComponent(path)}`,
    ),
    upsertProject: (body: {
    path: string
    preset?: string
    id?: string
    name?: string
    ports?: unknown[]
    actions?: unknown[]
  }) =>
    request<{ ok: boolean; project: Project }>('/api/projects', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  createWorkspace: (body: {
    parentPath: string
    folderName: string
    displayName?: string
  }) =>
    request<{ ok: boolean; project: Project }>('/api/workspaces/create', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  githubStatus: () =>
    request<{
      ok: boolean
      data?: {
        loggedIn: boolean
        user: string | null
        host: string
        hint: string | null
        detail?: string
        useOperatorLoginEnv?: boolean
        seatUser?: string
        seatHome?: string
        gitPath?: string | null
        gitVersion?: string | null
        ghPath?: string | null
        ghVersion?: string | null
        wrappedForSeat?: boolean
        envHint?: string | null
      }
      error?: string
    }>('/api/github/status'),
  gitGithubStatus: () =>
    request<{
      ok: boolean
      settings: { useOperatorLoginEnv: boolean; updatedAt?: number }
      env: {
        useOperatorLoginEnv: boolean
        seat: { name: string; uid: number; home: string; shell: string }
        service: { user: string | null; home: string | null; uid: number | null }
        env: {
          HOME: string | null
          PATH: string | null
          USER: string | null
          wrappedForSeat: boolean
        }
        git: { found: boolean; path: string | null; version: string | null }
        gh: { found: boolean; path: string | null; version: string | null }
        install: {
          id: string
          packages: string[]
          argv: string[]
          hint: string
        } | null
        hint: string | null
      }
      auth: {
        loggedIn: boolean
        user: string | null
        host: string
        hint: string | null
        detail?: string
      } | null
    }>('/api/git-github'),
  setGitGithubSettings: (body: { useOperatorLoginEnv: boolean }) =>
    request<{
      ok: boolean
      settings: { useOperatorLoginEnv: boolean }
    }>('/api/git-github/settings', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  gitGithubSetupGit: () =>
    request<{ ok: boolean; error?: string }>('/api/git-github/setup-git', {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  gitGithubTest: (body: { projectId?: string } = {}) =>
    request<{
      ok: boolean
      gh: { ok: boolean; loggedIn: boolean; user: string | null; detail: string }
      lsRemote: {
        ok: boolean
        projectId: string | null
        origin: string | null
        detail: string
      }
      hint: string | null
    }>('/api/git-github/test', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  gitGithubSignIn: (body: { projectId?: string } = {}) =>
    request<{
      ok: boolean
      sessionId?: string
      projectId?: string
      hint?: string
      error?: string
    }>('/api/git-github/signin', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  gitGithubInstall: (body: { confirm: boolean; projectId?: string }) =>
    request<{
      ok: boolean
      sessionId?: string
      projectId?: string
      hint?: string
      error?: string
      install?: { hint: string; argv: string[]; packages: string[] }
    }>('/api/git-github/install', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  githubRepos: (opts: { search?: string; limit?: number } = {}) => {
    const q = new URLSearchParams()
    if (opts.search) q.set('search', opts.search)
    if (opts.limit != null) q.set('limit', String(opts.limit))
    const qs = q.toString()
    return request<{
      ok: boolean
      repos: {
        name: string
        nameWithOwner: string
        url: string
        isPrivate: boolean
        defaultBranch: string
        description: string
      }[]
      user?: string
      count?: number
    }>(`/api/github/repos${qs ? `?${qs}` : ''}`)
  },
  cloneGithubWorkspace: (body: {
    repo: string
    workspaceName?: string
    branch?: string
  }) =>
    request<{
      ok: boolean
      project: Project
      path?: string
      origin?: string | null
      branch?: string
      openGitPanel?: boolean
    }>('/api/workspaces/clone-github', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  githubConnect: (
    id: string,
    body: { repo: string; setUpstream?: boolean },
  ) =>
    request<{ ok: boolean; origin?: string | null; repo?: string }>(
      `/api/projects/${encodeURIComponent(id)}/github/connect`,
      {
        method: 'POST',
        body: JSON.stringify(body),
      },
    ),
  githubCreateRepo: (
    id: string,
    body: {
      name?: string
      visibility?: 'private' | 'public'
      confirm: boolean
    },
  ) =>
    request<{
      ok: boolean
      origin?: string | null
      name?: string
      visibility?: string
      pushed?: boolean
    }>(`/api/projects/${encodeURIComponent(id)}/github/create-repo`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  deleteProject: (id: string) =>
    request<{
      ok: boolean
      id: string
      killedSessions?: string[]
      chatsDeleted?: number
      agentsUnmapped?: number
    }>(`/api/projects/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
  cursorCredentials: () =>
    request<{ configured: boolean; hint: string | null }>('/api/cursor/credentials'),
  setCursorCredentials: (apiKey: string) =>
    request<{ configured: boolean; hint: string | null }>('/api/cursor/credentials', {
      method: 'POST',
      body: JSON.stringify({ apiKey }),
    }),
  clearCursorCredentials: () =>
    request<{ configured: boolean; hint: string | null }>('/api/cursor/credentials', {
      method: 'DELETE',
    }),
  usage: (opts?: { refresh?: boolean }) =>
    request<{
      generatedAt: number
      projects: number
      homebase: {
        chats: number
        projectsWithChats: number
        userMessages: number
        assistantMessages: number
        thinkingMessages: number
        thinkingMs: number
        toolCalls: number
        toolErrors: number
        fileEdits: number
        imagesAttached: number
        models: { id: string; chats: number }[]
        modes: { id: string; chats: number }[]
        byDay: {
          day: string
          userMessages: number
          assistantMessages: number
          thinkingMs: number
          toolCalls: number
          inputTokens: number
          outputTokens: number
        }[]
        tokens: {
          input: number
          output: number
          cacheRead: number
          cacheWrite: number
          total: number
          events: number
          ledgerOnly: boolean
        }
        oldestAt: number | null
        newestAt: number | null
      }
      cursor: {
        ok: boolean
        configured: boolean
        keyHint: string | null
        me: {
          apiKeyName?: string
          createdAt?: string
          userId?: number
          userEmail?: string
          userFirstName?: string
          userLastName?: string
        } | null
        meError?: string
        billing: {
          available: boolean
          error?: string
          spendCents?: number
          overallSpendCents?: number
          members?: Array<{
            email?: string
            name?: string
            spendCents?: number
            overallSpendCents?: number
          }>
          events?: {
            count: number
            chargedCents: number
            inputTokens: number
            outputTokens: number
            cacheReadTokens: number
            cacheWriteTokens: number
            byModel: { model: string; count: number; chargedCents: number }[]
            tokenBasedCount?: number
            requestBasedCount?: number
            byKind?: { kind: string; count: number }[]
          }
          range?: { startMs: number; endMs: number }
          subscriptionCycleStartMs?: number
          totalMembers?: number
        } | null
        dashboardUrl: string
        note: string
      }
      ai: {
        plan: {
          family: 'x_subscription' | 'legacy_cursor' | 'request_based' | 'unknown'
          familyLabel: string
          tier: string | null
          tierLabel: string | null
          source: 'auto' | 'manual'
          confidence: 'high' | 'medium' | 'low'
          billingModel: 'usage_based' | 'request_based' | 'mixed' | 'unknown'
          cycleStartMs?: number
          dashboardUrl: string
          manageUrl: string
          note: string
          signals: string[]
        }
        pools: {
          cursorModels: Array<{
            id: string
            pool: string
            chats: number
            events: number
            chargedCents: number
          }>
          otherModels: Array<{
            id: string
            pool: string
            chats: number
            events: number
            chargedCents: number
          }>
          unknown: Array<{
            id: string
            pool: string
            chats: number
            events: number
            chargedCents: number
          }>
        }
        sources: {
          homebaseChat: { chats: number; models: number; tokensCaptured: number }
          mcp: {
            tokenCount: number
            tokens: Array<{ id: string; label: string; prefix: string; createdAt: number }>
            toolCalls7d: number
            actors7d: Array<{ label: string; calls: number }>
          }
        }
        availableTiers: Array<{ family: string; tier: string; label: string }>
      }
    }>(`/api/usage${opts?.refresh ? '?refresh=1' : ''}`),
  setUsagePlan: (body: { family: string; tier?: string | null }) =>
    request<Record<string, unknown>>('/api/usage/plan', {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  onboarding: () =>
    request<{
      complete: boolean
      skippedRemote?: boolean
      remoteMode?: 'wireguard' | 'cloudflare' | null
    }>('/api/onboarding'),
  saveOnboarding: (body: {
    complete?: boolean
    skippedRemote?: boolean
    remoteMode?: 'wireguard' | 'cloudflare' | null
    replay?: boolean
  }) =>
    request<{
      complete: boolean
      skippedRemote?: boolean
      remoteMode?: 'wireguard' | 'cloudflare' | null
    }>('/api/onboarding', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  systemReset: (mode: 'soft' | 'hard', confirm?: string) =>
    request<{ ok: boolean; removed: number }>('/api/system/reset', {
      method: 'POST',
      body: JSON.stringify({ mode, confirm }),
    }),
  cloudflareStatus: () =>
    request<{
      installed: boolean
      binary: string | null
      loggedIn: boolean
      /** Client-safe first/last-4 placeholder; never the full token. */
      tokenHint: string | null
      tunnelName: string | null
      hostname: string | null
      running: boolean
      publicUrl: string | null
      mode: string | null
      linux: boolean
      localPort: number
      guidance: {
        installMac: string
        installLinux: string
        dashboard: string
        docs: string
      }
    }>('/api/cloudflare/status'),
  cloudflareInstall: () =>
    request<Record<string, unknown>>('/api/cloudflare/install', {
      method: 'POST',
      body: '{}',
    }),
  cloudflareConfigure: (body: {
    token: string
    hostname?: string
    tunnelName?: string
  }) =>
    request<Record<string, unknown>>('/api/cloudflare/configure', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  cloudflareHostname: (hostname: string) =>
    request<Record<string, unknown>>('/api/cloudflare/hostname', {
      method: 'POST',
      body: JSON.stringify({ hostname }),
    }),
  cloudflareStart: () =>
    request<Record<string, unknown>>('/api/cloudflare/start', {
      method: 'POST',
      body: '{}',
    }),
  cloudflareStop: () =>
    request<Record<string, unknown>>('/api/cloudflare/stop', {
      method: 'POST',
      body: '{}',
    }),
  cloudflareClear: () =>
    request<Record<string, unknown>>('/api/cloudflare/clear', {
      method: 'POST',
      body: '{}',
    }),
  action: (id: string, actionId: string, extraArgs: string[] = []) =>
    request<{ type?: string; session?: Session; sessions?: Session[] }>(
      `/api/projects/${id}/action`,
      {
        method: 'POST',
        body: JSON.stringify({ actionId, extraArgs }),
      },
    ),
  stop: (id: string) =>
    request<{ killedSessions: string[] }>(`/api/projects/${id}/stop`, { method: 'POST' }),
  sessions: (project?: string) =>
    request<{ sessions: Session[] }>(
      project ? `/api/sessions?project=${project}` : '/api/sessions',
    ),
  killSession: (sessionId: string) =>
    request<{ ok: boolean }>(`/api/sessions/${sessionId}`, { method: 'DELETE' }),
  /** Ctrl+C twice — interrupt foreground process; session stays alive. */
  interruptSession: (sessionId: string) =>
    request<{ ok: boolean }>(`/api/sessions/${sessionId}/interrupt`, { method: 'POST' }),
  cursorModels: () =>
    request<{
      configured: boolean
      default: string
      models: { id: string; displayName: string; description: string }[]
      error?: string
    }>('/api/cursor/models'),
  cursorWorkspace: (projectId: string) =>
    request<{
      configured: boolean
      workspace: {
        tabs: {
          id: string
          title: string
          cwd: string
          messages: { role: string }[]
          updatedAt?: number
          running?: boolean
        }[]
        activeId: string | null
      }
    }>(`/api/cursor/${encodeURIComponent(projectId)}`),
  /** Lean chat list — no full histories / images. */
  cursorChats: (projectId: string) =>
    request<{
      configured: boolean
      activeId: string | null
      chats: {
        id: string
        title: string
        cwd: string
        updatedAt: number
        running: boolean
        messageCount: number
        recent: {
          role: string
          streaming?: boolean
          text?: string
          tool?: {
            name?: string
            status?: string
            detail?: string
            path?: string
            command?: string
          }
          file?: { path?: string; action?: string }
          task?: { status?: string; name?: string }
        }[]
      }[]
    }>(`/api/cursor/${encodeURIComponent(projectId)}/chats`),
  cursorCreateChat: (projectId: string, body: { title?: string; cwd?: string } = {}) =>
    request<{
      ok: boolean
      chat: { id: string; title: string; cwd: string }
    }>(`/api/cursor/${encodeURIComponent(projectId)}/chats`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  cursorDeleteChat: (projectId: string, chatId: string) =>
    request<{ ok: boolean; deleted: boolean; activeId: string | null }>(
      `/api/cursor/${encodeURIComponent(projectId)}/chats/${encodeURIComponent(chatId)}`,
      { method: 'DELETE' },
    ),
  fsList: (id: string, path = '', opts: { all?: boolean } = {}) => {
    const q = new URLSearchParams()
    // Allow "" (project-relative) and "/" (Linux root)
    if (path !== '') q.set('path', path)
    if (opts.all) q.set('all', '1')
    const qs = q.toString()
    return request<{ path: string; entries: FsEntry[]; includeIgnored?: boolean }>(
      `/api/projects/${id}/fs${qs ? `?${qs}` : ''}`,
    )
  },
  fsRead: (id: string, path: string) =>
    request<{ path: string; content: string; language: string; size: number }>(
      `/api/projects/${id}/fs/read?path=${encodeURIComponent(path)}`,
    ),
  fsWrite: (id: string, path: string, content: string) =>
    request<{ ok: boolean }>(`/api/projects/${id}/fs/write`, {
      method: 'PUT',
      body: JSON.stringify({ path, content }),
    }),
  gitStatus: (id: string) =>
    request<{
      ok: boolean
      branch: string
      ahead: number
      behind: number
      dirty: boolean
      files: { path: string; index: string; worktree: string; status: string }[]
      commits: {
        hash: string
        short: string
        subject: string
        author: string
        date: string
      }[]
      remotes: string[]
      originUrl: string | null
    }>(`/api/projects/${encodeURIComponent(id)}/git`),
  gitBranches: (id: string) =>
    request<{
      ok: boolean
      local: string[]
      remote: string[]
      current: string
    }>(`/api/projects/${encodeURIComponent(id)}/git/branches`),
  gitAction: (
    id: string,
    body: {
      action: string
      branch?: string
      name?: string
      base?: string
      checkout?: boolean
      noFf?: boolean
      abortOnConflict?: boolean
      message?: string
      stageAll?: boolean
      paths?: string[]
      mode?: 'push' | 'list' | 'pop'
      limit?: number
      staged?: boolean
      path?: string
    },
  ) =>
    request<Record<string, unknown>>(
      `/api/projects/${encodeURIComponent(id)}/git`,
      {
        method: 'POST',
        body: JSON.stringify(body),
      },
    ),
  appPinStatus: () =>
    request<{
      enabled: boolean
      locked: boolean
      idleMs: number
      lockout?: { locked: boolean; retryAfter: number; failCount: number; threshold?: number }
    }>('/api/app-pin/status'),
  appPinLock: () => request<{ ok: boolean; locked: boolean }>('/api/app-pin/lock', { method: 'POST' }),
  appPinUnlock: (pin: string) =>
    request<{ ok: boolean; locked: boolean }>('/api/app-pin/unlock', {
      method: 'POST',
      body: JSON.stringify({ pin }),
    }),
  appPinSet: (pin: string, currentPin?: string) =>
    request<{ ok: boolean; enabled: boolean }>('/api/app-pin/set', {
      method: 'POST',
      body: JSON.stringify({ pin, currentPin }),
    }),
  appPinClear: (currentPin: string) =>
    request<{ ok: boolean; enabled: boolean }>('/api/app-pin/clear', {
      method: 'POST',
      body: JSON.stringify({ currentPin }),
    }),
  appPinIdle: (idleMs: number) =>
    request<{ ok: boolean; idleMs: number }>('/api/app-pin/idle', {
      method: 'POST',
      body: JSON.stringify({ idleMs }),
    }),
  appPinImport: (salt: string, hash: string, idleMs?: number) =>
    request<{ ok: boolean; enabled: boolean; imported: boolean }>('/api/app-pin/import', {
      method: 'POST',
      body: JSON.stringify({ salt, hash, idleMs }),
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
  traceJournal: (limit = 200, unit = 'homebased') =>
    request<{
      items: TraceLine[]
      lastId: number
      max: number
      unit: string
      error?: string | null
    }>(`/api/trace/journal?limit=${limit}&unit=${encodeURIComponent(unit)}`),
  sudoStatus: () =>
    request<{
      cached: boolean
      sessionCached?: boolean
      persistent?: boolean
      expiresAt: number | null
      ttlSec: number
      askpassWaiting: boolean
      pending?: {
        id: string
        command?: string
        prompt?: string
        needsAllow?: boolean
      } | null
    }>('/api/sudo/status'),
  setSudo: (password: string, opts?: { ttlSec?: number; persistent?: boolean }) =>
    request<{
      cached: boolean
      sessionCached?: boolean
      persistent?: boolean
      ttlSec: number
      askpassWaiting: boolean
    }>('/api/sudo', {
      method: 'POST',
      body: JSON.stringify({
        password,
        ttlSec: opts?.ttlSec,
        persistent: opts?.persistent,
      }),
    }),
  allowSudo: (id?: string) =>
    request<{ ok: boolean; error?: string; ttlSec?: number; cached?: boolean }>(
      '/api/sudo/allow',
      { method: 'POST', body: JSON.stringify({ id }) },
    ),
  denySudo: (id?: string) =>
    request<{ ok: boolean }>('/api/sudo/deny', {
      method: 'POST',
      body: JSON.stringify({ id }),
    }),
  clearSudo: () => request<{ ok: boolean }>('/api/sudo', { method: 'DELETE' }),
  clearPersistentSudo: () =>
    request<{ ok: boolean }>('/api/sudo/persistent', { method: 'DELETE' }),
  visionStatus: () =>
    request<{
      ok: boolean
      armed: boolean
      remainingSec: number
      until: number | null
      linux: boolean
      platform: string
      display?: string
      screenW?: number
      screenH?: number
      error?: string | null
      guidance?: string
      /** Seat-user ~/.homebase — default Vision chat cwd */
      workspace?: string
    }>('/api/vision/status'),
  visionArmStatus: () =>
    request<{
      armed: boolean
      remainingSec: number
      until: number | null
      linux: boolean
      platform: string
    }>('/api/vision/arm'),
  visionArm: (ttlSec?: number) =>
    request<{
      ok: boolean
      armed: boolean
      remainingSec: number
      until: number | null
      error?: string
    }>('/api/vision/arm', {
      method: 'POST',
      body: JSON.stringify(ttlSec != null ? { ttlSec } : {}),
    }),
  visionDisarm: () =>
    request<{ ok: boolean; armed: boolean }>('/api/vision/disarm', {
      method: 'POST',
      body: '{}',
    }),
  homeAccess: () => request<{ widgets: AccessWidget[] }>('/api/home-access'),
  homeAccessUpsert: (widget: Partial<AccessWidget> & { kind: string; label: string }) =>
    request<{ widget: AccessWidget }>('/api/home-access/widgets', {
      method: 'POST',
      body: JSON.stringify(widget),
    }),
  homeAccessUpdate: (id: string, widget: Partial<AccessWidget>) =>
    request<{ widget: AccessWidget }>(`/api/home-access/widgets/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(widget),
    }),
  homeAccessDelete: (id: string) =>
    request<{ ok: boolean }>(`/api/home-access/widgets/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
  homeAccessInvoke: (id: string, value?: unknown) =>
    request<{ widget: AccessWidget }>(
      `/api/home-access/widgets/${encodeURIComponent(id)}/invoke`,
      {
        method: 'POST',
        body: JSON.stringify(value === undefined ? {} : { value }),
      },
    ),
}
