import { describe, expect, test } from 'bun:test'
import { parseAppPath, serializeAppPath, type AppLocation } from './appRoutes'

describe('parseAppPath / serializeAppPath', () => {
  const cases: [string, AppLocation][] = [
    ['/', { area: 'home', tab: 'work', workItem: 'apps' }],
    ['/home', { area: 'home', tab: 'work', workItem: 'apps' }],
    ['/access', { area: 'access', tab: 'work', workItem: 'apps' }],
    ['/agent', { area: 'agent', tab: 'work', workItem: 'apps' }],
    ['/vision', { area: 'vision', tab: 'work', workItem: 'apps' }],
    ['/settings', { area: 'settings', tab: 'work', workItem: 'apps' }],
    ['/work', { area: 'homework', tab: 'work', workItem: 'apps' }],
    ['/homework', { area: 'homework', tab: 'work', workItem: 'apps' }],
    ['/work/apps', { area: 'homework', tab: 'work', workItem: 'apps' }],
    ['/work/shell', { area: 'homework', tab: 'work', workItem: 'shell' }],
    ['/work/files', { area: 'homework', tab: 'work', workItem: 'files' }],
    ['/work/chat', { area: 'homework', tab: 'work', workItem: 'chat' }],
    ['/work/cursor', { area: 'homework', tab: 'work', workItem: 'chat' }],
    ['/view', { area: 'homework', tab: 'view', workItem: 'apps' }],
    ['/logs', { area: 'homework', tab: 'logs', workItem: 'apps' }],
    ['/homework/files', { area: 'homework', tab: 'work', workItem: 'files' }],
    ['/homework/view', { area: 'homework', tab: 'view', workItem: 'apps' }],
  ]

  for (const [path, loc] of cases) {
    test(`parses ${path}`, () => {
      expect(parseAppPath(path)).toEqual({ kind: 'ok', loc })
    })
  }

  test('unknown paths are not-found', () => {
    for (const path of ['/nope', '/work/unknown', '/api/trace', '/files', '/work/files/extra']) {
      const r = parseAppPath(path)
      expect(r.kind).toBe('notfound')
      if (r.kind === 'notfound') expect(r.path).toBe(path)
    }
  })

  test('serialize is stable and round-trips', () => {
    const locs: AppLocation[] = [
      { area: 'home', tab: 'work', workItem: 'apps' },
      { area: 'access', tab: 'work', workItem: 'apps' },
      { area: 'homework', tab: 'work', workItem: 'files' },
      { area: 'homework', tab: 'work', workItem: 'chat' },
      { area: 'homework', tab: 'view', workItem: 'apps' },
      { area: 'homework', tab: 'logs', workItem: 'shell' },
      { area: 'settings', tab: 'work', workItem: 'apps' },
    ]
    for (const loc of locs) {
      const path = serializeAppPath(loc)
      const parsed = parseAppPath(path)
      expect(parsed.kind).toBe('ok')
      if (parsed.kind === 'ok') {
        expect(parsed.loc.area).toBe(loc.area)
        expect(parsed.loc.tab).toBe(loc.tab)
        if (loc.tab === 'work') expect(parsed.loc.workItem).toBe(loc.workItem)
      }
    }
    expect(serializeAppPath({ area: 'home', tab: 'work', workItem: 'apps' })).toBe('/')
    expect(serializeAppPath({ area: 'homework', tab: 'work', workItem: 'files' })).toBe('/work/files')
  })
})
