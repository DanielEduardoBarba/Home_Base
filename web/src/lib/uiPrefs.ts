import type { Tab } from './types'

const TAB_KEY = 'hb-ui-tab'
const PROJECT_KEY = 'hb-ui-project'

const VALID_TABS: Tab[] = [
  'apps',
  'work',
  'shell',
  'files',
  'view',
  'cursor',
  'logs',
  'settings',
]

export function readLastTab(fallback: Tab = 'apps'): Tab {
  try {
    const v = localStorage.getItem(TAB_KEY)
    if (v && (VALID_TABS as string[]).includes(v)) return v as Tab
  } catch {
    /* ignore */
  }
  return fallback
}

export function writeLastTab(tab: Tab): void {
  try {
    localStorage.setItem(TAB_KEY, tab)
  } catch {
    /* ignore */
  }
}

export function readLastProjectId(): string {
  try {
    return localStorage.getItem(PROJECT_KEY) || ''
  } catch {
    return ''
  }
}

export function writeLastProjectId(id: string): void {
  try {
    if (id) localStorage.setItem(PROJECT_KEY, id)
  } catch {
    /* ignore */
  }
}
