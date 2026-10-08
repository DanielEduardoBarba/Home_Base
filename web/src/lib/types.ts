export type Tab = 'apps' | 'shell' | 'files' | 'cursor' | 'logs' | 'alerts' | 'settings'

/** True only when the page itself is loaded from loopback (not .local / LAN). */
export function isLocalHostPage(): boolean {
  const h = location.hostname.toLowerCase()
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1'
}

export interface TraceLine {
  id: number
  ts: number
  level: string
  source: string
  message: string
}

export interface PortDef {
  id: string
  label: string
  port: number
  health?: string | null
}

export interface PortStatus {
  id: string
  label: string
  port: number
  up: boolean
  health?: { ok: boolean; url: string; status?: number | null } | null
}

export interface ActionDef {
  id: string
  label: string
  type: string
  script: string
  args: string[]
  kind: string
  group: string
  variant: string
  hint: string
}

export interface Session {
  id: string
  kind: string
  projectId: string | null
  cwd: string
  cmdline: string[]
  label: string
  pid: number | null
  alive: boolean
  createdAt: number
}

export interface Project {
  id: string
  name: string
  path: string
  ports: PortDef[]
  actions: ActionDef[]
  portsStatus?: PortStatus[]
  sessions?: Session[]
  exists: boolean
  stateDir?: string
  cursor?: {
    projectId: string
    agentId?: string | null
    configured: boolean
    active: boolean
    running: boolean
    model?: string
    defaultModel?: string
  }
  logs?: { path: string; exists: boolean; text: string }
}

export interface CursorModel {
  id: string
  displayName: string
  description: string
}

export interface NotificationItem {
  id: string
  ts: string
  title: string
  body: string
  level: string
  category: string
  read: boolean
  meta?: Record<string, unknown>
}

export interface FsEntry {
  name: string
  path: string
  type: 'file' | 'dir'
  size?: number
  ignored?: boolean
}
