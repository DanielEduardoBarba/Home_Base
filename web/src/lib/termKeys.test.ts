import { describe, expect, test } from 'bun:test'
import { TERM_ARROW_KEYS, TERM_SYMBOL_KEYS } from './termKeys'

describe('term key sequences', () => {
  test('arrows are CSI cursor / history sequences', () => {
    const byLabel = Object.fromEntries(TERM_ARROW_KEYS.map((k) => [k.label, k.seq]))
    expect(byLabel['↑']).toBe('\x1b[A')
    expect(byLabel['↓']).toBe('\x1b[B')
    expect(byLabel['←']).toBe('\x1b[D')
    expect(byLabel['→']).toBe('\x1b[C')
  })

  test('common shell symbols are single characters', () => {
    expect(TERM_SYMBOL_KEYS.map((k) => k.seq).join('')).toBe('|~/-')
  })
})
