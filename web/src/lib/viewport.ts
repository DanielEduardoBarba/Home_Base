/**
 * Keep --hb-app-height locked to the visible browser window.
 * Mobile Safari/Chrome URL-bar show/hide and dvh quirks otherwise leave a
 * gap under the bottom nav or clip the shell short of the screen.
 */
export function installViewportHeight(): () => void {
  const root = document.documentElement

  const sync = () => {
    const vv = window.visualViewport
    // Layout viewport height — matches the area position:fixed fills.
    // When the soft keyboard opens, visualViewport shrinks; use that so
    // composers stay in view. Otherwise prefer innerHeight (stable edge).
    let h = window.innerHeight
    if (vv) {
      const keyboardOpen = vv.height < window.innerHeight - 40
      if (keyboardOpen) {
        h = Math.round(vv.height + vv.offsetTop)
      } else {
        h = Math.round(Math.max(window.innerHeight, vv.height))
      }
    }
    if (h < 1) h = window.innerHeight
    root.style.setProperty('--hb-app-height', `${h}px`)
  }

  sync()
  window.addEventListener('resize', sync)
  window.addEventListener('orientationchange', sync)
  window.addEventListener('pageshow', sync)
  const vv = window.visualViewport
  vv?.addEventListener('resize', sync)
  vv?.addEventListener('scroll', sync)

  return () => {
    window.removeEventListener('resize', sync)
    window.removeEventListener('orientationchange', sync)
    window.removeEventListener('pageshow', sync)
    vv?.removeEventListener('resize', sync)
    vv?.removeEventListener('scroll', sync)
  }
}
