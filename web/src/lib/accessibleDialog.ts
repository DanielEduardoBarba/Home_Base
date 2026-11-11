/**
 * Shared accessible-dialog behavior for Home Base overlays.
 * Focus moves into the dialog, Tab is trapped, Escape closes,
 * role=dialog + aria-modal when open, focus returns to the opener,
 * and destructive/confirm dialogs focus Cancel.
 */

export const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ')

export type DialogFocusMode = 'cancel' | 'first' | 'panel'

export function resolveInitialFocusMode(opts: {
  confirm?: boolean
  initialFocus?: DialogFocusMode
}): DialogFocusMode {
  if (opts.initialFocus) return opts.initialFocus
  return opts.confirm ? 'cancel' : 'first'
}

export function nextTabIndex(current: number, count: number, shiftKey: boolean): number {
  if (count <= 0) return 0
  if (shiftKey) return current <= 0 ? count - 1 : current - 1
  return current >= count - 1 ? 0 : current + 1
}

export function isFocusableElement(el: Element): el is HTMLElement {
  if (!(el instanceof HTMLElement)) return false
  if (el.getAttribute('tabindex') === '-1' || el.getAttribute('aria-hidden') === 'true') {
    return false
  }
  if (el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true') return false
  const style = typeof window !== 'undefined' ? window.getComputedStyle(el) : null
  if (style && (style.visibility === 'hidden' || style.display === 'none')) return false
  return true
}

export function focusableElements(root: ParentNode): HTMLElement[] {
  return Array.from(root.querySelectorAll(FOCUSABLE_SELECTOR)).filter(isFocusableElement)
}

export function findCancelElement(root: ParentNode): HTMLElement | null {
  const marked = root.querySelector('[data-dialog-cancel]')
  if (marked && isFocusableElement(marked)) return marked
  const buttons = focusableElements(root).filter((el) => el.tagName === 'BUTTON')
  const byLabel = buttons.find((el) => {
    const label = (el.getAttribute('aria-label') || el.textContent || '').trim().toLowerCase()
    return label === 'cancel' || label === 'close'
  })
  return byLabel || null
}

export function initialFocusTarget(
  root: HTMLElement,
  mode: DialogFocusMode,
): HTMLElement {
  if (mode === 'panel') {
    if (root.tabIndex < 0) root.tabIndex = -1
    return root
  }
  if (mode === 'cancel') {
    const cancel = findCancelElement(root)
    if (cancel) return cancel
  } else {
    const marked = root.querySelector('[data-dialog-initial]')
    if (marked && isFocusableElement(marked)) return marked
  }
  const list = focusableElements(root)
  if (mode === 'cancel') {
    const cancel = findCancelElement(root)
    if (cancel) return cancel
  }
  return list[0] || root
}

/** Trap Tab inside root. Returns true if the event was handled. */
export function trapTabKey(event: KeyboardEvent, root: HTMLElement): boolean {
  if (event.key !== 'Tab') return false
  const list = focusableElements(root)
  if (list.length === 0) {
    event.preventDefault()
    if (root.tabIndex < 0) root.tabIndex = -1
    root.focus()
    return true
  }
  const active = document.activeElement
  const current = active instanceof HTMLElement ? list.indexOf(active) : -1
  const next = nextTabIndex(current < 0 ? (event.shiftKey ? 0 : -1) : current, list.length, event.shiftKey)
  const target = list[next]
  if (!target) return false
  event.preventDefault()
  target.focus()
  return true
}

export type ClosedDialogProps = {
  inert: true
  'aria-hidden': true
}

export type OpenDialogProps = {
  role: 'dialog'
  'aria-modal': true
  'aria-labelledby'?: string
  'aria-label'?: string
}

export function dialogDomProps(opts: {
  open: boolean
  labelledBy?: string
  label?: string
}): ClosedDialogProps | OpenDialogProps {
  if (!opts.open) {
    return { inert: true, 'aria-hidden': true }
  }
  const open: OpenDialogProps = { role: 'dialog', 'aria-modal': true }
  if (opts.labelledBy) open['aria-labelledby'] = opts.labelledBy
  else if (opts.label) open['aria-label'] = opts.label
  return open
}
