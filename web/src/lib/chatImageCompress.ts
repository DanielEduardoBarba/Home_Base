import type { ChatImage } from './chatTypes'

const MAX_BYTES = 4 * 1024 * 1024
/** Longest edge when we start shrinking oversized files. */
const START_MAX_EDGE = 2048
const MIN_EDGE = 640
const MIN_QUALITY = 0.55

export function formatMb(bytes: number): string {
  const mb = bytes / (1024 * 1024)
  if (mb < 0.1) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return mb >= 10 ? `${mb.toFixed(0)} MB` : `${mb.toFixed(1)} MB`
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const url = String(reader.result || '')
      const i = url.indexOf(',')
      resolve(i >= 0 ? url.slice(i + 1) : '')
    }
    reader.onerror = () => reject(reader.error || new Error('read failed'))
    reader.readAsDataURL(blob)
  })
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  mimeType: string,
  quality: number,
): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob((b) => resolve(b), mimeType, quality)
  })
}

async function drawScaled(
  source: ImageBitmap | HTMLImageElement,
  maxEdge: number,
): Promise<{ canvas: HTMLCanvasElement; width: number; height: number }> {
  const sw = 'naturalWidth' in source ? source.naturalWidth : source.width
  const sh = 'naturalHeight' in source ? source.naturalHeight : source.height
  const scale = Math.min(1, maxEdge / Math.max(sw, sh, 1))
  const width = Math.max(1, Math.round(sw * scale))
  const height = Math.max(1, Math.round(sh * scale))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('canvas unavailable')
  ctx.drawImage(source, 0, 0, width, height)
  return { canvas, width, height }
}

/**
 * Encode a chat image; if the file (or encode) exceeds maxBytes, downscale
 * resolution/quality until it fits. Returns the image plus optional shrink note.
 */
export async function fileToCompressedChatImage(
  file: File,
  maxBytes = MAX_BYTES,
): Promise<{ image: ChatImage; fromBytes: number; toBytes: number } | null> {
  const mime = (file.type || '').toLowerCase()
  if (!/^image\/(png|jpe?g|gif|webp)$/.test(mime)) return null

  const fromBytes = file.size
  const nameBase = (file.name || 'image').replace(/\.[^.]+$/, '').slice(0, 100)

  // Fast path: already under the limit — keep original bytes.
  if (fromBytes <= maxBytes) {
    const buf = await file.arrayBuffer()
    const bytes = new Uint8Array(buf)
    let binary = ''
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!)
    const data = btoa(binary)
    const image: ChatImage = {
      mimeType: mime === 'image/jpg' ? 'image/jpeg' : mime,
      data,
      name: file.name?.slice(0, 120) || undefined,
    }
    try {
      const bmp = await createImageBitmap(file)
      image.width = bmp.width
      image.height = bmp.height
      bmp.close()
    } catch {
      /* optional */
    }
    return { image, fromBytes, toBytes: fromBytes }
  }

  // Oversized → JPEG + downscale until under the cap.
  const encodeMime = 'image/jpeg'
  let bitmap: ImageBitmap | null = null
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    return null
  }

  try {
    let maxEdge = Math.min(START_MAX_EDGE, Math.max(bitmap.width, bitmap.height))
    const ratio = Math.sqrt(maxBytes / fromBytes)
    maxEdge = Math.max(MIN_EDGE, Math.floor(maxEdge * Math.min(1, ratio * 1.15)))

    let quality = 0.85
    let best: { blob: Blob; width: number; height: number } | null = null

    for (let attempt = 0; attempt < 10; attempt++) {
      const { canvas, width, height } = await drawScaled(bitmap, maxEdge)
      const blob = await canvasToBlob(canvas, encodeMime, quality)
      if (!blob) break
      if (blob.size <= maxBytes) {
        best = { blob, width, height }
        break
      }
      best = { blob, width, height }
      if (quality > MIN_QUALITY + 0.05) {
        quality = Math.max(MIN_QUALITY, quality - 0.1)
      } else if (maxEdge > MIN_EDGE) {
        maxEdge = Math.max(MIN_EDGE, Math.floor(maxEdge * 0.75))
        quality = 0.8
      } else {
        break
      }
    }

    if (!best || best.blob.size > maxBytes) {
      return null
    }

    const data = await blobToBase64(best.blob)
    if (!data) return null
    const image: ChatImage = {
      mimeType: encodeMime,
      data,
      name: `${nameBase}.jpg`.slice(0, 120),
      width: best.width,
      height: best.height,
    }
    return { image, fromBytes, toBytes: best.blob.size }
  } finally {
    bitmap.close()
  }
}
