import type { AppArea, Tab } from './types'

const TAB_KEY = 'hb-ui-tab'
const AREA_KEY = 'hb-ui-area'
const PROJECT_KEY = 'hb-ui-project'

const VALID_TABS: Tab[] = [
  'apps',
  'work',
  'shell',
  'files',
  'view',
  'cursor',
  'logs',
]

const VALID_AREAS: AppArea[] = [
  'home',
  'homework',
  'access',
  'agent',
  'vision',
  'settings',
]

const AGENT_RECENT_KEY = 'hb-agent-recent-dirs'
const AGENT_RECENT_ABS_KEY = 'hb-agent-recent-abs'

/** Recent Home Agent working directories per project (relative cwd strings). */
export function readAgentRecentDirs(projectId: string): string[] {
  try {
    const raw = localStorage.getItem(`${AGENT_RECENT_KEY}:${projectId}`)
    if (!raw) return []
    const list = JSON.parse(raw) as string[]
    return Array.isArray(list) ? list.filter((x) => typeof x === 'string').slice(0, 12) : []
  } catch {
    return []
  }
}

export function pushAgentRecentDir(projectId: string, cwd: string): void {
  try {
    const next = [cwd, ...readAgentRecentDirs(projectId).filter((c) => c !== cwd)].slice(0, 12)
    localStorage.setItem(`${AGENT_RECENT_KEY}:${projectId}`, JSON.stringify(next))
  } catch {
    /* ignore */
  }
}

/** Global bare host directories for Home Agent (absolute paths, no app context). */
export type AgentRecentAbs = {
  path: string
  /** Project used as Cursor host when opening this folder. */
  projectId: string
}

export function readAgentRecentAbs(): AgentRecentAbs[] {
  try {
    const raw = localStorage.getItem(AGENT_RECENT_ABS_KEY)
    if (!raw) return []
    const list = JSON.parse(raw) as AgentRecentAbs[]
    if (!Array.isArray(list)) return []
    return list
      .filter(
        (x) =>
          x &&
          typeof x.path === 'string' &&
          x.path.startsWith('/') &&
          typeof x.projectId === 'string',
      )
      .slice(0, 16)
  } catch {
    return []
  }
}

export function pushAgentRecentAbs(entry: AgentRecentAbs): void {
  try {
    const next = [
      entry,
      ...readAgentRecentAbs().filter((e) => e.path !== entry.path),
    ].slice(0, 16)
    localStorage.setItem(AGENT_RECENT_ABS_KEY, JSON.stringify(next))
  } catch {
    /* ignore */
  }
}

export function readLastArea(fallback: AppArea = 'home'): AppArea {
  try {
    const v = localStorage.getItem(AREA_KEY)
    if (v && (VALID_AREAS as string[]).includes(v)) return v as AppArea
  } catch {
    /* ignore */
  }
  return fallback
}

export function writeLastArea(area: AppArea): void {
  try {
    localStorage.setItem(AREA_KEY, area)
  } catch {
    /* ignore */
  }
}

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

/** Work workspace pane. Chat is the full chat view inside Work. */
export type WorkItem = 'apps' | 'shell' | 'files' | 'chat'

export type WorkPlace = {
  item: WorkItem
  /** Last folder in Files. */
  dir?: string
  /** Last open file in Files. Empty clears it. */
  file?: string
}

const WORK_ITEMS: WorkItem[] = ['apps', 'shell', 'files', 'chat']
export const WORK_PLACE_PREFIX = 'hb-work-place:'
const MAX_PLACE_PATH = 4096
export const DEFAULT_WORK_PLACE: WorkPlace = { item: 'apps' }

function isAbsPlacePath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.startsWith('/') &&
    value.length <= MAX_PLACE_PATH &&
    !value.includes('\0') &&
    !value.includes('\n') &&
    !value.includes('\r')
  )
}

/** Schema-validate persisted Work pane state. Invalid values fall back to defaults. */
export function parseWorkPlace(raw: unknown): WorkPlace {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...DEFAULT_WORK_PLACE }
  const p = raw as Record<string, unknown>
  const item = WORK_ITEMS.includes(p.item as WorkItem) ? (p.item as WorkItem) : 'apps'
  return {
    item,
    dir: isAbsPlacePath(p.dir) ? p.dir : undefined,
    file: isAbsPlacePath(p.file) ? p.file : undefined,
  }
}

export function readWorkPlace(projectId: string): WorkPlace {
  if (!projectId) return { ...DEFAULT_WORK_PLACE }
  try {
    const raw = localStorage.getItem(`${WORK_PLACE_PREFIX}${projectId}`)
    if (!raw) return { ...DEFAULT_WORK_PLACE }
    return parseWorkPlace(JSON.parse(raw))
  } catch {
    return { ...DEFAULT_WORK_PLACE }
  }
}

export function clearWorkPlaces(): number {
  let removed = 0
  try {
    const keys: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k && k.startsWith(WORK_PLACE_PREFIX)) keys.push(k)
    }
    for (const k of keys) {
      localStorage.removeItem(k)
      removed++
    }
  } catch {
    /* ignore */
  }
  return removed
}

export function writeWorkPlace(projectId: string, patch: Partial<WorkPlace>): void {
  if (!projectId) return
  try {
    const prev = readWorkPlace(projectId)
    const next = parseWorkPlace({ ...prev, ...patch })
    if (!next.dir) delete next.dir
    if (!next.file) delete next.file
    localStorage.setItem(`${WORK_PLACE_PREFIX}${projectId}`, JSON.stringify(next))
  } catch {
    /* ignore */
  }
}

/**
 * Older builds stored Apps / Shell / Files / Chat as their own tabs.
 * Fold those into Work and remember the pane for this project.
 */
export function migrateLegacyWorkTab(tab: Tab, projectId: string): Tab {
  const item: WorkItem | null =
    tab === 'cursor' ? 'chat' : tab === 'apps' || tab === 'shell' || tab === 'files' ? tab : null
  if (!item) return tab
  if (projectId) writeWorkPlace(projectId, { item })
  return 'work'
}

const AGENT_SCENE_KEY = 'hb-agent-scene'
const AGENT_LAST_CHAT_KEY = 'hb-agent-last-chat'

/** Persisted Home Agent navigation (survives refresh). */
export type AgentScenePref =
  | { kind: 'setup' }
  | { kind: 'all' }
  | { kind: 'chats'; projectId: string; cwd: string }
  | { kind: 'chat'; projectId: string; cwd: string; chatId: string; fromAll?: boolean }

export function readAgentScene(): AgentScenePref | null {
  try {
    const raw = localStorage.getItem(AGENT_SCENE_KEY)
    if (!raw) return null
    const s = JSON.parse(raw) as AgentScenePref
    if (!s || typeof s !== 'object' || !('kind' in s)) return null
    if (s.kind === 'setup') return { kind: 'setup' }
    if (s.kind === 'all') return { kind: 'all' }
    if (
      (s.kind === 'chats' || s.kind === 'chat') &&
      typeof s.projectId === 'string' &&
      typeof s.cwd === 'string'
    ) {
      if (s.kind === 'chat' && typeof s.chatId !== 'string') return null
      return s
    }
    return null
  } catch {
    return null
  }
}

export function writeAgentScene(scene: AgentScenePref): void {
  try {
    localStorage.setItem(AGENT_SCENE_KEY, JSON.stringify(scene))
    if (scene.kind === 'chat' && scene.chatId) {
      writeAgentLastChat(scene.projectId, scene.cwd, scene.chatId)
    }
  } catch {
    /* ignore */
  }
}

export function readAgentLastChat(
  projectId: string,
  cwd: string,
): string {
  try {
    const raw = localStorage.getItem(
      `${AGENT_LAST_CHAT_KEY}:${projectId}:${cwd || '.'}`,
    )
    return raw || ''
  } catch {
    return ''
  }
}

export function writeAgentLastChat(
  projectId: string,
  cwd: string,
  chatId: string,
): void {
  try {
    if (chatId) {
      localStorage.setItem(
        `${AGENT_LAST_CHAT_KEY}:${projectId}:${cwd || '.'}`,
        chatId,
      )
    }
  } catch {
    /* ignore */
  }
}

const CHAT_DRAFT_KEY = 'hb-chat-draft'

/** Per-chat composer draft (survives leaving the chat / remounts). */
export function readChatDraft(projectId: string, chatId: string): string {
  if (!projectId || !chatId) return ''
  try {
    return localStorage.getItem(`${CHAT_DRAFT_KEY}:${projectId}:${chatId}`) || ''
  } catch {
    return ''
  }
}

export function writeChatDraft(projectId: string, chatId: string, text: string): void {
  if (!projectId || !chatId) return
  try {
    const key = `${CHAT_DRAFT_KEY}:${projectId}:${chatId}`
    if (!text) localStorage.removeItem(key)
    else localStorage.setItem(key, text)
  } catch {
    /* ignore */
  }
}

export function clearChatDraft(projectId: string, chatId: string): void {
  writeChatDraft(projectId, chatId, '')
}

const CHAT_DRAFT_SCRATCH_KEY = 'hb-chat-draft-scratch'

/**
 * Unsent text typed before a chat id exists (tabs still loading, or the
 * panel unmounted mid-keystroke). Applied to the chat once it is known.
 */
export function readChatDraftScratch(projectId: string): string {
  if (!projectId) return ''
  try {
    return localStorage.getItem(`${CHAT_DRAFT_SCRATCH_KEY}:${projectId}`) || ''
  } catch {
    return ''
  }
}

export function writeChatDraftScratch(projectId: string, text: string): void {
  if (!projectId) return
  try {
    const key = `${CHAT_DRAFT_SCRATCH_KEY}:${projectId}`
    if (!text) localStorage.removeItem(key)
    else localStorage.setItem(key, text)
  } catch {
    /* ignore */
  }
}

const PENDING_COMPOSE_KEY = 'hb-pending-compose'

/** One-shot composer seed (e.g. after Add app → Ask Chat to wire). */
export type PendingCompose = {
  projectId: string
  text: string
  autoSend?: boolean
  title?: string
}

export function setPendingCompose(pending: PendingCompose): void {
  try {
    if (!pending.projectId || !pending.text.trim()) {
      localStorage.removeItem(PENDING_COMPOSE_KEY)
      return
    }
    localStorage.setItem(PENDING_COMPOSE_KEY, JSON.stringify(pending))
  } catch {
    /* ignore */
  }
}

export function peekPendingCompose(): PendingCompose | null {
  try {
    const raw = localStorage.getItem(PENDING_COMPOSE_KEY)
    if (!raw) return null
    const p = JSON.parse(raw) as PendingCompose
    if (!p?.projectId || typeof p.text !== 'string' || !p.text.trim()) return null
    return p
  } catch {
    return null
  }
}

export function takePendingCompose(projectId?: string): PendingCompose | null {
  const p = peekPendingCompose()
  if (!p) return null
  if (projectId && p.projectId !== projectId) return null
  try {
    localStorage.removeItem(PENDING_COMPOSE_KEY)
  } catch {
    /* ignore */
  }
  return p
}

const PIN_HASH_KEY = 'hb-pin-hash'
const PIN_SALT_KEY = 'hb-pin-salt'
const PIN_IDLE_KEY = 'hb-pin-idle-ms'
const PIN_ENABLED_KEY = 'hb-pin-enabled'
const DEFAULT_PIN_IDLE_MS = 5 * 60 * 1000

/** Legacy browser-only PIN material (migrated to server once). */
export function readLegacyLocalPin(): { salt: string; hash: string; idleMs: number } | null {
  try {
    const salt = localStorage.getItem(PIN_SALT_KEY) || ''
    const hash = localStorage.getItem(PIN_HASH_KEY) || ''
    if (!salt || !hash) return null
    return { salt, hash, idleMs: readPinIdleMs() }
  } catch {
    return null
  }
}

export function clearLegacyLocalPin(): void {
  try {
    localStorage.removeItem(PIN_HASH_KEY)
    localStorage.removeItem(PIN_SALT_KEY)
    localStorage.setItem(PIN_ENABLED_KEY, '0')
  } catch {
    /* ignore */
  }
}

export function readPinIdleMs(): number {
  try {
    const n = Number(localStorage.getItem(PIN_IDLE_KEY))
    if (Number.isFinite(n) && n >= 60_000) return Math.min(n, 60 * 60_000)
  } catch {
    /* ignore */
  }
  return DEFAULT_PIN_IDLE_MS
}

export function writePinIdleMs(ms: number): void {
  try {
    localStorage.setItem(PIN_IDLE_KEY, String(Math.max(60_000, ms)))
  } catch {
    /* ignore */
  }
}
