import { uid } from './id'
import type { ChatTab } from './chatTypes'

const TABS_VERSION = 2

export function tabsKey(projectId: string) {
  return `hb-cursor-tabs:v${TABS_VERSION}:${projectId}`
}

export function activeKey(projectId: string) {
  return `hb-cursor-active:v${TABS_VERSION}:${projectId}`
}

export function newChatTab(cwd = '', title?: string): ChatTab {
  const leaf = cwd.split('/').filter(Boolean).pop()
  return {
    id: uid(10),
    title: title || (leaf ? `./${leaf}` : 'New chat'),
    cwd,
    messages: [],
    agentId: null,
    updatedAt: Date.now(),
  }
}

export function loadChatTabs(projectId: string): { tabs: ChatTab[]; activeId: string } {
  try {
    const raw = localStorage.getItem(tabsKey(projectId))
    const tabs = (raw ? (JSON.parse(raw) as ChatTab[]) : []).map((t) => ({
      ...t,
      updatedAt: t.updatedAt || Date.now(),
      messages: t.messages || [],
    }))
    const activeId = localStorage.getItem(activeKey(projectId)) || tabs[0]?.id || ''
    if (tabs.length) {
      return {
        tabs,
        activeId: tabs.some((t) => t.id === activeId) ? activeId : tabs[0].id,
      }
    }
  } catch {
    /* ignore */
  }
  const t = newChatTab()
  return { tabs: [t], activeId: t.id }
}

export function persistChatTabs(projectId: string, tabs: ChatTab[], activeId: string) {
  try {
    const slim = tabs.map((t) => ({
      ...t,
      messages: t.messages.slice(-120).map((m) => ({
        ...m,
        text: m.text && m.text.length > 12000 ? m.text.slice(0, 12000) + '…' : m.text,
      })),
    }))
    localStorage.setItem(tabsKey(projectId), JSON.stringify(slim))
    localStorage.setItem(activeKey(projectId), activeId)
  } catch {
    /* ignore */
  }
}
