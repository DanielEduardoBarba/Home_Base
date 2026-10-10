import type { PresentRequest } from './chatTypes'

/** Guess a PresentRequest from a Cursor tool_call so Work can show it. */
export function presentFromTool(
  _toolName: string,
  filePath?: string,
  sessionId?: string,
): PresentRequest | null {
  if (filePath) {
    return { scene: 'files', path: filePath }
  }
  if (sessionId) {
    return { scene: 'shell', sessionIds: [sessionId] }
  }
  // Bare tool name without path/session — do not auto-jump to an empty Shell.
  return null
}

export function presentLabel(req: PresentRequest): string {
  if (req.scene === 'shell') {
    if (req.newShell) return 'Open shell'
    if (req.sessionIds?.length) return 'Show in Shell'
    return 'Open Shell'
  }
  if (req.scene === 'files') return req.path ? 'Show file' : 'Open Files'
  return 'Open Apps'
}
