/** Shared chat types — used by ChatPanel (page + dock). */

export type ChatRole = 'user' | 'assistant' | 'thinking' | 'tool' | 'file' | 'status' | 'system'

export type ChatMsg = {
  id: string
  role: ChatRole
  text?: string
  tool?: { name: string; status: string; detail?: string }
  file?: { path: string; action: string }
}

export type ChatTab = {
  id: string
  title: string
  cwd: string
  messages: ChatMsg[]
  agentId?: string | null
  updatedAt: number
}

/** What Work / Shell / Files should show when chat asks to present. */
export type PresentRequest = {
  scene: 'apps' | 'shell' | 'files'
  /** Attach these PTY sessions in Shell. */
  sessionIds?: string[]
  /** Open a new interactive shell. */
  newShell?: boolean
  /** Absolute or project-relative path for Files. */
  path?: string
}

export type WorkScene = PresentRequest['scene']
