'use client'

import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/api'
import {
  collectVoiceDiagnostics,
  selectVoiceListenPath,
  setServerTranscriptionConfigured,
  unlockSpeechSynthesis,
  type VoiceDiagnostics,
  type VoiceListenPath,
} from '../lib/speech'

type Props = {
  /** Kid-friendly copy for Doodle device settings. */
  kid?: boolean
  className?: string
}

function micPathLabel(path: VoiceListenPath): string {
  switch (path) {
    case 'server':
      return 'Server STT (primary)'
    case 'browser':
      return 'Browser SpeechRecognition'
    default:
      return 'Keyboard mic / type'
  }
}

/**
 * Small voice diagnostic for Settings / Doodle device settings.
 * Shows secure context, recognition API, mic permission, synth voices, last error.
 */
export function VoiceCheck({ kid = false, className = '' }: Props) {
  const [diag, setDiag] = useState<VoiceDiagnostics | null>(null)
  const [httpsUrl, setHttpsUrl] = useState<string | null>(null)
  const [caPath, setCaPath] = useState<string | null>(null)
  const [transcribe, setTranscribe] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  const [activePath, setActivePath] = useState<VoiceListenPath | null>(null)

  const refresh = useCallback(async () => {
    setBusy(true)
    try {
      const d = await collectVoiceDiagnostics()
      setDiag(d)
      try {
        const tls = await api.tlsStatus()
        setHttpsUrl(tls.urls?.vpnHttps || tls.urls?.lanHttps || null)
        setCaPath(tls.materialPresent ? tls.caDownloadPath : null)
      } catch {
        setHttpsUrl(null)
        setCaPath(null)
        try {
          const cf = await api.cloudflareStatus()
          setHttpsUrl(cf.publicUrl || null)
        } catch {
          setHttpsUrl(null)
        }
      }
      let configured: boolean | null = null
      try {
        const st = await api.speechStatus()
        configured = !!st.configured
        setTranscribe(configured)
        setServerTranscriptionConfigured(configured)
      } catch {
        setTranscribe(null)
      }
      const ua = typeof navigator !== 'undefined' ? navigator.userAgent || '' : ''
      setActivePath(
        selectVoiceListenPath({
          ua,
          serverConfigured: configured === true,
          recognitionAvailable: !!d.recognitionApi,
        }),
      )
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  async function unlock() {
    setBusy(true)
    try {
      await unlockSpeechSynthesis()
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  const row = (label: string, value: string, ok?: boolean) => (
    <div className="hb-voice-check-row">
      <span className="hb-voice-check-label">{label}</span>
      <span
        className={`hb-voice-check-value${
          ok === true ? ' hb-voice-check-value--ok' : ok === false ? ' hb-voice-check-value--bad' : ''
        }`}
      >
        {value}
      </span>
    </div>
  )

  return (
    <section className={`hb-voice-check ${className}`.trim()} aria-label="Voice check">
      <header className="hb-voice-check-head">
        <h3 className="hb-voice-check-title">{kid ? 'Voice check' : 'Voice check'}</h3>
        <p className="hb-voice-check-sub">
          {kid
            ? 'This shows why Talk might not work on this iPad or iPhone.'
            : 'Diagnose mic / speech blockers on this device (esp. iOS Safari).'}
        </p>
      </header>

      {!diag ? (
        <p className="hb-voice-check-loading">{busy ? 'Checking…' : '—'}</p>
      ) : (
        <div className="hb-voice-check-grid">
          {row(
            'Secure page (HTTPS)',
            diag.secureContext ? 'Yes' : 'No — voice blocked',
            diag.secureContext,
          )}
          {row(
            'Mic path',
            activePath ? micPathLabel(activePath) : '—',
            activePath === 'keyboard' ? false : activePath ? true : undefined,
          )}
          {row('Speech recognition API', diag.recognitionApi ? 'Present' : 'Missing', diag.recognitionApi)}
          {row('MediaRecorder', diag.mediaRecorder ? 'Present' : 'Missing', diag.mediaRecorder)}
          {row(
            'Mic permission',
            diag.micPermission,
            diag.micPermission === 'granted'
              ? true
              : diag.micPermission === 'denied'
                ? false
                : undefined,
          )}
          {row('Speech synthesis', diag.speechSynthesis ? 'Yes' : 'No', diag.speechSynthesis)}
          {row('Synth voices', String(diag.synthVoices), diag.synthVoices > 0)}
          {row('iPhone / iPad mode', diag.ios ? 'Yes' : 'No')}
          {row(
            'Server transcription',
            transcribe === null ? '—' : transcribe ? 'Configured' : 'Not configured',
            transcribe === null ? undefined : transcribe,
          )}
          {row('Last error', diag.lastError || 'None', diag.lastError ? false : true)}
        </div>
      )}

      {!diag?.secureContext && (
        <p className="hb-voice-check-hint" role="status">
          {kid
            ? httpsUrl
              ? `Ask a grown-up to open ${httpsUrl} for Talk to work.`
              : 'Ask a grown-up to open the Home Base https link (VPN HTTPS or Cloudflare Tunnel) for Talk to work.'
            : httpsUrl
              ? `Open the HTTPS URL instead: ${httpsUrl}`
              : 'Open Settings → WireGuard / Voice check for the VPN HTTPS URL (trust the local CA first), or use Cloudflare Tunnel.'}
        </p>
      )}

      {caPath && !diag?.secureContext && (
        <p className="hb-voice-check-hint" role="status">
          {kid
            ? 'A grown-up can download the trust file over HTTP, then turn on Certificate Trust Settings.'
            : `Download CA over HTTP: ${caPath} — then Settings → General → About → Certificate Trust Settings.`}
        </p>
      )}

      {diag?.ios && (
        <p className="hb-voice-check-hint" role="status">
          {kid
            ? 'If you cannot hear replies, flip the mute switch on the side to Ring and turn the volume up.'
            : 'Silent switch mutes spoken replies — flip to Ring and raise volume.'}
        </p>
      )}

      <div className="hb-voice-check-actions">
        <button type="button" className="hb-voice-check-btn" disabled={busy} onClick={() => void refresh()}>
          Refresh
        </button>
        <button type="button" className="hb-voice-check-btn" disabled={busy} onClick={() => void unlock()}>
          Unlock speech
        </button>
        {caPath && (
          <a className="hb-voice-check-btn" href={caPath} download="homebase-local-ca.crt">
            Download CA
          </a>
        )}
      </div>
    </section>
  )
}
