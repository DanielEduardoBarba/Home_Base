'use client'

import { useMemo, useState } from 'react'
import type { Project } from '../lib/types'
import { openPortInNewTab, portTileHref } from '../lib/portTile'
import { suppressPinLockFor } from '../lib/pinLockSuppress'

function webglPort(project: Project): number | null {
  const p =
    (project.portsStatus || []).find((x) => x.id === 'webgl') ||
    (project.ports || []).find((x) => x.id === 'webgl')
  const n = Number(p?.port)
  return Number.isFinite(n) && n > 0 ? n : null
}

function webglUp(project: Project): boolean {
  const ps = (project.portsStatus || []).find((x) => x.id === 'webgl')
  return Boolean(ps?.up ?? ps?.listening)
}

/** Unity WebGL live preview: phone-sized iframe + open-on-phone link. */
export function WebGLPreview({ project }: { project: Project }) {
  const port = webglPort(project)
  const up = webglUp(project)
  const [bust, setBust] = useState(0)

  const href = useMemo(() => {
    if (!port || typeof window === 'undefined') return ''
    return portTileHref(port, window.location)
  }, [port])

  if (!port) return null

  const isUnity = (project.ports || []).some((p) => p.id === 'webgl')
  if (!isUnity) return null

  return (
    <div className="space-y-1.5 pt-1 border-t border-line/60">
      <div className="flex items-center justify-between gap-2">
        <span className="hb-label">WebGL live view</span>
        <div className="flex items-center gap-1.5">
          {up ? (
            <button
              type="button"
              className="hb-btn hb-btn-ghost !min-h-8 !px-2 text-[11px]"
              onClick={() => setBust((n) => n + 1)}
            >
              Reload
            </button>
          ) : null}
          <button
            type="button"
            className="hb-btn hb-btn-ghost !min-h-8 !px-2 text-[11px]"
            disabled={!up || !href}
            title={href || 'Start WebGL live view first'}
            onClick={() => {
              if (!href) return
              suppressPinLockFor(3000)
              openPortInNewTab(href)
            }}
          >
            Open on phone
          </button>
        </div>
      </div>
      <p className="text-[10px] text-mute break-all">
        {up ? href || `:${port}` : `Not serving — Start “WebGL live view” (:${port})`}
      </p>
      <div
        className="mx-auto w-full max-w-[390px] overflow-hidden rounded-lg border border-line/70 bg-black"
        style={{ aspectRatio: '390 / 844' }}
      >
        {up && href ? (
          <iframe
            key={`${href}-${bust}`}
            title={`${project.name} WebGL`}
            src={`${href}${href.includes('?') ? '&' : '?'}_hb=${bust}`}
            className="h-full w-full border-0 bg-black"
            allow="autoplay; fullscreen"
          />
        ) : (
          <div className="flex h-full min-h-[12rem] items-center justify-center px-4 text-center text-[11px] text-mute">
            Phone preview (~390×844). Start the WebGL action to load the build here.
          </div>
        )}
      </div>
    </div>
  )
}
