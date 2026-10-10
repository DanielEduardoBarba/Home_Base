/** Human-readable tool / thinking helpers for Chat. */

export function prettyToolName(name: string): string {
  const n = (name || 'tool').trim()
  if (!n || n === 'tool') return 'tool'
  if (n.startsWith('homebase_')) return n.replace(/_/g, ' ')
  const map: Record<string, string> = {
    shell: 'shell',
    read: 'read',
    write: 'write',
    edit: 'edit',
    grep: 'search',
    glob: 'glob',
    delete: 'delete',
    strreplace: 'edit',
    search_replace: 'edit',
  }
  return map[n.toLowerCase()] || n
}

export function polishThinking(text: string): string {
  if (!text) return ''
  let t = text.replace(/\r\n/g, '\n')
  // Collapse runaway spaces/tabs but keep paragraph breaks
  t = t.replace(/[^\S\n]+/g, ' ')
  t = t.replace(/ *\n */g, '\n')
  t = t.replace(/\n{3,}/g, '\n\n')
  // Space after sentence punctuation when jammed: "end.Next" → "end. Next"
  t = t.replace(/([.!?])([A-Za-z])/g, '$1 $2')
  // Space after comma/semicolon when jammed
  t = t.replace(/([,;:])([A-Za-z])/g, '$1 $2')
  return t.trim()
}

export function formatMsgTime(at?: number): string {
  if (!at) return ''
  try {
    return new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  } catch {
    return ''
  }
}
