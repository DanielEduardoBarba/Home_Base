/** Fixed-size browser console ring — never grows past MAX. */

import { getToken } from './auth'

export const MAX_CLIENT_LOGS = 300

export type ClientLogLine = {
  id: number
  ts: number
  level: string
  source: 'web'
  message: string
}

type Listener = () => void

let seq = 0
const buf: ClientLogLine[] = []
const listeners = new Set<Listener>()
let installed = false
const pendingPush: ClientLogLine[] = []
let flushTimer: ReturnType<typeof setTimeout> | null = null
const MAX_PENDING = 50

function notify() {
  for (const fn of listeners) fn()
}

function push(level: string, args: unknown[]) {
  seq += 1
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

  const line: ClientLogLine = {
    id: seq,
    ts: Date.now() / 1000,
    level,
    source: 'web',
    message,
  }
  buf.push(line)
  if (buf.length > MAX_CLIENT_LOGS) buf.splice(0, buf.length - MAX_CLIENT_LOGS)
  pendingPush.push(line)
  if (pendingPush.length > MAX_PENDING) pendingPush.splice(0, pendingPush.length - MAX_PENDING)
  notify()
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
    /* drop on failure — ring still holds locally */
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

export function getClientLogs(): ClientLogLine[] {
  return buf.slice()
}

export function subscribeClientLogs(fn: Listener): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function clearClientLogs() {
  buf.length = 0
  notify()
}
