import type { ChatMsg, PresentRequest } from './chatTypes'

const EDIT_TOOLS = new Set([
  'write',
  'edit',
  'strreplace',
  'search_replace',
  'searchreplace',
  'delete',
  'applypatch',
  'edit_file',
  'write_file',
])

const SHELL_TOOLS = new Set(['shell', 'bash', 'await', 'awaitshell'])

export function isEditTool(name: string): boolean {
  const n = (name || '').toLowerCase().replace(/[^a-z]/g, '')
  return EDIT_TOOLS.has(n) || n.includes('write') || n.includes('strreplace') || n.includes('editfile')
}

export function isShellTool(name: string): boolean {
  const n = (name || '').toLowerCase().replace(/[^a-z]/g, '')
  return SHELL_TOOLS.has(n) || n === 'shell'
}

/** Guess a PresentRequest from a Cursor tool_call so Work can show it. */
export function presentFromTool(
  toolName: string,
  filePath?: string,
  sessionId?: string,
  extra?: Partial<PresentRequest>,
): PresentRequest | null {
  if (filePath || extra?.path) {
    return {
      scene: 'files',
      path: filePath || extra?.path,
      minimal: true,
      before: extra?.before,
      after: extra?.after,
      action: extra?.action,
    }
  }
  if (sessionId || extra?.command || isShellTool(toolName)) {
    return {
      scene: 'shell',
      sessionIds: sessionId ? [sessionId] : extra?.sessionIds,
      minimal: true,
      command: extra?.command,
      output: extra?.output,
      newShell: extra?.newShell,
    }
  }
  // Bare tool name without path/session — do not auto-jump to an empty Shell.
  return null
}

/** Build a present request from a chat bubble (tool or file). */
export function presentFromMessage(m: ChatMsg): PresentRequest | null {
  if (m.role === 'file' && m.file?.path) {
    return {
      scene: 'files',
      path: m.file.path,
      minimal: true,
      before: m.file.before,
      after: m.file.after,
      action: m.file.action,
    }
  }
  if (m.role === 'tool' && m.tool) {
    const path = m.tool.path
    if (path && (isEditTool(m.tool.name) || m.tool.before != null || m.tool.after != null)) {
      return {
        scene: 'files',
        path,
        minimal: true,
        before: m.tool.before,
        after: m.tool.after,
        action: m.tool.name,
      }
    }
    if (isShellTool(m.tool.name) || m.tool.command || m.tool.sessionId) {
      return {
        scene: 'shell',
        sessionIds: m.tool.sessionId ? [m.tool.sessionId] : undefined,
        minimal: true,
        command: m.tool.command || m.tool.detail,
        output: m.tool.output,
      }
    }
    if (path) {
      return { scene: 'files', path, minimal: true }
    }
  }
  return null
}

export function presentLabel(req: PresentRequest): string {
  if (req.scene === 'shell') {
    if (req.command) return 'Show command'
    if (req.newShell) return 'Open shell'
    if (req.sessionIds?.length) return 'Show in Shell'
    return 'Open Shell'
  }
  if (req.scene === 'files') {
    if (req.before != null || req.after != null) return 'Show changes'
    return req.path ? 'Open file' : 'Open Files'
  }
  return 'Open Apps'
}
