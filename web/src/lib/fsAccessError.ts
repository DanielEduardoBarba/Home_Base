/** User-facing copy when a Files listing or open fails. */

function firstPathIn(message: string): string | undefined {
  const m = message.match(/['`](\/[^'`]*)['`]|(\/root|\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*)/)
  if (!m) return undefined
  return m[1] || m[2]
}

export function formatFsAccessError(raw: unknown, path?: string): string {
  let message = ''
  if (typeof raw === 'string') message = raw
  else if (raw instanceof Error) message = raw.message
  else if (raw && typeof raw === 'object' && 'detail' in raw) {
    const detail = (raw as { detail: unknown }).detail
    message = typeof detail === 'string' ? detail : JSON.stringify(detail)
  } else {
    message = String(raw ?? '')
  }
  message = message.replace(/^"+|"+$/g, '').trim()

  const target = (path && path.startsWith('/') ? path : firstPathIn(message)) || ''
  if (/eacces|eperm|permission denied/i.test(message)) {
    return target
      ? `Permission denied — Home Base can't read ${target}`
      : "Permission denied — Home Base can't read that folder"
  }
  if (/enoent|not_found|not found/i.test(message)) {
    return target ? `Folder not found: ${target}` : 'Folder not found'
  }
  if (/not_dir|not a directory/i.test(message)) {
    return target ? `Not a folder: ${target}` : 'That path is not a folder'
  }
  return message || 'Could not open that folder'
}
