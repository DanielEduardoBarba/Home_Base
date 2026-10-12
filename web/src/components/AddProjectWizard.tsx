'use client'

import { useEffect, useState } from 'react'
import { api } from '../lib/api'

type Props = {
  open: boolean
  onClose: () => void
  onAdded: (projectId: string) => void
}

export function AddProjectWizard({ open, onClose, onAdded }: Props) {
  const [step, setStep] = useState(0)
  const [name, setName] = useState('')
  const [path, setPath] = useState('')
  const [preset, setPreset] = useState('')
  const [presets, setPresets] = useState<{ id: string; name: string }[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return
    setStep(0)
    setName('')
    setPath('')
    setPreset('')
    setError('')
    void api.presets().then((r) => setPresets(r.presets)).catch(() => setPresets([]))
  }, [open])

  if (!open) return null

  async function submit() {
    setBusy(true)
    setError('')
    try {
      const r = await api.upsertProject({
        path: path.trim(),
        name: name.trim() || undefined,
        preset: preset || undefined,
      })
      onAdded(r.project.id)
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 hb-overlay backdrop-blur-sm flex items-end sm:items-center justify-center p-4">
      <div className="w-full max-w-md hb-surface p-5 space-y-4 hb-enter">
        <div className="flex items-center justify-between gap-2">
          <h2 className="font-display text-xl font-extrabold tracking-tight">Add app</h2>
          <button type="button" className="hb-btn hb-btn-ghost !min-h-9 text-sm" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="flex gap-1.5" aria-hidden>
          {[0, 1, 2, 3].map((i) => (
            <span
              key={i}
              className={`h-1 flex-1 rounded-full ${i <= step ? 'bg-accent' : 'bg-line'}`}
            />
          ))}
        </div>

        {step === 0 && (
          <div className="space-y-3">
            <p className="text-sm text-mute">Name this project.</p>
            <input
              className="w-full rounded-[var(--radius-control)] bg-panel-2 border border-line px-3 py-3 text-sm"
              placeholder="My App"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
            <button
              type="button"
              className="hb-btn hb-btn-primary w-full !min-h-11"
              disabled={!name.trim()}
              onClick={() => setStep(1)}
            >
              Continue
            </button>
          </div>
        )}

        {step === 1 && (
          <div className="space-y-3">
            <p className="text-sm text-mute">Folder path on this computer.</p>
            <input
              className="w-full rounded-[var(--radius-control)] bg-panel-2 border border-line px-3 py-3 text-sm font-mono"
              placeholder="/home/you/projects/my-app"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              autoFocus
            />
            <div className="flex gap-2">
              <button type="button" className="hb-btn hb-btn-ghost flex-1 !min-h-11" onClick={() => setStep(0)}>
                Back
              </button>
              <button
                type="button"
                className="hb-btn hb-btn-primary flex-1 !min-h-11"
                disabled={!path.trim().startsWith('/')}
                onClick={() => setStep(2)}
              >
                Continue
              </button>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-3">
            <p className="text-sm text-mute">Start from a template? Optional.</p>
            <div className="space-y-2">
              <button
                type="button"
                className={`w-full text-left rounded-[var(--radius-control)] border px-3 py-3 text-sm ${
                  !preset ? 'border-accent bg-accent/10' : 'border-line bg-panel-2'
                }`}
                onClick={() => setPreset('')}
              >
                Blank — wire actions later
              </button>
              {presets.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={`w-full text-left rounded-[var(--radius-control)] border px-3 py-3 text-sm ${
                    preset === p.id ? 'border-accent bg-accent/10' : 'border-line bg-panel-2'
                  }`}
                  onClick={() => setPreset(p.id)}
                >
                  {p.name}
                </button>
              ))}
            </div>
            <div className="flex gap-2">
              <button type="button" className="hb-btn hb-btn-ghost flex-1 !min-h-11" onClick={() => setStep(1)}>
                Back
              </button>
              <button type="button" className="hb-btn hb-btn-primary flex-1 !min-h-11" onClick={() => setStep(3)}>
                Continue
              </button>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="space-y-3">
            <p className="text-sm text-mute">Confirm</p>
            <div className="rounded-[var(--radius-control)] border border-line bg-panel-2 p-3 text-sm space-y-1">
              <p>
                <span className="text-mute">Name</span> · {name}
              </p>
              <p className="font-mono text-xs break-all">
                <span className="text-mute font-sans">Path</span> · {path}
              </p>
              <p>
                <span className="text-mute">Template</span> · {preset || 'Blank'}
              </p>
            </div>
            <p className="text-xs text-mute">Need scripts later? Ask Chat to wire them.</p>
            {error && <p className="text-danger text-sm">{error}</p>}
            <div className="flex gap-2">
              <button type="button" className="hb-btn hb-btn-ghost flex-1 !min-h-11" onClick={() => setStep(2)}>
                Back
              </button>
              <button
                type="button"
                className="hb-btn hb-btn-primary flex-1 !min-h-11"
                disabled={busy}
                onClick={() => void submit()}
              >
                {busy ? '…' : 'Add'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
