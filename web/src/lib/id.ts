/** Stable ids for chat tabs/messages — works on HTTP LAN (non-secure context). */
export function uid(len = 10): string {
  try {
    const c = globalThis.crypto
    if (c && typeof c.randomUUID === 'function') {
      return c.randomUUID().replace(/-/g, '').slice(0, len)
    }
    if (c && typeof c.getRandomValues === 'function') {
      const buf = new Uint8Array(Math.ceil(len / 2))
      c.getRandomValues(buf)
      return Array.from(buf, (b) => b.toString(16).padStart(2, '0'))
        .join('')
        .slice(0, len)
    }
  } catch {
    /* fall through */
  }
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`.slice(0, len)
}
