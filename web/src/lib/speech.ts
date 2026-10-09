/** Browser SpeechRecognition (Chrome / Safari / iOS WebKit) for English dictation. */

export type SpeechHandle = {
  stop: () => void
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

function getCtor(): SpeechRecognitionCtor | null {
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor
    webkitSpeechRecognition?: SpeechRecognitionCtor
  }
  return w.SpeechRecognition || w.webkitSpeechRecognition || null
}

export function speechSupported(): boolean {
  return !!getCtor()
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
 * Returns a handle to stop. Requires a user gesture on most browsers (esp. iOS).
 *
 * Accumulates across mobile engines that end/restart after a pause, and across
 * interim-only results that only expose the latest word.
 */
export function startSpeechDictation(opts: {
  onPartial: (text: string) => void
  onFinal: (text: string) => void
  onError?: (message: string) => void
  onEnd?: () => void
  lang?: string
}): SpeechHandle | null {
  const Ctor = getCtor()
  if (!Ctor) {
    opts.onError?.('Speech recognition is not available in this browser')
    return null
  }

  const rec = new Ctor()
  rec.lang = opts.lang || 'en-US'
  rec.continuous = true
  rec.interimResults = true
  rec.maxAlternatives = 1

  let stopped = false
  /** Survives recognition restarts (common on mobile after a pause). */
  let durable = ''
  /** Finals within the current recognition session. */
  let sessionFinal = ''
  /** Last interim seen this session (folded into durable on restart). */
  let lastInterim = ''
  /** Longest live string emitted — never shrink mid-utterance. */
  let lastLive = ''

  const emit = (live: string, finalish: boolean) => {
    // Never shrink the live transcript while still listening (interim flicker /
    // single-token replace from some engines).
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

  rec.onresult = (ev) => {
    let finals = ''
    let interim = ''
    // Scan the whole results list — some engines only bump resultIndex, others
    // rewrite the array; reading everything keeps phrases stable.
    for (let i = 0; i < ev.results.length; i++) {
      const piece = ev.results[i][0]?.transcript || ''
      if (ev.results[i].isFinal) finals += piece
      else interim += piece
    }
    sessionFinal = finals.replace(/\s+/g, ' ').trim()
    lastInterim = interim.replace(/\s+/g, ' ').trim()
    const live = joinSpeech(durable, sessionFinal, lastInterim)
    emit(live, !!sessionFinal)
  }

  rec.onerror = (ev) => {
    const err = ev.error || 'speech error'
    if (err === 'aborted' || err === 'no-speech') return
    opts.onError?.(
      err === 'not-allowed'
        ? 'Microphone permission denied'
        : err === 'service-not-allowed'
          ? 'Speech service not allowed'
          : `Speech: ${err}`,
    )
  }

  rec.onend = () => {
    if (!stopped) {
      // Fold this session into durable before the engine restarts with a fresh
      // results list (otherwise the next interim word overwrites the composer).
      durable = joinSpeech(durable, sessionFinal, lastInterim)
      sessionFinal = ''
      lastInterim = ''
      if (durable) {
        lastLive = durable
        opts.onFinal(durable)
      }
      try {
        rec.start()
        return
      } catch {
        /* fall through */
      }
    }
    opts.onEnd?.()
  }

  try {
    rec.start()
  } catch (e) {
    opts.onError?.(e instanceof Error ? e.message : 'Could not start microphone')
    return null
  }

  return {
    stop: () => {
      stopped = true
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
      // Commit whatever we have so the composer keeps the spoken text
      const finalText = joinSpeech(durable, sessionFinal, lastInterim) || lastLive
      if (finalText) opts.onFinal(finalText)
      opts.onEnd?.()
    },
  }
}
