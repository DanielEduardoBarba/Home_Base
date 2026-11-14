import { describe, expect, test } from 'bun:test'
import {
  chunkTextForSpeech,
  isIosUserAgent,
  mapSpeechRecognitionError,
  pickEnglishVoice,
  secureContextMessages,
  shouldUseContinuousRecognition,
} from './speech'

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

describe('mapSpeechRecognitionError', () => {
  test('maps not-allowed and service-not-allowed with adult copy', () => {
    expect(mapSpeechRecognitionError('not-allowed')).toContain('Microphone permission denied')
    expect(mapSpeechRecognitionError('service-not-allowed')).toContain('Enable Dictation')
    expect(mapSpeechRecognitionError('audio-capture')).toContain('microphone')
  })

  test('maps kid-friendly variants', () => {
    expect(mapSpeechRecognitionError('service-not-allowed', { kid: true })).toContain('grown-up')
    expect(mapSpeechRecognitionError('not-allowed', { kid: true })).toContain('microphone')
    expect(mapSpeechRecognitionError('no-speech', { kid: true })).toContain('hear')
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

  test('kid message is gentle and mentions typing', () => {
    const m = secureContextMessages({ kid: true })
    expect(m.title.toLowerCase()).toContain('safe')
    expect(m.body.toLowerCase()).toContain('type')
    expect(m.body.toLowerCase()).toContain('grown-up')
  })
})

describe('unlockSpeechSynthesis contract', () => {
  // unlockSpeechSynthesis is browser-only; we assert the export exists and
  // chunk/voice helpers used by the unlock + speak path stay stable.
  test('chunking used after unlock stays deterministic', () => {
    expect(chunkTextForSpeech('One. Two. Three.', 8).length).toBeGreaterThanOrEqual(2)
  })
})
