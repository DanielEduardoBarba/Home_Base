import { useEffect, useRef } from 'react'

/** True when the document is visible (or APIs unavailable). */
export function pageIsVisible(): boolean {
  if (typeof document === 'undefined') return true
  return document.visibilityState !== 'hidden'
}

/**
 * Run `tick` on an interval only while the tab is visible.
 * Also fires once on mount and when the page becomes visible again.
 */
export function useVisibleInterval(tick: () => void, ms: number, enabled = true) {
  const tickRef = useRef(tick)
  tickRef.current = tick

  useEffect(() => {
    if (!enabled) return
    const run = () => {
      if (pageIsVisible()) tickRef.current()
    }
    run()
    const t = window.setInterval(run, ms)
    const onVis = () => {
      if (pageIsVisible()) tickRef.current()
    }
    document.addEventListener('visibilitychange', onVis)
    return () => {
      window.clearInterval(t)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [ms, enabled])
}
