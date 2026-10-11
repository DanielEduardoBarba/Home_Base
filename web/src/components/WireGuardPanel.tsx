import QRCode from 'qrcode'
import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/api'
import { useSceneRefresh } from '../lib/sceneRefresh'
import { HoldButton } from './HoldButton'

type WgStatus = Awaited<ReturnType<typeof api.wireguardStatus>>

async function toQr(text: string, size = 220): Promise<string> {
  return QRCode.toDataURL(text, {
    width: size,
    margin: 2,
    color: { dark: '#041018', light: '#f4f8ff' },
    errorCorrectionLevel: 'M',
  })
}

function StatusPill({ active, label }: { active: boolean; label: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold ${
        active
          ? 'bg-ok/15 text-ok border border-ok/30'
          : 'bg-line/40 text-mute border border-line'
      }`}
    >
      <span
        className={`w-1.5 h-1.5 rounded-full ${active ? 'bg-ok' : 'bg-mute'}`}
        aria-hidden
      />
      {label}
    </span>
  )
}

export function WireGuardPanel() {
  const [status, setStatus] = useState<WgStatus | null>(null)
  const [error, setError] = useState('')
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState('')
  const [step, setStep] = useState(0)
  const [endpoint, setEndpoint] = useState('')
  const [clientName, setClientName] = useState('phone')
  const [iosQr, setIosQr] = useState('')
  const [androidQr, setAndroidQr] = useState('')
  const [configQr, setConfigQr] = useState('')
  const [configText, setConfigText] = useState('')
  const [configLabel, setConfigLabel] = useState('')
  const [newClientName, setNewClientName] = useState('')
  const [showUninstall, setShowUninstall] = useState(false)
  const [removePkgs, setRemovePkgs] = useState(false)

  const load = useCallback(async () => {
    try {
      const s = await api.wireguardStatus()
      setStatus(s)
      setError('')
      setEndpoint((prev) => {
        if (prev) return prev
        return s.access.suggestedEndpoint || s.state?.endpoint || ''
      })
      void toQr(s.appStore.ios, 160).then(setIosQr)
      void toQr(s.appStore.android, 160).then(setAndroidQr)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useSceneRefresh(load)

  useEffect(() => {
    void load()
  }, [load])

  async function showConfig(config: string, label: string) {
    setConfigText(config)
    setConfigLabel(label)
    setConfigQr(await toQr(config, 240))
  }

  async function run(action: string, fn: () => Promise<unknown>) {
    setBusy(action)
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

  const configured = Boolean(status?.configured)
  const active = Boolean(status?.active)
  const installed = Boolean(status?.installed)
  const managed = Boolean(status?.managedByHomebase)
  const onboarding = !configured

  // Guided onboarding steps when not configured
  const onboardingSteps = [
    { title: 'Install', blurb: 'Add WireGuard tools on this laptop.' },
    { title: 'Create tunnel', blurb: 'Generate keys and start the VPN service.' },
    { title: 'Router', blurb: 'Forward one UDP port from the internet to this laptop.' },
    { title: 'Phone app', blurb: 'Install WireGuard, then scan your tunnel QR.' },
  ]

  return (
    <section className="hb-surface p-3.5 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="hb-label">VPN · WireGuard</h2>
          <p className="text-xs text-mute mt-1 leading-relaxed">
            Phone → laptop tunnel for Home Base. Setup once on the laptop, then connect from
            cellular.
          </p>
        </div>
        {status && (
          <StatusPill
            active={active}
            label={active ? 'Up' : configured ? 'Down' : installed ? 'Ready' : 'Not installed'}
          />
        )}
      </div>

      {error && (
        <p className="text-xs text-danger whitespace-pre-wrap break-words">{error}</p>
      )}
      {msg && <p className="text-xs text-sky whitespace-pre-wrap break-words">{msg}</p>}

      {!status && !error && (
        <p className="text-xs text-mute">Loading VPN status…</p>
      )}

      {status && !status.root && (
        <p className="text-[11px] text-warn leading-relaxed rounded-xl border border-warn/30 bg-warn/10 px-3 py-2">
          Setup/start/stop need root. Production homebased runs as root; this process does not.
        </p>
      )}

      {/* ——— Onboarding ——— */}
      {status && onboarding && (
        <div className="space-y-3">
          <div className="flex gap-1">
            {onboardingSteps.map((s, i) => (
              <button
                key={s.title}
                type="button"
                className={`flex-1 rounded-lg px-1.5 py-1.5 text-[10px] font-semibold border transition-colors ${
                  step === i
                    ? 'border-accent bg-accent/15 text-text'
                    : i < step
                      ? 'border-ok/40 bg-ok/10 text-ok'
                      : 'border-line bg-panel-2/40 text-mute'
                }`}
                onClick={() => setStep(i)}
              >
                {i + 1}. {s.title}
              </button>
            ))}
          </div>
          <p className="text-xs text-mute">{onboardingSteps[step]?.blurb}</p>

          {step === 0 && (
            <div className="space-y-2">
              <p className="text-[11px] text-mute font-mono">
                wg {status.tools.wg ? '✓' : '✗'} · wg-quick {status.tools.wgQuick ? '✓' : '✗'} ·
                iptables {status.tools.iptables ? '✓' : '✗'}
              </p>
              {installed ? (
                <button
                  type="button"
                  className="hb-btn hb-btn-primary text-sm !min-h-10 w-full"
                  onClick={() => setStep(1)}
                >
                  Continue
                </button>
              ) : (
                <button
                  type="button"
                  className="hb-btn hb-btn-primary text-sm !min-h-10 w-full"
                  disabled={!!busy || !status.root}
                  onClick={() =>
                    void run('install', async () => {
                      await api.wireguardInstall()
                      setMsg('WireGuard packages installed')
                      setStep(1)
                    })
                  }
                >
                  {busy === 'install' ? 'Installing…' : 'Install WireGuard'}
                </button>
              )}
            </div>
          )}

          {step === 1 && (
            <div className="space-y-2">
              <label className="block space-y-1">
                <span className="text-[11px] text-mute">Public endpoint (IP or host:port)</span>
                <input
                  className="w-full rounded-[var(--radius-control)] bg-panel-2 border border-line px-3 py-2.5 text-sm font-mono"
                  value={endpoint}
                  onChange={(e) => setEndpoint(e.target.value)}
                  placeholder={status.access.suggestedEndpoint || 'x.x.x.x:51820'}
                />
              </label>
              <label className="block space-y-1">
                <span className="text-[11px] text-mute">First phone name</span>
                <input
                  className="w-full rounded-[var(--radius-control)] bg-panel-2 border border-line px-3 py-2.5 text-sm"
                  value={clientName}
                  onChange={(e) => setClientName(e.target.value)}
                  placeholder="phone"
                />
              </label>
              <p className="text-[11px] text-mute leading-relaxed">
                LAN {status.access.lanHost || '—'} · via{' '}
                {status.access.outboundIface || '—'} · VPN {status.defaults.serverAddress}
              </p>
              <button
                type="button"
                className="hb-btn hb-btn-primary text-sm !min-h-10 w-full"
                disabled={!!busy || !status.root || !installed}
                onClick={() =>
                  void run('setup', async () => {
                    const r = await api.wireguardSetup({
                      endpoint: endpoint || undefined,
                      clientName: clientName || 'phone',
                    })
                    setMsg(r.message || 'Tunnel created')
                    if (r.client?.config) {
                      await showConfig(r.client.config, r.client.name)
                    }
                    setStep(2)
                  })
                }
              >
                {busy === 'setup' ? 'Creating…' : 'Create & start VPN'}
              </button>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-2">
              <div className="rounded-xl border border-line bg-panel-2/50 px-3 py-2.5 text-xs space-y-1.5">
                <p className="font-semibold text-sm">Router port forward</p>
                <p className="text-mute leading-relaxed">
                  On your home router, forward WAN → this laptop:
                </p>
                <p className="font-mono text-[12px]">
                  {status.portForward.proto} {status.portForward.wanPort} →{' '}
                  {status.portForward.lanIp || 'LAN-IP'}:{status.portForward.lanPort}
                </p>
                <p className="text-mute leading-relaxed">
                  Without this, the phone can only connect on the same Wi‑Fi (or not at all from
                  cellular).
                </p>
              </div>
              <button
                type="button"
                className="hb-btn hb-btn-primary text-sm !min-h-10 w-full"
                onClick={() => setStep(3)}
              >
                I forwarded the port
              </button>
            </div>
          )}

          {step === 3 && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-2">
                <div className="rounded-xl border border-line bg-panel-2/40 p-2 text-center space-y-1.5">
                  <p className="text-[11px] font-semibold">iPhone / iPad</p>
                  {iosQr ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={iosQr} alt="App Store WireGuard QR" className="mx-auto w-full max-w-[140px] rounded-lg" />
                  ) : (
                    <p className="text-[10px] text-mute py-8">…</p>
                  )}
                  <a
                    href={status.appStore.ios}
                    className="text-[10px] text-sky underline-offset-2 hover:underline break-all"
                    target="_blank"
                    rel="noreferrer"
                  >
                    App Store
                  </a>
                </div>
                <div className="rounded-xl border border-line bg-panel-2/40 p-2 text-center space-y-1.5">
                  <p className="text-[11px] font-semibold">Android</p>
                  {androidQr ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={androidQr} alt="Play Store WireGuard QR" className="mx-auto w-full max-w-[140px] rounded-lg" />
                  ) : (
                    <p className="text-[10px] text-mute py-8">…</p>
                  )}
                  <a
                    href={status.appStore.android}
                    className="text-[10px] text-sky underline-offset-2 hover:underline break-all"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Play Store
                  </a>
                </div>
              </div>
              <p className="text-[11px] text-mute leading-relaxed">
                Open WireGuard → Create from QR code, then scan the tunnel config below. Test on{' '}
                <strong className="text-text font-semibold">cellular</strong>, not home Wi‑Fi.
              </p>
              {configQr ? (
                <div className="rounded-xl border border-accent/30 bg-accent/5 p-3 text-center space-y-2">
                  <p className="text-xs font-semibold">Tunnel · {configLabel}</p>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={configQr}
                    alt="WireGuard config QR"
                    className="mx-auto w-full max-w-[220px] rounded-lg"
                  />
                  <button
                    type="button"
                    className="hb-btn hb-btn-ghost text-xs !min-h-9 w-full"
                    onClick={() => {
                      void navigator.clipboard?.writeText(configText)
                      setMsg('Config copied')
                    }}
                  >
                    Copy config text
                  </button>
                </div>
              ) : (
                <p className="text-[11px] text-mute">
                  Finish step 2 to generate a phone config, or add a client after setup.
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {/* ——— Manage existing ——— */}
      {status && configured && (
        <div className="space-y-3">
          <div className="rounded-xl border border-line bg-panel-2/50 px-3 py-2.5 text-xs space-y-1.5">
            <div className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-[11px]">
              <span>
                <span className="text-mute">iface </span>
                {status.iface}
              </span>
              {status.access.vpnHost && (
                <span>
                  <span className="text-mute">vpn </span>
                  {status.access.vpnHost}
                </span>
              )}
              {status.access.lanHost && (
                <span>
                  <span className="text-mute">lan </span>
                  {status.access.lanHost}
                </span>
              )}
            </div>
            {status.state?.endpoint && (
              <p className="font-mono text-[11px] break-all">
                <span className="text-mute">endpoint </span>
                {status.state.endpoint}
              </p>
            )}
            <p className="text-mute leading-relaxed">
              Router: {status.portForward.proto} {status.portForward.wanPort} →{' '}
              {status.portForward.lanIp || 'LAN'}:{status.portForward.lanPort}
            </p>
            {(status.interfaces[0]?.peersLive?.length || 0) > 0 && (
              <div className="pt-1 space-y-1">
                {status.interfaces[0]!.peersLive.map((p) => (
                  <p key={p.publicKey} className="text-[10px] text-mute font-mono truncate">
                    peer {p.publicKey.slice(0, 8)}…
                    {p.latestHandshake ? ` · handshake ${p.latestHandshake}` : ' · no handshake'}
                    {p.transfer ? ` · ${p.transfer}` : ''}
                  </p>
                ))}
              </div>
            )}
          </div>

          <div className="grid grid-cols-3 gap-2">
            <button
              type="button"
              className="hb-btn hb-btn-ghost text-sm !min-h-10"
              disabled={!!busy || active || !status.root}
              onClick={() =>
                void run('start', async () => {
                  await api.wireguardStart(status.iface)
                  setMsg('VPN started')
                })
              }
            >
              {busy === 'start' ? '…' : 'Start'}
            </button>
            <button
              type="button"
              className="hb-btn hb-btn-ghost text-sm !min-h-10"
              disabled={!!busy || !active || !status.root}
              onClick={() =>
                void run('stop', async () => {
                  await api.wireguardStop(status.iface)
                  setMsg('VPN stopped')
                })
              }
            >
              {busy === 'stop' ? '…' : 'Stop'}
            </button>
            <HoldButton
              label={busy === 'restart' ? '…' : 'Restart'}
              holdLabel="Hold…"
              disabled={!!busy || !status.root}
              className="hb-btn hb-btn-ghost text-sm !min-h-10"
              onConfirm={() =>
                void run('restart', async () => {
                  await api.wireguardRestartIface(status.iface)
                  setMsg('VPN restarted')
                })
              }
            />
          </div>

          {!managed && (
            <button
              type="button"
              className="hb-btn hb-btn-ghost text-sm !min-h-10 w-full"
              disabled={!!busy || !status.root}
              onClick={() =>
                void run('adopt', async () => {
                  await api.wireguardAdopt({
                    iface: status.iface,
                    endpoint: endpoint || undefined,
                  })
                  setMsg('Existing WireGuard adopted into Home Base')
                })
              }
            >
              {busy === 'adopt' ? '…' : 'Manage with Home Base'}
            </button>
          )}

          {managed && (
            <div className="space-y-2">
              <h3 className="text-[11px] font-semibold uppercase tracking-wide text-mute">
                Phones
              </h3>
              {status.clients.length === 0 && (
                <p className="text-[11px] text-mute">No clients yet.</p>
              )}
              {status.clients.map((c) => (
                <div
                  key={c.id}
                  className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-panel-2/40 px-3 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold truncate">{c.name}</p>
                    <p className="text-[10px] text-mute font-mono">{c.address}</p>
                  </div>
                  {c.hasConfig ? (
                    <button
                      type="button"
                      className="hb-btn hb-btn-ghost text-xs !min-h-9"
                      disabled={!!busy}
                      onClick={() =>
                        void run(`cfg-${c.id}`, async () => {
                          const r = await api.wireguardClientConfig(c.id)
                          await showConfig(r.client.config, r.client.name)
                          setMsg(`Showing QR for ${r.client.name}`)
                        })
                      }
                    >
                      QR
                    </button>
                  ) : (
                    <HoldButton
                      label="Rotate"
                      holdLabel="Hold…"
                      disabled={!!busy || !status.root}
                      className="hb-btn hb-btn-ghost text-xs !min-h-9"
                      onConfirm={() =>
                        void run(`rot-${c.id}`, async () => {
                          const r = await api.wireguardAddClient({
                            rotateId: c.id,
                            name: c.name,
                          })
                          await showConfig(r.client.config, r.client.name)
                          setMsg(`Rotated keys for ${r.client.name}`)
                        })
                      }
                    />
                  )}
                  <HoldButton
                    label="Remove"
                    holdLabel="Hold…"
                    disabled={!!busy || !status.root}
                    className="hb-btn hb-btn-danger text-xs !min-h-9"
                    onConfirm={() =>
                      void run(`rm-${c.id}`, async () => {
                        await api.wireguardRemoveClient(c.id)
                        if (configLabel === c.name) {
                          setConfigQr('')
                          setConfigText('')
                        }
                        setMsg(`Removed ${c.name}`)
                      })
                    }
                  />
                </div>
              ))}

              <div className="flex gap-2">
                <input
                  className="flex-1 rounded-[var(--radius-control)] bg-panel-2 border border-line px-3 py-2.5 text-sm"
                  placeholder="New phone name"
                  value={newClientName}
                  onChange={(e) => setNewClientName(e.target.value)}
                />
                <button
                  type="button"
                  className="hb-btn hb-btn-primary text-sm !min-h-10 shrink-0"
                  disabled={!!busy || !status.root}
                  onClick={() =>
                    void run('add', async () => {
                      const r = await api.wireguardAddClient({
                        name: newClientName || undefined,
                      })
                      setNewClientName('')
                      await showConfig(r.client.config, r.client.name)
                      setMsg(`Added ${r.client.name}`)
                    })
                  }
                >
                  {busy === 'add' ? '…' : 'Add'}
                </button>
              </div>
            </div>
          )}

          {/* App download QRs (always handy) */}
          <details className="rounded-xl border border-line bg-panel-2/30 px-3 py-2">
            <summary className="text-xs font-semibold cursor-pointer select-none">
              Download WireGuard app
            </summary>
            <div className="grid grid-cols-2 gap-2 mt-2">
              <div className="text-center space-y-1">
                <p className="text-[10px] text-mute">iOS</p>
                {iosQr && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={iosQr} alt="iOS app QR" className="mx-auto w-[120px] rounded-lg" />
                )}
              </div>
              <div className="text-center space-y-1">
                <p className="text-[10px] text-mute">Android</p>
                {androidQr && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={androidQr}
                    alt="Android app QR"
                    className="mx-auto w-[120px] rounded-lg"
                  />
                )}
              </div>
            </div>
          </details>

          {configQr && (
            <div className="rounded-xl border border-accent/30 bg-accent/5 p-3 text-center space-y-2">
              <p className="text-xs font-semibold">Tunnel QR · {configLabel}</p>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={configQr}
                alt="WireGuard config QR"
                className="mx-auto w-full max-w-[220px] rounded-lg"
              />
              <button
                type="button"
                className="hb-btn hb-btn-ghost text-xs !min-h-9 w-full"
                onClick={() => {
                  void navigator.clipboard?.writeText(configText)
                  setMsg('Config copied')
                }}
              >
                Copy config text
              </button>
            </div>
          )}

          <div className="pt-1 border-t border-line space-y-2">
            {!showUninstall ? (
              <button
                type="button"
                className="text-[11px] text-mute underline-offset-2 hover:underline"
                onClick={() => setShowUninstall(true)}
              >
                Remove WireGuard…
              </button>
            ) : (
              <div className="space-y-2 rounded-xl border border-danger/30 bg-danger/5 px-3 py-2.5">
                <p className="text-xs text-mute leading-relaxed">
                  Stops the tunnel, deletes the config, and clears Home Base VPN state.
                </p>
                <label className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={removePkgs}
                    onChange={(e) => setRemovePkgs(e.target.checked)}
                  />
                  Also uninstall wireguard packages
                </label>
                <div className="flex gap-2">
                  <button
                    type="button"
                    className="hb-btn hb-btn-ghost text-sm !min-h-10 flex-1"
                    onClick={() => setShowUninstall(false)}
                  >
                    Cancel
                  </button>
                  <HoldButton
                    label={busy === 'uninstall' ? '…' : 'Uninstall'}
                    holdLabel="Hold…"
                    disabled={!!busy || !status.root}
                    className="hb-btn hb-btn-danger text-sm !min-h-10 flex-1"
                    onConfirm={() =>
                      void run('uninstall', async () => {
                        await api.wireguardUninstall({ removePackages: removePkgs })
                        setConfigQr('')
                        setConfigText('')
                        setShowUninstall(false)
                        setStep(0)
                        setMsg('WireGuard removed')
                      })
                    }
                  />
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  )
}
