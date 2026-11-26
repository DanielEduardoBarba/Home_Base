import { describe, expect, test } from 'bun:test'

/** Mirror of server redactCallbackUrl — keep UI expectations aligned. */
function redactCallbackUrl(raw: unknown): string | undefined {
  const u = String(raw || '').trim()
  if (!u) return undefined
  try {
    const parsed = new URL(u)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return '[invalid-url]'
    }
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`
  } catch {
    return '[invalid-url]'
  }
}

describe('webhook health URL redaction', () => {
  test('strips userinfo, query, and hash', () => {
    expect(
      redactCallbackUrl('https://user:pass@hooks.example/wake?token=abc#x'),
    ).toBe('https://hooks.example/wake')
  })

  test('returns undefined for empty', () => {
    expect(redactCallbackUrl('')).toBeUndefined()
  })
})
