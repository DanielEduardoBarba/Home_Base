import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { AlertsTab } from './components/AlertsTab'
import { AppsTab } from './components/AppsTab'
import { CursorTab } from './components/CursorTab'
import { FilesTab } from './components/FilesTab'
import { Login } from './components/Login'
import { LogsTab } from './components/LogsTab'
import { PullToRefresh } from './components/PullToRefresh'
import { SettingsTab } from './components/SettingsTab'
import { ShellTab } from './components/ShellTab'
import { api } from './lib/api'
import { clearToken, isSessionValid } from './lib/auth'
import { installClientLog } from './lib/clientLog'
import { applyTheme, getStoredTheme } from './lib/theme'
import { type Project, type Tab } from './lib/types'

installClientLog()
applyTheme(getStoredTheme())

const TABS: { id: Tab; label: string }[] = [
  { id: 'apps', label: 'Apps' },
  { id: 'shell', label: 'Shell' },
  { id: 'files', label: 'Files' },
  { id: 'cursor', label: 'Cursor' },
  { id: 'logs', label: 'Logs' },
  { id: 'alerts', label: 'Alerts' },
  { id: 'settings', label: 'Settings' },
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
    case 'alerts':
      return (
        <svg {...common}>
          <path d="M12 4.5 20 18.5H4L12 4.5z" />
          <path d="M12 10v4" />
          <circle cx="12" cy="16.5" r="0.6" fill="currentColor" stroke="none" />
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

export default function App() {
  const [authed, setAuthed] = useState(() => isSessionValid())
  const [tab, setTab] = useState<Tab>('apps')
  const [projects, setProjects] = useState<Project[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [attachSessionId, setAttachSessionId] = useState<string | null>(null)
  const [loadError, setLoadError] = useState('')
  const [unread, setUnread] = useState(0)

  const tabs = useMemo(() => TABS, [])

  const refresh = useCallback(async () => {
    try {
      const data = await api.projects()
      setProjects(data.projects)
      setLoadError('')
      if (!data.projects.find((p) => p.id === selectedId)) {
        setSelectedId(data.projects[0]?.id || '')
      }
      const n = await api.notifications({ limit: 1, history: true })
      setUnread(n.unread)
    } catch (e) {
      const err = e as Error & { status?: number }
      const msg = err.message || String(e)
      setLoadError(msg)
      if (err.status === 401 || err.status === 429 || /unauthorized|401/i.test(msg)) {
        clearToken()
        setAuthed(false)
      }
    }
  }, [selectedId])

  useEffect(() => {
    if (!authed) return
    refresh()
    const t = setInterval(refresh, 10000)
    return () => clearInterval(t)
  }, [authed, refresh])

  if (!authed) {
    return <Login onAuthed={() => setAuthed(true)} />
  }

  let body: ReactNode = null
  if (tab === 'apps') {
    body = (
      <div className="h-full overflow-y-auto">
        {loadError && <p className="hb-page !pb-0 pt-3 text-sm text-danger">{loadError}</p>}
        <AppsTab
          projects={projects}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onRefresh={refresh}
          onOpenShell={(sid) => {
            if (sid) setAttachSessionId(sid)
            setTab('shell')
          }}
        />
      </div>
    )
  } else if (tab === 'shell') {
    body = (
      <ShellTab
        projects={projects}
        selectedId={selectedId}
        onSelect={setSelectedId}
        attachSessionId={attachSessionId}
        onClearAttach={() => setAttachSessionId(null)}
      />
    )
  } else if (tab === 'files') {
    body = (
      <FilesTab projects={projects} selectedId={selectedId} onSelect={setSelectedId} />
    )
  } else if (tab === 'cursor') {
    body = (
      <CursorTab projects={projects} selectedId={selectedId} onSelect={setSelectedId} />
    )
  } else if (tab === 'logs') {
    body = <LogsTab />
  } else if (tab === 'alerts') {
    body = <AlertsTab />
  } else if (tab === 'settings') {
    body = (
      <SettingsTab
        onSignedOut={() => {
          setAuthed(false)
          setTab('apps')
        }}
      />
    )
  }

  return (
    <div className="h-full flex flex-col">
      <PullToRefresh onRefresh={refresh} />
      <main className="flex-1 min-h-0 overflow-hidden">{body}</main>

      <nav className="hb-nav" aria-label="Primary">
        <div
          className="hb-nav-dock"
          style={{ gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))` }}
        >
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className="hb-nav-item"
              data-active={tab === t.id}
              aria-current={tab === t.id ? 'page' : undefined}
            >
              <TabIcon id={t.id} />
              <span className="truncate max-w-full px-0.5">
                <span className="sm:hidden">{t.id === 'settings' ? 'Set' : t.label}</span>
                <span className="hidden sm:inline">{t.label}</span>
              </span>
              {t.id === 'alerts' && unread > 0 && (
                <span className="hb-badge">{unread > 9 ? '9+' : unread}</span>
              )}
            </button>
          ))}
        </div>
      </nav>
    </div>
  )
}
