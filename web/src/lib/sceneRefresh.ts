import { useEffect, useRef } from 'react'

type RefreshFn = () => void | Promise<void>

let sceneRefresh: RefreshFn | null = null

/** Register the active tab's reload handler (pull-to-refresh calls this). */
export function useSceneRefresh(fn: RefreshFn) {
  const fnRef = useRef(fn)
  fnRef.current = fn
  useEffect(() => {
    const wrapper: RefreshFn = () => fnRef.current()
    sceneRefresh = wrapper
    return () => {
      if (sceneRefresh === wrapper) sceneRefresh = null
    }
  }, [])
}

export async function runSceneRefresh(): Promise<void> {
  if (sceneRefresh) await sceneRefresh()
}
