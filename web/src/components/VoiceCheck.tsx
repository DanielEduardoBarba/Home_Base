'use client'

import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/api'
import {
  collectVoiceDiagnostics,
  unlockSpeechSynthesis,
  type VoiceDiagnostics,
} from '../lib/speech'

type Props = {
  /** Kid-friendly copy for Doodle device settings. */
  kid?: boolean
  className?: string
}

/**
 * Small voice diagnostic for Settings / Doodle device settings.
 * Shows secure context, recognition API, mic permission, synth voices, last error.
 */
export function VoiceCheck({ kid = false, className = '' }: Props) {
  const [diag, setDiag] = useState<VoiceDiagnostics | null>(null)
  const [httpsUrl, setHttpsUrl] = useState<string | null>(null)
  const [transcribe, setTranscribe] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    setBusy(true)
    try {
      const d = await collectVoiceDiagnostics()
      setDiag(d)
      try {
        const cf = await api.cloudflareStatus()
        setHttpsUrl(cf.publicUrl || null)
      } catch {
        setHttpsUrl(null)
      }
      try {
        const st = await api.speechStatus()
        setTranscribe(!!st.configured)
      } catch {
        setTranscribe(null)
      }
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
          {row('Speech recognition API', diag.recognitionApi ? 'Present' : 'Missing', diag.recognitionApi)}
          {row('MediaRecorder fallback', diag.mediaRecorder ? 'Present' : 'Missing', diag.mediaRecorder)}
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
              : 'Ask a grown-up to open the Home Base https link (Cloudflare Tunnel) for Talk to work.'
            : httpsUrl
              ? `Open the HTTPS tunnel URL instead: ${httpsUrl}`
              : 'Open Settings → Cloudflare Tunnel and use the https:// public URL (not http://LAN or VPN IP).'}
        </p>
      )}

      <div className="hb-voice-check-actions">
        <button type="button" className="hb-voice-check-btn" disabled={busy} onClick={() => void refresh()}>
          Refresh
        </button>
        <button type="button" className="hb-voice-check-btn" disabled={busy} onClick={() => void unlock()}>
          Unlock speech
        </button>
      </div>
    </section>
  )
}
