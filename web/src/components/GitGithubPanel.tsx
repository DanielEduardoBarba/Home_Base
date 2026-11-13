'use client'

import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/api'
import { useSceneRefresh } from '../lib/sceneRefresh'
import type { PresentRequest } from '../lib/chatTypes'

type GitGithubStatus = Awaited<ReturnType<typeof api.gitGithubStatus>>

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

export function GitGithubPanel({
  onPresent,
}: {
  onPresent?: (req: PresentRequest) => void
}) {
  const [status, setStatus] = useState<GitGithubStatus | null>(null)
  const [error, setError] = useState('')
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState('')
  const [testOut, setTestOut] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const s = await api.gitGithubStatus()
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

  const openShellSession = (sessionId: string) => {
    onPresent?.({
      scene: 'shell',
      sessionIds: [sessionId],
      minimal: true,
    })
  }

  const env = status?.env
  const auth = status?.auth
  const loginOn = status?.settings?.useOperatorLoginEnv !== false
  const missing =
    env && (!env.git.found || !env.gh.found)
      ? [!env.git.found ? 'git' : null, !env.gh.found ? 'gh' : null].filter(
          Boolean,
        )
      : []

  return (
    <div className="space-y-3">
      {!status && !error ? (
        <p className="text-xs text-mute px-0.5">Loading Git & GitHub…</p>
      ) : null}

      <section className="hb-surface p-3.5 space-y-2.5">
        <FeatureSwitch
          label="Use operator login env"
          hint="Run git/gh as your seat user with your HOME, PATH, and gh keyring (default On). Keeps argv allow-lists; never force-push."
          on={loginOn}
          disabled={Boolean(busy) || !status}
          onToggle={() =>
            void run('toggle', async () => {
              await api.setGitGithubSettings({ useOperatorLoginEnv: !loginOn })
              setMsg(
                loginOn
                  ? 'Operator login env off — git/gh may miss your gh sign-in'
                  : 'Operator login env on',
              )
            })
          }
        />
        {env ? (
          <div className="text-xs text-mute space-y-1 px-0.5">
            <p>
              Seat: <span className="text-text">{env.seat.name}</span> · HOME{' '}
              <span className="text-text font-mono">{env.seat.home}</span>
              {env.env.wrappedForSeat ? ' · setpriv wrap' : ''}
            </p>
            <p>
              Service: {env.service.user || '?'} · HOME{' '}
              <span className="font-mono">{env.service.home || '?'}</span>
            </p>
          </div>
        ) : null}
      </section>

      <section className="hb-surface p-3.5 space-y-2">
        <h3 className="text-sm font-semibold text-text">Tools</h3>
        <div className="text-xs space-y-1.5">
          <p>
            <span className="text-mute">git · </span>
            {env?.git.found ? (
              <span className="text-text">
                {env.git.version}
                {env.git.path ? (
                  <span className="text-mute font-mono"> · {env.git.path}</span>
                ) : null}
              </span>
            ) : (
              <span className="text-warn">not found</span>
            )}
          </p>
          <p>
            <span className="text-mute">gh · </span>
            {env?.gh.found ? (
              <span className="text-text">
                {env.gh.version}
                {env.gh.path ? (
                  <span className="text-mute font-mono"> · {env.gh.path}</span>
                ) : null}
              </span>
            ) : (
              <span className="text-warn">not found</span>
            )}
          </p>
          <p>
            <span className="text-mute">GitHub · </span>
            {auth?.loggedIn ? (
              <span className="text-text">signed in as {auth.user}</span>
            ) : (
              <span className="text-warn">not signed in</span>
            )}
          </p>
        </div>
        {env?.hint ? <p className="text-xs text-warn leading-snug">{env.hint}</p> : null}
        {auth?.hint && !auth.loggedIn ? (
          <p className="text-xs text-mute leading-snug">{auth.hint}</p>
        ) : null}
      </section>

      <section className="hb-surface p-3.5 space-y-2.5">
        <h3 className="text-sm font-semibold text-text">Setup</h3>
        {missing.length ? (
          <div className="space-y-2">
            <p className="text-xs text-mute leading-snug">
              {env?.install?.hint ||
                `Install missing tools: ${missing.join(', ')}. Opens Shell with a confirmed package command (no silent sudo).`}
            </p>
            <button
              type="button"
              className="hb-btn hb-btn-primary text-sm w-full"
              disabled={Boolean(busy)}
              onClick={() =>
                void run('install', async () => {
                  const r = await api.gitGithubInstall({ confirm: true })
                  if (r.sessionId) {
                    setMsg(r.hint || 'Install session opened')
                    openShellSession(r.sessionId)
                  }
                })
              }
            >
              Install {missing.join(' / ')}
            </button>
          </div>
        ) : null}

        <button
          type="button"
          className="hb-btn hb-btn-secondary text-sm w-full"
          disabled={Boolean(busy) || !env?.gh.found}
          onClick={() =>
            void run('signin', async () => {
              const r = await api.gitGithubSignIn()
              if (r.sessionId) {
                setMsg(r.hint || 'Finish sign-in in Shell')
                openShellSession(r.sessionId)
              }
            })
          }
        >
          Sign in to GitHub
        </button>
        <p className="text-[11px] text-mute leading-snug px-0.5">
          Opens Shell running <span className="font-mono">gh auth login -h github.com</span>.
          Home Base never captures or stores the token.
        </p>

        <button
          type="button"
          className="hb-btn hb-btn-secondary text-sm w-full"
          disabled={Boolean(busy) || !env?.gh.found}
          onClick={() =>
            void run('setup-git', async () => {
              await api.gitGithubSetupGit()
              setMsg('gh auth setup-git completed — git pushes use gh credentials')
            })
          }
        >
          Use gh for git pushes
        </button>

        <button
          type="button"
          className="hb-btn hb-btn-primary text-sm w-full"
          disabled={Boolean(busy)}
          onClick={() =>
            void run('test', async () => {
              const r = await api.gitGithubTest()
              const lines = [
                r.ok ? 'Pass' : 'Fail',
                r.gh.detail,
                r.lsRemote.detail,
                r.hint || '',
              ].filter(Boolean)
              setTestOut(lines.join('\n'))
              setMsg(r.ok ? 'Connection test passed' : 'Connection test failed')
            })
          }
        >
          Test connection
        </button>
        {testOut ? (
          <pre className="text-[11px] text-mute whitespace-pre-wrap leading-snug bg-panel-2/50 rounded-lg px-2.5 py-2">
            {testOut}
          </pre>
        ) : null}
      </section>

      {msg ? <p className="text-xs text-ok px-0.5">{msg}</p> : null}
      {error ? <p className="text-xs text-warn px-0.5">{error}</p> : null}
      {busy ? <p className="text-xs text-mute px-0.5">Working…</p> : null}
    </div>
  )
}
