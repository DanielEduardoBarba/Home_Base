'use client'

import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/api'
import { useSceneRefresh } from '../lib/sceneRefresh'

type UnityStatus = Awaited<ReturnType<typeof api.unityStatus>>

export function UnityPanel() {
  const [status, setStatus] = useState<UnityStatus | null>(null)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    try {
      const s = await api.unityStatus()
      setStatus(s)
      setError('')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useSceneRefresh(load)

  useEffect(() => {
    void load()
  }, [load])

  const license = status?.license
  const bridge = status?.bridge

  return (
    <div className="space-y-3">
      {!status && !error ? (
        <p className="text-xs text-mute px-0.5">Loading Unity status…</p>
      ) : null}

      {error ? <p className="text-xs text-danger px-0.5">{error}</p> : null}

      <section className="hb-surface p-3.5 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-text">Setup checks</h3>
          <button
            type="button"
            className="hb-btn text-xs !min-h-8"
            onClick={() => void load()}
          >
            Refresh
          </button>
        </div>
        <ul className="space-y-1.5">
          {(status?.checks || []).map((c) => (
            <li key={c.id} className="text-xs leading-snug">
              <span className={c.ok ? 'text-sky' : 'text-warn'}>
                {c.ok ? 'OK' : '—'}
              </span>
              <span className="text-text font-medium"> · {c.label}</span>
              {c.detail ? (
                <span className="block text-mute mt-0.5 pl-5 break-all">
                  {c.detail}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      </section>

      <section className="hb-surface p-3.5 space-y-2">
        <h3 className="text-sm font-semibold text-text">Account & license</h3>
        <p className="text-xs text-mute">
          Read-only. Emails and serials are never shown. Sign-in / activate only
          via Unity Hub (human).
        </p>
        {license?.products?.length ? (
          <ul className="text-xs space-y-1">
            {license.products.map((p, i) => (
              <li key={`${p.product}-${i}`}>
                <span className="text-text">{p.product}</span>
                {p.type ? (
                  <span className="text-mute"> · {p.type}</span>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-mute">
            {license?.note || 'No license products reported'}
          </p>
        )}
        <p className="text-xs text-mute">
          Entitlement file:{' '}
          {license?.entitlementPresent ? 'present' : 'absent'} · Legacy ULF:{' '}
          {license?.legacyUlfPresent ? 'present' : 'absent'}
        </p>
      </section>

      <section className="hb-surface p-3.5 space-y-2">
        <h3 className="text-sm font-semibold text-text">Editor & modules</h3>
        <ul className="text-xs space-y-1">
          {(status?.editors?.editors || []).map((ed) => (
            <li key={ed.version} className="leading-snug">
              <span className="text-text font-medium">{ed.version}</span>
              <span className="text-mute">
                {' '}
                ·{' '}
                {ed.modules
                  .map(
                    (m) =>
                      `${m.id}${m.installed ? '' : ' (missing)'}`,
                  )
                  .join(', ')}
              </span>
            </li>
          ))}
          {!status?.editors?.editors?.length ? (
            <li className="text-mute">No Editor under ~/Unity/Hub/Editor</li>
          ) : null}
        </ul>
        <p className="text-xs text-mute">
          WebGL:{' '}
          <span className="text-text">
            {status?.editors?.webglReady ? 'ready' : 'not installed'}
          </span>
          {' · '}
          CLI:{' '}
          <span className="text-text">
            {status?.editors?.cliPresent
              ? status.editors.cliVersion || 'present'
              : 'missing'}
          </span>
        </p>
      </section>

      <section className="hb-surface p-3.5 space-y-2">
        <h3 className="text-sm font-semibold text-text">MCP bridge</h3>
        <p className="text-xs text-mute">
          Port {bridge?.port ?? 6400}:{' '}
          <span className="text-text">
            {bridge?.reachable ? 'listening' : 'not listening'}
          </span>
          {bridge?.xvfbPresent ? ' · Xvfb available' : ''}
        </p>
        <p className="text-xs text-mute break-all">
          Sample:{' '}
          {bridge?.sampleProject.exists
            ? bridge.sampleProject.path
            : 'unity-sample not created yet'}
          {bridge?.sampleProject.hasMcpPackage ? ' · MCP package OK' : ''}
        </p>
        <p className="text-xs text-mute">
          Remote bots use <span className="font-mono">homebase_unity_*</span>{' '}
          MCP tools (bridge is localhost-only).
        </p>
      </section>
    </div>
  )
}
