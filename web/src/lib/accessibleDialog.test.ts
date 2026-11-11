import { describe, expect, test } from 'bun:test'
import {
  dialogDomProps,
  findCancelElement,
  focusableElements,
  initialFocusTarget,
  nextTabIndex,
  resolveInitialFocusMode,
} from './accessibleDialog'

describe('resolveInitialFocusMode', () => {
  test('confirm dialogs default to Cancel', () => {
    expect(resolveInitialFocusMode({ confirm: true })).toBe('cancel')
  })
  test('plain dialogs default to first focusable', () => {
    expect(resolveInitialFocusMode({})).toBe('first')
  })
  test('explicit initialFocus wins over confirm', () => {
    expect(resolveInitialFocusMode({ confirm: true, initialFocus: 'first' })).toBe('first')
  })
})

describe('nextTabIndex', () => {
  test('wraps forward and backward', () => {
    expect(nextTabIndex(2, 3, false)).toBe(0)
    expect(nextTabIndex(0, 3, true)).toBe(2)
    expect(nextTabIndex(1, 3, false)).toBe(2)
    expect(nextTabIndex(1, 3, true)).toBe(0)
  })
  test('empty list stays at 0', () => {
    expect(nextTabIndex(0, 0, false)).toBe(0)
  })
})

describe('dialogDomProps', () => {
  test('open dialog is modal', () => {
    expect(dialogDomProps({ open: true, label: 'Sign out?' })).toEqual({
      role: 'dialog',
      'aria-modal': true,
      'aria-label': 'Sign out?',
    })
  })
  test('closed dialog is inert and has no dialog role', () => {
    const props = dialogDomProps({ open: false, label: 'Notifications' })
    expect(props).toEqual({ inert: true, 'aria-hidden': true })
    expect(props).not.toHaveProperty('role')
    expect(props).not.toHaveProperty('aria-modal')
  })
})
