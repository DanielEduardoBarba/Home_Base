'use client'

import { useCallback, useState } from 'react'
import { api } from '../lib/api'
import { useSceneRefresh } from '../lib/sceneRefresh'
import { HoldButton } from './HoldButton'

type McpStatus = Awaited<ReturnType<typeof api.mcpServerStatus>>
type FeatureId = keyof McpStatus['features']

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

function FeatureSwitch({
  label,
  hint,
  on,
  disabled,
  onToggle,
}: {
  label: string
  hint: string
  on: boolean
  disabled?: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      disabled={disabled}
      onClick={onToggle}
      className="w-full flex items-center justify-between gap-3 text-left rounded-xl border border-line bg-panel-2/60 px-3 py-3 disabled:opacity-50"
    >
      <span className="min-w-0">
        <span className="block text-sm font-semibold text-text">{label}</span>
        <span className="block text-xs text-mute mt-0.5 leading-snug">{hint}</span>
      </span>
      <span className={`hb-switch shrink-0 ${on ? 'hb-switch--on' : ''}`} aria-hidden>
        <span className="hb-switch-knob" />
      </span>
    </button>
  )
}

export function McpServerPanel() {
  const [status, setStatus] = useState<McpStatus | null>(null)
  const [error, setError] = useState('')
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState('')
  const [label, setLabel] = useState('')
  const [freshToken, setFreshToken] = useState<string | null>(null)
  const [showTools, setShowTools] = useState(false)
  const [showHuman, setShowHuman] = useState(true)
  const [showGrok, setShowGrok] = useState(true)

  const load = useCallback(async () => {
    try {
      const s = await api.mcpServerStatus()
      setStatus(s)
      setError('')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useSceneRefresh(load)

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key)
    setMsg('')
    setError('')
    try {
      await fn()
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy('')
    }
  }

  const enabled = status?.enabled !== false
  const features = status?.features
  const featureMeta = status?.featureMeta || []

  return (
    <div className="space-y-3">
      <section className="hb-surface p-3.5 space-y-2.5">
        <FeatureSwitch
          label="MCP Server"
          hint="Master switch. AI clients on VPN/LAN can call /mcp. VPN, auth, vaults, and restarts stay in Settings."
          on={enabled}
          disabled={Boolean(busy) || !status}
          onToggle={() =>
            void run('toggle', async () => {
              await api.setMcpServer({ enabled: !enabled })
              setMsg(enabled ? 'MCP Server turned off' : 'MCP Server turned on')
            })
          }
        />

        {status?.url ? (
          <div className="rounded-xl border border-line bg-panel-2/50 px-3 py-2.5 space-y-2">
            <p className="text-[11px] uppercase tracking-wide text-mute font-semibold">
              Endpoint
            </p>
            <code className="block text-xs text-text break-all font-mono">{status.url}</code>
            <button
              type="button"
              className="hb-btn hb-btn-ghost text-xs !min-h-8"
              onClick={() =>
                void copyText(status.url || '').then((ok) =>
                  setMsg(ok ? 'URL copied' : 'Copy failed'),
                )
              }
            >
              Copy URL
            </button>
          </div>
        ) : (
          <p className="text-xs text-mute leading-relaxed">
            No VPN/LAN URL yet — open WireGuard or use this host&apos;s address with path{' '}
            <code className="text-text">/mcp</code>.
          </p>
        )}

        <p className="text-xs text-mute leading-relaxed">
          Prefer WireGuard. Do not public-port-forward. Master Off → /mcp 404. Password change
          revokes all MCP tokens.
        </p>
      </section>

      <section className="hb-surface p-3.5 space-y-2.5">
        <h2 className="text-sm font-semibold text-text">MCP features</h2>
        <p className="text-xs text-mute leading-relaxed">
          Fine-tune what tools bots can call. Vision defaults Off. Changes apply on the next MCP
          request (clients should re-list tools).
        </p>
        {featureMeta.map((meta) => {
          const id = meta.id as FeatureId
          const on = features ? features[id] !== false : meta.defaultOn
          return (
            <FeatureSwitch
              key={id}
              label={meta.label}
              hint={meta.hint}
              on={on}
              disabled={Boolean(busy) || !status || !enabled}
              onToggle={() =>
                void run(`feat-${id}`, async () => {
                  await api.setMcpServer({ features: { [id]: !on } })
                  setMsg(`${meta.label} ${on ? 'off' : 'on'} for MCP`)
                })
              }
            />
          )
        })}
      </section>

      <section className="hb-surface p-3.5 space-y-2.5">
        <h2 className="text-sm font-semibold text-text">Access tokens</h2>
        <p className="text-xs text-mute leading-relaxed">
          Mint a Bearer token for Grok / Cursor / other MCP hosts. Session login JWTs are not
          accepted on <code className="text-text">/mcp</code>. Keep the Cursor API key in Home Base
          — bots use MCP tokens only.
        </p>
        <div className="flex gap-2">
          <input
            className="flex-1 rounded-[var(--radius-control)] bg-panel-2 border border-line px-3 py-2.5 text-sm"
            placeholder="Label (e.g. grok-team)"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
          <button
            type="button"
            className="hb-btn text-sm shrink-0"
            disabled={Boolean(busy) || !enabled}
            onClick={() =>
              void run('mint', async () => {
                const r = await api.mintMcpToken(label.trim() || undefined)
                setFreshToken(r.token)
                setLabel('')
                setMsg('Token created — copy it now; it will not be shown again')
              })
            }
          >
            Mint
          </button>
        </div>

        {freshToken ? (
          <div className="rounded-xl border border-sky/40 bg-sky/10 px-3 py-2.5 space-y-2">
            <p className="text-xs text-sky font-semibold">New token (shown once)</p>
            <code className="block text-[11px] break-all font-mono text-text">{freshToken}</code>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="hb-btn hb-btn-ghost text-xs !min-h-8"
                onClick={() =>
                  void copyText(freshToken).then((ok) =>
                    setMsg(ok ? 'Token copied' : 'Copy failed'),
                  )
                }
              >
                Copy token
              </button>
              <button
                type="button"
                className="hb-btn hb-btn-ghost text-xs !min-h-8"
                onClick={() => setFreshToken(null)}
              >
                Hide
              </button>
            </div>
          </div>
        ) : null}

        <ul className="space-y-2">
          {(status?.tokens || []).length === 0 ? (
            <li className="text-xs text-mute">No tokens yet.</li>
          ) : (
            (status?.tokens || []).map((t) => (
              <li
                key={t.id}
                className="flex items-center justify-between gap-2 rounded-xl border border-line bg-panel-2/40 px-3 py-2"
              >
                <span className="min-w-0">
                  <span className="block text-sm text-text truncate">{t.label}</span>
                  <span className="block text-[11px] text-mute font-mono truncate">
                    {t.prefix} · {new Date(t.createdAt).toLocaleString()}
                  </span>
                </span>
                <button
                  type="button"
                  className="hb-btn hb-btn-ghost text-xs !min-h-8 shrink-0 text-danger"
                  disabled={Boolean(busy)}
                  onClick={() =>
                    void run(`revoke-${t.id}`, async () => {
                      await api.revokeMcpToken(t.id)
                      setMsg('Token revoked')
                    })
                  }
                >
                  Revoke
                </button>
              </li>
            ))
          )}
        </ul>

        {(status?.tokens || []).length > 0 ? (
          <HoldButton
            className="w-full"
            label="Hold to revoke all"
            tone="danger"
            holdMs={900}
            disabled={Boolean(busy)}
            onConfirm={() =>
              void run('revoke-all', async () => {
                await api.revokeAllMcpTokens()
                setFreshToken(null)
                setMsg('All MCP tokens revoked')
              })
            }
          />
        ) : null}
      </section>

      <section className="hb-surface p-3.5 space-y-2.5">
        <button
          type="button"
          className="w-full flex items-center justify-between text-left"
          onClick={() => setShowGrok((v) => !v)}
        >
          <span className="text-sm font-semibold text-text">Grok bot hookup</span>
          <span className="text-mute text-sm">{showGrok ? '▾' : '▸'}</span>
        </button>
        {showGrok ? (
          <div className="space-y-2">
            <p className="text-xs text-mute leading-relaxed">
              Grok Developer pilot: hand off whole jobs via{" "}
              <code className="text-text">homebase_cursor_job</code> (waitMs or webhook — no tight
              polling). Projects + Presence On; Vision + Home Access Off; dedicated token. Brief:{" "}
              <code className="text-text">docs/GROK_MCP.md</code>.
            </p>
            <pre className="text-[11px] font-mono whitespace-pre-wrap break-words rounded-xl border border-line bg-panel-2/50 px-3 py-2.5 text-text max-h-72 overflow-y-auto">
              {status?.grokGuide || '…'}
            </pre>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="hb-btn hb-btn-ghost text-xs !min-h-8"
                disabled={!status}
                onClick={() =>
                  void copyText(status?.grokGuide || '').then((ok) =>
                    setMsg(ok ? 'Grok guide copied' : 'Copy failed'),
                  )
                }
              >
                Copy Grok guide
              </button>
              <button
                type="button"
                className="hb-btn hb-btn-ghost text-xs !min-h-8"
                disabled={!status}
                onClick={() =>
                  void copyText(status?.clientConfigs.cursorMcpJson || '').then((ok) =>
                    setMsg(ok ? 'MCP JSON copied' : 'Copy failed'),
                  )
                }
              >
                Copy MCP JSON
              </button>
            </div>
          </div>
        ) : null}
      </section>

      <section className="hb-surface p-3.5 space-y-2.5">
        <h2 className="text-sm font-semibold text-text">Client config</h2>
        <p className="text-xs text-mute leading-relaxed">
          Streamable HTTP MCP snippet (Cursor-compatible hosts). Replace the Bearer token after
          minting.
        </p>
        <pre className="text-[11px] font-mono whitespace-pre-wrap break-all rounded-xl border border-line bg-panel-2/50 px-3 py-2.5 text-text max-h-48 overflow-y-auto">
          {status?.clientConfigs.cursorMcpJson || '…'}
        </pre>
      </section>

      <section className="hb-surface p-3.5 space-y-2">
        <button
          type="button"
          className="w-full flex items-center justify-between text-left"
          onClick={() => setShowHuman((v) => !v)}
        >
          <span className="text-sm font-semibold text-text">Human-only (Settings)</span>
          <span className="text-mute text-sm">{showHuman ? '▾' : '▸'}</span>
        </button>
        {showHuman ? (
          <ul className="text-xs text-mute space-y-1.5 list-disc pl-4">
            {(status?.catalog.humanOnly || []).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        ) : null}
      </section>

      <section className="hb-surface p-3.5 space-y-2">
        <button
          type="button"
          className="w-full flex items-center justify-between text-left"
          onClick={() => setShowTools((v) => !v)}
        >
          <span className="text-sm font-semibold text-text">
            Tools now exposed ({status?.catalog.allowed.length ?? '…'})
            {(status?.catalog.disabled.length || 0) > 0
              ? ` · ${status?.catalog.disabled.length} gated off`
              : ''}
          </span>
          <span className="text-mute text-sm">{showTools ? '▾' : '▸'}</span>
        </button>
        {showTools ? (
          <div className="space-y-3 max-h-72 overflow-y-auto">
            <ul className="space-y-2">
              {(status?.catalog.allowed || []).map((t) => (
                <li key={t.name} className="text-xs">
                  <code className="text-text font-mono">{t.name}</code>
                  <span className="text-mute"> · {t.feature}</span>
                  <span className="block text-mute mt-0.5 leading-snug">{t.description}</span>
                </li>
              ))}
            </ul>
            {(status?.catalog.disabled || []).length > 0 ? (
              <>
                <p className="text-[11px] uppercase tracking-wide text-mute font-semibold pt-1">
                  Gated off by feature toggle
                </p>
                <ul className="space-y-2 opacity-70">
                  {(status?.catalog.disabled || []).map((t) => (
                    <li key={t.name} className="text-xs">
                      <code className="text-text font-mono">{t.name}</code>
                      <span className="text-mute"> · {t.feature}</span>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
          </div>
        ) : null}
      </section>

      {msg ? <p className="text-xs text-sky">{msg}</p> : null}
      {error ? <p className="text-xs text-danger">{error}</p> : null}
    </div>
  )
}
