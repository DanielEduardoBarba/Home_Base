/** Shared chat types — used by ChatPanel (page + dock). */

export type ChatRole =
  | 'user'
  | 'assistant'
  | 'thinking'
  | 'tool'
  | 'file'
  | 'status'
  | 'system'
  | 'plan'
  | 'todo'
  | 'ask'
  | 'debug'
  | 'task'
  | 'mode_prompt'

export type ChatImage = {
  mimeType: string
  /** Raw base64 (no data: prefix). */
  data: string
  name?: string
  width?: number
  height?: number
}

export type TodoStatus = 'pending' | 'inProgress' | 'completed' | 'cancelled'

export type ChatTodoItem = {
  id?: string
  content: string
  status: TodoStatus
}

export type PlanCardState = 'open' | 'building' | 'cancelled' | 'done'

export type ChatMsg = {
  id: string
  role: ChatRole
  text?: string
  /** True while this bubble is still receiving streamed tokens. */
  streaming?: boolean
  /** Epoch ms when the bubble was created / last meaningfully updated. */
  at?: number
  /** Thinking duration from the model (ms), when known. */
  durationMs?: number
  images?: ChatImage[]
  /** Project-relative paths attached via @ picker. */
  contextPaths?: string[]
  tool?: {
    name: string
    status: string
    detail?: string
    callId?: string
    sessionId?: string
    /** Absolute or workspace path for edit/read tools. */
    path?: string
    /** Shell command when this tool ran a command. */
    command?: string
    /** Captured shell output (trimmed). */
    output?: string
    /** Pre-edit file snapshot for AI edits. */
    before?: string
    /** Post-edit file snapshot for AI edits. */
    after?: string
  }
  file?: {
    path: string
    action: string
    before?: string
    after?: string
  }
  /** Structured todo checklist (UpdateTodos). */
  todos?: ChatTodoItem[]
  /** Plan card lifecycle. */
  planState?: PlanCardState
  /** Mode-switch proposal. */
  modePrompt?: {
    from?: string
    to: ChatMode
    reason?: string
    status?: 'pending' | 'accepted' | 'denied'
    approvalId?: string
  }
  /** Subagent / task status line. */
  task?: {
    status?: string
    name?: string
  }
}

export function chatImageSrc(img: ChatImage): string {
  return `data:${img.mimeType};base64,${img.data}`
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
  model?: string
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
  /** Home Agent: strip chrome — editor / shell replay only. */
  minimal?: boolean
  /** AI edit snapshots for +/- diff in the editor. */
  before?: string
  after?: string
  action?: string
  /** Shell command + captured output for minimal replay. */
  command?: string
  output?: string
}

export type WorkScene = PresentRequest['scene']
