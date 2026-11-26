'use client'

import { useCallback, useEffect, useState } from 'react'
import { useSceneRefresh } from '../lib/sceneRefresh'
import {
  clearDefaultCallbackUrl,
  fetchDefaultCallbackUrl,
  fetchWebhookHealth,
  sendWebhookTestPing,
  setDefaultCallbackUrl,
  type WebhookHealthRow,
} from '../lib/webhookHealthApi'

function fmtTime(ms?: number): string {
  if (!ms) return '—'
  try {
    return new Date(ms).toLocaleString()
  } catch {
    return String(ms)
  }
}

export function WebhookHealthPanel({ compact }: { compact?: boolean }) {
  const [rows, setRows] = useState<WebhookHealthRow[]>([])
  const [hasFailures, setHasFailures] = useState(false)
  const [defaultConfigured, setDefaultConfigured] = useState(false)
  const [defaultRedacted, setDefaultRedacted] = useState<string | null>(null)
  const [defaultDraft, setDefaultDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    try {
      const [health, def] = await Promise.all([
        fetchWebhookHealth(40),
        fetchDefaultCallbackUrl(),
      ])
      setRows(health.rows || [])
      setHasFailures(!!health.hasFailures)
      setDefaultConfigured(!!def.configured)
      setDefaultRedacted(def.urlRedacted)
      setError('')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useSceneRefresh(load)

  useEffect(() => {
    void load()
  }, [load])

  async function saveDefault() {
    setBusy(true)
    setMsg('')
    setError('')
    try {
      const res = await setDefaultCallbackUrl(defaultDraft.trim())
      setDefaultConfigured(!!res.configured)
      setDefaultRedacted(res.urlRedacted)
      setDefaultDraft('')
      setMsg('Default callback URL saved')
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function clearDefault() {
    setBusy(true)
    setMsg('')
    setError('')
    try {
      const res = await clearDefaultCallbackUrl()
      setDefaultConfigured(!!res.configured)
      setDefaultRedacted(res.urlRedacted)
      setMsg('Default callback URL cleared')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function testPing() {
    setBusy(true)
    setMsg('')
    setError('')
    try {
      const res = await sendWebhookTestPing()
      if (res.ok) {
        setMsg(
          `Test ping ok · ${res.urlRedacted || 'url'} · HTTP ${res.statusCode ?? '—'}`,
        )
      } else {
        setError(
          `Test ping failed · ${res.urlRedacted || 'url'} · ${res.error || `HTTP ${res.statusCode}`}`,
        )
      }
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className={`hb-surface ${compact ? 'p-3' : 'p-3.5 sm:p-4'} space-y-3`}>
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="hb-label mb-0 flex items-center gap-2">
            Job webhooks
            {hasFailures && (
              <span
                className="inline-block min-w-[0.55rem] h-2.5 w-2.5 rounded-full bg-danger"
                title="A callback failed"
                aria-label="Callback failures"
              />
            )}
          </h2>
          <p className="text-[11px] text-mute mt-1 leading-relaxed">
            Delivery health for cursor-job wake URLs. Auth is never shown. Retries use backoff.
          </p>
        </div>
        <button
          type="button"
          className="hb-btn hb-btn-ghost text-xs !min-h-9 shrink-0"
          disabled={busy}
          onClick={() => void testPing()}
        >
          Send test ping
        </button>
      </div>

      <div className="space-y-2">
        <p className="text-xs text-mute">
          Default callback URL
          {defaultConfigured && defaultRedacted ? (
            <>
              {' '}
              · <span className="font-mono text-fg">{defaultRedacted}</span>
            </>
          ) : (
            ' · not set'
          )}
        </p>
        <input
          type="url"
          autoComplete="off"
          className="w-full rounded-[var(--radius-control)] bg-panel-2 border border-line px-3 py-2 text-sm font-mono"
          placeholder="https://…/job-done"
          value={defaultDraft}
          onChange={(e) => setDefaultDraft(e.target.value)}
        />
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="hb-btn hb-btn-primary text-xs !min-h-9"
            disabled={busy || !defaultDraft.trim()}
            onClick={() => void saveDefault()}
          >
            Save default
          </button>
          {defaultConfigured && (
            <button
              type="button"
              className="hb-btn hb-btn-ghost text-xs !min-h-9"
              disabled={busy}
              onClick={() => void clearDefault()}
            >
              Remove default
            </button>
          )}
        </div>
      </div>

      {rows.length === 0 ? (
        <p className="text-xs text-mute">No webhook jobs yet.</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((r) => (
            <li
              key={r.jobId}
              className="border border-line/60 rounded-[var(--radius-control)] p-2.5 space-y-1"
            >
              <div className="flex items-center gap-2 text-xs flex-wrap">
                <span className="font-mono text-mute truncate">{r.jobId}</span>
                <span className="text-mute">{r.projectId}</span>
                <span className="hb-apps-run-pill" data-running={r.jobStatus === 'running' ? '1' : undefined}>
                  {r.jobStatus}
                </span>
                {r.failed && (
                  <span className="text-danger text-[11px] font-medium">failed</span>
                )}
                {r.webhookDelivered && (
                  <span className="text-sky text-[11px]">delivered</span>
                )}
                {r.pending && !r.webhookDelivered && (
                  <span className="text-amber text-[11px]">pending</span>
                )}
              </div>
              <p className="text-xs font-mono text-fg break-all">
                {r.callbackUrlRedacted || '(no url)'}
              </p>
              <p className="text-[11px] text-mute leading-relaxed">
                sent {fmtTime(r.webhookSentAt)} · HTTP {r.webhookLastStatusCode ?? '—'} ·
                retries {r.webhookAttempts ?? 0}
                {r.webhookError ? ` · ${r.webhookError}` : ''}
              </p>
            </li>
          ))}
        </ul>
      )}

      {(msg || error) && (
        <p className={`text-xs ${error ? 'text-danger' : 'text-sky'}`}>{error || msg}</p>
      )}
    </section>
  )
}
