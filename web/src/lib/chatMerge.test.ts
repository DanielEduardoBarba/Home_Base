import { describe, expect, test } from 'bun:test'
import { mergeChatMessages, renderableImages } from './chatMerge'
import type { ChatMsg } from './chatTypes'

function user(partial: Partial<ChatMsg> & { id: string; text?: string }): ChatMsg {
  return {
    role: 'user',
    at: Date.now(),
    ...partial,
  }
}

describe('mergeChatMessages', () => {
  test('drops pending-* when server acks a new user message (image send)', () => {
    const pending = user({
      id: 'pending-123',
      text: 'look at this',
      images: [{ mimeType: 'image/png', data: 'AAA', name: 'shot.png' }],
    })
    const server = user({
      id: 'abc123',
      text: 'look at this',
      images: [{ mimeType: 'image/png', data: '', name: 'shot.png' }],
    })
    const merged = mergeChatMessages([pending], [server])
    expect(merged).toHaveLength(1)
    expect(merged[0]!.id).toBe('abc123')
    expect(merged[0]!.images?.[0]?.data).toBe('AAA')
  })

  test('does not keep two bubbles with the same text after ack', () => {
    const pending = user({
      id: 'pending-9',
      text: 'Please fix stuck plan mode',
      images: [{ mimeType: 'image/jpeg', data: 'bbb' }],
    })
    const prior = user({ id: 'old1', text: 'hi' })
    const serverOld = user({ id: 'old1', text: 'hi' })
    const serverNew = user({
      id: 'new1',
      text: 'Please fix stuck plan mode',
      images: [{ mimeType: 'image/jpeg', data: '' }],
    })
    const merged = mergeChatMessages([prior, pending], [serverOld, serverNew])
    const users = merged.filter((m) => m.role === 'user')
    expect(users).toHaveLength(2)
    expect(users.map((m) => m.id)).toEqual(['old1', 'new1'])
    expect(users[1]!.images?.[0]?.data).toBe('bbb')
  })

  test('keeps pending when server has not acked yet', () => {
    const pending = user({ id: 'pending-1', text: 'hello' })
    const assistant: ChatMsg = {
      id: 'a1',
      role: 'assistant',
      text: 'hi',
    }
    const merged = mergeChatMessages([pending], [assistant])
    expect(merged.map((m) => m.id)).toEqual(['pending-1', 'a1'])
  })

  test('renderableImages skips empty wire stubs', () => {
    expect(
      renderableImages([
        { mimeType: 'image/png', data: '' },
        { mimeType: 'image/png', data: 'xx' },
      ]),
    ).toHaveLength(1)
  })
})
