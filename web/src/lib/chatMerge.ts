import type { ChatImage, ChatMsg } from './chatTypes'

function isHistoryStub(id: string): boolean {
  return id === 'hb-wire-trim' || id === 'hb-history-trim' || /-r\d+$/.test(id)
}

function imageHasData(img: ChatImage | undefined): boolean {
  return !!(img && String(img.data || '').trim())
}

/** Prefer local base64 when the wire slim emptied image data (>100KB). */
function restoreImageData(server: ChatMsg, local: ChatMsg | undefined): ChatMsg {
  if (server.role !== 'user' || !server.images?.length) return server
  if (!server.images.some((img) => !imageHasData(img))) return server
  const pool = local?.images?.filter(imageHasData) || []
  if (!pool.length) return server
  return {
    ...server,
    images: server.images.map((img, i) => {
      if (imageHasData(img)) return img
      const byIdx = pool[i]
      if (byIdx) return { ...img, data: byIdx.data }
      const byName =
        img.name && pool.find((p) => p.name && p.name === img.name)
      if (byName) return { ...img, data: byName.data }
      return pool[0] ? { ...img, data: pool[0]!.data } : img
    }),
  }
}

/**
 * Merge server tab messages with local optimistic bubbles.
 * - Drops pending-* user msgs once the server acks a new user message (fixes
 *   double bubbles when attaching images).
 * - Restores image bytes the wire slim stripped so thumbs don't break.
 */
export function mergeChatMessages(
  prev: ChatMsg[] | undefined,
  incoming: ChatMsg[],
): ChatMsg[] {
  const next = incoming.filter((m) => m.id !== 'hb-wire-trim')
  if (!prev?.length) return next
  const realPrev = prev.filter((m) => m.id && !isHistoryStub(m.id))
  if (!realPrev.length) return next

  const prevIds = new Set(realPrev.map((m) => m.id))
  const newServerUsers = next.filter(
    (m) => m.role === 'user' && !prevIds.has(m.id),
  )
  const dropPendings = newServerUsers.length > 0

  // Match pending locals to restore image data onto slimmed server copies.
  const pendingByText = new Map<string, ChatMsg>()
  for (const m of realPrev) {
    if (m.role !== 'user') continue
    if (!String(m.id || '').startsWith('pending-')) continue
    pendingByText.set(m.text || '', m)
  }

  const enriched = next.map((m) => {
    if (m.role !== 'user') return m
    const local =
      pendingByText.get(m.text || '') ||
      (String(m.id || '').startsWith('pending-')
        ? undefined
        : realPrev.find((p) => p.id === m.id))
    return restoreImageData(m, local)
  })

  const ids = new Set(enriched.map((m) => m.id))
  const serverUserTexts = new Set(
    enriched.filter((m) => m.role === 'user').map((m) => m.text || ''),
  )

  const older = realPrev.filter((m) => {
    if (ids.has(m.id)) return false
    if (m.role === 'user' && String(m.id || '').startsWith('pending-')) {
      if (dropPendings) return false
      if (serverUserTexts.has(m.text || '')) return false
      return true
    }
    return true
  })
  return [...older, ...enriched]
}

/** Images that can actually render (wire may strip base64). */
export function renderableImages(images: ChatImage[] | undefined): ChatImage[] {
  if (!images?.length) return []
  return images.filter(imageHasData)
}
