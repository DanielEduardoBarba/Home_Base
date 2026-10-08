import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertsTab } from './components/AlertsTab'
import { AppsTab } from './components/AppsTab'
import { CursorTab } from './components/CursorTab'
import { FilesTab } from './components/FilesTab'
import { Login } from './components/Login'
import { LogsTab } from './components/LogsTab'
import { PullToRefresh } from './components/PullToRefresh'
import { SharingTab } from './components/SharingTab'
import { ShellTab } from './components/ShellTab'
import { api } from './lib/api'
import { clearToken, isSessionValid } from './lib/auth'
import { installClientLog } from './lib/clientLog'
import { isLocalHostPage, type Project, type Tab } from './lib/types'

installClientLog()

const BASE_TABS: { id: Tab; label: string }[] = [
  { id: 'apps', label: 'Apps' },
  { id: 'shell', label: 'Shell' },
  { id: 'files', label: 'Files' },
  { id: 'cursor', label: 'Cursor' },
  { id: 'logs', label: 'Logs' },
  { id: 'alerts', label: 'Alerts' },
]

export default function App() {
  const [authed, setAuthed] = useState(() => isSessionValid())
  const [tab, setTab] = useState<Tab>('apps')
  const [projects, setProjects] = useState<Project[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [attachSessionId, setAttachSessionId] = useState<string | null>(null)
  const [loadError, setLoadError] = useState('')
  const [unread, setUnread] = useState(0)
  const localPage = isLocalHostPage()

  const tabs = useMemo(() => {
    if (!localPage) return BASE_TABS
    return [...BASE_TABS, { id: 'sharing' as Tab, label: 'Share' }]
  }, [localPage])

  useEffect(() => {
    if (!localPage && tab === 'sharing') setTab('apps')
  }, [localPage, tab])

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

  return (
    <div className="h-full flex flex-col">
      <PullToRefresh onRefresh={refresh} />
      <main className="flex-1 min-h-0 overflow-hidden">
        {loadError && tab === 'apps' && (
          <p className="px-4 pt-3 text-sm text-danger">{loadError}</p>
        )}
        {tab === 'apps' && (
          <div className="h-full overflow-y-auto">
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
        )}
        {tab === 'shell' && (
          <ShellTab
            projects={projects}
            selectedId={selectedId}
            onSelect={setSelectedId}
            attachSessionId={attachSessionId}
            onClearAttach={() => setAttachSessionId(null)}
          />
        )}
        {tab === 'files' && (
          <FilesTab
            projects={projects}
            selectedId={selectedId}
            onSelect={setSelectedId}
          />
        )}
        {tab === 'cursor' && (
          <CursorTab
            projects={projects}
            selectedId={selectedId}
            onSelect={setSelectedId}
          />
        )}
        {tab === 'logs' && <LogsTab />}
        {tab === 'alerts' && <AlertsTab />}
        {tab === 'sharing' && localPage && <SharingTab />}
      </main>

      <nav className="fixed bottom-0 inset-x-0 z-20 border-t border-line bg-ink/95 backdrop-blur-xl pb-[env(safe-area-inset-bottom)] shadow-[0_-8px_32px_rgba(0,0,0,0.45)]">
        <div
          className="max-w-5xl mx-auto grid"
          style={{ gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))` }}
        >
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={`py-3.5 text-[10px] sm:text-xs font-semibold tracking-wide relative ${
                tab === t.id ? 'text-accent hb-tab-active' : 'text-mute hover:text-text'
              }`}
            >
              {t.label}
              {t.id === 'alerts' && unread > 0 && (
                <span className="absolute top-1.5 right-[12%] min-w-[1rem] h-4 px-1 rounded-full bg-danger text-[9px] text-white leading-4">
                  {unread > 9 ? '9+' : unread}
                </span>
              )}
            </button>
          ))}
        </div>
      </nav>
    </div>
  )
}
