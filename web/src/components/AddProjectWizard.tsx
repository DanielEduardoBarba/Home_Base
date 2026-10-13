'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../lib/api'
import { setPendingCompose } from '../lib/uiPrefs'

export type AddProjectResult = {
  projectId: string
  askAi: boolean
  path: string
  name: string
}

type Props = {
  open: boolean
  onClose: () => void
  onAdded: (result: AddProjectResult) => void
}

function basenamePath(path: string): string {
  const parts = path.replace(/\/+$/, '').split('/').filter(Boolean)
  return parts[parts.length - 1] || ''
}

function wirePrompt(name: string, path: string): string {
  return [
    `I just added my own project "${name}" to Home Base as a blank app (no Run/Ship actions yet).`,
    `Path: ${path}`,
    '',
    'Please inspect the repo and wire it cleanly into Home Base:',
    '1. Detect how to run / build / ship (package.json, build.sh, compose, Makefile, etc.).',
    '2. Propose ports + actions (Run, Stop, Ship when relevant) with homebase_project_upsert — keep this project id and path; only fill ports/actions/stateDir.',
    '3. Prefer patterns from existing presets when they fit; do not delete project files.',
    '4. Summarize what you configured and how to Start it from Apps.',
  ].join('\n')
}

export function AddProjectWizard({ open, onClose, onAdded }: Props) {
  const [step, setStep] = useState(0)
  const [name, setName] = useState('')
  const [nameTouched, setNameTouched] = useState(false)
  const [path, setPath] = useState('')
  const [preset, setPreset] = useState('')
  const [askAi, setAskAi] = useState(true)
  const [presets, setPresets] = useState<{ id: string; name: string }[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const panelRef = useRef<HTMLDivElement>(null)
  const pathRef = useRef<HTMLInputElement>(null)
  const nameRef = useRef<HTMLInputElement>(null)

  const selectablePresets = useMemo(
    () => presets.filter((p) => p.id !== 'homebase'),
    [presets],
  )

  useEffect(() => {
    if (!open) return
    setStep(0)
    setName('')
    setNameTouched(false)
    setPath('')
    setPreset('')
    setAskAi(true)
    setError('')
    setBusy(false)
    void api
      .presets()
      .then((r) => setPresets(r.presets))
      .catch(() => setPresets([]))
  }, [open])

  useEffect(() => {
    if (!open || step !== 0) return
    const t = window.setTimeout(() => pathRef.current?.focus(), 50)
    return () => window.clearTimeout(t)
  }, [open, step])

  /** Keep focused fields above the soft keyboard inside the vv panel. */
  useEffect(() => {
    if (!open) return
    const onFocusIn = (e: FocusEvent) => {
      const t = e.target
      if (!(t instanceof HTMLElement)) return
      if (t.tagName !== 'INPUT' && t.tagName !== 'TEXTAREA') return
      window.setTimeout(() => {
        t.scrollIntoView({ block: 'center', behavior: 'smooth' })
        panelRef.current?.scrollTo({
          top: Math.max(0, (panelRef.current.scrollTop || 0) - 8),
        })
      }, 120)
    }
    document.addEventListener('focusin', onFocusIn)
    return () => document.removeEventListener('focusin', onFocusIn)
  }, [open])

  if (!open) return null

  const pathOk = path.trim().startsWith('/')
  const nameOk = Boolean(name.trim())
  const modeLabel = preset
    ? selectablePresets.find((p) => p.id === preset)?.name || preset
    : 'Own project (blank)'

  function onPathChange(next: string) {
    setPath(next)
    if (!nameTouched) {
      const base = basenamePath(next.trim())
      setName(base)
    }
  }

  async function submit() {
    setBusy(true)
    setError('')
    try {
      const abs = path.trim()
      const label = name.trim() || basenamePath(abs)
      const r = await api.upsertProject({
        path: abs,
        name: label,
        preset: preset || undefined,
      })
      const wantAi = askAi && !preset
      if (wantAi) {
        setPendingCompose({
          projectId: r.project.id,
          text: wirePrompt(label, abs),
          autoSend: true,
          title: 'Wire app',
        })
      }
      onAdded({
        projectId: r.project.id,
        askAi: wantAi,
        path: abs,
        name: label,
      })
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="hb-vv-overlay hb-overlay backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="hb-add-app-title"
      onClick={onClose}
    >
      <div
        ref={panelRef}
        className="hb-vv-overlay-panel hb-surface p-5 space-y-4 hb-enter shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-2">
          <h2 id="hb-add-app-title" className="font-display text-xl font-extrabold tracking-tight">
            Add app
          </h2>
          <button type="button" className="hb-btn hb-btn-ghost !min-h-9 text-sm" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="flex gap-1.5" aria-hidden>
          {[0, 1].map((i) => (
            <span
              key={i}
              className={`h-1 flex-1 rounded-full ${i <= step ? 'bg-accent' : 'bg-line'}`}
            />
          ))}
        </div>

        {step === 0 && (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <label htmlFor="hb-add-path" className="hb-label">
                Project folder
              </label>
              <p className="text-sm text-mute">
                Absolute path on this computer — your own repo, not a copy.
              </p>
              <input
                id="hb-add-path"
                ref={pathRef}
                className="w-full rounded-[var(--radius-control)] bg-panel-2 border border-line px-3 py-3 text-sm font-mono"
                placeholder="/home/you/projects/my-app"
                value={path}
                onChange={(e) => onPathChange(e.target.value)}
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                enterKeyHint="next"
                inputMode="text"
                autoComplete="off"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && pathOk) {
                    e.preventDefault()
                    nameRef.current?.focus()
                  }
                }}
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="hb-add-name" className="hb-label">
                Display name
              </label>
              <input
                id="hb-add-name"
                ref={nameRef}
                className="w-full rounded-[var(--radius-control)] bg-panel-2 border border-line px-3 py-3 text-sm"
                placeholder="My App"
                value={name}
                onChange={(e) => {
                  setNameTouched(true)
                  setName(e.target.value)
                }}
                enterKeyHint="done"
                autoComplete="off"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && pathOk && nameOk) {
                    e.preventDefault()
                    setStep(1)
                  }
                }}
              />
            </div>
            <button
              type="button"
              className="hb-btn hb-btn-primary w-full !min-h-11"
              disabled={!pathOk || !nameOk}
              onClick={() => setStep(1)}
            >
              Continue
            </button>
          </div>
        )}

        {step === 1 && (
          <div className="space-y-3">
            <div className="space-y-1">
              <p className="hb-label mb-0">How to integrate</p>
              <p className="text-sm text-mute">
                Own projects start blank. Chat can detect Run/Ship for you, or pick a template.
              </p>
            </div>

            <div className="space-y-2">
              <button
                type="button"
                className={`w-full text-left rounded-[var(--radius-control)] border px-3 py-3 ${
                  !preset ? 'border-accent bg-accent/10' : 'border-line bg-panel-2'
                }`}
                onClick={() => {
                  setPreset('')
                  setAskAi(true)
                }}
              >
                <span className="block text-sm font-medium">Own project</span>
                <span className="block text-xs text-mute mt-0.5 leading-relaxed">
                  Keep your folder as-is. Add Run/Ship later — or let Chat wire them now.
                </span>
              </button>
              {selectablePresets.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={`w-full text-left rounded-[var(--radius-control)] border px-3 py-3 ${
                    preset === p.id ? 'border-accent bg-accent/10' : 'border-line bg-panel-2'
                  }`}
                  onClick={() => {
                    setPreset(p.id)
                    setAskAi(false)
                  }}
                >
                  <span className="block text-sm font-medium">{p.name}</span>
                  <span className="block text-xs text-mute mt-0.5">
                    Template ports &amp; actions
                  </span>
                </button>
              ))}
            </div>

            {!preset && (
              <label className="flex items-start gap-2.5 rounded-[var(--radius-control)] border border-line bg-panel-2 px-3 py-3 cursor-pointer">
                <input
                  type="checkbox"
                  className="mt-1 accent-[var(--hb-accent)]"
                  checked={askAi}
                  onChange={(e) => setAskAi(e.target.checked)}
                />
                <span>
                  <span className="block text-sm font-medium">Ask Chat to wire it</span>
                  <span className="block text-xs text-mute mt-0.5 leading-relaxed">
                    Opens Work chat after add and has the agent inspect the repo, then upsert
                    ports and actions.
                  </span>
                </span>
              </label>
            )}

            <div className="rounded-[var(--radius-control)] border border-line bg-panel-2 p-3 text-sm space-y-1">
              <p>
                <span className="text-mute">Name</span> · {name.trim()}
              </p>
              <p className="font-mono text-xs break-all">
                <span className="text-mute font-sans">Path</span> · {path.trim()}
              </p>
              <p>
                <span className="text-mute">Integrate</span> · {modeLabel}
                {!preset && askAi ? ' + Chat' : ''}
              </p>
            </div>

            {error && <p className="text-danger text-sm">{error}</p>}

            <div className="flex gap-2">
              <button
                type="button"
                className="hb-btn hb-btn-ghost flex-1 !min-h-11"
                disabled={busy}
                onClick={() => {
                  setError('')
                  setStep(0)
                }}
              >
                Back
              </button>
              <button
                type="button"
                className="hb-btn hb-btn-primary flex-1 !min-h-11"
                disabled={busy || !pathOk || !nameOk}
                onClick={() => void submit()}
              >
                {busy ? '…' : askAi && !preset ? 'Add & open Chat' : 'Add app'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
