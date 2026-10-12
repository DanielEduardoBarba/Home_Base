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
    Shell: 'shell',
    Read: 'read',
    Write: 'write',
    Edit: 'edit',
    Grep: 'search',
    Glob: 'glob',
    Delete: 'delete',
    AwaitShell: 'await',
    Task: 'task',
    WebFetch: 'fetch',
    WebSearch: 'search',
  }
  return map[n] || map[n.toLowerCase()] || n.replace(/_/g, ' ')
}

/** Turn raw tool args / JSON blobs into a short readable line. */
export function formatToolDetail(name: string, detail?: string): string {
  if (!detail) return ''
  const raw = detail.trim()
  if (!raw) return ''

  const pick = (obj: Record<string, unknown>): string | undefined => {
    const keys = [
      'command',
      'cmd',
      'path',
      'file_path',
      'filePath',
      'target_file',
      'targetFile',
      'pattern',
      'query',
      'url',
      'glob',
      'glob_pattern',
      'globPattern',
      'description',
      'prompt',
      'title',
      'action',
      'projectId',
    ]
    for (const k of keys) {
      const v = obj[k]
      if (typeof v === 'string' && v.trim()) {
        if (k === 'command' || k === 'cmd') return v.trim()
        if (k === 'path' || k === 'file_path' || k === 'filePath' || k === 'target_file' || k === 'targetFile') {
          return v.trim()
        }
        if (k === 'pattern' || k === 'query' || k === 'glob' || k === 'glob_pattern' || k === 'globPattern') {
          return v.trim()
        }
        if (k === 'url') return v.trim()
        if (k === 'description' || k === 'prompt' || k === 'title') {
          const t = v.trim()
          return t.length > 160 ? `${t.slice(0, 160)}…` : t
        }
        return v.trim()
      }
    }
    // Nested tool shapes: { shell: { command }, read: { path }, … }
    for (const v of Object.values(obj)) {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        const nested = pick(v as Record<string, unknown>)
        if (nested) return nested
      }
    }
    return undefined
  }

  try {
    if (raw.startsWith('{') || raw.startsWith('[')) {
      const parsed = JSON.parse(raw) as unknown
      if (typeof parsed === 'string') {
        const t = parsed.trim()
        return t.length > 220 ? `${t.slice(0, 220)}…` : t
      }
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const nice = pick(parsed as Record<string, unknown>)
        if (nice) return nice.length > 220 ? `${nice.slice(0, 220)}…` : nice
      }
    }
  } catch {
    /* fall through */
  }

  // Strip obvious JSON braces for already-truncated blobs
  let t = raw.replace(/^\{+\s*/, '').replace(/\s*\}+$/, '')
  t = t.replace(/"(?:command|cmd|path|file_path)"\s*:\s*"/i, '')
  if (t.length > 220) t = `${t.slice(0, 220)}…`
  const label = prettyToolName(name)
  return t || (label !== 'tool' ? label : raw)
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

/** Bubble timestamp — hour:minute:second.milliseconds for precise ordering. */
export function formatMsgTime(at?: number): string {
  if (!at) return ''
  try {
    const d = new Date(at)
    if (Number.isNaN(d.getTime())) return ''
    const pad = (n: number, w = 2) => String(n).padStart(w, '0')
    const h = d.getHours()
    const hh = h % 12 || 12
    const ap = h >= 12 ? 'PM' : 'AM'
    const ms = pad(d.getMilliseconds(), 3)
    return `${hh}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${ms} ${ap}`
  } catch {
    return ''
  }
}

export type LiveActivityKind = 'thinking' | 'writing' | 'tool' | 'busy'

export type LiveActivity = {
  kind: LiveActivityKind
  /** Short performative line, e.g. "editing HomeAgentTab.tsx…" */
  line: string
  live: boolean
}

function shortBasename(path: string): string {
  const clean = path.replace(/\/+$/, '').trim()
  if (!clean) return ''
  const parts = clean.split('/')
  return parts[parts.length - 1] || clean
}

/** Couple words / short cmd snippet for list chrome. */
function shortSnippet(raw: string, max = 36): string {
  const one = raw.replace(/\s+/g, ' ').trim()
  if (!one) return ''
  if (one.length <= max) return one
  const tokens = one.split(' ')
  let out = tokens[0] || ''
  for (let i = 1; i < tokens.length; i++) {
    const next = `${out} ${tokens[i]}`
    if (next.length > max) break
    out = next
  }
  if (out.length < 8 && tokens[0]) out = one.slice(0, max)
  return out.replace(/[.,;:]+$/, '') + '…'
}

function looksLikePath(s: string): boolean {
  const t = s.trim()
  if (!t || t.includes('\n')) return false
  if (t.startsWith('/') || t.startsWith('./') || t.startsWith('../') || t.startsWith('~/')) return true
  const base = t.split('/').pop() || ''
  return /^[\w.-]+\.[a-zA-Z0-9]{1,12}$/.test(base)
}

function looksLikeCommand(s: string): boolean {
  const t = s.trim()
  if (!t) return false
  if (t.includes('&&') || t.includes('||') || t.includes(' | ') || t.startsWith('export ')) return true
  return /^(cd|ls|grep|rg|find|curl|wget|npm|npx|bun|pnpm|yarn|git|cat|head|tail|kill|sleep|which|mkdir|rm|cp|mv|echo|python|python3|node|ssh|systemctl|journalctl|docker|kubectl|tsc|eslint)\b/i.test(
    t,
  )
}

function withEllipsis(s: string): string {
  const t = s.trim()
  if (!t) return '…'
  return /…$|\.\.\.$/.test(t) ? t : `${t}…`
}

/** Performative verb + tip for a tool bubble (list / status chrome). */
export function formatLiveToolLine(tool: {
  name?: string
  detail?: string
  path?: string
  command?: string
}): string {
  const rawName = (tool.name || '').trim()
  const name = prettyToolName(rawName)
  const detail = formatToolDetail(rawName || name, tool.detail)
  const path = (tool.path || '').trim() || (looksLikePath(detail) ? detail : '')
  const command =
    (tool.command || '').trim() ||
    (name === 'shell' || looksLikeCommand(detail) ? detail : '')

  let verb = name
  if (name === 'shell' || (rawName.toLowerCase() === 'tool' && command && !path)) {
    verb = 'running'
  } else if (name === 'read') {
    verb = 'reading'
  } else if (name === 'write') {
    verb = 'writing'
  } else if (name === 'edit' || name === 'delete') {
    verb = 'editing'
  } else if (name === 'search' || name === 'glob') {
    verb = name === 'glob' ? 'finding' : 'searching'
  } else if (name === 'fetch') {
    verb = 'fetching'
  } else if (name === 'task' || name === 'await') {
    verb = name === 'await' ? 'awaiting' : 'task'
  } else if (rawName.toLowerCase() === 'tool' || name === 'tool') {
    if (path) verb = 'reading'
    else if (command) verb = 'running'
    else verb = 'working'
  }

  if (verb === 'running' && command) {
    return withEllipsis(`running ${shortSnippet(command, 40)}`)
  }
  if ((verb === 'reading' || verb === 'writing' || verb === 'editing' || verb === 'finding') && path) {
    return withEllipsis(`${verb} ${shortBasename(path)}`)
  }
  if (verb === 'searching') {
    const tip = shortSnippet(detail || path || command, 32)
    return tip ? withEllipsis(`searching ${tip}`) : 'searching…'
  }
  if (path) return withEllipsis(`${verb} ${shortBasename(path)}`)
  if (command) return withEllipsis(`${verb} ${shortSnippet(command, 36)}`)
  if (detail) {
    const tip = looksLikePath(detail) ? shortBasename(detail) : shortSnippet(detail, 32)
    return withEllipsis(`${verb} ${tip}`)
  }
  return withEllipsis(verb === 'tool' ? 'working' : verb)
}

type ActivityMsg = {
  role?: string
  streaming?: boolean
  text?: string
  tool?: {
    name?: string
    status?: string
    detail?: string
    path?: string
    command?: string
  }
  file?: { path?: string; action?: string }
  task?: { status?: string; name?: string }
}

/**
 * Last pertinent live line for a chat tab (Home Agent chats list).
 * Prefers in-flight thinking/tools; while the run is still active, falls back
 * to the latest step after the last user message.
 */
export function chatLiveActivity(
  messages: ActivityMsg[] | undefined | null,
  running?: boolean,
): LiveActivity | null {
  const msgs = messages || []
  if (!msgs.length && !running) return null

  let lastUser = -1
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i]?.role === 'user') {
      lastUser = i
      break
    }
  }
  const turn = lastUser >= 0 ? msgs.slice(lastUser + 1) : msgs

  for (let i = turn.length - 1; i >= 0; i--) {
    const m = turn[i]!
    if (m.role === 'thinking' && m.streaming) {
      return { kind: 'thinking', line: 'thinking…', live: true }
    }
    if (
      (m.role === 'assistant' || m.role === 'ask' || m.role === 'debug' || m.role === 'plan') &&
      m.streaming
    ) {
      return { kind: 'writing', line: 'writing…', live: true }
    }
    if (m.role === 'tool' && m.tool) {
      const st = (m.tool.status || '').toLowerCase()
      if (st === 'running' || st === 'pending') {
        return { kind: 'tool', line: formatLiveToolLine(m.tool), live: true }
      }
    }
    if (m.role === 'task' && m.task) {
      const st = (m.task.status || '').toLowerCase()
      if (st === 'running' || st === 'pending') {
        const tip = shortSnippet(m.task.name || 'task', 32)
        return { kind: 'tool', line: withEllipsis(tip ? `task ${tip}` : 'task'), live: true }
      }
    }
  }

  if (!running) return null

  for (let i = turn.length - 1; i >= 0; i--) {
    const m = turn[i]!
    if (m.role === 'thinking') {
      return { kind: 'thinking', line: 'thinking…', live: true }
    }
    if (m.role === 'tool' && m.tool) {
      return { kind: 'tool', line: formatLiveToolLine(m.tool), live: true }
    }
    if (m.role === 'file' && m.file?.path) {
      const action = (m.file.action || '').toLowerCase()
      const verb =
        action.includes('write') ? 'writing' : action.includes('delete') ? 'editing' : 'editing'
      return {
        kind: 'tool',
        line: withEllipsis(`${verb} ${shortBasename(m.file.path)}`),
        live: true,
      }
    }
    if (m.role === 'assistant' || m.role === 'ask' || m.role === 'debug' || m.role === 'plan') {
      if (m.streaming) return { kind: 'writing', line: 'writing…', live: true }
    }
    if (m.role === 'todo') {
      return { kind: 'tool', line: 'todos…', live: true }
    }
  }

  return { kind: 'busy', line: 'working…', live: true }
}
