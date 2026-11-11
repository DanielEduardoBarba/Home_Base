import { describe, expect, test } from 'bun:test'
import { formatFsAccessError } from './fsAccessError'

describe('formatFsAccessError', () => {
  test('maps EACCES / permission denied to a clear inline message', () => {
    expect(formatFsAccessError("EACCES: permission denied, scandir '/root'", '/root')).toBe(
      "Permission denied — Home Base can't read /root",
    )
    expect(formatFsAccessError('permission denied')).toBe(
      "Permission denied — Home Base can't read that folder",
    )
    expect(formatFsAccessError('"EACCES: permission denied, scandir \'/root\'"')).toBe(
      "Permission denied — Home Base can't read /root",
    )
  })

  test('maps missing and not-a-folder errors', () => {
    expect(formatFsAccessError('not_found', '/tmp/missing')).toBe('Folder not found: /tmp/missing')
    expect(formatFsAccessError('not_dir', '/etc/hosts')).toBe('Not a folder: /etc/hosts')
  })

  test('unwraps API detail objects and leaves other messages intact', () => {
    expect(formatFsAccessError({ detail: "Permission denied — Home Base can't read /root" })).toBe(
      "Permission denied — Home Base can't read /root",
    )
    expect(formatFsAccessError('File too large to edit in browser (2000000 bytes)')).toBe(
      'File too large to edit in browser (2000000 bytes)',
    )
  })
})
