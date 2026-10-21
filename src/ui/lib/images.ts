import type { ImageAttachment } from '../../connection/types'

/** Image types the computer accepts. */
export const SENDABLE_IMAGE = /^image\/(png|jpeg|gif|webp|bmp)$/
/** Images per message, as on the desktop. */
export const MAX_IMAGES = 16
/** Longest side after downscaling a large photo. */
const MAX_SIDE = 2048
/** Base64 size above which a photo is re-encoded smaller (the computer takes up to 3 MiB). */
const REENCODE_ABOVE_CHARS = 1_500_000
const MAX_CHARS = 3 * 1024 * 1024

export interface PendingImage extends ImageAttachment {
  id: string
  /** `data:` URL for the thumbnail. */
  preview: string
}

function readDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('read failed'))
    reader.readAsDataURL(file)
  })
}

function split(dataUrl: string): { mimeType: string; data: string } {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl)
  if (!match) throw new Error('unreadable')
  return { mimeType: match[1], data: match[2] }
}

/** Draws the image smaller as JPEG; undefined when this platform cannot decode or draw it. */
async function reencode(dataUrl: string): Promise<string | undefined> {
  if (typeof document === 'undefined' || typeof Image === 'undefined') return undefined
  const image = new Image()
  const loaded = new Promise<boolean>((resolve) => {
    image.onload = () => resolve(true)
    image.onerror = () => resolve(false)
  })
  image.src = dataUrl
  if (!(await loaded) || !image.naturalWidth || !image.naturalHeight) return undefined
  const scale = Math.min(1, MAX_SIDE / Math.max(image.naturalWidth, image.naturalHeight))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale))
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale))
  const context = canvas.getContext?.('2d')
  if (!context) return undefined
  context.drawImage(image, 0, 0, canvas.width, canvas.height)
  for (const quality of [0.86, 0.72, 0.58]) {
    const out = canvas.toDataURL('image/jpeg', quality)
    if (out.startsWith('data:image/jpeg') && out.length - out.indexOf(',') - 1 <= MAX_CHARS) return out
  }
  return undefined
}

/**
 * Reads a picked or pasted image for sending. Large photos and types the computer does not take
 * (for example HEIC) are re-encoded as JPEG when the platform can draw them.
 */
export async function readImage(file: File): Promise<PendingImage> {
  const name = file.name || 'image'
  if (!file.type.startsWith('image/')) throw new Error(`${name} is not an image. Only images can be sent from the phone.`)
  let dataUrl = await readDataUrl(file)
  let parts = split(dataUrl)
  if (!SENDABLE_IMAGE.test(parts.mimeType) || parts.data.length > REENCODE_ABOVE_CHARS) {
    const smaller = await reencode(dataUrl)
    if (smaller) {
      dataUrl = smaller
      parts = split(dataUrl)
    }
  }
  if (!SENDABLE_IMAGE.test(parts.mimeType)) throw new Error(`${name} is in a format the computer cannot read.`)
  if (parts.data.length > MAX_CHARS) throw new Error(`${name} is too large to send.`)
  const renamed = parts.mimeType === 'image/jpeg' && !/\.jpe?g$/i.test(name) ? name.replace(/\.[^.]*$/, '') + '.jpg' : name
  return {
    id: `img-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    name: renamed,
    mimeType: parts.mimeType,
    data: parts.data,
    preview: dataUrl
  }
}
