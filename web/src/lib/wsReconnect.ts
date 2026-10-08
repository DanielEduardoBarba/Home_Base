import { clearSession, getToken, type AuthLostReason } from './auth'

export type WsConnState = 'connecting' | 'live' | 'reconnecting' | 'offline' | 'auth'

export type WsReconnectHandle = {
  /** Stop reconnecting and close the socket. */
  dispose: () => void
  /** Force an immediate reconnect attempt (resets backoff). */
  reconnect: () => void
  getSocket: () => WebSocket | null
  getState: () => WsConnState
}

const AUTH_CLOSE_CODES = new Set([4401, 4403])
const AUTH_REASON_PREFIXES = [
  'expired',
  'stale_session',
  'invalid_token',
  'missing_token',
  'unauthorized',
  'share_token',
  'invalid_kind',
]

function parseAuthReason(code: number, reason: string): AuthLostReason | null {
  if (AUTH_CLOSE_CODES.has(code) || AUTH_REASON_PREFIXES.some((p) => reason.startsWith(p))) {
    if (reason.startsWith('expired')) return 'expired'
    if (reason.startsWith('stale_session')) return 'stale_session'
    return 'unauthorized'
  }
  return null
}

export function connectWithReconnect(opts: {
  /** Build URL each attempt (picks up fresh JWT). */
  url: () => string
  onOpen?: (ws: WebSocket) => void
  onMessage?: (ev: MessageEvent, ws: WebSocket) => void
  onState?: (state: WsConnState) => void
  /** Max backoff between attempts (default 30s). */
  maxBackoffMs?: number
  /** Stop after this many failures while offline (0 = unlimited). Default 0. */
  maxAttempts?: number
}): WsReconnectHandle {
  const maxBackoff = opts.maxBackoffMs ?? 30_000
  const maxAttempts = opts.maxAttempts ?? 0
  let disposed = false
  let ws: WebSocket | null = null
  let state: WsConnState = 'connecting'
  let attempt = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  /** Bumped on every intentional close / dispose so stale onclose cannot schedule. */
  let epoch = 0
  let visHandler: (() => void) | null = null

  const setState = (next: WsConnState) => {
    if (state === next) return
    state = next
    opts.onState?.(next)
  }

  const clearTimer = () => {
    if (timer) {
      clearTimeout(timer)
      timer = undefined
    }
    if (visHandler) {
      document.removeEventListener('visibilitychange', visHandler)
      visHandler = null
    }
  }

  const open = () => {
    if (disposed) return
    clearTimer()
    if (!getToken()) {
      setState('auth')
      return
    }
    // Never open a second socket while one is alive/connecting (prevents storms)
    if (
      ws &&
      (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)
    ) {
      return
    }

    const myEpoch = epoch
    setState(attempt === 0 ? 'connecting' : 'reconnecting')
    let socket: WebSocket
    try {
      socket = new WebSocket(opts.url())
    } catch {
      schedule()
      return
    }
    ws = socket

    socket.onopen = () => {
      if (disposed || myEpoch !== epoch || ws !== socket) return
      attempt = 0
      setState('live')
      opts.onOpen?.(socket)
    }

    socket.onmessage = (ev) => {
      if (disposed || myEpoch !== epoch || ws !== socket) return
      opts.onMessage?.(ev, socket)
    }

    socket.onerror = () => {
      /* onclose follows */
    }

    socket.onclose = (ev) => {
      if (myEpoch !== epoch) return
      if (ws === socket) ws = null
      if (disposed) return
      const authReason = parseAuthReason(ev.code, ev.reason || '')
      if (authReason) {
        setState('auth')
        clearSession(authReason)
        return
      }
      // Normal close from our dispose/reconnect bumps epoch before close — ignore.
      if (ev.code === 1000 && (ev.reason === 'dispose' || ev.reason === 'manual-reconnect' || ev.reason === 'auth-lost')) {
        return
      }
      schedule()
    }
  }

  const schedule = () => {
    if (disposed) return
    attempt += 1
    if (maxAttempts > 0 && attempt > maxAttempts) {
      setState('offline')
      return
    }
    setState('reconnecting')
    const delay = Math.min(maxBackoff, 800 * 2 ** Math.min(attempt - 1, 4))
    clearTimer()
    timer = setTimeout(() => {
      if (disposed) return
      if (document.visibilityState === 'hidden') {
        visHandler = () => {
          if (document.visibilityState === 'visible') {
            if (visHandler) {
              document.removeEventListener('visibilitychange', visHandler)
              visHandler = null
            }
            open()
          }
        }
        document.addEventListener('visibilitychange', visHandler)
        return
      }
      open()
    }, delay)
  }

  const onAuthLost = () => {
    disposed = true
    epoch += 1
    clearTimer()
    try {
      ws?.close(1000, 'auth-lost')
    } catch {
      /* ignore */
    }
    ws = null
    setState('auth')
  }

  window.addEventListener('hb-auth-lost', onAuthLost)
  open()

  return {
    dispose: () => {
      disposed = true
      epoch += 1
      clearTimer()
      window.removeEventListener('hb-auth-lost', onAuthLost)
      try {
        ws?.close(1000, 'dispose')
      } catch {
        /* ignore */
      }
      ws = null
      setState('offline')
    },
    reconnect: () => {
      if (disposed) return
      if (state === 'auth' && !getToken()) return
      epoch += 1
      clearTimer()
      try {
        ws?.close(1000, 'manual-reconnect')
      } catch {
        /* ignore */
      }
      ws = null
      attempt = 0
      open()
    },
    getSocket: () => ws,
    getState: () => state,
  }
}

export function connStateLabel(state: WsConnState): string {
  switch (state) {
    case 'live':
      return 'Live'
    case 'connecting':
      return 'Connecting'
    case 'reconnecting':
      return 'Reconnecting'
    case 'auth':
      return 'Sign in'
    case 'offline':
    default:
      return 'Offline'
  }
}
