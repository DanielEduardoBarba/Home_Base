import { describe, expect, test } from 'bun:test'
import {
  decidePortTileClick,
  findActionForPort,
  isPortStartAction,
  portTileHref,
} from './portTile'
import type { ActionDef } from './types'

function action(partial: Partial<ActionDef> & { id: string }): ActionDef {
  return {
    label: partial.label || partial.id,
    type: partial.type || 'script',
    script: partial.script || 'scripts/x.sh',
    args: partial.args || [],
    kind: partial.kind || 'action',
    group: partial.group || 'main',
    variant: partial.variant || 'default',
    hint: partial.hint || '',
    ...partial,
  }
}

const loc = { protocol: 'https:', hostname: '192.168.0.4' }

describe('portTileHref', () => {
  test('uses SPA host + port (not localhost)', () => {
    expect(portTileHref(4201, loc)).toBe('https://192.168.0.4:4201/')
  })
})

describe('findActionForPort / isPortStartAction', () => {
  test('matches hyphenated port id == action id', () => {
    const actions = [
      action({
        id: 'api-noflags',
        label: 'QA API dev-flags OFF (VPN 4201)',
        group: 'qa',
        script: 'scripts/qa-start-api-noflags.sh',
      }),
    ]
    expect(findActionForPort(actions, 'api-noflags')?.id).toBe('api-noflags')
    expect(findActionForPort(undefined, 'api-noflags')).toBeNull()
    expect(findActionForPort(actions, 'missing')).toBeNull()
  })

  test('stop actions are not startable from a port tile', () => {
    expect(isPortStartAction(action({ id: 'stop', type: 'stop' }))).toBe(false)
    expect(
      isPortStartAction(
        action({ id: 'api-noflags', type: 'script', group: 'qa' }),
      ),
    ).toBe(true)
  })
})

describe('decidePortTileClick (okeroo-shaped config)', () => {
  const actions = [
    action({
      id: 'api-noflags',
      label: 'QA API dev-flags OFF (VPN 4201)',
      group: 'qa',
      script: 'scripts/qa-start-api-noflags.sh',
    }),
    action({
      id: 'seed-qa',
      label: 'Seed QA',
      group: 'qa',
      script: 'pnpm --filter @okeroo/api seed:qa',
    }),
  ]

  test('down + matching action → run (does not navigate away)', () => {
    const d = decidePortTileClick({
      port: {
        id: 'api-noflags',
        port: 4201,
        label: 'API (dev flags off)',
        up: false,
      },
      actions,
      location: loc,
    })
    expect(d.kind).toBe('run')
    if (d.kind === 'run') expect(d.action.id).toBe('api-noflags')
  })

  test('up → open URL on SPA hostname', () => {
    const d = decidePortTileClick({
      port: {
        id: 'api-noflags',
        port: 4201,
        label: 'API (dev flags off)',
        up: true,
      },
      actions,
      location: loc,
    })
    expect(d).toEqual({
      kind: 'open',
      href: 'https://192.168.0.4:4201/',
    })
  })

  test('down + no matching action → toast (not throw)', () => {
    const d = decidePortTileClick({
      port: { id: 'orphan', port: 9999, label: 'Orphan', up: false },
      actions,
      location: loc,
    })
    expect(d.kind).toBe('toast')
    if (d.kind === 'toast') expect(d.message).toContain('9999')
  })

  test('missing actions array does not throw', () => {
    const d = decidePortTileClick({
      port: { id: 'api', port: 4200, up: false },
      actions: null,
      location: loc,
    })
    expect(d.kind).toBe('toast')
  })

  test('port without matching action id is fine when up', () => {
    const d = decidePortTileClick({
      port: { id: 'web', port: 3200, up: true },
      actions: [],
      location: loc,
    })
    expect(d).toEqual({ kind: 'open', href: 'https://192.168.0.4:3200/' })
  })
})

describe('Unity webgl / mcp-bridge port tiles', () => {
  const unityActions = [
    action({
      id: 'webgl',
      label: 'WebGL live view',
      script: 'scripts/unity/live-webgl.sh',
    }),
    action({
      id: 'editor',
      label: 'Editor + MCP bridge',
      script: 'scripts/unity/start-editor-bridge.sh',
    }),
  ]

  test('webgl port id maps to webgl action when down', () => {
    const d = decidePortTileClick({
      port: { id: 'webgl', port: 8410, label: 'WebGL', up: false },
      actions: unityActions,
      location: loc,
    })
    expect(d.kind).toBe('run')
    if (d.kind === 'run') expect(d.action.id).toBe('webgl')
  })

  test('webgl alias finds webgl_serve', () => {
    expect(
      findActionForPort(
        [action({ id: 'webgl_serve', label: 'Serve', script: 'x' })],
        'webgl',
      )?.id,
    ).toBe('webgl_serve')
  })

  test('mcp-bridge up does not open HTTP URL', () => {
    const d = decidePortTileClick({
      port: { id: 'mcp-bridge', port: 6400, up: true },
      actions: unityActions,
      location: loc,
    })
    expect(d.kind).toBe('toast')
    if (d.kind === 'toast') expect(d.message).toContain('TCP')
  })

  test('mcp-bridge down starts editor action', () => {
    const d = decidePortTileClick({
      port: { id: 'mcp-bridge', port: 6400, up: false },
      actions: unityActions,
      location: loc,
    })
    expect(d.kind).toBe('run')
    if (d.kind === 'run') expect(d.action.id).toBe('editor')
  })
})
