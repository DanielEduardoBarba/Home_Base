import { clearSession, getToken, type AuthLostReason } from './auth'
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
      const reasons: Record<string, AuthLostReason> = {
        expired: 'expired',
        invalid_token: 'unauthorized',
        missing_token: 'unauthorized',
        stale_session: 'stale_session',
        invalid_kind: 'unauthorized',
        share_token: 'unauthorized',
      }
      const reason = reasons[code]
      if (reason) clearSession(reason)
    }
    // Server-side App PIN gate — tell PinLock to cover the UI
    if (res.status === 423) {
      try {
        window.dispatchEvent(new Event('hb-pin-lock'))
      } catch {
        /* ignore */
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
  /** First-time setup only (login page). Fails once initialized. */
  bootstrapPassword: async (password: string) => {
    const res = await fetch('/api/auth/bootstrap', {
      method: 'POST',
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
  projects: () => request<{ projects: Project[] }>('/api/projects'),
  presets: () =>
    request<{ presets: { id: string; name: string }[] }>('/api/presets'),
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
  deleteProject: (id: string) =>
    request<{ ok: boolean; id: string }>(`/api/projects/${encodeURIComponent(id)}`, {
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
  appPinStatus: () =>
    request<{ enabled: boolean; locked: boolean; idleMs: number }>('/api/app-pin/status'),
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
