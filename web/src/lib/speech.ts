/**
 * Browser speech helpers for Home Base + Doodle (Chrome / Safari / iOS WebKit).
 * Pure helpers are unit-tested; browser APIs are gated for iOS secure-context quirks.
 */

export type SpeechHandle = {
  stop: () => void
}

export type VoiceDiagnostics = {
  secureContext: boolean
  recognitionApi: boolean
  mediaRecorder: boolean
  speechSynthesis: boolean
  micPermission: 'granted' | 'denied' | 'prompt' | 'unknown'
  synthVoices: number
  ios: boolean
  lastError: string | null
}

type SpeechRecognitionLike = {
  lang: string
  continuous: boolean
  interimResults: boolean
  maxAlternatives: number
  start: () => void
  stop: () => void
  abort: () => void
  onresult: ((ev: SpeechRecognitionEventLike) => void) | null
  onerror: ((ev: { error?: string }) => void) | null
  onend: (() => void) | null
}

type SpeechRecognitionEventLike = {
  resultIndex: number
  results: {
    length: number
    [i: number]: {
      isFinal: boolean
      [j: number]: { transcript: string }
    }
  }
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike

export type SpeechSynthesisVoiceLike = {
  lang: string
  name: string
  localService?: boolean
  default?: boolean
}

let lastSpeechError: string | null = null
let synthUnlocked = false
let preferredVoice: SpeechSynthesisVoiceLike | null = null
let speakingActive = false
let synthWatchdog: ReturnType<typeof setInterval> | null = null

/** Test / UI: last speech-related error string. */
export function getLastSpeechError(): string | null {
  return lastSpeechError
}

export function setLastSpeechError(message: string | null): void {
  lastSpeechError = message ? message.trim().slice(0, 400) || null : null
}

export function isSpeaking(): boolean {
  return speakingActive
}

export function isIosUserAgent(ua: string): boolean {
  const u = (ua || '').toLowerCase()
  if (/iphone|ipad|ipod/.test(u)) return true
  // iPadOS 13+ desktop UA still needs the WebKit speech path.
  if (/macintosh/.test(u) && typeof navigator !== 'undefined' && Number(navigator.maxTouchPoints || 0) > 1) {
    return true
  }
  return false
}

export function isIosBrowser(): boolean {
  if (typeof navigator === 'undefined') return false
  return isIosUserAgent(navigator.userAgent || '')
}

/** iOS continuous=true is unreliable — use false + restart loop. */
export function shouldUseContinuousRecognition(ua: string): boolean {
  return !isIosUserAgent(ua)
}

export function mapSpeechRecognitionError(
  error: string,
  opts: { kid?: boolean } = {},
): string {
  const kid = !!opts.kid
  const code = (error || '').trim().toLowerCase()
  switch (code) {
    case 'not-allowed':
      return kid
        ? 'Please allow the microphone for this page (ask a grown-up if you need help).'
        : 'Microphone permission denied — allow mic access for this site in Safari Settings.'
    case 'service-not-allowed':
      return kid
        ? 'Voice listening is turned off on this iPhone/iPad. A grown-up can enable Dictation in Settings.'
        : 'Speech service not allowed — enable Settings → Siri & Dictation / Keyboard → Enable Dictation (Screen Time may block it).'
    case 'audio-capture':
      return kid
        ? 'Could not hear the microphone. Check that nothing else is using it.'
        : 'Audio capture failed — another app may be using the microphone, or mic access is blocked.'
    case 'network':
      return kid
        ? 'Voice needs a network connection. Try again in a moment.'
        : 'Speech recognition network error — check connectivity and try again.'
    case 'no-speech':
      return kid ? 'I did not hear anything — tap Talk and try again.' : 'No speech detected'
    case 'aborted':
      return kid ? 'Listening stopped.' : 'Speech recognition aborted'
    case 'bad-grammar':
    case 'language-not-supported':
      return kid
        ? 'This device cannot understand that language for talking.'
        : `Speech recognition error: ${code}`
    default:
      return kid ? `Voice hiccup (${code || 'unknown'}). Try typing instead.` : `Speech: ${code || 'error'}`
  }
}

export function secureContextMessages(opts: {
  kid?: boolean
  httpsUrl?: string | null
} = {}): { title: string; body: string } {
  const https = (opts.httpsUrl || '').trim()
  const linkHint = https
    ? ` Open ${https} instead.`
    : ' Ask a grown-up to open the Cloudflare Tunnel HTTPS link from Home Base Settings → Cloudflare Tunnel (or finish the Setup HTTPS step).'
  if (opts.kid) {
    return {
      title: 'Voice needs a safe link',
      body:
        'Talking out loud only works on a special secure web address (https).' +
        linkHint +
        ' You can still type your message!',
    }
  }
  return {
    title: 'Secure connection required for voice',
    body:
      'Microphone and speech recognition need a secure context (HTTPS or localhost). ' +
      'http://LAN-IP and WireGuard VPN IPs are blocked by iOS/Safari.' +
      (https
        ? ` Use the Cloudflare Tunnel URL: ${https}`
        : ' Configure Settings → Cloudflare Tunnel (or the Setup HTTPS step) and open that https:// URL.') +
      ' Text chat still works.',
  }
}

/** Split long TTS into sentence-sized chunks (iOS cuts long utterances). */
export function chunkTextForSpeech(text: string, maxLen = 220): string[] {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (!clean) return []
  if (clean.length <= maxLen) return [clean]

  const parts: string[] = []
  const sentences = clean.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [clean]
  let buf = ''
  for (const raw of sentences) {
    const s = raw.trim()
    if (!s) continue
    if (s.length > maxLen) {
      if (buf) {
        parts.push(buf)
        buf = ''
      }
      for (let i = 0; i < s.length; i += maxLen) {
        parts.push(s.slice(i, i + maxLen).trim())
      }
      continue
    }
    if (!buf) {
      buf = s
    } else if (buf.length + 1 + s.length <= maxLen) {
      buf = `${buf} ${s}`
    } else {
      parts.push(buf)
      buf = s
    }
  }
  if (buf) parts.push(buf)
  return parts.filter(Boolean)
}

export function pickEnglishVoice(
  voices: SpeechSynthesisVoiceLike[],
  lang = 'en-US',
): SpeechSynthesisVoiceLike | null {
  if (!voices.length) return null
  const want = lang.toLowerCase()
  const primary = want.slice(0, 2)
  const scored = voices
    .map((v) => {
      const l = (v.lang || '').toLowerCase()
      let score = 0
      if (l === want) score += 100
      else if (l.startsWith(primary)) score += 50
      else if (l.includes(primary)) score += 20
      if (v.localService) score += 5
      if (v.default) score += 2
      if (/enhanced|premium|siri|neural/i.test(v.name || '')) score += 3
      return { v, score }
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
  return scored[0]?.v || voices.find((v) => /^en/i.test(v.lang || '')) || voices[0] || null
}

function getCtor(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor
    webkitSpeechRecognition?: SpeechRecognitionCtor
  }
  return w.SpeechRecognition || w.webkitSpeechRecognition || null
}

export function speechSupported(): boolean {
  return !!getCtor()
}

export function speechSynthesisSupported(): boolean {
  return typeof window !== 'undefined' && typeof window.speechSynthesis !== 'undefined'
}

export function mediaRecorderSupported(): boolean {
  return typeof window !== 'undefined' && typeof MediaRecorder !== 'undefined'
}

export function isSecureContext(): boolean {
  if (typeof window === 'undefined') return true
  return !!window.isSecureContext
}

function clearSynthWatchdog(): void {
  if (synthWatchdog) {
    clearInterval(synthWatchdog)
    synthWatchdog = null
  }
}

function startSynthWatchdog(): void {
  clearSynthWatchdog()
  if (typeof window === 'undefined' || !window.speechSynthesis) return
  synthWatchdog = setInterval(() => {
    try {
      const s = window.speechSynthesis
      if (!speakingActive) {
        clearSynthWatchdog()
        return
      }
      // iOS sometimes leaves synth paused/stuck mid-utterance.
      if (s.paused || (s.speaking && s.pending === false && s.paused)) {
        try {
          s.resume()
        } catch {
          /* ignore */
        }
      }
      if (!s.speaking && !s.pending) {
        // Stuck: cancel + resume so the next chunk can proceed.
        try {
          s.cancel()
          s.resume()
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
  }, 1200)
}

function loadVoices(): SpeechSynthesisVoiceLike[] {
  if (!speechSynthesisSupported()) return []
  try {
    return window.speechSynthesis.getVoices() as SpeechSynthesisVoiceLike[]
  } catch {
    return []
  }
}

function ensurePreferredVoice(lang: string): void {
  const voices = loadVoices()
  if (!voices.length) return
  preferredVoice = pickEnglishVoice(voices, lang)
}

/**
 * Must run inside a user gesture on iOS so later async TTS can speak.
 * Speaks a near-empty utterance and resumes the synth.
 */
export async function unlockSpeechSynthesis(): Promise<boolean> {
  if (!speechSynthesisSupported()) return false
  if (synthUnlocked) {
    try {
      window.speechSynthesis.resume()
    } catch {
      /* ignore */
    }
    return true
  }
  try {
    ensurePreferredVoice('en-US')
    const waitVoices = new Promise<void>((resolve) => {
      const existing = loadVoices()
      if (existing.length) {
        resolve()
        return
      }
      const done = () => {
        try {
          window.speechSynthesis.removeEventListener('voiceschanged', done)
        } catch {
          /* ignore */
        }
        resolve()
      }
      try {
        window.speechSynthesis.addEventListener('voiceschanged', done)
      } catch {
        resolve()
        return
      }
      window.setTimeout(done, 800)
    })
    await waitVoices
    ensurePreferredVoice('en-US')
    try {
      window.speechSynthesis.cancel()
      window.speechSynthesis.resume()
    } catch {
      /* ignore */
    }
    await new Promise<void>((resolve) => {
      try {
        const u = new SpeechSynthesisUtterance(' ')
        u.volume = 0
        u.rate = 1
        u.lang = 'en-US'
        if (preferredVoice && 'voice' in u) {
          ;(u as SpeechSynthesisUtterance).voice =
            preferredVoice as unknown as SpeechSynthesisUtterance['voice']
        }
        u.onend = () => resolve()
        u.onerror = () => resolve()
        window.speechSynthesis.speak(u)
        window.setTimeout(resolve, 500)
      } catch {
        resolve()
      }
    })
    try {
      window.speechSynthesis.resume()
    } catch {
      /* ignore */
    }
    synthUnlocked = true
    return true
  } catch (e) {
    setLastSpeechError(e instanceof Error ? e.message : 'Could not unlock speech')
    return false
  }
}

export type SpeakOpts = {
  lang?: string
  onStart?: () => void
  onEnd?: () => void
  onError?: (message: string) => void
}

/** Speak English (or lang) aloud; cancels in-flight speech; chunks for iOS. */
export function speakText(text: string, opts: SpeakOpts = {}): void {
  if (!speechSynthesisSupported()) {
    opts.onEnd?.()
    return
  }
  const clean = text.replace(/\s+/g, ' ').trim()
  if (!clean) {
    opts.onEnd?.()
    return
  }
  const lang = opts.lang || 'en-US'
  const chunks = chunkTextForSpeech(clean, isIosBrowser() ? 200 : 4000)
  if (!chunks.length) {
    opts.onEnd?.()
    return
  }

  try {
    window.speechSynthesis.cancel()
  } catch {
    /* ignore */
  }

  speakingActive = true
  opts.onStart?.()
  startSynthWatchdog()
  ensurePreferredVoice(lang)

  let idx = 0
  let finished = false
  const finish = () => {
    if (finished) return
    finished = true
    speakingActive = false
    clearSynthWatchdog()
    opts.onEnd?.()
  }

  const speakNext = () => {
    if (finished) return
    if (idx >= chunks.length) {
      finish()
      return
    }
    const piece = chunks[idx++]!
    try {
      window.speechSynthesis.resume()
      const u = new SpeechSynthesisUtterance(piece)
      u.lang = lang
      if (preferredVoice) {
        try {
          u.voice = preferredVoice as unknown as SpeechSynthesisUtterance['voice']
        } catch {
          /* ignore */
        }
      }
      u.onend = () => speakNext()
      u.onerror = () => {
        setLastSpeechError('Speech synthesis error')
        opts.onError?.('Speech synthesis error')
        // Skip failed chunk and continue so hands-free can recover.
        speakNext()
      }
      window.speechSynthesis.speak(u)
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Could not speak'
      setLastSpeechError(msg)
      opts.onError?.(msg)
      finish()
    }
  }

  // voiceschanged may fire late on iOS — pick voice then start.
  const start = () => {
    ensurePreferredVoice(lang)
    speakNext()
  }
  if (!loadVoices().length) {
    const once = () => {
      try {
        window.speechSynthesis.removeEventListener('voiceschanged', once)
      } catch {
        /* ignore */
      }
      start()
    }
    try {
      window.speechSynthesis.addEventListener('voiceschanged', once)
    } catch {
      start()
      return
    }
    window.setTimeout(start, 400)
  } else {
    start()
  }
}

export function stopSpeaking(): void {
  speakingActive = false
  clearSynthWatchdog()
  try {
    window.speechSynthesis?.cancel()
  } catch {
    /* ignore */
  }
}

function joinSpeech(...parts: string[]): string {
  return parts
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(' ')
    .trim()
}

/**
 * Start listening; calls onPartial with live text and onFinal when a phrase commits.
 * Requires a user gesture on most browsers (esp. iOS). Pauses while TTS is speaking.
 */
export function startSpeechDictation(opts: {
  onPartial: (text: string) => void
  onFinal: (text: string) => void
  onError?: (message: string) => void
  onEnd?: () => void
  lang?: string
  kid?: boolean
}): SpeechHandle | null {
  if (typeof window !== 'undefined' && !window.isSecureContext) {
    const msg = secureContextMessages({ kid: opts.kid }).body
    setLastSpeechError(msg)
    opts.onError?.(msg)
    return null
  }

  const Ctor = getCtor()
  if (!Ctor) {
    const msg = opts.kid
      ? 'Voice listening is not available here — try typing, or use the keyboard mic.'
      : 'Speech recognition is not available in this browser'
    setLastSpeechError(msg)
    opts.onError?.(msg)
    return null
  }

  const ua = typeof navigator !== 'undefined' ? navigator.userAgent || '' : ''
  const continuous = shouldUseContinuousRecognition(ua)
  const rec = new Ctor()
  rec.lang = opts.lang || 'en-US'
  rec.continuous = continuous
  rec.interimResults = true
  rec.maxAlternatives = 1

  let stopped = false
  let restartTimer: ReturnType<typeof setTimeout> | null = null
  /** Survives recognition restarts (common on mobile after a pause). */
  let durable = ''
  /** Finals within the current recognition session. */
  let sessionFinal = ''
  /** Interim words committed when the engine replaces a single interim slot. */
  let sessionCommitted = ''
  /** Last interim seen this session (folded into durable on restart). */
  let lastInterim = ''
  /** Longest live string emitted — never shrink mid-utterance. */
  let lastLive = ''

  const clearRestart = () => {
    if (restartTimer) {
      clearTimeout(restartTimer)
      restartTimer = null
    }
  }

  const emit = (live: string, finalish: boolean) => {
    if (live.length < lastLive.length && !finalish) {
      const head = Math.min(12, live.length)
      if (!live || (head >= 4 && lastLive.startsWith(live.slice(0, head)))) {
        live = lastLive
      }
    }
    if (live.length >= lastLive.length) lastLive = live
    else live = lastLive
    opts.onPartial(live)
    if (finalish) opts.onFinal(live)
  }

  const foldSession = () => {
    durable = joinSpeech(durable, sessionCommitted, sessionFinal, lastInterim)
    sessionFinal = ''
    sessionCommitted = ''
    lastInterim = ''
    if (durable) {
      lastLive = durable
      opts.onFinal(durable)
    }
  }

  const tryStart = () => {
    if (stopped) return
    if (speakingActive) {
      clearRestart()
      restartTimer = setTimeout(tryStart, 300)
      return
    }
    try {
      rec.start()
    } catch {
      clearRestart()
      restartTimer = setTimeout(tryStart, 400)
    }
  }

  rec.onresult = (ev) => {
    let finals = ''
    let interim = ''
    for (let i = 0; i < ev.results.length; i++) {
      const piece = ev.results[i][0]?.transcript || ''
      if (ev.results[i].isFinal) finals += piece
      else interim += piece
    }
    sessionFinal = finals.replace(/\s+/g, ' ').trim()
    const nextInterim = interim.replace(/\s+/g, ' ').trim()
    if (
      lastInterim &&
      nextInterim &&
      !sessionFinal &&
      !nextInterim.startsWith(lastInterim) &&
      !lastInterim.startsWith(nextInterim)
    ) {
      sessionCommitted = joinSpeech(sessionCommitted, lastInterim)
    }
    lastInterim = nextInterim
    if (sessionFinal) sessionCommitted = ''
    const live = joinSpeech(durable, sessionCommitted, sessionFinal, lastInterim)
    emit(live, !!sessionFinal)
  }

  rec.onerror = (ev) => {
    const err = (ev.error || 'speech error').toLowerCase()
    if (err === 'aborted') return
    if (err === 'no-speech') {
      // Expected on iOS single-shot — restart loop handles it.
      return
    }
    const mapped = mapSpeechRecognitionError(err, { kid: opts.kid })
    setLastSpeechError(mapped)
    opts.onError?.(mapped)
    if (err === 'not-allowed' || err === 'service-not-allowed' || err === 'audio-capture') {
      stopped = true
      clearRestart()
    }
  }

  rec.onend = () => {
    if (stopped) {
      opts.onEnd?.()
      return
    }
    foldSession()
    // Controlled restart (esp. iOS continuous=false).
    clearRestart()
    restartTimer = setTimeout(() => {
      if (stopped) {
        opts.onEnd?.()
        return
      }
      tryStart()
    }, speakingActive ? 350 : 180)
  }

  try {
    tryStart()
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Could not start microphone'
    setLastSpeechError(msg)
    opts.onError?.(msg)
    return null
  }

  return {
    stop: () => {
      stopped = true
      clearRestart()
      try {
        rec.onend = null
        rec.stop()
      } catch {
        try {
          rec.abort()
        } catch {
          /* ignore */
        }
      }
      const finalText =
        joinSpeech(durable, sessionCommitted, sessionFinal, lastInterim) || lastLive
      if (finalText) opts.onFinal(finalText)
      opts.onEnd?.()
    },
  }
}

/** Preferred MediaRecorder mime for the current browser (mp4 on iOS). */
export function preferredRecordingMime(): string {
  if (typeof MediaRecorder === 'undefined') return ''
  const ios = isIosBrowser()
  const candidates = ios
    ? ['audio/mp4', 'audio/aac', 'audio/webm', 'audio/ogg']
    : ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg']
  for (const m of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(m)) return m
    } catch {
      /* ignore */
    }
  }
  return ''
}

/**
 * Push-to-talk MediaRecorder fallback when SpeechRecognition is missing/blocked.
 * Call stop() to finish; onBlob receives the recorded audio.
 */
export function startMediaRecorderCapture(opts: {
  onBlob: (blob: Blob, mime: string) => void
  onError?: (message: string) => void
  kid?: boolean
}): SpeechHandle | null {
  if (typeof window !== 'undefined' && !window.isSecureContext) {
    const msg = secureContextMessages({ kid: opts.kid }).body
    setLastSpeechError(msg)
    opts.onError?.(msg)
    return null
  }
  if (!mediaRecorderSupported() || typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    const msg = opts.kid
      ? 'Recording is not available — type your message or use the keyboard mic.'
      : 'MediaRecorder / getUserMedia not available in this browser'
    setLastSpeechError(msg)
    opts.onError?.(msg)
    return null
  }

  let stopped = false
  let recorder: MediaRecorder | null = null
  let stream: MediaStream | null = null
  const chunks: BlobPart[] = []
  const mime = preferredRecordingMime()

  void (async () => {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      if (stopped) {
        stream.getTracks().forEach((t) => t.stop())
        return
      }
      recorder = mime
        ? new MediaRecorder(stream, { mimeType: mime })
        : new MediaRecorder(stream)
      const usedMime = recorder.mimeType || mime || 'audio/webm'
      recorder.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) chunks.push(ev.data)
      }
      recorder.onerror = () => {
        const msg = 'Recording failed'
        setLastSpeechError(msg)
        opts.onError?.(msg)
      }
      recorder.onstop = () => {
        stream?.getTracks().forEach((t) => t.stop())
        stream = null
        const blob = new Blob(chunks, { type: usedMime })
        if (blob.size > 0) opts.onBlob(blob, usedMime)
      }
      recorder.start()
    } catch (e) {
      const name = e instanceof DOMException ? e.name : ''
      let msg: string
      if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
        msg = mapSpeechRecognitionError('not-allowed', { kid: opts.kid })
      } else {
        msg = e instanceof Error ? e.message : 'Could not start recording'
      }
      setLastSpeechError(msg)
      opts.onError?.(msg)
    }
  })()

  return {
    stop: () => {
      stopped = true
      try {
        if (recorder && recorder.state !== 'inactive') recorder.stop()
        else stream?.getTracks().forEach((t) => t.stop())
      } catch {
        stream?.getTracks().forEach((t) => t.stop())
      }
    },
  }
}

export async function queryMicPermission(): Promise<VoiceDiagnostics['micPermission']> {
  if (typeof navigator === 'undefined' || !navigator.permissions?.query) return 'unknown'
  try {
    const st = await navigator.permissions.query({ name: 'microphone' as PermissionName })
    if (st.state === 'granted' || st.state === 'denied' || st.state === 'prompt') return st.state
    return 'unknown'
  } catch {
    return 'unknown'
  }
}

export async function collectVoiceDiagnostics(): Promise<VoiceDiagnostics> {
  const micPermission = await queryMicPermission()
  return {
    secureContext: isSecureContext(),
    recognitionApi: speechSupported(),
    mediaRecorder: mediaRecorderSupported(),
    speechSynthesis: speechSynthesisSupported(),
    micPermission,
    synthVoices: loadVoices().length,
    ios: isIosBrowser(),
    lastError: lastSpeechError,
  }
}
