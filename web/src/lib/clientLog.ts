/** Forward browser console lines to the server trace ring. */

import { getToken } from './auth'

type ClientLogLine = {
  level: string
  message: string
}

let installed = false
const pendingPush: ClientLogLine[] = []
let flushTimer: ReturnType<typeof setTimeout> | null = null
const MAX_PENDING = 50

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
    const token = getToken()
    if (!token) {
      pendingPush.unshift(...batch)
      if (pendingPush.length > MAX_PENDING) pendingPush.splice(0, pendingPush.length - MAX_PENDING)
      return
    }
    await fetch('/api/trace/client', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
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
  push('info', ['client log ready'])
}
