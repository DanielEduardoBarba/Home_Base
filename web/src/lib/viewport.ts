/**
 * Keep --hb-app-height locked to the visible browser window.
 * Mobile Safari/Chrome URL-bar show/hide and soft-keyboard otherwise leave a
 * gap under the bottom nav, clip the shell, or shove composers off-screen.
 */
export function installViewportHeight(): () => void {
  const root = document.documentElement

  const sync = () => {
    const vv = window.visualViewport
    let h = window.innerHeight
    let top = 0
    let keyboardOpen = false

    if (vv) {
      // Soft keyboard: visual viewport shrinks (and may offset). Prefer vv so
      // the fixed app shell tracks the area above the keyboard.
      const layoutH = window.innerHeight
      keyboardOpen = vv.height < layoutH - 40 || vv.offsetTop > 1
      if (keyboardOpen) {
        // Pin shell to the visual viewport — not layout viewport + nav clearance.
        h = Math.max(1, Math.round(vv.height))
        top = Math.max(0, Math.round(vv.offsetTop))
      } else {
        h = Math.round(Math.max(layoutH, vv.height))
        top = 0
      }
    }

    if (h < 1) h = window.innerHeight
    root.style.setProperty('--hb-app-height', `${h}px`)
    root.style.setProperty('--hb-vv-top', `${top}px`)
    root.toggleAttribute('data-hb-keyboard', keyboardOpen)
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
  const vv = window.visualViewport
  vv?.addEventListener('resize', sync)
  vv?.addEventListener('scroll', sync)

  return () => {
    window.removeEventListener('resize', sync)
    window.removeEventListener('orientationchange', sync)
    window.removeEventListener('pageshow', sync)
    window.removeEventListener('focusin', sync)
    window.removeEventListener('focusout', sync)
    vv?.removeEventListener('resize', sync)
    vv?.removeEventListener('scroll', sync)
  }
}
