import { describe, expect, test } from 'bun:test'
import {
  isPinLockSuppressed,
  resetPinLockSuppress,
  suppressPinLockFor,
} from './pinLockSuppress'

describe('pinLockSuppress', () => {
  test('suppress window blocks lock checks briefly', () => {
    resetPinLockSuppress()
    expect(isPinLockSuppressed()).toBe(false)
    suppressPinLockFor(5_000)
    expect(isPinLockSuppressed()).toBe(true)
    expect(isPinLockSuppressed(Date.now() + 10_000)).toBe(false)
    resetPinLockSuppress()
    expect(isPinLockSuppressed()).toBe(false)
  })

  test('non-positive ms is ignored', () => {
    resetPinLockSuppress()
    suppressPinLockFor(0)
    suppressPinLockFor(-1)
    expect(isPinLockSuppressed()).toBe(false)
  })
})
