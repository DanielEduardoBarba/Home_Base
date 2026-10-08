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

/**
 * Start listening; calls onPartial with live text and onFinal when a phrase commits.
 * Returns a handle to stop. Requires a user gesture on most browsers (esp. iOS).
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
  let committed = ''

  rec.onresult = (ev) => {
    let interim = ''
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const piece = ev.results[i][0]?.transcript || ''
      if (ev.results[i].isFinal) {
        committed = (committed + ' ' + piece).replace(/\s+/g, ' ').trim()
        opts.onFinal(committed)
      } else {
        interim += piece
      }
    }
    const live = (committed + (interim ? ' ' + interim : '')).replace(/\s+/g, ' ').trim()
    opts.onPartial(live)
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
      // Some mobile engines end after a pause — restart while user still wants dictation
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
      opts.onEnd?.()
    },
  }
}
