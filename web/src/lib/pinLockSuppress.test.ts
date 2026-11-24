import { describe, expect, test } from 'bun:test'
import {
  clearPinLockHideGrace,
  isPinLockSuppressed,
  resetPinLockSuppress,
  suppressPinLockFor,
  takePinLockHideSuppress,
} from './pinLockSuppress'

describe('pinLockSuppress', () => {
  test('one-shot: first hide consumes; twin hide stays in grace', () => {
    resetPinLockSuppress()
    expect(isPinLockSuppressed()).toBe(false)
    suppressPinLockFor(3_000)
    expect(isPinLockSuppressed()).toBe(true)

    const first = takePinLockHideSuppress()
    expect(first).toEqual({ skip: true, scheduleMs: 3_000 })
    expect(isPinLockSuppressed()).toBe(true) // grace until visible

    const twin = takePinLockHideSuppress()
    expect(twin).toEqual({ skip: true, scheduleMs: null })

    clearPinLockHideGrace()
    expect(isPinLockSuppressed()).toBe(false)
    expect(takePinLockHideSuppress()).toEqual({ skip: false })
  })

  test('non-positive ms is ignored', () => {
    resetPinLockSuppress()
    suppressPinLockFor(0)
    suppressPinLockFor(-1)
    expect(isPinLockSuppressed()).toBe(false)
    expect(takePinLockHideSuppress()).toEqual({ skip: false })
  })

  test('without arm, hide is not skipped', () => {
    resetPinLockSuppress()
    expect(takePinLockHideSuppress()).toEqual({ skip: false })
  })
})
