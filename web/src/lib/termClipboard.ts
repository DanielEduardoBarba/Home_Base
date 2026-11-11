/** Keyboard and clipboard helpers for the desktop terminal. */

export type TermKeyAction = 'copy' | 'paste' | 'interrupt' | null

export type TermKeyEvent = {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  altKey: boolean
  type?: string
}

export function isApplePlatform(platform = '', userAgent = ''): boolean {
  return /Mac|iPhone|iPad|iPod/.test(platform) || /Mac OS X|iPhone|iPad|iPod/.test(userAgent)
}

function isC(key: string): boolean {
  return key === 'c' || key === 'C'
}

function isV(key: string): boolean {
  return key === 'v' || key === 'V'
}

/**
 * Standard terminal copy/paste shortcuts.
 * - Ctrl+Shift+C / Cmd+C: copy the selection
 * - Ctrl+C: copy when there is a selection, otherwise SIGINT
 * - Ctrl+Shift+V / Cmd+V: paste
 */
export function termClipboardKeyAction(
  ev: TermKeyEvent,
  hasSelection: boolean,
  apple: boolean,
): TermKeyAction {
  if (ev.type && ev.type !== 'keydown') return null
  if (ev.altKey) return null

  const keyC = isC(ev.key)
  const keyV = isV(ev.key)

  if (apple && ev.metaKey && !ev.ctrlKey) {
    if (keyC) return 'copy'
    if (keyV) return 'paste'
    return null
  }

  if (ev.ctrlKey && ev.shiftKey && !ev.metaKey) {
    if (keyC) return 'copy'
    if (keyV) return 'paste'
    return null
  }

  if (ev.ctrlKey && !ev.shiftKey && !ev.metaKey && keyC) {
    return hasSelection ? 'copy' : 'interrupt'
  }

  return null
}

export async function writeClipboard(text: string): Promise<boolean> {
  if (!text) return false
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* fall through to execCommand */
  }
  return fallbackCopy(text)
}

function fallbackCopy(text: string): boolean {
  if (typeof document === 'undefined') return false
  const ta = document.createElement('textarea')
  ta.value = text
  ta.setAttribute('readonly', '')
  ta.style.position = 'fixed'
  ta.style.top = '0'
  ta.style.left = '-9999px'
  document.body.appendChild(ta)
  ta.focus()
  ta.select()
  let ok = false
  try {
    ok = document.execCommand('copy')
  } catch {
    ok = false
  }
  ta.remove()
  return ok
}

export async function readClipboard(): Promise<string> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.readText) {
      return (await navigator.clipboard.readText()) || ''
    }
  } catch {
    /* no permission or unsupported */
  }
  return ''
}
