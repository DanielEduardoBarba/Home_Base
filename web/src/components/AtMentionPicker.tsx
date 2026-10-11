'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../lib/api'
import type { FsEntry } from '../lib/types'

const SKIP = new Set([
  'node_modules',
  '.git',
  'dist',
  'web/dist',
  '.next',
  'out',
  '.venv',
  'venv',
  'build',
  'coverage',
])

export type AtPick = { path: string; name: string; type: 'file' | 'dir' }

type Props = {
  projectId: string
  /** Relative project path to start from (chat cwd), or ''. */
  rootPath?: string
  query: string
  open: boolean
  onSelect: (pick: AtPick) => void
  onClose: () => void
}

function joinRel(dir: string, name: string): string {
  if (!dir) return name
  return `${dir.replace(/\/$/, '')}/${name}`
}

/** Popover file/dir picker for @mentions in Chat. */
export function AtMentionPicker({
  projectId,
  rootPath = '',
  query,
  open,
  onSelect,
  onClose,
}: Props) {
  const [browseDir, setBrowseDir] = useState(rootPath || '')
  const [items, setItems] = useState<AtPick[]>([])
  const [loading, setLoading] = useState(false)
  const [active, setActive] = useState(0)
  const listRef = useRef<HTMLUListElement>(null)
  const reqId = useRef(0)
  const onSelectRef = useRef(onSelect)
  const onCloseRef = useRef(onClose)
  onSelectRef.current = onSelect
  onCloseRef.current = onClose

  useEffect(() => {
    if (open) setBrowseDir(rootPath || '')
  }, [open, rootPath])

  useEffect(() => {
    if (!open) return
    const id = ++reqId.current
    setLoading(true)
    const t = window.setTimeout(() => {
      void (async () => {
        let entries: FsEntry[] = []
        try {
          const data = await api.fsList(projectId, browseDir)
          entries = data.entries || []
        } catch {
          if (reqId.current === id) {
            setItems([])
            setLoading(false)
          }
          return
        }
        if (reqId.current !== id) return
        const q = query.trim().toLowerCase()
        const out: AtPick[] = []
        for (const e of entries) {
          if (e.type === 'dir' && (SKIP.has(e.name) || e.name.startsWith('.'))) continue
          const path = e.path || joinRel(browseDir, e.name)
          const hay = `${e.name} ${path}`.toLowerCase()
          if (q && !hay.includes(q)) continue
          out.push({
            path,
            name: e.type === 'dir' ? `${e.name}/` : e.name,
            type: e.type,
          })
        }
        out.sort((a, b) => {
          if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
          return a.name.localeCompare(b.name)
        })
        setItems(out)
        setActive(0)
        setLoading(false)
      })()
    }, query ? 80 : 0)
    return () => window.clearTimeout(t)
  }, [open, projectId, browseDir, query])

  const activate = useCallback((pick: AtPick) => {
    if (pick.type === 'dir') {
      setBrowseDir(pick.path)
      return
    }
    onSelectRef.current(pick)
  }, [])

  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onCloseRef.current()
        return
      }
      if (!items.length) return
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        e.stopPropagation()
        setActive((i) => Math.min(items.length - 1, i + 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        e.stopPropagation()
        setActive((i) => Math.max(0, i - 1))
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        e.stopPropagation()
        const pick = items[active]
        if (pick) activate(pick)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, items, active, activate])

  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-idx="${active}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const empty = useMemo(
    () => !loading && open && items.length === 0,
    [loading, open, items.length],
  )

  if (!open) return null

  const parentDir = browseDir.includes('/')
    ? browseDir.slice(0, browseDir.lastIndexOf('/'))
    : ''

  return (
    <div className="hb-at-picker" role="listbox" aria-label="Attach file context">
      <div className="hb-at-picker-head">
        <span className="font-semibold">@ context</span>
        <span className="text-mute truncate" title={browseDir || '.'}>
          {browseDir || '.'}
          {query ? ` · “${query}”` : ''}
        </span>
      </div>
      {!!browseDir && (
        <button type="button" className="hb-at-picker-up" onClick={() => setBrowseDir(parentDir)}>
          ↑ {parentDir || 'project root'}
        </button>
      )}
      {loading && <p className="hb-at-picker-hint">Loading…</p>}
      {empty && <p className="hb-at-picker-hint">No matches</p>}
      <ul ref={listRef} className="hb-at-picker-list">
        {items.map((it, i) => (
          <li key={it.path}>
            <button
              type="button"
              role="option"
              aria-selected={i === active}
              data-idx={i}
              data-active={i === active}
              className="hb-at-picker-item"
              onMouseEnter={() => setActive(i)}
              onClick={() => activate(it)}
            >
              <span className="hb-at-picker-kind">{it.type === 'dir' ? 'dir' : 'file'}</span>
              <span className="hb-at-picker-name truncate">{it.name}</span>
              <span className="hb-at-picker-path truncate text-mute">
                {it.type === 'dir' ? 'open' : it.path}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <div className="hb-at-picker-foot">
        <span>↑↓ enter · esc</span>
        <button
          type="button"
          className="hb-at-picker-attach-dir"
          disabled={!browseDir}
          title="Attach this folder as context"
          onClick={() => {
            if (!browseDir) return
            const name = browseDir.includes('/')
              ? browseDir.slice(browseDir.lastIndexOf('/') + 1)
              : browseDir
            onSelectRef.current({ path: browseDir, name: `${name}/`, type: 'dir' })
          }}
        >
          Attach folder
        </button>
      </div>
    </div>
  )
}

/** Detect an active @mention at the caret. */
export function detectAtMention(
  value: string,
  caret: number,
): { start: number; query: string } | null {
  const before = value.slice(0, caret)
  const m = /(?:^|[\s([{])@([^\s@]*)$/.exec(before)
  if (!m) return null
  const start = before.lastIndexOf('@')
  if (start < 0) return null
  return { start, query: m[1] || '' }
}
