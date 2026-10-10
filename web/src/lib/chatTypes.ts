/** Shared chat types — used by ChatPanel (page + dock). */

export type ChatRole = 'user' | 'assistant' | 'thinking' | 'tool' | 'file' | 'status' | 'system'

export type ChatMsg = {
  id: string
  role: ChatRole
  text?: string
  /** True while this bubble is still receiving streamed tokens. */
  streaming?: boolean
  /** Epoch ms when the bubble was created / last meaningfully updated. */
  at?: number
  tool?: {
    name: string
    status: string
    detail?: string
    callId?: string
    sessionId?: string
  }
  file?: { path: string; action: string }
}

/** Cursor IDE–style conversation modes (Ask/Debug approximated via tool policy). */
export type ChatMode = 'agent' | 'ask' | 'plan' | 'debug'

export type ApprovalPolicy = 'ask' | 'auto'

export type PendingApproval = {
  id: string
  kind: string
  tool: string
  detail: string
  command?: string
  cwd?: string
  chatId?: string
  createdAt?: number
}

export type ChatTab = {
  id: string
  title: string
  cwd: string
  messages: ChatMsg[]
  agentId?: string | null
  mode?: ChatMode
  /** True while the server is still running this chat's agent. */
  running?: boolean
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
