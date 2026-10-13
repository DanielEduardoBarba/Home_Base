'use client'

import dynamic from 'next/dynamic'
import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/api'
import type { Project } from '../lib/types'
import { ChatPanel, writeDockOpen } from './ChatPanel'

const ViewTab = dynamic(() => import('./ViewTab').then((m) => m.ViewTab), {
  ssr: false,
  loading: () => (
    <div className="h-full flex items-center justify-center text-mute text-sm">Loading desktop…</div>
  ),
})

type ArmInfo = {
  armed: boolean
  remainingSec: number
  linux: boolean
  platform: string
  error?: string | null
  display?: string
  screenW?: number
  screenH?: number
  workspace?: string
}

function formatRemain(sec: number): string {
  if (sec <= 0) return ''
  const m = Math.floor(sec / 60)
  const s = sec % 60
  if (m <= 0) return `${s}s`
  return `${m}m ${s.toString().padStart(2, '0')}s`
}

/**
 * Vision — live X11 desktop + chat dock. Arm unlocks AI mouse/keyboard tools.
 * Chat cwd defaults to the seat-user ~/.homebase workspace.
 */
export function HomeVisionTab({
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
  // Vision is chat-first: start with the dock open (still persisted on toggle).
  const [dockOpen, setDockOpenState] = useState(true)
  const [arm, setArm] = useState<ArmInfo>({
    armed: false,
    remainingSec: 0,
    linux: true,
    platform: 'linux',
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [workspace, setWorkspace] = useState('')

  function setDockOpen(open: boolean) {
    writeDockOpen(open)
    setDockOpenState(open)
  }

  const refresh = useCallback(async () => {
    try {
      const st = await api.visionStatus()
      setArm({
        armed: Boolean(st.armed),
        remainingSec: Number(st.remainingSec || 0),
        linux: st.linux !== false,
        platform: st.platform || 'unknown',
        error: st.error,
        display: st.display,
        screenW: st.screenW,
        screenH: st.screenH,
        workspace: st.workspace,
      })
      if (st.workspace) setWorkspace(String(st.workspace))
      setError('')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    void refresh()
    const id = window.setInterval(() => void refresh(), 5000)
    return () => window.clearInterval(id)
  }, [refresh])

  async function toggleArm() {
    setBusy(true)
    try {
      if (arm.armed) {
        await api.visionDisarm()
      } else {
        const res = await api.visionArm(15 * 60)
        if (res.ok === false && res.error) {
          setError(res.error)
        }
      }
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const linux = arm.linux
  const project =
    projects.find((p) => p.id === selectedId) ||
    projects.find((p) => p.id === 'homebase') ||
    projects[0]
  const wsLabel = workspace
    ? `~/.homebase (${workspace.split('/').filter(Boolean).slice(-2).join('/')})`
    : '~/.homebase'

  return (
    <div className="hb-vision h-full min-h-0 flex flex-col">
      <header className="hb-vision-bar shrink-0">
        <button type="button" className="hb-status-home shrink-0" onClick={onHome} title="Home">
          Home
        </button>
        <div className="hb-vision-bar-title min-w-0">
          <h1 className="hb-vision-title">Vision</h1>
          <p className="hb-vision-sub truncate">
            {!linux ? (
              <span className="text-amber">Desktop control needs Linux X11</span>
            ) : arm.armed ? (
              <>
                <span className="text-ok">Armed</span>
                {arm.remainingSec > 0 ? (
                  <>
                    <span className="hb-status-sep">·</span>
                    {formatRemain(arm.remainingSec)}
                  </>
                ) : null}
                {arm.display ? (
                  <>
                    <span className="hb-status-sep">·</span>
                    {arm.display}
                  </>
                ) : null}
              </>
            ) : (
              <>
                <span className="text-mute">Disarmed</span>
                <span className="hb-status-sep">·</span>
                look-only until you Arm
              </>
            )}
            {workspace ? (
              <>
                <span className="hb-status-sep">·</span>
                <span className="font-mono text-[11px]">{wsLabel}</span>
              </>
            ) : null}
          </p>
        </div>
        <div className="hb-vision-bar-actions shrink-0">
          {projects.length > 1 && (
            <select
              className="hb-select hb-select-sm"
              aria-label="Project for chat"
              value={project?.id || ''}
              onChange={(e) => onSelect(e.target.value)}
            >
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name || p.id}
                </option>
              ))}
            </select>
          )}
          <button
            type="button"
            className={`hb-btn hb-btn-sm ${arm.armed ? 'hb-btn-danger' : 'hb-btn-primary'}`}
            disabled={busy || !linux}
            onClick={() => void toggleArm()}
            title={
              linux
                ? arm.armed
                  ? 'Stop AI mouse/keyboard control'
                  : 'Allow AI to control mouse and keyboard for 15 minutes'
                : 'Vision requires Linux X11'
            }
          >
            {arm.armed ? 'Disarm' : 'Arm'}
          </button>
        </div>
      </header>

      {(error || (!linux && arm.error)) && (
        <p className="hb-vision-banner text-danger" role="status">
          {error || arm.error}
        </p>
      )}

      <div className="hb-vision-body flex-1 min-h-0 flex flex-col relative">
        <div className="hb-vision-stage flex-1 min-h-0" data-hb-no-ptr="1">
          {linux ? (
            <ViewTab embedded />
          ) : (
            <div className="hb-vision-unavailable">
              <p className="text-sm font-medium">Vision is Linux-only</p>
              <p className="text-xs text-mute mt-2 max-w-sm text-center">
                Live desktop control uses X11 / XWayland on the Ubuntu host. Chat still works for
                project work; Arm and mouse/keyboard tools stay disabled on this platform.
              </p>
            </div>
          )}
        </div>

        <p className="hb-vision-hint shrink-0">
          Chat starts in <code>~/.homebase</code>. Prefer GUI apps via{' '}
          <code>homebase_vision_*</code> while Armed; use Shell/Files/CLI when that is clearly
          better.
        </p>

        {workspace ? (
          <ChatPanel
            projects={projects}
            selectedId={project?.id || selectedId}
            onSelect={onSelect}
            variant="dock"
            dockOpen={dockOpen}
            onDockOpenChange={setDockOpen}
            defaultCwd={workspace}
            defaultCwdLabel="Vision (~/.homebase)"
          />
        ) : (
          <p className="hb-vision-hint shrink-0 text-mute text-xs">
            Preparing Vision workspace (~/.homebase)…
          </p>
        )}
      </div>
    </div>
  )
}
