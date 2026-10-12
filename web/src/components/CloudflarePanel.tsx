'use client'

import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/api'
import { useSceneRefresh } from '../lib/sceneRefresh'

type CfStatus = Awaited<ReturnType<typeof api.cloudflareStatus>>

export function CloudflarePanel({ embedded = false }: { embedded?: boolean }) {
  const [status, setStatus] = useState<CfStatus | null>(null)
  const [error, setError] = useState('')
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState('')
  const [token, setToken] = useState('')
  const [hostname, setHostname] = useState('')

  const load = useCallback(async () => {
    try {
      const s = await api.cloudflareStatus()
      setStatus(s)
      setHostname((prev) => prev || s.hostname || '')
      setError('')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useSceneRefresh(load)
  useEffect(() => {
    void load()
  }, [load])

  async function run(label: string, fn: () => Promise<unknown>) {
    setBusy(label)
    setError('')
    setMsg('')
    try {
      await fn()
      setMsg('Done')
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy('')
    }
  }

  const body = (
    <div className="space-y-3">
      {!embedded && <h2 className="hb-label">Cloudflare Tunnel</h2>}
      <p className="text-xs text-mute leading-relaxed">
        Reach Home Base with a private HTTPS link — no public IP or router port.
      </p>

      {status && (
        <div className="flex flex-wrap gap-2 text-[11px]">
          <span className={`rounded-full px-2 py-0.5 border ${status.installed ? 'border-ok/40 text-ok' : 'border-line text-mute'}`}>
            {status.installed ? 'Installed' : 'Not installed'}
          </span>
          <span className={`rounded-full px-2 py-0.5 border ${status.running ? 'border-ok/40 text-ok' : 'border-line text-mute'}`}>
            {status.running ? 'Running' : 'Stopped'}
          </span>
        </div>
      )}

      {status?.publicUrl && (
        <p className="font-mono text-xs break-all text-sky">{status.publicUrl}</p>
      )}

      {!status?.installed && (
        <div className="space-y-2">
          {status?.linux ? (
            <button
              type="button"
              className="hb-btn hb-btn-primary text-sm !min-h-10 w-full"
              disabled={!!busy}
              onClick={() => void run('install', () => api.cloudflareInstall())}
            >
              {busy === 'install' ? '…' : 'Install cloudflared'}
            </button>
          ) : (
            <p className="text-xs text-mute font-mono leading-relaxed">
              {status?.guidance.installMac || 'brew install cloudflare/cloudflare/cloudflared'}
            </p>
          )}
        </div>
      )}

      {status?.installed && (
        <div className="space-y-2">
          <label className="block space-y-1">
            <span className="text-xs text-mute">Tunnel token (from Cloudflare Zero Trust)</span>
            <input
              type="password"
              className="w-full rounded-[var(--radius-control)] bg-panel-2 border border-line px-3 py-2.5 text-sm font-mono"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="Paste token"
              autoComplete="off"
            />
          </label>
          <label className="block space-y-1">
            <span className="text-xs text-mute">Public hostname</span>
            <input
              className="w-full rounded-[var(--radius-control)] bg-panel-2 border border-line px-3 py-2.5 text-sm"
              value={hostname}
              onChange={(e) => setHostname(e.target.value)}
              placeholder="home.example.com"
            />
          </label>
          <button
            type="button"
            className="hb-btn hb-btn-primary text-sm !min-h-10 w-full"
            disabled={!!busy || !token.trim()}
            onClick={() =>
              void run('cfg', () =>
                api.cloudflareConfigure({
                  token: token.trim(),
                  hostname: hostname.trim() || undefined,
                }),
              )
            }
          >
            {busy === 'cfg' ? '…' : 'Save & start tunnel'}
          </button>
          {hostname.trim() && (
            <button
              type="button"
              className="hb-btn hb-btn-ghost text-sm !min-h-10 w-full"
              disabled={!!busy}
              onClick={() => void run('host', () => api.cloudflareHostname(hostname.trim()))}
            >
              Update hostname only
            </button>
          )}
          <div className="flex gap-2">
            <button
              type="button"
              className="hb-btn hb-btn-ghost text-sm !min-h-10 flex-1"
              disabled={!!busy}
              onClick={() => void run('start', () => api.cloudflareStart())}
            >
              Start
            </button>
            <button
              type="button"
              className="hb-btn hb-btn-ghost text-sm !min-h-10 flex-1"
              disabled={!!busy}
              onClick={() => void run('stop', () => api.cloudflareStop())}
            >
              Stop
            </button>
          </div>
          <a
            href={status.guidance.dashboard}
            target="_blank"
            rel="noreferrer"
            className="block text-xs text-sky underline underline-offset-2"
          >
            Open Cloudflare dashboard
          </a>
        </div>
      )}

      {error && <p className="text-danger text-xs">{error}</p>}
      {msg && <p className="text-sky text-xs">{msg}</p>}
    </div>
  )

  if (embedded) return body
  return <section className="hb-surface p-3.5 space-y-2.5">{body}</section>
}
