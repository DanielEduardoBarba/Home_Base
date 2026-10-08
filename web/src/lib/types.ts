export type Tab = 'apps' | 'files' | 'shell' | 'cursor' | 'monitor' | 'alerts'

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
  }
  logs?: { path: string; exists: boolean; text: string }
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
}
