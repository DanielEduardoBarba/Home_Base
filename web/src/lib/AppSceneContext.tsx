'use client'

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import type { AppArea, Tab } from './types'
import {
  migrateLegacyWorkTab,
  readLastArea,
  readLastProjectId,
  readLastTab,
  readWorkPlace,
  writeLastArea,
  writeLastProjectId,
  writeLastTab,
  type WorkItem,
} from './uiPrefs'
import {
  readAppSceneSnapshot,
  writeAppSceneSnapshot,
  type AppSceneSnapshot,
} from './appSceneSnapshot'

type AppSceneContextValue = {
  area: AppArea
  tab: Tab
  workItem: WorkItem
  selectedId: string
  routesReady: boolean
  bootstrapped: boolean
  setArea: (area: AppArea) => void
  setTab: (tab: Tab) => void
  setWorkItem: (item: WorkItem) => void
  setSelectedId: (id: string) => void
  setRoutesReady: (ready: boolean) => void
  setBootstrapped: (done: boolean) => void
  applyScene: (patch: Partial<AppSceneSnapshot>) => void
}

const AppSceneContext = createContext<AppSceneContextValue | null>(null)

function loadInitialScene(): AppSceneSnapshot {
  const snap = readAppSceneSnapshot()
  if (snap) return snap
  const selectedId = readLastProjectId()
  const tab = migrateLegacyWorkTab(readLastTab('work'), selectedId)
  return {
    area: readLastArea('home'),
    tab,
    workItem: selectedId ? readWorkPlace(selectedId).item : 'apps',
    selectedId,
  }
}

/**
 * Holds nav/scene state above PinLock so AuthedApp can remount (fragment ↔ frozen
 * wrapper) without resetting to Work / Home Base / Shell defaults.
 */
export function AppSceneProvider({ children }: { children: ReactNode }) {
  const initial = useMemo(() => loadInitialScene(), [])
  const [area, setAreaState] = useState<AppArea>(initial.area)
  const [tab, setTabState] = useState<Tab>(initial.tab)
  const [workItem, setWorkItemState] = useState<WorkItem>(initial.workItem)
  const [selectedId, setSelectedIdState] = useState(initial.selectedId)
  const [routesReady, setRoutesReady] = useState(false)
  const [bootstrapped, setBootstrapped] = useState(false)

  const setArea = useCallback((next: AppArea) => {
    setAreaState(next)
    writeLastArea(next)
  }, [])

  const setTab = useCallback((next: Tab) => {
    setTabState(next)
    writeLastTab(next)
  }, [])

  const setWorkItem = useCallback((next: WorkItem) => {
    setWorkItemState(next)
  }, [])

  const setSelectedId = useCallback((id: string) => {
    setSelectedIdState(id)
    if (id) writeLastProjectId(id)
  }, [])

  const applyScene = useCallback((patch: Partial<AppSceneSnapshot>) => {
    if (patch.area !== undefined) {
      setAreaState(patch.area)
      writeLastArea(patch.area)
    }
    if (patch.tab !== undefined) {
      setTabState(patch.tab)
      writeLastTab(patch.tab)
    }
    if (patch.workItem !== undefined) setWorkItemState(patch.workItem)
    if (patch.selectedId !== undefined) {
      setSelectedIdState(patch.selectedId)
      if (patch.selectedId) writeLastProjectId(patch.selectedId)
    }
  }, [])

  useEffect(() => {
    const snap: AppSceneSnapshot = { area, tab, workItem, selectedId }
    writeAppSceneSnapshot(snap)
  }, [area, tab, workItem, selectedId])

  const value = useMemo<AppSceneContextValue>(
    () => ({
      area,
      tab,
      workItem,
      selectedId,
      routesReady,
      bootstrapped,
      setArea,
      setTab,
      setWorkItem,
      setSelectedId,
      setRoutesReady,
      setBootstrapped,
      applyScene,
    }),
    [
      area,
      tab,
      workItem,
      selectedId,
      routesReady,
      bootstrapped,
      setArea,
      setTab,
      setWorkItem,
      setSelectedId,
      applyScene,
    ],
  )

  return <AppSceneContext.Provider value={value}>{children}</AppSceneContext.Provider>
}

export function useAppScene(): AppSceneContextValue {
  const ctx = useContext(AppSceneContext)
  if (!ctx) throw new Error('useAppScene requires AppSceneProvider')
  return ctx
}
