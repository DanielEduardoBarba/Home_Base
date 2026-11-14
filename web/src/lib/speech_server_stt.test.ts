import { describe, expect, test } from 'bun:test'
import { createServerSttSession, type SpeechHandle } from './speech'

type FakeRec = {
  state: 'inactive' | 'recording'
  mimeType: string
  ondataavailable: ((ev: { data: Blob }) => void) | null
  onstop: (() => void) | null
  onerror: (() => void) | null
  start: () => void
  stop: () => void
}

function installFakeMediaRecorder(opts?: { mime?: string; chunk?: Blob }) {
  const mime = opts?.mime || 'audio/webm'
  const chunk = opts?.chunk || new Blob([new Uint8Array([1, 2, 3, 4])], { type: mime })
  const recorders: FakeRec[] = []

  class FakeMediaRecorder {
    state: FakeRec['state'] = 'inactive'
    mimeType = mime
    ondataavailable: FakeRec['ondataavailable'] = null
    onstop: FakeRec['onstop'] = null
    onerror: FakeRec['onerror'] = null
    constructor(_stream: unknown, _init?: { mimeType?: string }) {
      recorders.push(this)
    }
    start() {
      this.state = 'recording'
    }
    stop() {
      this.state = 'inactive'
      this.ondataavailable?.({ data: chunk })
      this.onstop?.()
    }
    static isTypeSupported() {
      return true
    }
  }

  const g = globalThis as unknown as {
    MediaRecorder?: typeof FakeMediaRecorder
    window?: { isSecureContext: boolean }
    navigator?: {
      mediaDevices: { getUserMedia: () => Promise<{ getTracks: () => { stop: () => void }[] }> }
    }
  }
  const prevMR = g.MediaRecorder
  const prevWin = g.window
  const prevNav = g.navigator
  g.MediaRecorder = FakeMediaRecorder
  g.window = { isSecureContext: true }
  g.navigator = {
    mediaDevices: {
      getUserMedia: async () => ({
        getTracks: () => [{ stop: () => undefined }],
      }),
    },
  }

  return {
    recorders,
    restore() {
      if (prevMR === undefined) delete g.MediaRecorder
      else g.MediaRecorder = prevMR
      if (prevWin === undefined) delete g.window
      else g.window = prevWin
      if (prevNav === undefined) delete g.navigator
      else g.navigator = prevNav
    },
  }
}

function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0))
}

describe('createServerSttSession (HB-1246-01)', () => {
  test('tap-start, tap-stop → exactly one transcribe POST; transcript inserted', async () => {
    const fake = installFakeMediaRecorder({
      chunk: new Blob([new Uint8Array([9, 9, 9])], { type: 'audio/webm' }),
    })
    const posts: Array<{ blob: Blob; filename: string }> = []
    const texts: string[] = []
    try {
      const session = createServerSttSession({
        onText: (t) => texts.push(t),
        ensureConfigured: async () => true,
        transcribe: async (blob, filename) => {
          posts.push({ blob, filename })
          return { text: 'hello from stt' }
        },
      })
      session.start()
      await flush()
      expect(fake.recorders.length).toBe(1)
      expect(fake.recorders[0]!.state).toBe('recording')

      session.stop()
      await flush()
      await flush()

      expect(posts.length).toBe(1)
      expect(posts[0]!.filename).toBe('speech.webm')
      expect(posts[0]!.blob.size).toBeGreaterThan(0)
      expect(texts).toEqual(['hello from stt'])
    } finally {
      fake.restore()
    }
  })

  test('cancel → no POST', async () => {
    const fake = installFakeMediaRecorder()
    const posts: unknown[] = []
    const texts: string[] = []
    try {
      const session = createServerSttSession({
        onText: (t) => texts.push(t),
        ensureConfigured: async () => true,
        transcribe: async (blob, filename) => {
          posts.push({ blob, filename })
          return { text: 'should not appear' }
        },
      })
      session.start()
      await flush()
      session.cancel()
      await flush()
      await flush()
      expect(posts.length).toBe(0)
      expect(texts.length).toBe(0)
    } finally {
      fake.restore()
    }
  })

  test('rapid double-tap stop then start keeps first upload and starts second', async () => {
    const fake = installFakeMediaRecorder()
    const posts: string[] = []
    const texts: string[] = []
    let n = 0
    try {
      const session = createServerSttSession({
        onText: (t) => texts.push(t),
        ensureConfigured: async () => true,
        transcribe: async (blob) => {
          const id = `clip-${++n}-${blob.size}`
          posts.push(id)
          return { text: id }
        },
      })
      session.start()
      await flush()
      session.stop()
      // Immediate new Talk — must not discard the stop()'d upload (HB-1246-01).
      session.start()
      await flush()
      session.stop()
      await flush()
      await flush()

      expect(posts.length).toBe(2)
      expect(texts.length).toBe(2)
      expect(texts[0]).toBe(posts[0])
      expect(texts[1]).toBe(posts[1])
    } finally {
      fake.restore()
    }
  })

  test('prefix is prepended to transcript', async () => {
    const fake = installFakeMediaRecorder()
    const texts: string[] = []
    try {
      const session = createServerSttSession({
        onText: (t) => texts.push(t),
        getComposerPrefix: () => 'draft',
        ensureConfigured: async () => true,
        transcribe: async () => ({ text: 'world' }),
      })
      session.start()
      await flush()
      session.stop()
      await flush()
      await flush()
      expect(texts).toEqual(['draft world'])
    } finally {
      fake.restore()
    }
  })

  test('injected startCapture: stop delivers blob; cancel does not', async () => {
    let last: { onBlob: (b: Blob, m: string) => void; stop: () => void; cancel: () => void } | null =
      null
    const posts: number[] = []
    const session = createServerSttSession({
      onText: () => undefined,
      ensureConfigured: async () => true,
      transcribe: async (blob) => {
        posts.push(blob.size)
        return { text: 'x' }
      },
      startCapture: (o) => {
        const handle: SpeechHandle = {
          stop: () => o.onBlob(new Blob([new Uint8Array([1, 2])]), 'audio/webm'),
          cancel: () => undefined,
        }
        last = { onBlob: o.onBlob, stop: handle.stop, cancel: handle.cancel }
        return handle
      },
    })
    session.start()
    expect(last).toBeTruthy()
    session.stop()
    await flush()
    expect(posts).toEqual([2])

    posts.length = 0
    session.start()
    session.cancel()
    // Late blob after cancel must not POST.
    last!.onBlob(new Blob([new Uint8Array([3, 4, 5])]), 'audio/webm')
    await flush()
    expect(posts.length).toBe(0)
  })
})
