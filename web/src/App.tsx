import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AppsTab } from './components/AppsTab'
import { CursorTab } from './components/CursorTab'
import { FilesTab } from './components/FilesTab'
import { Login } from './components/Login'
import { LogsTab } from './components/LogsTab'
import { NotificationCenter } from './components/NotificationCenter'
import { PullToRefresh } from './components/PullToRefresh'
import { SettingsTab } from './components/SettingsTab'
import { ShellTab } from './components/ShellTab'
import { ToastStack } from './components/ToastStack'
import { ViewTab } from './components/ViewTab'
import { WorkTab } from './components/WorkTab'
import { api } from './lib/api'
import { clearSession, isSessionValid, watchSessionExpiry } from './lib/auth'
import type { PresentRequest } from './lib/chatTypes'
import { installClientLog } from './lib/clientLog'
import { NotifyProvider, useNotify } from './lib/NotifyContext'
import { runSceneRefresh } from './lib/sceneRefresh'
import { applyMobileSafeTop, applyTheme, getStoredTheme } from './lib/theme'
import { type Project, type Tab } from './lib/types'
import {
  readLastProjectId,
  readLastTab,
  writeLastProjectId,
  writeLastTab,
} from './lib/uiPrefs'

installClientLog()
applyTheme(getStoredTheme())
applyMobileSafeTop()

/** Mobile-first: Apps · Work · Chat · Shell · Files · View · Logs · More (Alerts = status-bar bell) */
const TABS: { id: Tab; label: string }[] = [
  { id: 'apps', label: 'Apps' },
  { id: 'work', label: 'Work' },
  { id: 'cursor', label: 'Chat' },
  { id: 'shell', label: 'Shell' },
  { id: 'files', label: 'Files' },
  { id: 'view', label: 'View' },
  { id: 'logs', label: 'Logs' },
  { id: 'settings', label: 'More' },
]

function TabIcon({ id }: { id: Tab }) {
  const common = { className: 'hb-nav-icon', viewBox: '0 0 24 24', 'aria-hidden': true as const }
  switch (id) {
    case 'apps':
      return (
        <svg {...common}>
          <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
          <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
          <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
          <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
        </svg>
      )
    case 'work':
      return (
        <svg {...common}>
          <rect x="3.5" y="5" width="17" height="14" rx="1.5" />
          <path d="M3.5 9.5h17" />
          <path d="M14 9.5v9.5" />
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
    case 'cursor':
      return (
        <svg {...common}>
          <path d="M5 4.5 19 12 5 19.5V4.5z" />
        </svg>
      )
    case 'logs':
      return (
        <svg {...common}>
          <path d="M5 7h14M5 12h10M5 17h12" />
        </svg>
      )
    case 'settings':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="3" />
          <path d="M12 3.5v2.2M12 18.3v2.2M3.5 12h2.2M18.3 12h2.2M5.8 5.8l1.6 1.6M16.6 16.6l1.6 1.6M5.8 18.2l1.6-1.6M16.6 7.4l1.6-1.6" />
        </svg>
      )
    default:
      return null
  }
}

type HostLink = 'live' | 'reconnecting' | 'unreachable'

function AuthedApp() {
  const [tab, setTab] = useState<Tab>(() => readLastTab('apps'))
  const [projects, setProjects] = useState<Project[]>([])
  const [selectedId, setSelectedId] = useState(() => readLastProjectId())
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
  const [hostLabel, setHostLabel] = useState(() => location.hostname || 'host')
  const failStreak = useRef(0)
  const {
    unread,
    inboxOpen,
    toggleInbox,
    closeInbox,
    unlockAudio,
    refresh: refreshNotify,
  } = useNotify()

  const tabs = useMemo(() => TABS, [])
  const activeProject = projects.find((p) => p.id === selectedId) || projects[0]

  const goTab = useCallback((id: Tab) => {
    writeLastTab(id)
    setTab(id)
  }, [])

  const selectProject = useCallback((id: string) => {
    writeLastProjectId(id)
    setSelectedId(id)
  }, [])

  /** Chat → Work: show Apps / Shell / Files (and optionally a shell or file). */
  const presentInWork = useCallback((req: PresentRequest) => {
    workPresentSeq.current += 1
    setWorkPresent(req)
    setWorkPresentKey(workPresentSeq.current)
    goTab('work')
  }, [goTab])

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
      }
      if (!data.projects.find((p) => p.id === selectedId)) {
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
      void refreshNotify()
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
  }, [selectedId, refreshNotify])

  const refresh = useCallback(async () => {
    setRefreshing(true)
    try {
      await Promise.all([refreshProjects(), runSceneRefresh()])
    } finally {
      setRefreshing(false)
    }
  }, [refreshProjects])

  useEffect(() => {
    void refreshProjects()
    const t = setInterval(() => void refreshProjects(), 10000)
    return () => clearInterval(t)
  }, [refreshProjects])

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
          onOpenShell={(ids) => {
            const list = Array.isArray(ids) ? ids : ids ? [ids] : []
            setAttachSessionIds(list.length ? list : null)
            goTab('shell')
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
  } else if (tab === 'settings') {
    body = (
      <SettingsTab
        onSignedOut={() => {
          goTab('apps')
        }}
      />
    )
  }

  const linkLabel =
    hostLink === 'live' ? 'Live' : hostLink === 'reconnecting' ? 'Reconnecting' : 'Unreachable'
  const cursorHint = activeProject?.cursor
  const cursorRunning = !!(cursorHint?.running || cursorHint?.active)

  return (
    <div className="hb-app-shell h-full flex flex-col">
      <PullToRefresh onRefresh={refresh} />
      {refreshing && (
        <div className="hb-refresh-overlay" role="status" aria-live="polite" aria-label="Refreshing">
          <div className="hb-spinner" />
        </div>
      )}
      <div className="hb-status-bar">
        <div className="hb-status-meta min-w-0" role="status" aria-live="polite">
          <span
            className={`hb-status-dot ${
              hostLink === 'live'
                ? 'hb-status-dot--ok'
                : hostLink === 'reconnecting'
                  ? 'hb-status-dot--warn'
                  : 'hb-status-dot--err'
            }`}
          />
          <span className="hb-status-host truncate" title={hostLabel}>
            {hostLabel}
          </span>
          <span className="hb-status-sep">·</span>
          <span
            className={
              hostLink === 'live'
                ? 'text-ok'
                : hostLink === 'reconnecting'
                  ? 'text-amber'
                  : 'text-danger'
            }
          >
            {linkLabel}
          </span>
          {activeProject && (
            <>
              <span className="hb-status-sep">·</span>
              <span className="truncate min-w-0" title={activeProject.path}>
                {activeProject.name}
              </span>
            </>
          )}
          {cursorConfigured && (
            <>
              <span className="hb-status-sep">·</span>
              <span className={cursorRunning ? 'text-sky' : 'text-mute'} title="Local Cursor agent">
                Cursor{cursorRunning ? ' run' : ''}
              </span>
            </>
          )}
        </div>
        <button
          type="button"
          className="hb-status-alerts shrink-0"
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
        {version && (
          <span className="hb-status-ver shrink-0">
            v{version}
            {backup ? ' · bak' : ''}
          </span>
        )}
      </div>
      <main className="flex-1 min-h-0 overflow-hidden relative">
        {/* Keep View mounted (hidden) so JWT WS + capture stay up across tab switches. */}
        <div
          className={tab === 'view' ? 'h-full' : 'hidden'}
          aria-hidden={tab !== 'view'}
        >
          <ViewTab />
        </div>
        {tab !== 'view' && body}
      </main>

      <ToastStack />
      <NotificationCenter />

      <nav className="hb-nav" aria-label="Primary">
        <div
          className="hb-nav-dock"
          style={{ gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))` }}
        >
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => {
                unlockAudio()
                closeInbox()
                // Drop stale present so revisiting Work via nav opens clean Apps scene
                if (t.id !== 'work') setWorkPresent(null)
                goTab(t.id)
              }}
              className="hb-nav-item"
              data-active={tab === t.id}
              aria-current={tab === t.id ? 'page' : undefined}
            >
              <TabIcon id={t.id} />
              <span className="truncate max-w-full px-0.5">{t.label}</span>
            </button>
          ))}
        </div>
      </nav>
    </div>
  )
}

export default function App() {
  const [authed, setAuthed] = useState(() => isSessionValid())

  useEffect(() => {
    const onLost = () => setAuthed(false)
    window.addEventListener('hb-auth-lost', onLost)
    return () => window.removeEventListener('hb-auth-lost', onLost)
  }, [])

  useEffect(() => {
    if (!authed) return
    return watchSessionExpiry()
  }, [authed])

  if (!authed) {
    return <Login onAuthed={() => setAuthed(true)} />
  }

  return (
    <NotifyProvider>
      <AuthedApp />
    </NotifyProvider>
  )
}
