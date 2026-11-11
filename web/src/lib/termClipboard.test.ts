import { describe, expect, test } from 'bun:test'
import { termClipboardKeyAction, writeClipboard, type TermKeyEvent } from './termClipboard'

function ev(partial: Partial<TermKeyEvent> & Pick<TermKeyEvent, 'key'>): TermKeyEvent {
  return {
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    type: 'keydown',
    ...partial,
  }
}

describe('termClipboardKeyAction', () => {
  test('Ctrl+Shift+C copies, Ctrl+Shift+V pastes', () => {
    expect(termClipboardKeyAction(ev({ key: 'c', ctrlKey: true, shiftKey: true }), false, false)).toBe(
      'copy',
    )
    expect(termClipboardKeyAction(ev({ key: 'v', ctrlKey: true, shiftKey: true }), false, false)).toBe(
      'paste',
    )
  })

  test('Cmd+C copies and Cmd+V pastes on Apple', () => {
    expect(termClipboardKeyAction(ev({ key: 'c', metaKey: true }), true, true)).toBe('copy')
    expect(termClipboardKeyAction(ev({ key: 'c', metaKey: true }), false, true)).toBe('copy')
    expect(termClipboardKeyAction(ev({ key: 'v', metaKey: true }), false, true)).toBe('paste')
  })

  test('Ctrl+C copies when there is a selection, otherwise interrupts', () => {
    expect(termClipboardKeyAction(ev({ key: 'c', ctrlKey: true }), true, false)).toBe('copy')
    expect(termClipboardKeyAction(ev({ key: 'c', ctrlKey: true }), false, false)).toBe('interrupt')
    // On a Mac, Ctrl+C is still the shell interrupt (Cmd is the copy modifier).
    expect(termClipboardKeyAction(ev({ key: 'c', ctrlKey: true }), false, true)).toBe('interrupt')
    expect(termClipboardKeyAction(ev({ key: 'c', ctrlKey: true }), true, true)).toBe('copy')
  })

  test('plain keys and Alt combinations are ignored', () => {
    expect(termClipboardKeyAction(ev({ key: 'c' }), true, false)).toBe(null)
    expect(termClipboardKeyAction(ev({ key: 'c', ctrlKey: true, altKey: true }), true, false)).toBe(
      null,
    )
    expect(termClipboardKeyAction(ev({ key: 'v', ctrlKey: true }), false, false)).toBe(null)
  })

  test('keyup is ignored', () => {
    expect(
      termClipboardKeyAction(ev({ key: 'c', ctrlKey: true, shiftKey: true, type: 'keyup' }), true, false),
    ).toBe(null)
  })
})

describe('writeClipboard', () => {
  test('uses navigator.clipboard.writeText when available', async () => {
    const written: string[] = []
    const prev = globalThis.navigator
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        clipboard: {
          writeText: async (text: string) => {
            written.push(text)
          },
        },
      },
    })
    try {
      expect(await writeClipboard('QA_COPY_ME')).toBe(true)
      expect(written).toEqual(['QA_COPY_ME'])
      expect(await writeClipboard('')).toBe(false)
    } finally {
      Object.defineProperty(globalThis, 'navigator', { configurable: true, value: prev })
    }
  })
})
