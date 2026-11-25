import { beforeEach, describe, expect, test } from 'bun:test'
import {
  parseAppSceneSnapshot,
  readAppSceneSnapshot,
  resolveBootstrapScene,
  resolveLandingPath,
  sceneAfterAuthedRemount,
  shouldWriteHistory,
  writeAppSceneSnapshot,
  type AppSceneSnapshot,
} from './appSceneSnapshot'
import { serializeAppPath } from './appRoutes'

function memorySessionStorage() {
  const map = new Map<string, string>()
  return {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => {
      map.set(k, v)
    },
    removeItem: (k: string) => {
      map.delete(k)
    },
    clear: () => map.clear(),
    key: () => null,
    get length() {
      return map.size
    },
  }
}

describe('resolveLandingPath', () => {
  test('prefers live deep link over stale boot path after client nav', () => {
    // Boot captured /work/shell; user later pushState to /vision; PinLock remounts.
    expect(resolveLandingPath('/work/shell', '/vision')).toBe('/vision')
    expect(resolveLandingPath('/', '/agent')).toBe('/agent')
  })

  test('uses boot deep link when live is soft-home (SSR hydrate quirk)', () => {
    expect(resolveLandingPath('/vision', '/')).toBe('/vision')
    expect(resolveLandingPath('/agent', '/')).toBe('/agent')
  })

  test('soft-home stays soft-home when boot matches', () => {
    expect(resolveLandingPath('/', '/')).toBe('/')
    expect(resolveLandingPath(null, '/')).toBe('/')
  })
})

describe('resolveBootstrapScene', () => {
  const prefs = {
    lastArea: 'home' as const,
    lastTab: 'work' as const,
    workItem: 'shell' as const,
    selectedId: 'homebase',
  }

  test('vision deep link restores Vision — not Work/Shell', () => {
    const r = resolveBootstrapScene('/vision', prefs, null)
    expect(r.kind).toBe('ok')
    if (r.kind === 'ok') {
      expect(r.loc.area).toBe('vision')
      expect(r.canonical).toBe('/vision')
      expect(r.loc.selectedId).toBe('homebase')
    }
  })

  test('agent deep link restores Agent with project id', () => {
    const snap: AppSceneSnapshot = {
      area: 'agent',
      tab: 'work',
      workItem: 'apps',
      selectedId: 'homebase',
    }
    const r = resolveBootstrapScene('/agent', prefs, snap)
    expect(r.kind).toBe('ok')
    if (r.kind === 'ok') {
      expect(r.loc.area).toBe('agent')
      expect(r.loc.selectedId).toBe('homebase')
      expect(r.canonical).toBe('/agent')
    }
  })

  test('soft-home uses snapshot area over Work/Shell prefs', () => {
    const snap: AppSceneSnapshot = {
      area: 'vision',
      tab: 'work',
      workItem: 'shell',
      selectedId: 'homebase',
    }
    const r = resolveBootstrapScene('/', prefs, snap)
    expect(r.kind).toBe('ok')
    if (r.kind === 'ok') {
      expect(r.loc.area).toBe('vision')
      expect(r.canonical).toBe('/vision')
    }
  })
})

describe('shouldWriteHistory', () => {
  test('does not push defaults before bootstrap', () => {
    const d = shouldWriteHistory({
      routesReady: true,
      bootstrapped: false,
      notFound: false,
      area: 'home',
      tab: 'work',
      workItem: 'apps',
      currentPath: '/vision',
    })
    expect(d.write).toBe(false)
  })

  test('does not clobber Vision with Work/Shell defaults', () => {
    const d = shouldWriteHistory({
      routesReady: true,
      bootstrapped: true,
      notFound: false,
      area: 'home',
      tab: 'work',
      workItem: 'apps',
      currentPath: '/vision',
    })
    // Would write `/` — callers must only run this after scene restore; with
    // restored vision area it must not write.
    expect(d.path).toBe('/')
    expect(d.write).toBe(true)

    const restored = shouldWriteHistory({
      routesReady: true,
      bootstrapped: true,
      notFound: false,
      area: 'vision',
      tab: 'work',
      workItem: 'shell',
      currentPath: '/vision',
    })
    expect(restored.write).toBe(false)
    expect(restored.path).toBe('/vision')
  })

  test('does not clobber Agent after restore', () => {
    const d = shouldWriteHistory({
      routesReady: true,
      bootstrapped: true,
      notFound: false,
      area: 'agent',
      tab: 'work',
      workItem: 'apps',
      currentPath: '/agent',
    })
    expect(d.write).toBe(false)
  })
})

describe('PinLock remount survival', () => {
  test('provider scene survives AuthedApp remount (fragment ↔ frozen)', () => {
    const before: AppSceneSnapshot = {
      area: 'vision',
      tab: 'work',
      workItem: 'shell',
      selectedId: 'homebase',
    }
    // Mimic PinLock moving children — state above PinLock stays put.
    expect(sceneAfterAuthedRemount(before, true)).toEqual(before)

    const agent: AppSceneSnapshot = {
      area: 'agent',
      tab: 'work',
      workItem: 'apps',
      selectedId: 'homebase',
    }
    expect(sceneAfterAuthedRemount(agent, true).area).toBe('agent')
  })

  test('stale boot path + remount bootstrap still lands on live Vision', () => {
    const landed = resolveLandingPath('/work/shell', '/vision')
    const r = resolveBootstrapScene(
      landed,
      {
        lastArea: 'homework',
        lastTab: 'work',
        workItem: 'shell',
        selectedId: 'homebase',
      },
      {
        area: 'homework',
        tab: 'work',
        workItem: 'shell',
        selectedId: 'homebase',
      },
    )
    expect(r.kind).toBe('ok')
    if (r.kind === 'ok') {
      expect(r.loc.area).toBe('vision')
      expect(serializeAppPath(r.loc)).toBe('/vision')
    }
  })

  test('stale boot path + remount bootstrap still lands on live Agent', () => {
    const landed = resolveLandingPath('/work/shell', '/agent')
    const r = resolveBootstrapScene(landed, {
      lastArea: 'homework',
      lastTab: 'work',
      workItem: 'shell',
      selectedId: 'homebase',
    }, null)
    expect(r.kind).toBe('ok')
    if (r.kind === 'ok') {
      expect(r.loc.area).toBe('agent')
      expect(r.loc.selectedId).toBe('homebase')
    }
  })
})

describe('app scene snapshot persistence', () => {
  beforeEach(() => {
    // @ts-expect-error test shim
    globalThis.sessionStorage = memorySessionStorage()
  })

  test('round-trips Vision and Agent snapshots', () => {
    const vision: AppSceneSnapshot = {
      area: 'vision',
      tab: 'work',
      workItem: 'apps',
      selectedId: 'homebase',
    }
    writeAppSceneSnapshot(vision)
    expect(readAppSceneSnapshot()).toEqual(vision)

    const agent: AppSceneSnapshot = {
      area: 'agent',
      tab: 'work',
      workItem: 'apps',
      selectedId: 'lastmanholdout',
    }
    writeAppSceneSnapshot(agent)
    expect(readAppSceneSnapshot()).toEqual(agent)
  })

  test('rejects invalid payloads', () => {
    expect(parseAppSceneSnapshot(null)).toBeNull()
    expect(parseAppSceneSnapshot({ area: 'nope', tab: 'work', workItem: 'apps', selectedId: '' })).toBeNull()
  })
})
