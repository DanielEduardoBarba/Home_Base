import type { ChatTab } from './chatTypes'

const TABS_VERSION = 2

function tabsKey(projectId: string) {
  return `hb-cursor-tabs:v${TABS_VERSION}:${projectId}`
}

function activeKey(projectId: string) {
  return `hb-cursor-active:v${TABS_VERSION}:${projectId}`
}

/**
 * Chats used to live in this browser only. Read them once so the server can
 * adopt them. Returns null when there is nothing worth keeping.
 */
export function loadLocalChatsForImport(
  projectId: string,
): { tabs: ChatTab[]; activeId: string } | null {
  try {
    const raw = localStorage.getItem(tabsKey(projectId))
    if (!raw) return null
    const tabs = (JSON.parse(raw) as ChatTab[]).filter((t) => t && t.id)
    const hasBody = tabs.some((t) =>
      (t.messages || []).some(
        (m) =>
          m.role === 'user' ||
          m.role === 'assistant' ||
          m.role === 'thinking' ||
          m.role === 'tool',
      ),
    )
    if (!hasBody) return null
    const activeId = localStorage.getItem(activeKey(projectId)) || tabs[0]?.id || ''
    return { tabs, activeId }
  } catch {
    return null
  }
}

export function clearLocalChats(projectId: string) {
  try {
    localStorage.removeItem(tabsKey(projectId))
    localStorage.removeItem(activeKey(projectId))
  } catch {
    /* ignore */
  }
}
