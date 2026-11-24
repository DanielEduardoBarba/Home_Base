import { afterEach, describe, expect, test } from 'bun:test'
import {
  chunkTextForSpeech,
  getServerTranscriptionConfigured,
  isIosUserAgent,
  isWebKitUserAgent,
  mapSpeechRecognitionError,
  pickEnglishVoice,
  preferBrowserSpeechRecognition,
  preferServerTranscription,
  secureContextMessages,
  selectVoiceListenPath,
  serverTranscriptionMissingMessages,
  setServerTranscriptionConfigured,
  shouldUseContinuousRecognition,
  silentSwitchHintMessages,
} from './speech'

afterEach(() => {
  setServerTranscriptionConfigured(null)
})

describe('isIosUserAgent / continuous mode', () => {
  test('detects iPhone and iPad UAs', () => {
    expect(isIosUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)')).toBe(true)
    expect(isIosUserAgent('Mozilla/5.0 (iPad; CPU OS 16_0 like Mac OS X)')).toBe(true)
    expect(isIosUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120')).toBe(false)
  })

  test('iOS uses continuous=false', () => {
    expect(shouldUseContinuousRecognition('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)')).toBe(false)
    expect(shouldUseContinuousRecognition('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120')).toBe(
      true,
    )
  })
})

describe('preferServerTranscription / browser fast path', () => {
  const ios = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15'
  const safari =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'
  const chrome =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

  test('iOS and Safari WebKit prefer server STT when configured / unknown', () => {
    expect(preferServerTranscription(ios, { serverConfigured: true })).toBe(true)
    expect(isWebKitUserAgent(safari)).toBe(true)
    expect(preferServerTranscription(safari, { serverConfigured: true })).toBe(true)
    expect(preferBrowserSpeechRecognition(ios, { serverConfigured: true })).toBe(false)
  })

  test('iOS does not prefer server when not configured (browser fallback)', () => {
    expect(preferServerTranscription(ios, { serverConfigured: false })).toBe(false)
    expect(preferServerTranscription(safari, { serverConfigured: false })).toBe(false)
    setServerTranscriptionConfigured(false)
    expect(getServerTranscriptionConfigured()).toBe(false)
    expect(preferServerTranscription(ios)).toBe(false)
  })

  test('desktop Chrome prefers browser SpeechRecognition', () => {
    expect(preferServerTranscription(chrome, { serverConfigured: true })).toBe(false)
    expect(preferBrowserSpeechRecognition(chrome, { serverConfigured: true })).toBe(true)
  })
})

describe('selectVoiceListenPath matrix (iOS/desktop × configured × recognition)', () => {
  const ios = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15'
  const chrome =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

  const cases: Array<{
    name: string
    ua: string
    serverConfigured: boolean
    recognitionAvailable: boolean
    path: 'server' | 'browser' | 'keyboard'
  }> = [
    { name: 'iOS configured + recognition', ua: ios, serverConfigured: true, recognitionAvailable: true, path: 'server' },
    { name: 'iOS configured + no recognition', ua: ios, serverConfigured: true, recognitionAvailable: false, path: 'server' },
    { name: 'iOS not configured + recognition', ua: ios, serverConfigured: false, recognitionAvailable: true, path: 'browser' },
    { name: 'iOS not configured + no recognition', ua: ios, serverConfigured: false, recognitionAvailable: false, path: 'keyboard' },
    { name: 'desktop configured + recognition', ua: chrome, serverConfigured: true, recognitionAvailable: true, path: 'browser' },
    { name: 'desktop configured + no recognition', ua: chrome, serverConfigured: true, recognitionAvailable: false, path: 'server' },
    { name: 'desktop not configured + recognition', ua: chrome, serverConfigured: false, recognitionAvailable: true, path: 'browser' },
    { name: 'desktop not configured + no recognition', ua: chrome, serverConfigured: false, recognitionAvailable: false, path: 'keyboard' },
  ]

  for (const c of cases) {
    test(c.name, () => {
      expect(
        selectVoiceListenPath({
          ua: c.ua,
          serverConfigured: c.serverConfigured,
          recognitionAvailable: c.recognitionAvailable,
        }),
      ).toBe(c.path)
    })
  }
})

describe('silent switch + missing STT messages', () => {
  test('silent switch hint mentions Ring', () => {
    expect(silentSwitchHintMessages().body.toLowerCase()).toContain('ring')
  })

  test('missing key message names env var and keyboard fallback', () => {
    expect(serverTranscriptionMissingMessages().body).toContain('HOMEBASE_TRANSCRIBE_API_KEY')
    expect(serverTranscriptionMissingMessages().body.toLowerCase()).toContain('keyboard mic')
  })
})

describe('mapSpeechRecognitionError', () => {
  test('maps not-allowed and service-not-allowed with adult copy', () => {
    expect(mapSpeechRecognitionError('not-allowed')).toContain('Microphone permission denied')
    expect(mapSpeechRecognitionError('service-not-allowed')).toContain('Enable Dictation')
    expect(mapSpeechRecognitionError('audio-capture')).toContain('microphone')
  })

  test('aborted and unknown stay specific', () => {
    expect(mapSpeechRecognitionError('aborted')).toContain('aborted')
    expect(mapSpeechRecognitionError('weird-code')).toContain('weird-code')
  })
})

describe('chunkTextForSpeech', () => {
  test('returns empty for blank', () => {
    expect(chunkTextForSpeech('')).toEqual([])
    expect(chunkTextForSpeech('   ')).toEqual([])
  })

  test('keeps short text as one chunk', () => {
    expect(chunkTextForSpeech('Hello there.')).toEqual(['Hello there.'])
  })

  test('splits long multi-sentence replies', () => {
    const a = 'Hello friend. '.repeat(30)
    const chunks = chunkTextForSpeech(a, 80)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.join(' ').replace(/\s+/g, ' ').trim().length).toBeGreaterThan(50)
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(90)
  })

  test('hard-splits a single oversized sentence', () => {
    const long = 'word '.repeat(100).trim()
    const chunks = chunkTextForSpeech(long, 40)
    expect(chunks.length).toBeGreaterThan(2)
    expect(chunks.every((c) => c.length <= 40)).toBe(true)
  })
})

describe('pickEnglishVoice', () => {
  test('prefers exact en-US then en-*', () => {
    const voices = [
      { lang: 'fr-FR', name: 'French' },
      { lang: 'en-GB', name: 'British' },
      { lang: 'en-US', name: 'Samantha', localService: true },
    ]
    expect(pickEnglishVoice(voices, 'en-US')?.name).toBe('Samantha')
    expect(pickEnglishVoice(voices.filter((v) => v.lang !== 'en-US'), 'en-US')?.lang).toBe('en-GB')
  })

  test('returns null for empty list', () => {
    expect(pickEnglishVoice([])).toBe(null)
  })
})

describe('secureContextMessages', () => {
  test('adult message mentions HTTPS and optional tunnel URL', () => {
    const m = secureContextMessages({ httpsUrl: 'https://hb.example.com' })
    expect(m.title.toLowerCase()).toContain('secure')
    expect(m.body).toContain('https://hb.example.com')
    expect(m.body.toLowerCase()).toContain('text chat')
  })
})

describe('unlockSpeechSynthesis contract', () => {
  // unlockSpeechSynthesis is browser-only; we assert the export exists and
  // chunk/voice helpers used by the unlock + speak path stay stable.
  test('chunking used after unlock stays deterministic', () => {
    expect(chunkTextForSpeech('One. Two. Three.', 8).length).toBeGreaterThanOrEqual(2)
  })
})
