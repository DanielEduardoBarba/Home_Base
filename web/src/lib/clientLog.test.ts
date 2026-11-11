import { describe, expect, test } from 'bun:test'
import { shouldRecordClientLog } from './clientLog'

describe('shouldRecordClientLog', () => {
  test('drops a second client log ready', () => {
    expect(
      shouldRecordClientLog([], { level: 'info', message: 'client log ready' }, true),
    ).toBe(false)
    expect(
      shouldRecordClientLog([], { level: 'info', message: 'client log ready' }, false),
    ).toBe(true)
  })

  test('drops consecutive identical lines', () => {
    const pending = [{ level: 'info', message: 'hello' }]
    expect(shouldRecordClientLog(pending, { level: 'info', message: 'hello' }, false)).toBe(false)
    expect(shouldRecordClientLog(pending, { level: 'info', message: 'other' }, false)).toBe(true)
  })
})
