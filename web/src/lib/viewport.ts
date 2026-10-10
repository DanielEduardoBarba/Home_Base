/**
 * Keep --hb-app-height locked to the visible browser window.
 * Mobile Safari/Chrome URL-bar show/hide and soft-keyboard otherwise leave a
 * gap under the bottom nav, clip the shell, or shove composers off-screen.
 *
 * Important: Chrome URL-bar collapse must NOT be treated as a keyboard —
 * that was leaving a gap under View / the app shell on mobile.
 */
export function installViewportHeight(): () => void {
  const root = document.documentElement

  const isEditableFocus = (): boolean => {
    const a = document.activeElement
    if (!a || !(a instanceof HTMLElement)) return false
    const tag = a.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
    if (a.isContentEditable) return true
    return !!a.closest('[contenteditable="true"], input, textarea, select')
  }

  const isFullscreenLike = (): boolean => {
    try {
      if (document.fullscreenElement) return true
      const w = window as Window & { navigator?: Navigator & { standalone?: boolean } }
      if (w.navigator?.standalone) return true
      if (window.matchMedia('(display-mode: standalone)').matches) return true
      if (window.matchMedia('(display-mode: fullscreen)').matches) return true
      if (window.matchMedia('(display-mode: minimal-ui)').matches) return true
    } catch {
      /* ignore */
    }
    return false
  }

  const sync = () => {
    const vv = window.visualViewport
    let h = window.innerHeight
    let top = 0
    let keyboardOpen = false
    const fullscreen = isFullscreenLike()

    if (vv) {
      const layoutH = Math.max(
        window.innerHeight,
        document.documentElement.clientHeight || 0,
      )
      // Soft keyboard only when an editable is focused AND the visual viewport
      // shrinks meaningfully. URL-bar show/hide alone must not flip this.
      const shrunk = vv.height < layoutH - 100
      keyboardOpen = isEditableFocus() && (shrunk || vv.offsetTop > 2)

      if (keyboardOpen) {
        // Pin shell to the visual viewport — not layout viewport + nav clearance.
        h = Math.max(1, Math.round(vv.height))
        top = Math.max(0, Math.round(vv.offsetTop))
      } else {
        // Prefer the larger of layout vs visual so fullscreen Chrome / PWA
        // fills to the bottom (no gap under #root that looks like a browser footer).
        const visual = Math.round(vv.height + Math.max(0, vv.offsetTop))
        h = Math.max(layoutH, visual, Math.round(vv.height))
        // Standalone / fullscreen: stretch to the layout window. Nav CSS paints
        // a tall skirt below the dock for any remaining sub-pixel gap.
        if (fullscreen) {
          h = Math.max(h, window.innerHeight, layoutH)
        }
        top = 0
      }
    } else {
      h = Math.max(
        window.innerHeight,
        document.documentElement.clientHeight || 0,
      )
    }

    if (h < 1) h = window.innerHeight
    root.style.setProperty('--hb-app-height', `${h}px`)
    root.style.setProperty('--hb-vv-top', `${top}px`)
    root.toggleAttribute('data-hb-keyboard', keyboardOpen)
    root.toggleAttribute('data-hb-fullscreen', fullscreen)
    // Cancel iOS Safari's habit of scrolling the layout viewport under a focused input.
    if (keyboardOpen && (window.scrollY !== 0 || window.scrollX !== 0)) {
      window.scrollTo(0, 0)
    }
  }

  sync()
  window.addEventListener('resize', sync)
  window.addEventListener('orientationchange', sync)
  window.addEventListener('pageshow', sync)
  window.addEventListener('focusin', sync)
  window.addEventListener('focusout', sync)
  window.addEventListener('visibilitychange', sync)
  document.addEventListener('fullscreenchange', sync)
  const vv = window.visualViewport
  vv?.addEventListener('resize', sync)
  vv?.addEventListener('scroll', sync)

  return () => {
    window.removeEventListener('resize', sync)
    window.removeEventListener('orientationchange', sync)
    window.removeEventListener('pageshow', sync)
    window.removeEventListener('focusin', sync)
    window.removeEventListener('focusout', sync)
    window.removeEventListener('visibilitychange', sync)
    document.removeEventListener('fullscreenchange', sync)
    vv?.removeEventListener('resize', sync)
    vv?.removeEventListener('scroll', sync)
  }
}
