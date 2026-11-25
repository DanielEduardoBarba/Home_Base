import type { ActionDef, PortStatus } from './types'

export type PortTileDecision =
  | { kind: 'run'; action: ActionDef }
  | { kind: 'open'; href: string }
  | { kind: 'toast'; message: string }

/** Actions that are safe to start from a port tile (same id as the port). */
export function isPortStartAction(action: ActionDef | undefined | null): boolean {
  if (!action) return false
  if (action.type === 'stop') return false
  return (
    action.type === 'script' ||
    action.type === 'compose' ||
    action.type === 'restart' ||
    action.kind === 'run' ||
    action.kind === 'expo' ||
    action.kind === 'action'
  )
}

/** Port id → action id aliases (Unity webgl port vs live/serve action names). */
const PORT_ACTION_ALIASES: Record<string, string[]> = {
  webgl: ['webgl', 'webgl_live', 'webgl_serve'],
  'mcp-bridge': ['editor', 'mcp-bridge'],
}

export function findActionForPort(
  actions: ActionDef[] | undefined | null,
  portId: string,
): ActionDef | null {
  if (!actions || !portId) return null
  const direct = actions.find((x) => x && x.id === portId)
  if (direct) return direct
  for (const alias of PORT_ACTION_ALIASES[portId] || []) {
    const a = actions.find((x) => x && x.id === alias)
    if (a) return a
  }
  return null
}

export function portTileHref(
  port: number,
  loc: Pick<Location, 'protocol' | 'hostname'>,
): string {
  return `${loc.protocol}//${loc.hostname}:${port}/`
}

/**
 * Decide what tapping an Apps port tile should do.
 * Never same-tab navigate — callers open via window.open + pin-lock suppress.
 */
/** Port tile rows may lack up/label before portsStatus arrives. */
export type PortTilePort = Pick<PortStatus, 'id' | 'port'> &
  Partial<Pick<PortStatus, 'up' | 'listening' | 'label'>>

export function decidePortTileClick(opts: {
  port: PortTilePort
  actions: ActionDef[] | undefined | null
  location: Pick<Location, 'protocol' | 'hostname'>
}): PortTileDecision {
  const up = Boolean(opts.port.up ?? opts.port.listening)
  const action = findActionForPort(opts.actions, opts.port.id)
  const label = opts.port.label || opts.port.id || `:${opts.port.port}`

  // MCP bridge is TCP, not HTTP — never open http://host:6400/
  if (opts.port.id === 'mcp-bridge') {
    if (!up && isPortStartAction(action)) {
      return { kind: 'run', action: action! }
    }
    return {
      kind: 'toast',
      message: up
        ? `MCP bridge :${opts.port.port} is listening (TCP — not a browser URL)`
        : `${label} (:${opts.port.port}) is not listening`,
    }
  }

  if (!up && isPortStartAction(action)) {
    return { kind: 'run', action: action! }
  }

  if (up) {
    return { kind: 'open', href: portTileHref(opts.port.port, opts.location) }
  }

  if (action && !isPortStartAction(action)) {
    return {
      kind: 'toast',
      message: `${label} (:${opts.port.port}) is not listening`,
    }
  }

  return {
    kind: 'toast',
    message: action
      ? `${label} (:${opts.port.port}) is not listening`
      : `${label} (:${opts.port.port}) is not listening (no matching start action)`,
  }
}

/** Open without navigating the SPA tab away (critical on iOS PWA). */
export function openPortInNewTab(href: string): boolean {
  try {
    const w = window.open(href, '_blank', 'noopener,noreferrer')
    return Boolean(w)
  } catch {
    return false
  }
}
