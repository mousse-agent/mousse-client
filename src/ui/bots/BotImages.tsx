// Pictures in a bot's chat on the phone, after the desktop's BotImages.tsx and imageSources.ts: a
// rounded thumbnail in a fixed box (so nothing moves when it loads), and a tap opens it large. An
// attached image (the computer marks it `image`) is read from the computer once, in parts
// (`bots.chat.attachment`); a computer without that method shows the file's name instead, and a file
// that can't be read shows its name in the box. A `data:` PNG, JPEG, GIF
// or WebP in a reply shows as it is. A web image is never loaded (it would tell its server who read
// the chat and when): it shows as a link that opens in the browser. SVG never shows.
import { useEffect, useState } from 'react'
import { isBotsUnsupported, type BotChatFile, type ComputerBots } from '../../connection/bots'
import { Image as ImageIcon, Paperclip } from '../components/icons'
import { openLink } from '../timeline/actions'
import { ImageLightbox } from '../timeline/ImageLightbox'

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp'])
const DATA_IMAGE = /^data:image\/(?:png|jpeg|jpg|gif|webp);base64,[a-z0-9+/=\s]+$/i

export type BotImageSource = { kind: 'data'; url: string } | { kind: 'link'; url: string } | { kind: 'blocked' }

/** True when a file name ends in a type the chat shows as a picture. */
export function isImageFile(name: string): boolean {
  const extension = /\.([a-z0-9]+)$/i.exec(name.trim())?.[1]?.toLowerCase()
  return extension !== undefined && IMAGE_EXTENSIONS.has(extension)
}

/** A message's file the phone can read as a picture: the computer marks it `image` (older ones send no type: never). */
export const isImageAttachment = (file: BotChatFile): boolean => file.image === true && isImageFile(file.name)

/** What an image's `src` in a bot chat may show as. A path on the computer can't be read from here. */
export function botImageSource(src: string | undefined | null): BotImageSource {
  const value = src?.trim() ?? ''
  if (/^data:/i.test(value)) return DATA_IMAGE.test(value) ? { kind: 'data', url: value } : { kind: 'blocked' }
  if (/^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value)
      return url.protocol === 'http:' || url.protocol === 'https:' ? { kind: 'link', url: url.toString() } : { kind: 'blocked' }
    } catch {
      return { kind: 'blocked' }
    }
  }
  return { kind: 'blocked' }
}

type FileImage = { url?: string; failed?: true }

/** Images read once per app run: a chat's copies never change. Kept small: a phone has little memory. */
const fileImages = new Map<string, FileImage>()
const loading = new Map<string, Promise<void>>()
const listeners = new Set<() => void>()
const MAX_KEPT = 60
/** Computers without `bots.chat.attachment`: their images show as name pills, without asking again. */
const noAttachments = new WeakSet<ComputerBots>()

function remember(key: string, image: FileImage): void {
  fileImages.set(key, image)
  while (fileImages.size > MAX_KEPT) {
    const [oldest, value] = fileImages.entries().next().value as [string, FileImage]
    if (value.url) URL.revokeObjectURL(value.url)
    fileImages.delete(oldest)
    loading.delete(oldest)
  }
  for (const listener of listeners) listener()
}

function loadFileImage(bots: ComputerBots, botId: string, messageId: string, index: number, key: string): Promise<void> {
  const known = loading.get(key)
  if (known) return known
  const read = (async () => {
    try {
      const image = await bots.attachment(botId, messageId, index)
      remember(key, { url: URL.createObjectURL(new Blob([image.bytes as BlobPart], { type: image.mimeType })) })
    } catch (error) {
      if (isBotsUnsupported(error)) noAttachments.add(bots)
      remember(key, { failed: true })
    }
  })()
  loading.set(key, read)
  return read
}

function useFileImage(bots: ComputerBots, botId: string, messageId: string, index: number): FileImage | undefined {
  const key = `${botId}\n${messageId}\n${index}`
  const [image, setImage] = useState(() => fileImages.get(key))
  useEffect(() => {
    const update = () => setImage(fileImages.get(key))
    listeners.add(update)
    update()
    void loadFileImage(bots, botId, messageId, index, key)
    return () => { listeners.delete(update) }
  }, [bots, botId, messageId, index, key])
  return image
}

/** Forgets the pictures read so far. Tests start clean. */
export function resetBotFileImages(): void {
  for (const image of fileImages.values()) if (image.url) URL.revokeObjectURL(image.url)
  fileImages.clear()
  loading.clear()
}

/** One thumbnail: the picture once there is one, an empty box while it loads, the name when it can't be shown. */
function Thumb({ url, name, failed, className }: { url?: string; name?: string; failed?: boolean; className?: string }) {
  const [open, setOpen] = useState(false)
  const [broken, setBroken] = useState(false)
  const label = name?.trim() || undefined
  const classes = `bot-image${className ? ` ${className}` : ''}`
  if (!url || broken) {
    const gone = failed || broken
    return (
      <span className={`${classes} is-empty${gone ? ' is-failed' : ''}`} role={gone ? 'img' : undefined} aria-label={gone ? `${label ?? 'Image'} (can't be shown)` : undefined}>
        {gone && <><ImageIcon size={16} aria-hidden /><span>{label ?? 'Image'}</span></>}
      </span>
    )
  }
  return (
    <>
      <button type="button" className={classes} aria-label={label ? `Open image: ${label}` : 'Open image'} onClick={() => setOpen(true)}>
        <img src={url} alt={label ?? ''} loading="lazy" decoding="async" draggable={false} onError={() => setBroken(true)} />
      </button>
      {open && <ImageLightbox src={url} name={label ?? 'Image'} onClose={() => setOpen(false)} />}
    </>
  )
}

function FileThumb({ bots, botId, messageId, index, name }: { bots: ComputerBots; botId: string; messageId: string; index: number; name: string }) {
  const image = useFileImage(bots, botId, messageId, index)
  if (noAttachments.has(bots)) return <span className="bot-file-pill"><Paperclip size={12} aria-hidden />{name}</span>
  return <Thumb url={image?.url} name={name} failed={image?.failed} />
}

/** A message's attached images: one large, several in a small grid. A computer that can't send them shows name pills. */
export function BotImageFiles({ files, indexedFiles, skipIndices, bots, botId, messageId }: {
  files?: BotChatFile[]
  indexedFiles?: ReadonlyArray<{ name: string; index: number }>
  skipIndices?: ReadonlySet<number>
  bots: ComputerBots
  botId: string
  messageId: string
}) {
  // The index is the file's place among all of the message's files, as the computer counts them.
  const images = indexedFiles
    ? indexedFiles.map((entry) => ({ file: { name: entry.name, image: true as const }, index: entry.index }))
    : (files ?? []).flatMap((file, index) => (isImageAttachment(file) && !skipIndices?.has(index) ? [{ file, index }] : []))
  if (!images.length) return null
  if (noAttachments.has(bots)) return <BotOtherFiles files={images.map((entry) => entry.file)} images={false} />
  return (
    <div className="bot-images" data-count={Math.min(images.length, 4)}>
      {images.map(({ file, index }) => <FileThumb key={`${index}:${file.name}`} bots={bots} botId={botId} messageId={messageId} index={index} name={file.name} />)}
    </div>
  )
}

/** A message's other files (and its images when they can't be shown), as name pills. */
export function BotOtherFiles({ files, images }: { files: BotChatFile[]; images: boolean }) {
  const others = images ? files.filter((file) => !isImageAttachment(file)) : files
  if (!others.length) return null
  return <div className="bot-you-files">{others.map((file, index) => <span key={`${index}:${file.name}`} className="bot-file-pill"><Paperclip size={12} aria-hidden />{file.name}</span>)}</div>
}

/** An image in a message's text: a `data:` picture as a thumbnail, a web image as a link to open in the browser, anything else its name. */
export function BotMarkdownImage({ src, alt }: { src: string; alt?: string }) {
  const source = botImageSource(src)
  if (source.kind === 'data') return <Thumb url={source.url} name={alt} className="is-inline" />
  if (source.kind === 'link') {
    const label = alt?.trim() || new URL(source.url).hostname
    return (
      <a className="bot-image-link" href={source.url} onClick={(event) => { event.preventDefault(); openLink(source.url) }}>
        <ImageIcon size={13} aria-hidden /><span>{label}</span>
      </a>
    )
  }
  return <span className="bot-image-link is-blocked" title="This image can't be shown here"><ImageIcon size={13} aria-hidden /><span>{alt?.trim() || 'Image'}</span></span>
}

/** The renderer to put in `MarkdownImageRenderer` for a bot chat. */
export const renderBotImage = (image: { src: string; alt?: string }) => <BotMarkdownImage src={image.src} alt={image.alt} />
