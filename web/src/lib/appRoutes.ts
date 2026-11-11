import type { AppArea, Tab } from './types'
import type { WorkItem } from './uiPrefs'

export type AppLocation = {
  area: AppArea
  tab: Tab
  workItem: WorkItem
}

export type ParseResult =
  | { kind: 'ok'; loc: AppLocation }
  | { kind: 'notfound'; path: string }

const WORK_ITEMS: WorkItem[] = ['apps', 'shell', 'files', 'chat']

function normalizePath(pathname: string): string {
  const raw = (pathname.split('?')[0] || '/').replace(/\/+$/, '')
  return raw || '/'
}

/**
 * History paths for the main areas and Work tabs.
 * `/` and `/home` are Home. Work lives under `/work/...` (and `/homework` as an alias).
 */
export function parseAppPath(pathname: string): ParseResult {
  const path = normalizePath(pathname)
  const parts = path === '/' ? [] : path.split('/').filter(Boolean)
  const unknown = (): ParseResult => ({ kind: 'notfound', path })

  if (parts.length === 0 || (parts.length === 1 && parts[0] === 'home')) {
    return { kind: 'ok', loc: { area: 'home', tab: 'work', workItem: 'apps' } }
  }

  const head = parts[0] || ''
  if (parts.length === 1 && (head === 'access' || head === 'agent' || head === 'vision' || head === 'settings')) {
    return { kind: 'ok', loc: { area: head, tab: 'work', workItem: 'apps' } }
  }
  if (parts.length === 1 && head === 'view') {
    return { kind: 'ok', loc: { area: 'homework', tab: 'view', workItem: 'apps' } }
  }
  if (parts.length === 1 && head === 'logs') {
    return { kind: 'ok', loc: { area: 'homework', tab: 'logs', workItem: 'apps' } }
  }

  if (head === 'work' || head === 'homework') {
    if (parts.length === 1) {
      return { kind: 'ok', loc: { area: 'homework', tab: 'work', workItem: 'apps' } }
    }
    if (parts.length !== 2) return unknown()
    const sub = parts[1] === 'cursor' ? 'chat' : parts[1]
    if (sub === 'view' || sub === 'logs') {
      return { kind: 'ok', loc: { area: 'homework', tab: sub, workItem: 'apps' } }
    }
    if (WORK_ITEMS.includes(sub as WorkItem)) {
      return { kind: 'ok', loc: { area: 'homework', tab: 'work', workItem: sub as WorkItem } }
    }
    return unknown()
  }

  return unknown()
}

export function serializeAppPath(loc: AppLocation): string {
  if (loc.area === 'home') return '/'
  if (loc.area === 'access') return '/access'
  if (loc.area === 'agent') return '/agent'
  if (loc.area === 'vision') return '/vision'
  if (loc.area === 'settings') return '/settings'
  if (loc.tab === 'view') return '/view'
  if (loc.tab === 'logs') return '/logs'
  const item = WORK_ITEMS.includes(loc.workItem) ? loc.workItem : 'apps'
  return `/work/${item}`
}
