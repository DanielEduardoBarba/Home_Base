'use client'

import dynamic from 'next/dynamic'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { AddProjectWizard, type AddProjectResult } from './components/AddProjectWizard'
import { AppsTab } from './components/AppsTab'
import { HomeAccessTab } from './components/HomeAccessTab'
import { HomeDashboard } from './components/HomeDashboard'
import { HomeVisionTab } from './components/HomeVisionTab'
import { IconBtn } from './components/IconBtn'
import { LegalConnectionError, LegalGate } from './components/LegalGate'
import { Login } from './components/Login'
import { NotificationCenter } from './components/NotificationCenter'
import { ProjectSelect } from './components/ProjectSelect'
import { PullToRefresh } from './components/PullToRefresh'
import { StatusChip } from './components/StatusChip'
import { ToastStack } from './components/ToastStack'
import { api } from './lib/api'
import { clearSession, hasSession, isSessionValid, migrateLegacyLocalSession, registerSessionPoller, setSession, watchSessionExpiry } from './lib/auth'
import { LEGAL_DOC_VERSION } from './lib/legalDocs'
import type { PresentRequest } from './lib/chatTypes'
import { installClientLog } from './lib/clientLog'
import { confirmNavigation } from './lib/navGuard'
import { parseAppPath, serializeAppPath } from './lib/appRoutes'
import { NotifyProvider, useNotify } from './lib/NotifyContext'
import { runSceneRefresh } from './lib/sceneRefresh'
import { applyMobileSafeTop } from './lib/theme'
import { type AppArea, type Project, type Tab } from './lib/types'
import {
  migrateLegacyWorkTab,
  readLastArea,
  readShowAccess,
  readLastProjectId,
  readLastTab,
  readWorkPlace,
  writeLastArea,
  writeLastProjectId,
  writeLastTab,
  writeWorkPlace,
  type WorkItem,
} from './lib/uiPrefs'
import { writeDockOpen } from './components/ChatPanel'
import { useVisibleInterval } from './lib/visibility'
import { logActivity, presenceHeartbeat } from './lib/activity'

const tabFallback = () => (
  <div className="h-full flex items-center justify-center text-mute text-sm">Loading…</div>
)

const WorkTab = dynamic(() => import('./components/WorkTab').then((m) => m.WorkTab), {
  ssr: false,
  loading: tabFallback,
})
const CursorTab = dynamic(() => import('./components/CursorTab').then((m) => m.CursorTab), {
  ssr: false,
  loading: tabFallback,
})
const ShellTab = dynamic(() => import('./components/ShellTab').then((m) => m.ShellTab), {
  ssr: false,
  loading: tabFallback,
})
const FilesTab = dynamic(() => import('./components/FilesTab').then((m) => m.FilesTab), {
  ssr: false,
  loading: tabFallback,
})
const ViewTab = dynamic(() => import('./components/ViewTab').then((m) => m.ViewTab), {
  ssr: false,
  loading: tabFallback,
})
const LogsTab = dynamic(() => import('./components/LogsTab').then((m) => m.LogsTab), {
  ssr: false,
  loading: tabFallback,
})
const SettingsTab = dynamic(() => import('./components/SettingsTab').then((m) => m.SettingsTab), {
  ssr: false,
  loading: tabFallback,
})
const HomeAgentTab = dynamic(
  () => import('./components/HomeAgentTab').then((m) => m.HomeAgentTab),
  { ssr: false, loading: tabFallback },
)
const PinLock = dynamic(() => import('./components/PinLock').then((m) => m.PinLock), {
  ssr: false,
})
const OnboardingFlow = dynamic(
  () => import('./components/OnboardingFlow').then((m) => m.OnboardingFlow),
  { ssr: false },
)

type NavId = 'apps' | 'shell' | 'files' | 'chat' | 'git' | 'view' | 'logs'

/** Bottom dock: the workspace scenes, one tap each (Alerts = top-bar bell; Settings = Home card). */
const NAV_MAIN: { id: NavId; label: string }[] = [
  { id: 'apps', label: 'Apps' },
  { id: 'shell', label: 'Shell' },
  { id: 'files', label: 'Files' },
  { id: 'chat', label: 'Chat' },
]

/** Behind the dock's More slot. */
const NAV_MORE: { id: NavId; label: string }[] = [
  { id: 'git', label: 'Git' },
  { id: 'view', label: 'View' },
  { id: 'logs', label: 'Logs' },
]

function activeNavId(tab: Tab, workItem: WorkItem): NavId | null {
  if (tab === 'work') return workItem
  if (tab === 'cursor') return 'chat'
  if (tab === 'apps' || tab === 'shell' || tab === 'files' || tab === 'view' || tab === 'logs') return tab
  return null
}

/** Home Access is advanced / off-by-default. */
function coerceArea(area: AppArea): AppArea {
  if (area === 'access' && !readShowAccess()) return 'home'
  return area
}

function TabIcon({ id }: { id: NavId | 'more' | 'home' }) {
  const common = { className: 'hb-nav-icon', viewBox: '0 0 24 24', 'aria-hidden': true as const }
  switch (id) {
    case 'home':
      return (
        <svg {...common}>
          <path d="M4 11.5 12 5l8 6.5" />
          <path d="M6.5 10v9.5h11V10" />
          <path d="M10 19.5v-5h4v5" />
        </svg>
      )
    case 'git':
      return (
        <svg {...common}>
          <circle cx="7" cy="6" r="2.25" />
          <circle cx="7" cy="18" r="2.25" />
          <circle cx="17" cy="8" r="2.25" />
          <path d="M7 8.25v7.5" />
          <path d="M17 10.25c0 3.5-4 3.5-8.2 6.4" />
        </svg>
      )
    case 'more':
      return (
        <svg {...common}>
          <circle cx="5.5" cy="12" r="1.4" />
          <circle cx="12" cy="12" r="1.4" />
          <circle cx="18.5" cy="12" r="1.4" />
        </svg>
      )
    case 'chat':
      return (
        <svg {...common}>
          <path d="M5 5.5h14a1.5 1.5 0 0 1 1.5 1.5v8.5A1.5 1.5 0 0 1 19 17h-7l-4.5 3.5V17H5a1.5 1.5 0 0 1-1.5-1.5V7A1.5 1.5 0 0 1 5 5.5z" />
          <path d="M8 10h8M8 13h5" />
        </svg>
      )
    case 'apps':
      return (
        <svg {...common}>
          <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
          <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
          <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
          <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
        </svg>
      )
    case 'shell':
      return (
        <svg {...common}>
          <path d="M4.5 7.5 9 12l-4.5 4.5" />
          <path d="M12 17.5h7.5" />
        </svg>
      )
    case 'files':
      return (
        <svg {...common}>
          <path d="M4.5 6.5h5l2 2h8v10.5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 3.5 19V8a1.5 1.5 0 0 1 1-1.5z" />
        </svg>
      )
    case 'view':
      return (
        <svg {...common}>
          <rect x="3.5" y="5" width="17" height="12" rx="1.5" />
          <circle cx="12" cy="11" r="2.75" />
          <path d="M8 19.5h8" />
        </svg>
      )
    case 'logs':
      return (
        <svg {...common}>
          <path d="M5 7h14M5 12h10M5 17h12" />
        </svg>
      )
    default:
      return null
  }
}

type HostLink = 'live' | 'reconnecting' | 'unreachable'

function NotFoundView({ path, onHome }: { path: string; onHome: () => void }) {
  return (
    <div className="hb-page min-h-[100dvh] flex flex-col items-center justify-center gap-4 text-center px-6">
      <p className="hb-label">404</p>
      <h1 className="text-xl font-semibold text-ink">This page isn&apos;t in Home Base</h1>
      <p className="text-sm text-mute max-w-md font-mono break-all">{path}</p>
      <button type="button" className="hb-btn hb-btn-primary" onClick={onHome}>
        Back to Home
      </button>
    </div>
  )
}

function AuthedApp() {

  const [area, setArea] = useState<AppArea>('home')
  const [tab, setTab] = useState<Tab>('work')
  const [notFoundPath, setNotFoundPath] = useState<string | null>(null)
  const [routesReady, setRoutesReady] = useState(false)
  const applyingHistory = useRef(false)
  const [projects, setProjects] = useState<Project[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [workItem, setWorkItem] = useState<WorkItem>('apps')
  const [attachSessionIds, setAttachSessionIds] = useState<string[] | null>(null)
  const [workPresent, setWorkPresent] = useState<PresentRequest | null>(null)
  /** Bumps so Work re-applies even if the same scene is requested twice. */
  const [workPresentKey, setWorkPresentKey] = useState(0)
  const workPresentSeq = useRef(0)
  const [loadError, setLoadError] = useState('')
  const [version, setVersion] = useState('')
  const [backup, setBackup] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [hostLink, setHostLink] = useState<HostLink>('reconnecting')
  const [cursorConfigured, setCursorConfigured] = useState(false)
  const [hostLabel, setHostLabel] = useState('host')
  const [vpnActive, setVpnActive] = useState<boolean | null>(null)
  const [vpnHostHint, setVpnHostHint] = useState<string | null>(null)
  const failStreak = useRef(0)
  const { unread, inboxOpen, toggleInbox, closeInbox, unlockAudio } = useNotify()
  const [viewVisited, setViewVisited] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const [showOnboarding, setShowOnboarding] = useState(false)
  const [onboardingReady, setOnboardingReady] = useState(false)

  useEffect(() => {
    const pid = readLastProjectId()
    setHostLabel(location.hostname || 'host')
    const savedTab = migrateLegacyWorkTab(readLastTab('work'), pid)
    if (savedTab !== readLastTab('work')) writeLastTab(savedTab)
    const savedItem = pid ? readWorkPlace(pid).item : 'apps'
    const landed = (window as Window & { __HB_PATH?: string }).__HB_PATH || window.location.pathname
    const parsed = parseAppPath(landed)
    if (parsed.kind === 'notfound') {
      setNotFoundPath(parsed.path)
      setSelectedId(pid)
      setRoutesReady(true)
      return
    }
    const path = (landed.replace(/\/+$/, '') || '/')
    let loc = parsed.loc
    if (path === '/') {
      loc = {
        area: readLastArea('home'),
        tab: savedTab,
        workItem: savedItem,
      }
    } else if (path === '/work' || path === '/homework') {
      loc = { ...parsed.loc, workItem: savedItem }
    }
    loc = { ...loc, area: coerceArea(loc.area) }
    setArea(loc.area)
    setTab(loc.tab)
    setWorkItem(loc.workItem)
    writeLastArea(loc.area)
    writeLastTab(loc.tab)
    if (pid) writeWorkPlace(pid, { item: loc.workItem })
    setSelectedId(pid)
    const canonical = serializeAppPath(loc)
    if (window.location.pathname !== canonical) {
      window.history.replaceState({ hb: true }, '', canonical)
    }
    setRoutesReady(true)
  }, [])

  useEffect(() => {
    let cancelled = false
    void api
      .onboarding()
      .then((s) => {
        if (!cancelled) {
          setShowOnboarding(!s.complete)
          setOnboardingReady(true)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setShowOnboarding(false)
          setOnboardingReady(true)
        }
      })
    const onReplay = () => setShowOnboarding(true)
    window.addEventListener('hb-onboarding-replay', onReplay)
    return () => {
      cancelled = true
      window.removeEventListener('hb-onboarding-replay', onReplay)
    }
  }, [])

  const goArea = useCallback(async (next: AppArea) => {
    if (next === area && !notFoundPath) return
    if (!(await confirmNavigation())) return
    const target = coerceArea(next)
    setNotFoundPath(null)
    writeLastArea(target)
    setArea(target)
    setMoreOpen(false)
    closeInbox()
    logActivity('nav', `Area → ${target}`, { area: target })
    presenceHeartbeat({ area: target, tab })
  }, [area, closeInbox, notFoundPath, tab])

  useEffect(() => {
    if (tab === 'view') setViewVisited(true)
  }, [tab])

  useEffect(() => {
    setMoreOpen(false)
  }, [tab, workItem])

  const activeProject = projects.find((p) => p.id === selectedId) || projects[0]

  const goTab = useCallback(async (id: Tab) => {
    if (id === tab && !notFoundPath) return
    if (!(await confirmNavigation())) return
    setNotFoundPath(null)
    writeLastTab(id)
    setTab(id)
    logActivity('nav', `Tab → ${id}`, { tab: id, area })
    presenceHeartbeat({ area, tab: id })
  }, [area, notFoundPath, tab])

  useEffect(() => {
    if (!hasSession()) return
    presenceHeartbeat({ area, tab })
    const t = setInterval(() => {
      if (!hasSession()) return
      presenceHeartbeat({ area, tab })
    }, 20_000)
    const unregister = registerSessionPoller(() => clearInterval(t))
    return () => {
      unregister()
      clearInterval(t)
    }
  }, [area, tab])

  const chooseWorkItem = useCallback(
    async (item: WorkItem) => {
      if (item === workItem && tab === 'work' && area === 'homework' && !notFoundPath) return
      if (!(await confirmNavigation())) return
      setNotFoundPath(null)
      setWorkItem(item)
      if (selectedId) writeWorkPlace(selectedId, { item })
      setWorkPresent(null)
      setMoreOpen(false)
      writeLastTab('work')
      setTab('work')
      writeLastArea('homework')
      setArea('homework')
      logActivity('nav', `Tab → work`, { tab: 'work', area: 'homework' })
      presenceHeartbeat({ area: 'homework', tab: 'work' })
    },
    [area, notFoundPath, selectedId, tab, workItem],
  )

  const onNav = useCallback(
    (id: NavId) => {
      unlockAudio()
      closeInbox()
      setMoreOpen(false)
      if (id === 'view' || id === 'logs') {
        setWorkPresent(null)
        void goTab(id)
        return
      }
      void chooseWorkItem(id)
    },
    [chooseWorkItem, closeInbox, goTab, unlockAudio],
  )

  // Each project keeps its own Apps / Shell / Files / Chat pane.
  // When selectedId is first assigned (projects arriving after a deep link),
  // persist the landed work item instead of overwriting it with the default pane.
  const workItemRef = useRef(workItem)
  workItemRef.current = workItem
  const lastSelectedRef = useRef('')
  useEffect(() => {
    if (!routesReady || !selectedId) return
    if (lastSelectedRef.current === selectedId) return
    const prev = lastSelectedRef.current
    lastSelectedRef.current = selectedId
    if (!prev) {
      writeWorkPlace(selectedId, { item: workItemRef.current })
      return
    }
    setWorkItem(readWorkPlace(selectedId).item)
  }, [selectedId, routesReady])

  // Close the More tray on outside tap / Escape
  useEffect(() => {
    if (!moreOpen) return
    const onPointer = (e: PointerEvent) => {
      const t = e.target
      if (!(t instanceof Element)) return
      if (t.closest('.hb-nav')) return
      setMoreOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMoreOpen(false)
    }
    document.addEventListener('pointerdown', onPointer, true)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [moreOpen])

  useEffect(() => {
    if (!routesReady || notFoundPath) return
    if (applyingHistory.current) {
      applyingHistory.current = false
      return
    }
    const path = serializeAppPath({ area, tab, workItem })
    if (window.location.pathname === path) return
    window.history.pushState({ hb: true }, '', path)
  }, [area, tab, workItem, routesReady, notFoundPath])

  useEffect(() => {
    const onPop = () => {
      void (async () => {
        if (!(await confirmNavigation())) {
          const path = notFoundPath || serializeAppPath({ area, tab, workItem })
          window.history.pushState({ hb: true }, '', path)
          return
        }
        const parsed = parseAppPath(window.location.pathname)
        applyingHistory.current = true
        if (parsed.kind === 'notfound') {
          setNotFoundPath(parsed.path)
          return
        }
        setNotFoundPath(null)
        const nextArea = coerceArea(parsed.loc.area)
        setArea(nextArea)
        setTab(parsed.loc.tab)
        setWorkItem(parsed.loc.workItem)
        writeLastArea(nextArea)
        writeLastTab(parsed.loc.tab)
      })()
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [area, tab, workItem, notFoundPath])

  const selectProject = useCallback(async (id: string) => {
    if (id === selectedId) return
    if (!(await confirmNavigation())) return
    writeLastProjectId(id)
    setSelectedId(id)
  }, [selectedId])

  /** Chat → Work: show Apps / Shell / Files (and optionally a shell or file). */
  const presentInWork = useCallback(async (req: PresentRequest) => {
    if (!(await confirmNavigation())) return
    setNotFoundPath(null)
    workPresentSeq.current += 1
    setWorkPresent(req)
    setWorkPresentKey(workPresentSeq.current)
    setWorkItem(req.scene)
    if (selectedId) writeWorkPlace(selectedId, { item: req.scene })
    writeLastTab('work')
    setTab('work')
    writeLastArea('homework')
    setArea('homework')
  }, [selectedId])

  const refreshProjects = useCallback(async () => {
    try {
      const [data, health] = await Promise.all([
        api.projects(),
        api.health().catch(() => null),
      ])
      setProjects(data.projects)
      setLoadError('')
      failStreak.current = 0
      setHostLink('live')
      setHostLabel(location.hostname || 'host')
      if (health) {
        setCursorConfigured(!!health.cursorConfigured)
        if (health.version) setVersion(health.version)
        if (typeof health.backup === 'boolean') setBackup(health.backup)
        if (health.wireguard) {
          setVpnActive(
            health.wireguard.configured ? !!health.wireguard.active : null,
          )
          setVpnHostHint(health.wireguard.host || health.vpnHost || null)
        } else {
          setVpnActive(health.vpnHost ? true : null)
          setVpnHostHint(health.vpnHost || null)
        }
      }
      const preferred = selectedId || readLastProjectId()
      const found = data.projects.find((p) => p.id === preferred)
      if (found) {
        if (found.id !== selectedId) setSelectedId(found.id)
      } else {
        const next = data.projects[0]?.id || ''
        setSelectedId(next)
        if (next) writeLastProjectId(next)
      }
      if (!health) {
        try {
          const v = await api.version()
          setVersion(v.version || '')
          setBackup(!!v.backup)
        } catch {
          /* ignore */
        }
      }
    } catch (e) {
      const err = e as Error & { status?: number }
      const msg = err.message || String(e)
      setLoadError(msg)
      failStreak.current += 1
      setHostLink(failStreak.current >= 2 ? 'unreachable' : 'reconnecting')
      if (err.status === 401 || /unauthorized|401/i.test(msg)) {
        // clearSession already fired by api.ts for JWT codes; ensure UI resets
        if (isSessionValid()) clearSession('unauthorized')
        else
          window.dispatchEvent(
            new CustomEvent('hb-auth-lost', { detail: { reason: 'unauthorized' } }),
          )
      }
    }
  }, [selectedId])

  const onProjectAdded = useCallback(
    (result: AddProjectResult) => {
      setAddOpen(false)
      const item: WorkItem | null = result.openGit ? 'git' : result.askAi ? 'apps' : null
      if (item) writeWorkPlace(result.projectId, { item })
      if (result.askAi) writeDockOpen(true)
      writeLastProjectId(result.projectId)
      setSelectedId(result.projectId)
      if (item) {
        setWorkItem(item)
        writeLastTab('work')
        setTab('work')
      }
      void refreshProjects()
    },
    [refreshProjects],
  )

  const refresh = useCallback(async () => {
    setRefreshing(true)
    try {
      await Promise.all([refreshProjects(), runSceneRefresh()])
    } finally {
      setRefreshing(false)
    }
  }, [refreshProjects])

  // Pause project polls while the phone screen is off / tab backgrounded (VPN savings).
  useVisibleInterval(() => void refreshProjects(), 15_000)

  let body: ReactNode = null
  if (tab === 'apps') {
    body = (
      <div className="h-full overflow-y-auto">
        {loadError && <p className="hb-page !pb-0 pt-3 text-sm text-danger">{loadError}</p>}
        <AppsTab
          projects={projects}
          selectedId={selectedId}
          onSelect={selectProject}
          onRefresh={refreshProjects}
          onAskAiWire={(id) => {
            selectProject(id)
            writeDockOpen(true)
            presentInWork({ scene: 'apps' })
          }}
          onOpenShell={(ids) => {
            const list = Array.isArray(ids) ? ids : ids ? [ids] : []
            presentInWork({
              scene: 'shell',
              sessionIds: list.length ? list : undefined,
              newShell: !list.length,
            })
          }}
        />
      </div>
    )
  } else if (tab === 'work') {
    body = (
      <WorkTab
        projects={projects}
        selectedId={selectedId}
        onSelect={selectProject}
        onRefresh={refreshProjects}
        item={workItem}
        onItemChange={chooseWorkItem}
        present={workPresent}
        presentKey={workPresentKey}
      />
    )
  } else if (tab === 'shell') {
    body = (
      <ShellTab
        projects={projects}
        selectedId={selectedId}
        onSelect={selectProject}
        attachSessionIds={attachSessionIds}
        onClearAttach={() => setAttachSessionIds(null)}
      />
    )
  } else if (tab === 'files') {
    body = (
      <FilesTab projects={projects} selectedId={selectedId} onSelect={selectProject} />
    )
  } else if (tab === 'view') {
    // View is kept mounted below so capture survives tab switches.
    body = null
  } else if (tab === 'cursor') {
    body = (
      <CursorTab
        projects={projects}
        selectedId={selectedId}
        onSelect={selectProject}
        onPresent={presentInWork}
      />
    )
  } else if (tab === 'logs') {
    body = <LogsTab />
  }

  if (onboardingReady && showOnboarding) {
    return (
      <OnboardingFlow
        onDone={() => {
          setShowOnboarding(false)
          void refresh()
        }}
      />
    )
  }

  const cursorHint = activeProject?.cursor
  const cursorRunning = !!(cursorHint?.running || cursorHint?.active)
  const navActive = activeNavId(tab, workItem)
  const moreActive = NAV_MORE.find((t) => t.id === navActive) || null
  const showWorkspacePicker = tab !== 'view' && tab !== 'logs' && projects.length > 0

  if (notFoundPath) {
    return (
      <div className="hb-app-shell h-full flex flex-col">
        <main className="flex-1 min-h-0 overflow-hidden">
          <NotFoundView path={notFoundPath} onHome={() => void goArea('home')} />
        </main>
      </div>
    )
  }

  if (area === 'home') {
    return (
      <div className="hb-app-shell h-full flex flex-col">
        <PullToRefresh onRefresh={refresh} />
        {refreshing && (
          <div className="hb-refresh-overlay" role="status" aria-live="polite" aria-label="Refreshing">
            <div className="hb-spinner" />
          </div>
        )}
        <main className="flex-1 min-h-0 overflow-hidden">
          <HomeDashboard
            version={version}
            hostLabel={hostLabel}
            hostLink={hostLink}
            vpnActive={vpnActive}
            onOpenAgent={() => {
              unlockAudio()
              goArea('agent')
            }}
            onOpenHomework={() => {
              unlockAudio()
              goArea('homework')
            }}
            onOpenAccess={() => {
              unlockAudio()
              goArea('access')
            }}
            onOpenVision={() => {
              unlockAudio()
              goArea('vision')
            }}
            onOpenSettings={() => {
              unlockAudio()
              goArea('settings')
            }}
          />
        </main>
        <ToastStack />
        <NotificationCenter />
      </div>
    )
  }

  if (area === 'settings') {
    return (
      <div className="hb-app-shell h-full flex flex-col">
        <PullToRefresh onRefresh={refresh} />
        {refreshing && (
          <div className="hb-refresh-overlay" role="status" aria-live="polite" aria-label="Refreshing">
            <div className="hb-spinner" />
          </div>
        )}
        <main className="flex-1 min-h-0 overflow-hidden">
          <SettingsTab
            onHome={() => goArea('home')}
            onPresent={presentInWork}
            onSignedOut={() => {
              // Session is already cleared; AuthedApp unmounts to Login.
              // Do not navigate (that would post /api/activity + heartbeat and 401).
            }}
          />
        </main>
        <ToastStack />
        <NotificationCenter />
      </div>
    )
  }

  if (area === 'agent') {
    return (
      <div className="hb-app-shell h-full flex flex-col">
        <PullToRefresh onRefresh={refresh} />
        {refreshing && (
          <div className="hb-refresh-overlay" role="status" aria-live="polite" aria-label="Refreshing">
            <div className="hb-spinner" />
          </div>
        )}
        <main className="flex-1 min-h-0 overflow-hidden">
          <HomeAgentTab
            projects={projects}
            selectedId={selectedId}
            onSelect={selectProject}
            onHome={() => goArea('home')}
          />
        </main>
        <ToastStack />
        <NotificationCenter />
      </div>
    )
  }

  if (area === 'access') {
    return (
      <div className="hb-app-shell h-full flex flex-col">
        <PullToRefresh onRefresh={refresh} />
        {refreshing && (
          <div className="hb-refresh-overlay" role="status" aria-live="polite" aria-label="Refreshing">
            <div className="hb-spinner" />
          </div>
        )}
        <main className="flex-1 min-h-0 overflow-hidden">
          <HomeAccessTab
            projects={projects}
            selectedId={selectedId}
            onSelect={selectProject}
            onHome={() => goArea('home')}
          />
        </main>
        <ToastStack />
        <NotificationCenter />
      </div>
    )
  }

  if (area === 'vision') {
    return (
      <div className="hb-app-shell h-full flex flex-col">
        <PullToRefresh onRefresh={refresh} />
        {refreshing && (
          <div className="hb-refresh-overlay" role="status" aria-live="polite" aria-label="Refreshing">
            <div className="hb-spinner" />
          </div>
        )}
        <main className="flex-1 min-h-0 overflow-hidden">
          <HomeVisionTab
            projects={projects}
            selectedId={selectedId}
            onSelect={selectProject}
            onHome={() => goArea('home')}
          />
        </main>
        <ToastStack />
        <NotificationCenter />
      </div>
    )
  }

  return (
    <div className={`hb-app-shell h-full flex flex-col${moreOpen ? ' hb-nav-more-open' : ''}`}>
      <PullToRefresh onRefresh={refresh} />
      {refreshing && (
        <div className="hb-refresh-overlay" role="status" aria-live="polite" aria-label="Refreshing">
          <div className="hb-spinner" />
        </div>
      )}
      <header className="hb-topbar">
        <button
          type="button"
          className="hb-topbar-home shrink-0"
          onClick={() => {
            unlockAudio()
            goArea('home')
          }}
          aria-label="Home dashboard"
          title="Home"
        >
          <TabIcon id="home" />
        </button>
        <div className="hb-topbar-center">
          {showWorkspacePicker ? (
            <>
              <ProjectSelect
                projects={projects}
                selectedId={selectedId}
                onSelect={selectProject}
                className="hb-topbar-picker"
              />
              <IconBtn
                label="New workspace"
                onClick={() => setAddOpen(true)}
                className="hb-topbar-add"
              />
            </>
          ) : (
            <h1 className="hb-topbar-title">
              {tab === 'view' ? 'View' : tab === 'logs' ? 'Logs' : 'Work'}
            </h1>
          )}
        </div>
        <StatusChip
          hostLabel={hostLabel}
          hostLink={hostLink}
          vpnActive={vpnActive}
          vpnHostHint={vpnHostHint}
          cursorConfigured={cursorConfigured}
          cursorRunning={cursorRunning}
          version={version}
          backup={backup}
        />
        <button
          type="button"
          className="hb-status-alerts hb-topbar-icon shrink-0"
          onClick={() => {
            unlockAudio()
            toggleInbox()
          }}
          aria-label={unread > 0 ? `Alerts, ${unread} unread` : 'Alerts'}
          aria-expanded={inboxOpen}
          data-active={inboxOpen}
          title="Alerts"
        >
          <svg className="hb-status-alerts-icon" viewBox="0 0 24 24" aria-hidden>
            <path d="M15 17.5H5.5a1.5 1.5 0 0 1-1.3-2.25C5.3 13.4 6 11.8 6 10a6 6 0 1 1 12 0c0 1.8.7 3.4 1.8 5.25A1.5 1.5 0 0 1 18.5 17.5H15z" />
            <path d="M10 17.5v.75a2 2 0 0 0 4 0v-.75" />
          </svg>
          {unread > 0 && (
            <span className="hb-status-badge">{unread > 9 ? '9+' : unread}</span>
          )}
        </button>
      </header>
      <main className="flex-1 min-h-0 overflow-hidden relative">
        {/* Mount View on first visit; keep mounted (hidden) so capture survives tab switches. */}
        {viewVisited && (
          <div
            className={tab === 'view' ? 'h-full' : 'hidden'}
            aria-hidden={tab !== 'view'}
          >
            <ViewTab />
          </div>
        )}
        {tab !== 'view' && body}
      </main>

      <AddProjectWizard open={addOpen} onClose={() => setAddOpen(false)} onAdded={onProjectAdded} />
      <ToastStack />
      <NotificationCenter />

      <nav className="hb-nav" aria-label="Primary" data-more-open={moreOpen ? 'true' : 'false'}>
        {moreOpen && (
          <div className="hb-nav-more-tray" role="group" aria-label="More">
            {NAV_MORE.map((t) => {
              const active = navActive === t.id
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => onNav(t.id)}
                  className="hb-nav-more-item"
                  data-active={active}
                  aria-current={active ? 'page' : undefined}
                >
                  <TabIcon id={t.id} />
                  <span>{t.label}</span>
                </button>
              )
            })}
          </div>
        )}
        <div className="hb-nav-dock" style={{ gridTemplateColumns: `repeat(${NAV_MAIN.length + 1}, minmax(0, 1fr))` }}>
          {NAV_MAIN.map((t) => {
            const active = navActive === t.id
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => onNav(t.id)}
                className="hb-nav-item"
                data-active={active}
                aria-current={active ? 'page' : undefined}
              >
                <TabIcon id={t.id} />
                <span className="truncate max-w-full px-0.5">{t.label}</span>
              </button>
            )
          })}
          <button
            type="button"
            onClick={() => setMoreOpen((v) => !v)}
            className="hb-nav-item"
            data-active={!!moreActive || moreOpen}
            aria-current={moreActive ? 'page' : undefined}
            aria-expanded={moreOpen}
            aria-haspopup="true"
          >
            <TabIcon id={moreActive && !moreOpen ? moreActive.id : 'more'} />
            <span className="truncate max-w-full px-0.5">
              {moreActive && !moreOpen ? moreActive.label : 'More'}
            </span>
          </button>
        </div>
      </nav>
    </div>
  )
}

export default function App() {
  const [authed, setAuthed] = useState(false)
  const [authReady, setAuthReady] = useState(false)
  const [legalOk, setLegalOk] = useState<boolean | null>(null)
  const [legalError, setLegalError] = useState(false)
  const [legalRetrying, setLegalRetrying] = useState(false)

  useEffect(() => {
    installClientLog()
    applyMobileSafeTop()
    migrateLegacyLocalSession()
    let cancelled = false
    void api
      .authSession()
      .then((s) => {
        if (cancelled) return
        if (s.authenticated && s.csrfToken && s.expiresAt) {
          setSession({ expiresAt: s.expiresAt, csrfToken: s.csrfToken })
          setAuthed(true)
        } else {
          setAuthed(false)
        }
        setAuthReady(true)
      })
      .catch(() => {
        if (cancelled) return
        setAuthed(false)
        setAuthReady(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const onLost = () => setAuthed(false)
    window.addEventListener('hb-auth-lost', onLost)
    return () => window.removeEventListener('hb-auth-lost', onLost)
  }, [])

  useEffect(() => {
    if (!authed) {
      setLegalOk(null)
      setLegalError(false)
      return
    }
    let cancelled = false
    let timer = 0
    const load = (fromRetry = false) => {
      if (fromRetry) setLegalRetrying(true)
      void api
        .legalStatus()
        .then((l) => {
          if (cancelled) return
          setLegalError(false)
          setLegalRetrying(false)
          setLegalOk(!!l.accepted && l.version === LEGAL_DOC_VERSION)
        })
        .catch(() => {
          if (cancelled) return
          setLegalRetrying(false)
          setLegalError(true)
          setLegalOk(null)
          timer = window.setTimeout(() => load(), 4000)
        })
    }
    load()
    return () => {
      cancelled = true
      if (timer) window.clearTimeout(timer)
    }
  }, [authed])

  useEffect(() => {
    if (!authed) return
    return watchSessionExpiry()
  }, [authed])

  if (!authReady) {
    return <div className="min-h-dvh bg-panel" aria-busy="true" />
  }

  if (!authed) {
    return <Login onAuthed={() => setAuthed(true)} />
  }

  if (legalError) {
    return (
      <LegalConnectionError
        busy={legalRetrying}
        onRetry={() => {
          setLegalRetrying(true)
          void api
            .legalStatus()
            .then((l) => {
              setLegalError(false)
              setLegalOk(!!l.accepted && l.version === LEGAL_DOC_VERSION)
            })
            .catch(() => setLegalRetrying(false))
            .finally(() => setLegalRetrying(false))
        }}
      />
    )
  }

  if (legalOk === null) {
    return <div className="min-h-dvh bg-panel" aria-busy="true" />
  }

  if (!legalOk) {
    return <LegalGate onAccepted={() => setLegalOk(true)} />
  }

  return (
    <NotifyProvider>
      <PinLock>
        <AuthedApp />
      </PinLock>
    </NotifyProvider>
  )
}
