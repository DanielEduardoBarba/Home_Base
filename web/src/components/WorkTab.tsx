import { useEffect, useState } from 'react'
import type { PresentRequest, WorkScene } from '../lib/chatTypes'
import type { Project } from '../lib/types'
import type { WorkItem } from '../lib/uiPrefs'
import { AppsTab } from './AppsTab'
import { ChatPanel, readDockOpen, writeDockOpen } from './ChatPanel'
import { CursorTab } from './CursorTab'
import { FilesTab } from './FilesTab'
import { ProjectSelect } from './ProjectSelect'
import { ShellTab } from './ShellTab'

const ITEMS: { id: WorkItem; label: string }[] = [
  { id: 'apps', label: 'Apps' },
  { id: 'shell', label: 'Shell' },
  { id: 'files', label: 'Files' },
  { id: 'chat', label: 'Chat' },
]

/**
 * Work = one workspace: project + Apps / Shell / Files / Chat.
 * The parent remembers the project and the pane across visits.
 */
export function WorkTab({
  projects,
  selectedId,
  onSelect,
  onRefresh,
  item,
  onItemChange,
  present,
  presentKey = 0,
}: {
  projects: Project[]
  selectedId: string
  onSelect: (id: string) => void
  onRefresh: () => void | Promise<void>
  item: WorkItem
  onItemChange: (item: WorkItem) => void
  /** Latest present request (from Chat tab or dock). */
  present?: PresentRequest | null
  /** Increments on each present — survives Strict Mode remounts. */
  presentKey?: number
}) {
  const [attachSessionIds, setAttachSessionIds] = useState<string[] | null>(() =>
    present?.sessionIds?.length ? present.sessionIds : null,
  )
  const [startShellKey, setStartShellKey] = useState(() =>
    present?.scene === 'shell' && present.newShell ? presentKey || 1 : 0,
  )
  const [focusPath, setFocusPath] = useState<string | null>(() =>
    present?.scene === 'files' ? present.path || null : null,
  )
  const [diffBefore, setDiffBefore] = useState<string | null>(() =>
    present?.scene === 'files' ? present.before ?? null : null,
  )
  const [diffAfter, setDiffAfter] = useState<string | null>(() =>
    present?.scene === 'files' ? present.after ?? null : null,
  )
  const [diffAction, setDiffAction] = useState<string | null>(() =>
    present?.scene === 'files' ? present.action || null : null,
  )
  // Incoming present from Chat → start with dock minimized so the scene is visible
  const [dockOpen, setDockOpenState] = useState(false)
  // 0 so the first presentKey from Chat→Work is treated as a change
  const [lastPresentKey, setLastPresentKey] = useState(0)

  useEffect(() => {
    if (present && presentKey) {
      setDockOpenState(false)
      return
    }
    setDockOpenState(readDockOpen())
  }, [present, presentKey])

  function setDockOpen(open: boolean) {
    writeDockOpen(open)
    setDockOpenState(open)
  }

  function applyShellPresent(req: PresentRequest, key: number) {
    if (req.sessionIds?.length) {
      setAttachSessionIds(req.sessionIds)
    } else if (req.newShell) {
      setAttachSessionIds(null)
      setStartShellKey(key || Date.now())
    } else {
      setAttachSessionIds(null)
    }
  }

  function applyFilesPresent(req: PresentRequest) {
    setFocusPath(req.path || null)
    setDiffBefore(req.before ?? null)
    setDiffAfter(req.after ?? null)
    setDiffAction(req.action || null)
  }

  function showScene(scene: WorkScene) {
    onItemChange(scene)
  }

  // Apply present when key changes (Chat → Work, or dock buttons while here)
  useEffect(() => {
    if (!present || !presentKey || presentKey === lastPresentKey) return
    setLastPresentKey(presentKey)
    showScene(present.scene)
    if (present.scene === 'shell') applyShellPresent(present, presentKey)
    if (present.scene === 'files') applyFilesPresent(present)
    setDockOpen(false)
    // showScene writes the remembered pane; present identity is presentKey.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [present, presentKey, lastPresentKey])

  function applyPresent(req: PresentRequest) {
    const key = Date.now()
    setLastPresentKey(key)
    showScene(req.scene)
    if (req.scene === 'shell') applyShellPresent(req, key)
    if (req.scene === 'files') applyFilesPresent(req)
    setDockOpen(false)
  }

  return (
    <div className="hb-work h-full flex flex-col min-h-0 hb-with-nav">
      <div className="hb-chrome shrink-0">
        <div className="hb-chrome-inner">
          <div className="hb-work-chrome-row">
            <ProjectSelect
              projects={projects}
              selectedId={selectedId}
              onSelect={onSelect}
              className="hb-work-project-select"
            />
            <div className="hb-work-scenes" role="tablist" aria-label="Workspace">
              {ITEMS.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  role="tab"
                  aria-selected={item === s.id}
                  data-active={item === s.id}
                  className="hb-work-scene"
                  onClick={() => onItemChange(s.id)}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="hb-work-body flex-1 min-h-0 relative">
        <div
          key={item === 'shell' ? `shell-${startShellKey}` : item}
          className="hb-work-main hb-work-scene-enter h-full min-h-0 overflow-hidden"
        >
          {item === 'apps' && (
            <div className="h-full overflow-y-auto">
              <AppsTab
                projects={projects}
                selectedId={selectedId}
                onSelect={onSelect}
                onRefresh={onRefresh}
                embedded
                onAskAiWire={() => {
                  onItemChange('apps')
                  setDockOpen(true)
                }}
                onOpenShell={(ids) => {
                  const list = Array.isArray(ids) ? ids : ids ? [ids] : []
                  applyPresent({
                    scene: 'shell',
                    sessionIds: list.length ? list : undefined,
                    newShell: !list.length,
                  })
                }}
              />
            </div>
          )}
          {item === 'shell' && (
            <ShellTab
              projects={projects}
              selectedId={selectedId}
              onSelect={onSelect}
              embedded
              attachSessionIds={attachSessionIds}
              startShellKey={startShellKey}
              onClearAttach={() => setAttachSessionIds(null)}
            />
          )}
          {item === 'files' && (
            <FilesTab
              projects={projects}
              selectedId={selectedId}
              onSelect={onSelect}
              embedded
              focusPath={focusPath}
              diffBefore={diffBefore}
              diffAfter={diffAfter}
              diffAction={diffAction}
              onFocusPathConsumed={() => setFocusPath(null)}
            />
          )}
          {item === 'chat' && (
            <CursorTab
              projects={projects}
              selectedId={selectedId}
              onSelect={onSelect}
              onPresent={applyPresent}
            />
          )}
        </div>

        {item !== 'chat' && (
          <ChatPanel
            projects={projects}
            selectedId={selectedId}
            onSelect={onSelect}
            variant="dock"
            dockOpen={dockOpen}
            onDockOpenChange={setDockOpen}
            onPresent={applyPresent}
          />
        )}
      </div>
    </div>
  )
}
