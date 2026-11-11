import { describe, expect, test } from 'bun:test'
import { DEFAULT_WORK_PLACE, parseWorkPlace } from './uiPrefs'

describe('parseWorkPlace', () => {
  test('defaults on invalid payloads', () => {
    for (const raw of [null, undefined, '', 3, [], true, 'files']) {
      expect(parseWorkPlace(raw)).toEqual(DEFAULT_WORK_PLACE)
    }
  })

  test('unknown item and bad paths fall back', () => {
    expect(
      parseWorkPlace({
        item: 'nope',
        dir: 'relative',
        file: { path: '/x' },
      }),
    ).toEqual({ item: 'apps' })
    expect(
      parseWorkPlace({
        item: 'files',
        dir: '/ok',
        file: '/ok/a.ts\n',
      }),
    ).toEqual({ item: 'files', dir: '/ok' })
  })

  test('accepts a valid restored place', () => {
    expect(
      parseWorkPlace({
        item: 'shell',
        dir: '/home/you/app',
        file: '/home/you/app/src/index.ts',
        extra: true,
      }),
    ).toEqual({
      item: 'shell',
      dir: '/home/you/app',
      file: '/home/you/app/src/index.ts',
    })
  })
})
