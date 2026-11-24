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

export function findActionForPort(
  actions: ActionDef[] | undefined | null,
  portId: string,
): ActionDef | null {
  if (!actions || !portId) return null
  const a = actions.find((x) => x && x.id === portId)
  return a || null
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
export function decidePortTileClick(opts: {
  port: Pick<PortStatus, 'id' | 'port' | 'up' | 'listening' | 'label'>
  actions: ActionDef[] | undefined | null
  location: Pick<Location, 'protocol' | 'hostname'>
}): PortTileDecision {
  const up = Boolean(opts.port.up ?? opts.port.listening)
  const action = findActionForPort(opts.actions, opts.port.id)
  const label = opts.port.label || opts.port.id || `:${opts.port.port}`

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
