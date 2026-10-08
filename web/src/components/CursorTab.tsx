import type { PresentRequest } from '../lib/chatTypes'
import type { Project } from '../lib/types'
import { ChatPanel } from './ChatPanel'

/** Full-page Chat tab — same engine as Work's dock. */
export function CursorTab({
  projects,
  selectedId,
  onSelect,
  onPresent,
}: {
  projects: Project[]
  selectedId: string
  onSelect: (id: string) => void
  onPresent?: (req: PresentRequest) => void
}) {
  return (
    <ChatPanel
      projects={projects}
      selectedId={selectedId}
      onSelect={onSelect}
      variant="page"
      onPresent={onPresent}
    />
  )
}
