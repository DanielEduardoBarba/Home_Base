import { useEffect, useState } from 'react'
import type { PresentRequest, WorkScene } from '../lib/chatTypes'
import type { Project } from '../lib/types'
import { AppsTab } from './AppsTab'
import { ChatPanel, readDockOpen, writeDockOpen } from './ChatPanel'
import { FilesTab } from './FilesTab'
import { ProjectSelect } from './ProjectSelect'
import { ShellTab } from './ShellTab'

const SCENES: { id: WorkScene; label: string }[] = [
  { id: 'apps', label: 'Apps' },
  { id: 'shell', label: 'Shell' },
  { id: 'files', label: 'Files' },
]

/**
 * Work = workspace like Cursor IDE:
 * project + scene dropdowns, chat dock bottom-right.
 */
export function WorkTab({
  projects,
  selectedId,
  onSelect,
  onRefresh,
  present,
  presentKey = 0,
}: {
  projects: Project[]
  selectedId: string
  onSelect: (id: string) => void
  onRefresh: () => void | Promise<void>
  /** Latest present request (from Chat tab or dock). */
  present?: PresentRequest | null
  /** Increments on each present — survives Strict Mode remounts. */
  presentKey?: number
}) {
  const [scene, setScene] = useState<WorkScene>(() => present?.scene || 'apps')
  const [attachSessionIds, setAttachSessionIds] = useState<string[] | null>(() =>
    present?.sessionIds?.length ? present.sessionIds : null,
  )
  const [startShellKey, setStartShellKey] = useState(() =>
    present?.scene === 'shell' && present.newShell ? presentKey || 1 : 0,
  )
  const [focusPath, setFocusPath] = useState<string | null>(() =>
    present?.scene === 'files' ? present.path || null : null,
  )
  const [dockOpen, setDockOpenState] = useState(() => readDockOpen())
  const [lastPresentKey, setLastPresentKey] = useState(presentKey)

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

  // Apply present when key changes (Chat → Work, or dock buttons while here)
  useEffect(() => {
    if (!present || !presentKey || presentKey === lastPresentKey) return
    setLastPresentKey(presentKey)
    setScene(present.scene)
    if (present.scene === 'shell') applyShellPresent(present, presentKey)
    if (present.scene === 'files') setFocusPath(present.path || null)
    // Present from Chat opens the dock once; preference is still persisted
    setDockOpen(true)
  }, [present, presentKey, lastPresentKey])

  function applyPresent(req: PresentRequest) {
    const key = Date.now()
    setLastPresentKey(key)
    setScene(req.scene)
    if (req.scene === 'shell') applyShellPresent(req, key)
    if (req.scene === 'files') setFocusPath(req.path || null)
    setDockOpen(true)
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
            <select
              value={scene}
              onChange={(e) => setScene(e.target.value as WorkScene)}
              className="hb-select hb-work-scene-select"
              aria-label="Workspace view"
            >
              {SCENES.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      <div className="hb-work-body flex-1 min-h-0 relative">
        <div className="hb-work-main h-full min-h-0 overflow-hidden">
          {scene === 'apps' && (
            <div className="h-full overflow-y-auto">
              <AppsTab
                projects={projects}
                selectedId={selectedId}
                onSelect={onSelect}
                onRefresh={onRefresh}
                embedded
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
          {scene === 'shell' && (
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
          {scene === 'files' && (
            <FilesTab
              projects={projects}
              selectedId={selectedId}
              onSelect={onSelect}
              embedded
              focusPath={focusPath}
              onFocusPathConsumed={() => setFocusPath(null)}
            />
          )}
        </div>

        <ChatPanel
          projects={projects}
          selectedId={selectedId}
          onSelect={onSelect}
          variant="dock"
          dockOpen={dockOpen}
          onDockOpenChange={setDockOpen}
          onPresent={applyPresent}
        />
      </div>
    </div>
  )
}
