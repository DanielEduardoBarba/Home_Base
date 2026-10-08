import type { PresentRequest } from './chatTypes'

/** Tool names that usually mean a shell / terminal ran. */
const SHELL_TOOLS = /^(shell|bash|terminal|run_terminal|execute|command|pty)$/i

/** Guess a PresentRequest from a Cursor tool_call so Work can show it. */
export function presentFromTool(toolName: string, filePath?: string): PresentRequest | null {
  if (filePath) {
    return { scene: 'files', path: filePath }
  }
  if (SHELL_TOOLS.test(toolName || '')) {
    return { scene: 'shell', newShell: false }
  }
  return null
}

export function presentLabel(req: PresentRequest): string {
  if (req.scene === 'shell') {
    if (req.newShell) return 'Open shell'
    if (req.sessionIds?.length) return 'Show shell'
    return 'Open Shell'
  }
  if (req.scene === 'files') return req.path ? 'Show file' : 'Open Files'
  return 'Open Apps'
}
