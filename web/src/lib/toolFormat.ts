/** Human-readable tool / thinking helpers for Chat. */

export function formatToolDetail(
  name: string,
  args: unknown,
  summary?: string,
): string {
  if (summary && summary.trim()) return summary.trim()
  const n = (name || 'tool').toLowerCase()

  let obj: Record<string, unknown> | null = null
  if (typeof args === 'string') {
    const s = args.trim()
    if (!s) return prettyToolName(name)
    try {
      const parsed = JSON.parse(s) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        obj = parsed as Record<string, unknown>
      } else {
        return s.slice(0, 240)
      }
    } catch {
      return s.slice(0, 240)
    }
  } else if (args && typeof args === 'object' && !Array.isArray(args)) {
    obj = args as Record<string, unknown>
  } else if (args != null) {
    return String(args).slice(0, 240)
  } else {
    return prettyToolName(name)
  }

  const path = pickStr(obj, ['path', 'file', 'filePath', 'filename', 'target', 'target_file'])
  const cmd = pickStr(obj, ['command', 'cmd', 'script'])

  if (n === 'shell' || n === 'bash' || n === 'terminal' || n === 'execute' || n === 'command') {
    return cmd || 'shell'
  }
  if (n === 'read' || n === 'read_file') return path ? `Read ${shortPath(path)}` : 'Read file'
  if (n === 'write' || n === 'write_file') return path ? `Write ${shortPath(path)}` : 'Write file'
  if (n === 'edit' || n === 'strreplace' || n === 'search_replace' || n === 'apply_patch') {
    return path ? `Edit ${shortPath(path)}` : 'Edit file'
  }
  if (n === 'delete' || n === 'delete_file') return path ? `Delete ${shortPath(path)}` : 'Delete file'
  if (n === 'grep' || n === 'rg' || n === 'search') {
    const pat = pickStr(obj, ['pattern', 'query'])
    const where = path || pickStr(obj, ['glob', 'glob_pattern'])
    if (pat && where) return `Search “${pat.slice(0, 80)}” in ${shortPath(where)}`
    if (pat) return `Search “${pat.slice(0, 120)}”`
    return 'Search'
  }
  if (n === 'glob' || n === 'list_dir' || n === 'ls') {
    const g = pickStr(obj, ['glob_pattern', 'glob']) || path
    return g ? `List ${shortPath(g)}` : 'List files'
  }
  if (n.startsWith('homebase_')) return n.replace(/_/g, ' ')
  if (path) return `${prettyToolName(name)} ${shortPath(path)}`
  if (cmd) return cmd.slice(0, 240)

  const bits: string[] = []
  for (const [k, v] of Object.entries(obj).slice(0, 3)) {
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      if (v === '') continue
      bits.push(`${k}=${String(v).slice(0, 60)}`)
    }
  }
  return bits.length ? bits.join(' · ') : prettyToolName(name)
}

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

/** Join streamed thinking chunks so glued tokens become readable prose. */
export function joinThinkingChunk(prev: string, chunk: string): string {
  if (!chunk) return prev
  if (!prev) return chunk
  if (/\s$/.test(prev) || /^\s/.test(chunk)) return prev + chunk
  if (/^[.,;:!?…)}\]"']/.test(chunk)) return prev + chunk
  if (/[({\["']$/.test(prev)) return prev + chunk
  // Word boundary: previous ended alnum and chunk starts alnum → space
  if (/\w$/.test(prev) && /^\w/.test(chunk)) {
    // Continuation of a hyphenated / mid-word stream (very short chunk) — no space
    if (chunk.length <= 2 && /^[a-z]/.test(chunk) && /[a-z]$/.test(prev)) {
      return prev + chunk
    }
    return `${prev} ${chunk}`
  }
  return prev + chunk
}

export function formatMsgTime(at?: number): string {
  if (!at) return ''
  try {
    return new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  } catch {
    return ''
  }
}

function pickStr(obj: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = obj[k]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return ''
}

function shortPath(p: string): string {
  if (p.length <= 56) return p
  const parts = p.split('/').filter(Boolean)
  if (parts.length >= 2) return `…/${parts.slice(-2).join('/')}`
  return `…${p.slice(-48)}`
}
