'use client'

/**
 * Shared Talk / mic session for ChatPanel, Doodle, and every chat bot surface.
 * Owns listen/record/speak orchestration — no duplicate speech wiring in UI.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from './api'
import {
  isIosBrowser,
  isSecureContext,
  mediaRecorderSupported,
  preferBrowserSpeechRecognition,
  preferServerTranscription,
  secureContextMessages,
  serverTranscriptionMissingMessages,
  silentSwitchHintMessages,
  speakText,
  speechSupported,
  speechSynthesisSupported,
  startMediaRecorderCapture,
  startSpeechDictation,
  stopSpeaking,
  unlockSpeechSynthesis,
  type SpeechHandle,
} from './speech'

export type VoiceIssueLevel = 'error' | 'warn'

export type UseVoiceSessionOpts = {
  /** Agent Talk or Doodle kid mic. */
  enabled: boolean
  kid?: boolean
  /** Apply dictation text into the composer. */
  onText: (text: string) => void
  /** Surface errors / hints (toast + status). */
  onIssue: (message: string, level?: VoiceIssueLevel) => void
  /** Unlock notification / WebAudio if the host has it. */
  unlockAudio?: () => void
  /** Current composer value when starting a listen without an explicit prefix. */
  getComposerText: () => string
}

export type UseVoiceSession = {
  voiceMode: boolean
  listening: boolean
  canSpeak: boolean
  canTts: boolean
  /** True when this device prefers MediaRecorder → server Whisper. */
  usesServerStt: boolean
  /** Show Ring/Silent switch hint (iOS). */
  showSilentSwitchHint: boolean
  silentSwitchHint: string
  toggleTalk: () => void
  stopListening: () => void
  /** Speak an assistant reply; resumes listen on end while Talk stays on. */
  speakReply: (text: string) => void
  /** Resume listening after send / TTS if Talk is still armed. */
  resumeListenSoon: (delayMs?: number) => void
  beginListen: (prefix?: string) => void
}

export function useVoiceSession(opts: UseVoiceSessionOpts): UseVoiceSession {
  const { enabled, kid = false } = opts
  const [listening, setListening] = useState(false)
  const [voiceMode, setVoiceMode] = useState(false)
  const voiceModeRef = useRef(false)
  voiceModeRef.current = voiceMode

  const speechRef = useRef<SpeechHandle | null>(null)
  const listenGen = useRef(0)
  const inputBeforeSpeech = useRef('')
  const optsRef = useRef(opts)
  optsRef.current = opts

  const canSpeak = useMemo(() => speechSupported(), [])
  const canTts = useMemo(() => speechSynthesisSupported(), [])
  const usesServerStt = useMemo(() => preferServerTranscription(), [])
  const showSilentSwitchHint = useMemo(() => isIosBrowser() && voiceMode, [voiceMode])
  const silentSwitchHint = useMemo(
    () => silentSwitchHintMessages({ kid }).body,
    [kid],
  )

  const stopListening = useCallback(() => {
    listenGen.current += 1
    const handle = speechRef.current
    speechRef.current = null
    setListening(false)
    handle?.stop()
  }, [])

  const beginRecord = useCallback(
    (gen: number, prefix?: string) => {
      const o = optsRef.current
      inputBeforeSpeech.current = (prefix ?? o.getComposerText()).trim()
      const handle = startMediaRecorderCapture({
        kid: o.kid,
        onError: (message) => {
          if (gen !== listenGen.current) return
          o.onIssue(
            `${message} Tip: use the keyboard mic (dictation) or type — text chat always works.`,
            'warn',
          )
        },
        onBlob: (blob, mime) => {
          if (gen !== listenGen.current) return
          setListening(false)
          speechRef.current = null
          void (async () => {
            try {
              const st = await api.speechStatus()
              if (!st.configured) {
                o.onIssue(serverTranscriptionMissingMessages({ kid: o.kid }).body, 'warn')
                return
              }
              const filename =
                mime.includes('mp4') || mime.includes('aac') ? 'speech.m4a' : 'speech.webm'
              const res = await api.speechTranscribe(blob, filename)
              const text = (res.text || '').trim()
              if (!text) {
                o.onIssue(
                  o.kid ? 'I could not catch that — try again!' : 'No speech transcribed',
                  'warn',
                )
                return
              }
              const base = inputBeforeSpeech.current
              o.onText(base ? `${base} ${text}` : text)
            } catch (e) {
              o.onIssue(e instanceof Error ? e.message : 'Transcription failed', 'warn')
            }
          })()
        },
      })
      if (!handle) return
      if (gen !== listenGen.current) {
        handle.stop()
        return
      }
      speechRef.current = handle
      setListening(true)
      if (enabled) {
        o.onIssue(
          o.kid
            ? 'Hold Talk — I am recording. Tap again when you finish.'
            : 'Recording… tap Talk again to send audio for transcription.',
          'warn',
        )
      }
    },
    [enabled],
  )

  const beginListen = useCallback(
    (prefix?: string) => {
      const o = optsRef.current
      const gen = ++listenGen.current
      const prev = speechRef.current
      speechRef.current = null
      setListening(false)
      prev?.stop()
      o.unlockAudio?.()
      void unlockSpeechSynthesis()

      if (!isSecureContext()) {
        const msg = secureContextMessages({ kid: o.kid }).body
        o.onIssue(msg)
        void (async () => {
          try {
            let httpsUrl: string | null = null
            try {
              const tls = await api.tlsStatus()
              httpsUrl = tls.urls?.vpnHttps || tls.urls?.lanHttps || null
            } catch {
              /* optional */
            }
            if (!httpsUrl) {
              const cf = await api.cloudflareStatus()
              httpsUrl = cf.publicUrl || null
            }
            if (httpsUrl) {
              o.onIssue(secureContextMessages({ kid: o.kid, httpsUrl }).body)
            }
          } catch {
            /* keep generic */
          }
        })()
        return
      }

      inputBeforeSpeech.current = (prefix ?? o.getComposerText()).trim()
      const applySpeech = (text: string) => {
        if (gen !== listenGen.current) return
        const base = inputBeforeSpeech.current
        o.onText(base ? `${base} ${text}` : text)
      }
      const onSpeechError = (message: string) => {
        if (gen !== listenGen.current) return
        o.onIssue(message)
      }

      const useServer =
        preferServerTranscription() && mediaRecorderSupported() && voiceModeRef.current && enabled
      const useBrowserFast =
        preferBrowserSpeechRecognition() && speechSupported() && !useServer

      // PRIMARY on iOS/WebKit: MediaRecorder → server STT.
      if (useServer) {
        beginRecord(gen, prefix)
        return
      }

      // Optional fast path (desktop Chrome) or best-effort elsewhere.
      if (useBrowserFast || (speechSupported() && !preferServerTranscription())) {
        const handle = startSpeechDictation({
          onPartial: applySpeech,
          onFinal: applySpeech,
          onError: onSpeechError,
          onEnd: () => {
            if (gen !== listenGen.current) return
            speechRef.current = null
            setListening(false)
            if (voiceModeRef.current && enabled) {
              window.setTimeout(() => {
                if (voiceModeRef.current && listenGen.current === gen) beginListen()
              }, 250)
            }
          },
          lang: 'en-US',
          kid: o.kid,
        })
        if (handle) {
          if (gen !== listenGen.current) {
            handle.stop()
            return
          }
          speechRef.current = handle
          setListening(true)
          return
        }
      }

      // Fallback: server STT when browser recognition missing/failed.
      if (mediaRecorderSupported() && enabled && voiceModeRef.current) {
        beginRecord(gen, prefix)
        return
      }

      if (preferServerTranscription()) {
        o.onIssue(serverTranscriptionMissingMessages({ kid: o.kid }).body, 'warn')
      }
    },
    [beginRecord, enabled],
  )

  const resumeListenSoon = useCallback(
    (delayMs = 400) => {
      if (!enabled || !voiceModeRef.current) return
      if (!(speechSupported() || mediaRecorderSupported() || preferServerTranscription())) return
      window.setTimeout(() => {
        if (voiceModeRef.current) beginListen('')
      }, delayMs)
    },
    [beginListen, enabled],
  )

  const speakReply = useCallback(
    (text: string) => {
      if (!text.trim()) return
      try {
        stopListening()
        speakText(text, {
          onEnd: () => {
            if (voiceModeRef.current && (speechSupported() || mediaRecorderSupported())) {
              window.setTimeout(() => {
                if (voiceModeRef.current) beginListen('')
              }, 280)
            }
          },
        })
      } catch (e) {
        console.error('[home-agent] speak failed', e)
      }
    },
    [beginListen, stopListening],
  )

  const toggleTalk = useCallback(() => {
    const o = optsRef.current
    if (!enabled) {
      if (listening) {
        stopListening()
        return
      }
      void unlockSpeechSynthesis()
      beginListen()
      return
    }

    if (voiceMode) {
      setVoiceMode(false)
      voiceModeRef.current = false
      stopListening()
      stopSpeaking()
      return
    }

    setVoiceMode(true)
    voiceModeRef.current = true
    o.unlockAudio?.()
    void unlockSpeechSynthesis()
    if (!isSecureContext()) {
      beginListen()
      return
    }
    if (canSpeak || mediaRecorderSupported() || preferServerTranscription()) {
      beginListen()
    } else {
      stopListening()
      o.onIssue(
        o.kid
          ? 'I can still talk back out loud — type your words, or ask a grown-up to check Voice check in Settings.'
          : 'Microphone dictation unavailable here — Talk will still speak AI replies. Use the keyboard mic if available.',
        'warn',
      )
    }
  }, [beginListen, canSpeak, enabled, listening, stopListening, voiceMode])

  useEffect(() => {
    return () => {
      listenGen.current += 1
      speechRef.current?.stop()
      stopSpeaking()
    }
  }, [])

  return {
    voiceMode,
    listening,
    canSpeak,
    canTts,
    usesServerStt,
    showSilentSwitchHint,
    silentSwitchHint,
    toggleTalk,
    stopListening,
    speakReply,
    resumeListenSoon,
    beginListen,
  }
}
