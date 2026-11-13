/** Forward browser console lines to the server trace ring. */

import { getCsrfToken, hasSession } from './auth'

type ClientLogLine = {
  level: string
  message: string
}

let installed = false
const pendingPush: ClientLogLine[] = []
let flushTimer: ReturnType<typeof setTimeout> | null = null
const MAX_PENDING = 50
const READY_FLAG = 'hb-client-log-ready'
const READY_MESSAGE = 'client log ready'

/** Drop consecutive duplicates; also drop a repeated "client log ready". */
export function shouldRecordClientLog(
  pending: ClientLogLine[],
  line: ClientLogLine,
  alreadyReady: boolean,
): boolean {
  if (line.message === READY_MESSAGE && alreadyReady) return false
  const last = pending[pending.length - 1]
  if (last && last.level === line.level && last.message === line.message) return false
  return true
}

function push(level: string, args: unknown[]) {
  const message = args
    .map((a) => {
      if (typeof a === 'string') return a
      try {
        return JSON.stringify(a)
      } catch {
        return String(a)
      }
    })
    .join(' ')
    .slice(0, 2000)

  let alreadyReady = false
  try {
    alreadyReady = sessionStorage.getItem(READY_FLAG) === '1'
  } catch {
    /* ignore */
  }
  if (!shouldRecordClientLog(pendingPush, { level, message }, alreadyReady)) return
  if (message === READY_MESSAGE) {
    try {
      sessionStorage.setItem(READY_FLAG, '1')
    } catch {
      /* ignore */
    }
  }

  pendingPush.push({ level, message })
  if (pendingPush.length > MAX_PENDING) pendingPush.splice(0, pendingPush.length - MAX_PENDING)
  scheduleFlush()
}

function scheduleFlush() {
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    void flushToServer()
  }, 1500)
}

async function flushToServer() {
  if (!pendingPush.length) return
  const batch = pendingPush.splice(0, 50)
  try {
    if (!hasSession()) {
      pendingPush.unshift(...batch)
      if (pendingPush.length > MAX_PENDING) pendingPush.splice(0, pendingPush.length - MAX_PENDING)
      return
    }
    const csrf = getCsrfToken()
    await fetch('/api/trace/client', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
      },
      body: JSON.stringify({
        lines: batch.map((l) => ({ level: l.level, message: l.message })),
      }),
    })
  } catch {
    /* drop on failure — server ring is the source of truth */
  }
}

export function installClientLog() {
  if (installed || typeof console === 'undefined') return
  installed = true
  const levels = ['log', 'info', 'warn', 'error', 'debug'] as const
  for (const level of levels) {
    const orig = console[level].bind(console)
    console[level] = (...args: unknown[]) => {
      push(level === 'log' ? 'info' : level, args)
      orig(...args)
    }
  }
  push('info', [READY_MESSAGE])
}
