'use client'

import dynamic from 'next/dynamic'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../lib/api'
import type { PresentRequest } from '../lib/chatTypes'
import { useNotify } from '../lib/NotifyContext'
import type { FsEntry, Project } from '../lib/types'
import { useSceneRefresh } from '../lib/sceneRefresh'
import { chatLiveActivity, type LiveActivity } from '../lib/toolFormat'
import {
  pushAgentRecentAbs,
  pushAgentRecentDir,
  readAgentLastChat,
  readAgentRecentAbs,
  readAgentRecentDirs,
  readAgentScene,
  writeAgentScene,
  type AgentRecentAbs,
  type AgentScenePref,
} from '../lib/uiPrefs'
import { SwipeDeleteRow } from './SwipeDeleteRow'

const ChatPanel = dynamic(() => import('./ChatPanel').then((m) => m.ChatPanel), { ssr: false })
const FilesTab = dynamic(() => import('./FilesTab').then((m) => m.FilesTab), { ssr: false })
const ShellTab = dynamic(() => import('./ShellTab').then((m) => m.ShellTab), { ssr: false })

type ChatRow = {
  id: string
  title: string
  cwd: string
  projectId: string
  projectName: string
  /** Short dir/project context for the All list. */
  contextLabel: string
  updatedAt: number
  running?: boolean
  messageCount: number
  /** Performative live line while the agent run is active. */
  activity?: LiveActivity | null
}

type Scene =
  | { kind: 'setup' }
  | { kind: 'all' }
  | { kind: 'chats'; projectId: string; cwd: string }
  | { kind: 'chat'; projectId: string; cwd: string; chatId: string; fromAll?: boolean }
  | {
      kind: 'present'
      projectId: string
      cwd: string
      chatId: string
      fromAll?: boolean
      present: PresentRequest
    }

function chatContextLabel(cwd: string, projectName: string): string {
  if (!cwd) return projectName
  if (cwd.startsWith('/')) {
    const leaf = cwd.split('/').filter(Boolean).slice(-2).join('/') || cwd
    return leaf
  }
  return `${projectName} · ./${cwdLabel(cwd, projectName)}`
}

function normCwd(cwd: string | undefined | null): string {
  return (cwd || '').replace(/^\.\//, '').replace(/\/+$/, '')
}

function cwdLabel(cwd: string, projectName: string): string {
  if (!cwd) return projectName
  if (cwd.startsWith('/')) {
    const parts = cwd.split('/').filter(Boolean)
    return parts.slice(-2).join('/') || cwd
  }
  const parts = cwd.split('/').filter(Boolean)
  return parts.slice(-2).join('/') || cwd
}

function mapSummaryToRow(
  c: {
    id: string
    title?: string
    cwd?: string
    updatedAt?: number
    running?: boolean
    messageCount?: number
    recent?: Parameters<typeof chatLiveActivity>[0]
  },
  project: Project,
): ChatRow {
  const cwd = c.cwd || ''
  const running = !!c.running
  return {
    id: c.id,
    title: c.title || 'Chat',
    cwd,
    projectId: project.id,
    projectName: project.name,
    contextLabel: chatContextLabel(cwd, project.name),
    updatedAt: c.updatedAt || 0,
    running,
    messageCount: c.messageCount || 0,
    activity: chatLiveActivity(c.recent || [], running),
  }
}

/**
 * Home Agent — pick host folder or project → chats → minimal agent.
 */
export function HomeAgentTab({
  projects,
  selectedId,
  onSelect,
  onHome,
}: {
  projects: Project[]
  selectedId: string
  onSelect: (id: string) => void
  onHome: () => void
}) {
  const { unread, inboxOpen, toggleInbox, unlockAudio, ping } = useNotify()
  const [scene, setSceneState] = useState<Scene>(() => {
    const saved = readAgentScene()
    if (!saved) return { kind: 'setup' }
    if (saved.kind === 'setup' || saved.kind === 'all') return saved
    if (!projects.some((p) => p.id === saved.projectId) && projects.length) {
      return { kind: 'setup' }
    }
    return saved as Scene
  })
  const setScene = useCallback((next: Scene | ((prev: Scene) => Scene)) => {
    setSceneState((prev) => {
      const resolved = typeof next === 'function' ? next(prev) : next
      const pref: AgentScenePref =
        resolved.kind === 'present'
          ? {
              kind: 'chat',
              projectId: resolved.projectId,
              cwd: resolved.cwd,
              chatId: resolved.chatId,
              fromAll: resolved.fromAll,
            }
          : resolved.kind === 'setup'
            ? { kind: 'setup' }
            : resolved.kind === 'all'
              ? { kind: 'all' }
              : resolved.kind === 'chats'
                ? { kind: 'chats', projectId: resolved.projectId, cwd: resolved.cwd }
                : {
                    kind: 'chat',
                    projectId: resolved.projectId,
                    cwd: resolved.cwd,
                    chatId: resolved.chatId,
                    fromAll: resolved.fromAll,
                  }
      writeAgentScene(pref)
      return resolved
    })
  }, [])
  const [error, setError] = useState('')
  const [chats, setChats] = useState<ChatRow[]>([])
  const [loadingChats, setLoadingChats] = useState(false)
  const [busy, setBusy] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [browseOpen, setBrowseOpen] = useState(false)
  const [browsePath, setBrowsePath] = useState('/home')
  const [browseEntries, setBrowseEntries] = useState<FsEntry[]>([])
  const [recentAbs, setRecentAbs] = useState<AgentRecentAbs[]>(() => readAgentRecentAbs())
  const [focusProjectId, setFocusProjectId] = useState(() => {
    const saved = readAgentScene()
    if (saved && 'projectId' in saved) return saved.projectId
    return selectedId || projects[0]?.id || ''
  })
  const [projectRecents, setProjectRecents] = useState<string[]>([])
  const lastChatId =
    scene.kind === 'chats' ? readAgentLastChat(scene.projectId, scene.cwd) : ''

  // Validate restored scene once projects load.
  useEffect(() => {
    if (!projects.length) return
    if (scene.kind === 'setup' || scene.kind === 'all') return
    if ('projectId' in scene && !projects.some((p) => p.id === scene.projectId)) {
      setScene({ kind: 'setup' })
    }
  }, [projects, scene, setScene])

  const hostProject = useMemo(() => {
    return (
      projects.find((p) => p.id === 'homebase') ||
      projects.find((p) => p.id === focusProjectId) ||
      projects.find((p) => p.id === selectedId) ||
      projects[0]
    )
  }, [projects, focusProjectId, selectedId])

  const project = useMemo(() => {
    const id =
      scene.kind === 'setup' || scene.kind === 'all'
        ? focusProjectId
        : 'projectId' in scene
          ? scene.projectId
          : selectedId
    return projects.find((p) => p.id === id) || hostProject || projects[0]
  }, [projects, scene, selectedId, focusProjectId, hostProject])

  const reportError = useCallback(
    (message: string) => {
      const text = message.trim()
      if (!text) return
      setError(text)
      console.error('[home-agent]', text)
      ping({
        title: 'Agent error',
        body: text.slice(0, 200),
        level: 'error',
        category: 'home-agent',
      })
    },
    [ping],
  )

  const loadChats = useCallback(
    async (projectId: string, cwd: string, opts?: { soft?: boolean }) => {
      if (!opts?.soft) {
        setLoadingChats(true)
        setError('')
      }
      try {
        const proj = projects.find((p) => p.id === projectId)
        if (!proj) {
          setChats([])
          return
        }
        const data = await api.cursorChats(projectId)
        const want = normCwd(cwd)
        const rows: ChatRow[] = (data.chats || [])
          .filter((t) => normCwd(t.cwd) === want)
          .map((t) => mapSummaryToRow(t, proj))
          .sort((a, b) => b.updatedAt - a.updatedAt)
        setChats(rows)
      } catch (e) {
        if (!opts?.soft) {
          reportError(e instanceof Error ? e.message : String(e))
          setChats([])
        }
      } finally {
        if (!opts?.soft) setLoadingChats(false)
      }
    },
    [projects, reportError],
  )

  const loadAllChats = useCallback(
    async (opts?: { soft?: boolean }) => {
      if (!opts?.soft) {
        setLoadingChats(true)
        setError('')
      }
      try {
        const lists = await Promise.all(
          projects.map(async (proj) => {
            try {
              const data = await api.cursorChats(proj.id)
              return (data.chats || []).map((t) => mapSummaryToRow(t, proj))
            } catch {
              return [] as ChatRow[]
            }
          }),
        )
        setChats(lists.flat().sort((a, b) => b.updatedAt - a.updatedAt))
      } catch (e) {
        if (!opts?.soft) {
          reportError(e instanceof Error ? e.message : String(e))
          setChats([])
        }
      } finally {
        if (!opts?.soft) setLoadingChats(false)
      }
    },
    [projects, reportError],
  )

  useEffect(() => {
    if (scene.kind === 'chats') void loadChats(scene.projectId, scene.cwd)
    else if (scene.kind === 'all') void loadAllChats()
  }, [scene, loadChats, loadAllChats])

  const chatsLive = useMemo(
    () => chats.some((c) => c.running || c.activity?.live),
    [chats],
  )

  // Soft-refresh lean summaries (slower idle; still snappy while a run is live).
  useEffect(() => {
    if (scene.kind !== 'chats' && scene.kind !== 'all') return
    const ms = chatsLive ? 2500 : 12_000
    const t = window.setInterval(() => {
      if (scene.kind === 'all') void loadAllChats({ soft: true })
      else if (scene.kind === 'chats') void loadChats(scene.projectId, scene.cwd, { soft: true })
    }, ms)
    return () => window.clearInterval(t)
  }, [scene, chatsLive, loadChats, loadAllChats])

  useSceneRefresh(() => {
    if (scene.kind === 'chats') return loadChats(scene.projectId, scene.cwd)
    if (scene.kind === 'all') return loadAllChats()
  })

  useEffect(() => {
    if (scene.kind !== 'setup') return
    setRecentAbs(readAgentRecentAbs())
    if (focusProjectId) setProjectRecents(readAgentRecentDirs(focusProjectId))
  }, [scene.kind, focusProjectId])

  async function loadBrowse(path: string) {
    if (!hostProject) {
      reportError('No project available to browse the filesystem')
      return
    }
    const target = path.startsWith('/') ? path : `/${path}`
    try {
      const data = await api.fsList(hostProject.id, target)
      setBrowsePath(data.path.startsWith('/') ? data.path : target)
      setBrowseEntries(data.entries.filter((e) => e.type === 'dir'))
      setError('')
    } catch (e) {
      reportError(e instanceof Error ? e.message : String(e))
    }
  }

  function openBrowse() {
    setBrowseOpen(true)
    void loadBrowse(browsePath || '/home')
  }

  function chooseAbsDir(absPath: string, projectId?: string) {
    const pid = projectId || hostProject?.id
    if (!pid) {
      reportError('No project available to host this chat')
      return
    }
    const path = absPath.startsWith('/') ? absPath : `/${absPath}`
    pushAgentRecentAbs({ path, projectId: pid })
    setRecentAbs(readAgentRecentAbs())
    onSelect(pid)
    setBrowseOpen(false)
    setScene({ kind: 'chats', projectId: pid, cwd: path })
  }

  function chooseProjectRoot(projectId: string) {
    pushAgentRecentDir(projectId, '')
    onSelect(projectId)
    setScene({ kind: 'chats', projectId, cwd: '' })
  }

  function chooseProjectRel(projectId: string, cwd: string) {
    pushAgentRecentDir(projectId, cwd)
    onSelect(projectId)
    setScene({ kind: 'chats', projectId, cwd })
  }

  async function newChat(projectId: string, cwd: string) {
    setBusy(true)
    setError('')
    try {
      const title = cwd
        ? cwd.startsWith('/')
          ? cwd.split('/').filter(Boolean).slice(-1)[0] || 'Chat'
          : `./${cwd.split('/').pop()}`
        : 'New chat'
      const { chat } = await api.cursorCreateChat(projectId, { cwd, title })
      if (cwd.startsWith('/')) pushAgentRecentAbs({ path: cwd, projectId })
      else pushAgentRecentDir(projectId, cwd)
      setScene({ kind: 'chat', projectId, cwd, chatId: chat.id })
    } catch (e) {
      reportError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function removeChat(projectId: string, cwd: string, chatId: string) {
    const rowKey = `${projectId}:${chatId}`
    setDeletingId(rowKey)
    setError('')
    const prev = chats
    // Optimistic: drop the row immediately; server delete is sync + background agent GC.
    setChats((list) => list.filter((c) => !(c.id === chatId && c.projectId === projectId)))
    try {
      await api.cursorDeleteChat(projectId, chatId)
    } catch (e) {
      setChats(prev)
      reportError(e instanceof Error ? e.message : String(e))
      if (scene.kind === 'all') void loadAllChats({ soft: true })
      else void loadChats(projectId, cwd, { soft: true })
    } finally {
      setDeletingId(null)
    }
  }

  function openChatRow(c: ChatRow, fromAll = false) {
    onSelect(c.projectId)
    setScene({
      kind: 'chat',
      projectId: c.projectId,
      cwd: c.cwd,
      chatId: c.id,
      fromAll,
    })
  }

  if (scene.kind === 'chat' || scene.kind === 'present') {
    const { projectId, cwd, chatId, fromAll } = scene
    const present = scene.kind === 'present' ? scene.present : null
    const minimal = present ? present.minimal !== false : true
    const presentTitle = !present
      ? ''
      : present.scene === 'shell'
        ? present.command
          ? 'Command'
          : 'Shell'
        : present.before != null || present.after != null
          ? 'Changes'
          : 'File'
    // Keep ChatPanel mounted under a present so drafts/WS survive, and ignore
    // further presents until the user taps ← Chat (no auto-jump to next file).
    return (
      <div className="hb-agent h-full min-h-0 relative">
        <div
          className={`h-full min-h-0${present ? ' invisible pointer-events-none absolute inset-0' : ''}`}
          aria-hidden={!!present}
        >
          <ChatPanel
            projects={projects}
            selectedId={projectId}
            onSelect={onSelect}
            variant="agent"
            agentChatId={chatId}
            onAgentBack={() =>
              setScene(
                fromAll
                  ? { kind: 'all' }
                  : { kind: 'chats', projectId, cwd },
              )
            }
            onPresent={(req) => {
              if (req.scene !== 'shell' && req.scene !== 'files') return
              setScene((prev) => {
                if (prev.kind === 'present') return prev
                if (prev.kind !== 'chat') return prev
                return {
                  kind: 'present',
                  projectId: prev.projectId,
                  cwd: prev.cwd,
                  chatId: prev.chatId,
                  fromAll: prev.fromAll,
                  present: { ...req, minimal: req.minimal !== false },
                }
              })
            }}
          />
        </div>
        {present && (
          <div className="hb-agent h-full flex flex-col min-h-0 absolute inset-0 z-10 bg-[var(--hb-bg)]">
            <div className={`hb-agent-bar${minimal ? ' hb-agent-bar--minimal' : ''}`}>
              <button
                type="button"
                className="hb-btn hb-btn-ghost text-sm"
                onClick={() =>
                  setScene({ kind: 'chat', projectId, cwd, chatId, fromAll })
                }
              >
                ← Chat
              </button>
              <span className="hb-agent-bar-title truncate">{presentTitle}</span>
              {!minimal && (
                <AgentAlertsButton
                  unread={unread}
                  inboxOpen={inboxOpen}
                  onToggle={() => {
                    unlockAudio()
                    toggleInbox()
                  }}
                />
              )}
            </div>
            <div className="flex-1 min-h-0">
              {present.scene === 'shell' ? (
                <ShellTab
                  projects={projects}
                  selectedId={projectId}
                  onSelect={onSelect}
                  embedded
                  minimal={minimal}
                  replayCommand={present.command || null}
                  replayOutput={present.output || null}
                  attachSessionIds={present.sessionIds || null}
                  startShellKey={present.newShell ? Date.now() : 0}
                  onClearAttach={() => undefined}
                />
              ) : (
                <FilesTab
                  projects={projects}
                  selectedId={projectId}
                  onSelect={onSelect}
                  embedded
                  minimal={minimal}
                  focusPath={present.path || null}
                  diffBefore={present.before ?? null}
                  diffAfter={present.after ?? null}
                  diffAction={present.action || null}
                  onFocusPathConsumed={() => undefined}
                />
              )}
            </div>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="hb-agent h-full flex flex-col min-h-0">
      <div className="hb-agent-bar">
        <button
          type="button"
          className="hb-btn hb-btn-ghost text-sm"
          onClick={() => {
            if (scene.kind === 'chats' || scene.kind === 'all') setScene({ kind: 'setup' })
            else onHome()
          }}
        >
          ← {scene.kind === 'setup' ? 'Home' : 'Back'}
        </button>
        <div className="min-w-0 flex-1">
          <h1 className="hb-agent-bar-title truncate">Agent</h1>
          <p className="text-mute text-xs truncate">
            {scene.kind === 'setup' && 'Folder or project'}
            {scene.kind === 'all' && 'All chats'}
            {scene.kind === 'chats' &&
              project &&
              `${cwdLabel(scene.cwd, project.name)} · chats`}
          </p>
        </div>
        <AgentAlertsButton
          unread={unread}
          inboxOpen={inboxOpen}
          onToggle={() => {
            unlockAudio()
            toggleInbox()
          }}
        />
      </div>

      <div className="hb-agent-body flex-1 min-h-0 overflow-y-auto">
        {error && <p className="text-sm text-danger mb-3">{error}</p>}

        {scene.kind === 'setup' && (
          <div className="hb-agent-list">
            <section className="hb-agent-section">
              <button
                type="button"
                className="hb-agent-row hb-agent-row--primary"
                onClick={() => setScene({ kind: 'all' })}
              >
                <span className="hb-agent-row-label">All chats</span>
                <span className="hb-agent-row-meta">Every project & folder</span>
              </button>
            </section>

            {recentAbs.length > 0 && (
              <section className="hb-agent-section">
                <p className="hb-agent-setup-dirs-label">Recent directories</p>
                {recentAbs.map((r) => (
                  <button
                    key={r.path}
                    type="button"
                    className="hb-agent-row"
                    onClick={() => chooseAbsDir(r.path, r.projectId)}
                  >
                    <span className="hb-agent-row-label truncate">
                      {cwdLabel(r.path, r.path)}
                    </span>
                    <span className="hb-agent-row-meta font-mono truncate">{r.path}</span>
                  </button>
                ))}
              </section>
            )}

            <section className="hb-agent-section">
              <p className="hb-agent-setup-dirs-label">Host directory</p>
              {!browseOpen ? (
                <button type="button" className="hb-agent-row hb-agent-row--primary" onClick={openBrowse}>
                  <span className="hb-agent-row-label">Browse directory…</span>
                  <span className="hb-agent-row-meta">Bare host paths — no app context</span>
                </button>
              ) : (
                <div className="hb-agent-picker">
                  <p className="text-[11px] font-mono text-mute truncate mb-2">{browsePath}</p>
                  <div className="flex gap-2 mb-2">
                    <button
                      type="button"
                      className="hb-btn hb-btn-ghost text-xs flex-1"
                      disabled={browsePath === '/'}
                      onClick={() => {
                        const parent =
                          browsePath === '/'
                            ? '/'
                            : browsePath.replace(/\/+$/, '').split('/').slice(0, -1).join('/') ||
                              '/'
                        void loadBrowse(parent)
                      }}
                    >
                      Up
                    </button>
                    <button
                      type="button"
                      className="hb-btn hb-btn-primary text-xs flex-1"
                      onClick={() => chooseAbsDir(browsePath)}
                    >
                      Use here
                    </button>
                    <button
                      type="button"
                      className="hb-btn hb-btn-ghost text-xs"
                      onClick={() => setBrowseOpen(false)}
                    >
                      Close
                    </button>
                  </div>
                  <div className="hb-agent-list !gap-1.5">
                    {browseEntries.map((e) => {
                      const childPath = e.path.startsWith('/')
                        ? e.path
                        : `${browsePath.replace(/\/+$/, '')}/${e.name}`
                      return (
                        <button
                          key={childPath}
                          type="button"
                          className="hb-agent-row !py-2"
                          onClick={() => void loadBrowse(childPath)}
                        >
                          <span className="hb-agent-row-label">{e.name}/</span>
                        </button>
                      )
                    })}
                    {browseEntries.length === 0 && (
                      <p className="text-mute text-xs px-1">No subfolders</p>
                    )}
                  </div>
                </div>
              )}
            </section>

            <section className="hb-agent-section">
              <p className="hb-agent-setup-dirs-label">Projects</p>
              {projects.length === 0 && (
                <p className="text-mute text-sm">No projects yet — add one from Work.</p>
              )}
              {projects.map((p) => {
                const open = p.id === focusProjectId
                return (
                  <div
                    key={p.id}
                    className={`hb-agent-setup-card${open ? ' hb-agent-setup-card--open' : ''}`}
                  >
                    <button
                      type="button"
                      className="hb-agent-row !border-0 !rounded-none !bg-transparent"
                      onClick={() => {
                        setFocusProjectId(p.id)
                        onSelect(p.id)
                        setProjectRecents(readAgentRecentDirs(p.id))
                      }}
                    >
                      <span className="hb-agent-row-label">{p.name}</span>
                      <span className="hb-agent-row-meta truncate">{p.path}</span>
                    </button>
                    {open && (
                      <div className="hb-agent-setup-dirs">
                        <button
                          type="button"
                          className="hb-agent-row hb-agent-row--primary"
                          onClick={() => chooseProjectRoot(p.id)}
                        >
                          <span className="hb-agent-row-label">Whole app</span>
                          <span className="hb-agent-row-meta">{p.name}</span>
                        </button>
                        {projectRecents
                          .filter((c) => c)
                          .map((cwd) => (
                            <button
                              key={cwd}
                              type="button"
                              className="hb-agent-row"
                              onClick={() => chooseProjectRel(p.id, cwd)}
                            >
                              <span className="hb-agent-row-label">
                                ./{cwdLabel(cwd, p.name)}
                              </span>
                              <span className="hb-agent-row-meta">Recent in app</span>
                            </button>
                          ))}
                      </div>
                    )}
                  </div>
                )
              })}
            </section>
          </div>
        )}

        {(scene.kind === 'chats' || scene.kind === 'all') && (
          <div className="hb-agent-list">
            {scene.kind === 'chats' && project && (
              <button
                type="button"
                className="hb-agent-row hb-agent-row--primary"
                disabled={busy}
                onClick={() => void newChat(scene.projectId, scene.cwd)}
              >
                <span className="hb-agent-row-label">+ New chat</span>
                <span className="hb-agent-row-meta">
                  {cwdLabel(scene.cwd, project.name)}
                </span>
              </button>
            )}
            {scene.kind === 'all' && (
              <p className="hb-agent-setup-dirs-label">Across every project & folder</p>
            )}
            {loadingChats && <p className="text-mute text-sm px-1">Loading chats…</p>}
            {!loadingChats && chats.length === 0 && (
              <p className="text-mute text-sm px-1">
                {scene.kind === 'all' ? 'No chats yet.' : 'No chats in this folder yet.'}
              </p>
            )}
            {chats.map((c) => {
              const live = c.activity?.live
              const rowKey = `${c.projectId}:${c.id}`
              const isLast =
                scene.kind === 'chats' && c.id === lastChatId && c.projectId === scene.projectId
              const showAllContext = scene.kind === 'all'
              return (
                <SwipeDeleteRow
                  key={rowKey}
                  confirmLabel={c.title}
                  disabled={busy}
                  deleting={deletingId === rowKey}
                  onDelete={() => removeChat(c.projectId, c.cwd, c.id)}
                >
                  <button
                    type="button"
                    className={`hb-agent-row${isLast ? ' hb-agent-row--last' : ''}${
                      live ? ' hb-agent-row--live' : ''
                    }`}
                    onClick={() => openChatRow(c, scene.kind === 'all')}
                  >
                    <span className="hb-agent-row-label truncate">{c.title}</span>
                    {showAllContext && (
                      <span className="hb-agent-row-context truncate" title={c.cwd || c.projectName}>
                        <span className="hb-agent-row-context-proj">{c.projectName}</span>
                        {c.cwd ? (
                          <>
                            <span className="hb-agent-row-context-sep" aria-hidden>
                              ·
                            </span>
                            <span className="hb-agent-row-context-path font-mono">
                              {c.cwd.startsWith('/')
                                ? c.contextLabel
                                : `./${cwdLabel(c.cwd, c.projectName)}`}
                            </span>
                          </>
                        ) : (
                          <>
                            <span className="hb-agent-row-context-sep" aria-hidden>
                              ·
                            </span>
                            <span className="hb-agent-row-context-path">whole app</span>
                          </>
                        )}
                      </span>
                    )}
                    {live && c.activity ? (
                      <span
                        className={`hb-agent-row-live hb-agent-row-live--${c.activity.kind}`}
                        role="status"
                      >
                        <span className="hb-agent-row-live-dot" aria-hidden />
                        <span className="hb-agent-row-live-text truncate">
                          {c.activity.line}
                        </span>
                      </span>
                    ) : (
                      <span className="hb-agent-row-meta">
                        {isLast ? 'last · ' : ''}
                        {c.messageCount} msg{c.messageCount === 1 ? '' : 's'}
                      </span>
                    )}
                  </button>
                </SwipeDeleteRow>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

function AgentAlertsButton({
  unread,
  inboxOpen,
  onToggle,
}: {
  unread: number
  inboxOpen: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      className="hb-agent-alerts"
      onClick={onToggle}
      aria-label={unread > 0 ? `Alerts, ${unread} unread` : 'Alerts'}
      aria-expanded={inboxOpen}
      data-active={inboxOpen}
      title="Alerts"
    >
      <svg className="hb-status-alerts-icon" viewBox="0 0 24 24" aria-hidden>
        <path d="M15 17.5H5.5a1.5 1.5 0 0 1-1.3-2.25C5.3 13.4 6 11.8 6 10a6 6 0 1 1 12 0c0 1.8.7 3.4 1.8 5.25A1.5 1.5 0 0 1 18.5 17.5H15z" />
        <path d="M10 17.5v.75a2 2 0 0 0 4 0v-.75" />
      </svg>
      {unread > 0 && <span className="hb-status-badge">{unread > 9 ? '9+' : unread}</span>}
    </button>
  )
}
