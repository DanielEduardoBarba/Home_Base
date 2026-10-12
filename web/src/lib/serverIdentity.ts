'use client'

import { useCallback, useEffect, useState } from 'react'
import { api } from './api'

export type ServerIdentity = {
  displayName: string
  suggestedName: string
  ownerGuess: string
  customized: boolean
}

const DEFAULT: ServerIdentity = {
  displayName: 'Home Base',
  suggestedName: 'Home Base',
  ownerGuess: 'Home',
  customized: false,
}

let cache: ServerIdentity | null = null
const listeners = new Set<() => void>()

function notify() {
  for (const l of listeners) l()
}

export function getCachedDisplayName(): string {
  return cache?.displayName || 'Home Base'
}

export async function refreshServerIdentity(): Promise<ServerIdentity> {
  try {
    const s = await api.serverIdentity()
    cache = s
    try {
      document.title = s.displayName
    } catch {
      /* ignore */
    }
    notify()
    return s
  } catch {
    return cache || DEFAULT
  }
}

export function useServerIdentity(): ServerIdentity & { refresh: () => Promise<void> } {
  const [state, setState] = useState<ServerIdentity>(cache || DEFAULT)

  const refresh = useCallback(async () => {
    const s = await refreshServerIdentity()
    setState(s)
  }, [])

  useEffect(() => {
    const onChange = () => setState(cache || DEFAULT)
    listeners.add(onChange)
    if (!cache) void refresh()
    else setState(cache)
    return () => {
      listeners.delete(onChange)
    }
  }, [refresh])

  return { ...state, refresh }
}
