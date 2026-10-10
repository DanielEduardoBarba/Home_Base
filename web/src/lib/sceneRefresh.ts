import { useEffect, useRef } from 'react'

type RefreshFn = () => void | Promise<void>

/** All active tab/scene refresh handlers (Work can host scene + dock Chat). */
const sceneHandlers = new Set<RefreshFn>()

/** Register the active tab's reload handler (pull-to-refresh calls these). */
export function useSceneRefresh(fn: RefreshFn) {
  const fnRef = useRef(fn)
  fnRef.current = fn
  useEffect(() => {
    const wrapper: RefreshFn = () => fnRef.current()
    sceneHandlers.add(wrapper)
    return () => {
      sceneHandlers.delete(wrapper)
    }
  }, [])
}

export async function runSceneRefresh(): Promise<void> {
  await Promise.all([...sceneHandlers].map((h) => h()))
}
