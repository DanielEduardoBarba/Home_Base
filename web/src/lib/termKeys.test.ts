import { describe, expect, test } from 'bun:test'
import {
  TERM_ARROW_KEYS,
  TERM_CTRL_LETTERS,
  TERM_SYMBOL_KEYS,
  toCtrlSequence,
} from './termKeys'

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

  test('Ctrl letter grid is A–Z', () => {
    expect(TERM_CTRL_LETTERS.join('')).toBe('ABCDEFGHIJKLMNOPQRSTUVWXYZ')
  })

  test('toCtrlSequence maps letters and punctuation', () => {
    expect(toCtrlSequence('c')).toBe('\x03')
    expect(toCtrlSequence('C')).toBe('\x03')
    expect(toCtrlSequence('d')).toBe('\x04')
    expect(toCtrlSequence('z')).toBe('\x1a')
    expect(toCtrlSequence('[')).toBe('\x1b')
    expect(toCtrlSequence('\\')).toBe('\x1c')
    expect(toCtrlSequence(']')).toBe('\x1d')
    expect(toCtrlSequence('^')).toBe('\x1e')
    expect(toCtrlSequence('_')).toBe('\x1f')
    expect(toCtrlSequence('@')).toBe('\x00')
    expect(toCtrlSequence('?')).toBe('\x7f')
    expect(toCtrlSequence('1')).toBeNull()
    expect(toCtrlSequence('cc')).toBeNull()
  })
})
