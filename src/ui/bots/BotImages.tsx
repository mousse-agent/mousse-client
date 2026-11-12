// Pictures in a bot's chat on the phone, after the desktop's BotImages.tsx and imageSources.ts: a
// rounded thumbnail in a fixed box (so nothing moves when it loads), and a tap opens it large. An
// attached image file is read from the computer once (`bots.chat.attachment`); a computer without
// that method, or a file that can't be read, shows the file's name instead. A `data:` PNG, JPEG, GIF
// or WebP in a reply shows as it is. A web image is never loaded (it would tell its server who read
// the chat and when): it shows as a link that opens in the browser. SVG never shows.
import { useEffect, useState } from 'react'
import { isBotsUnsupported, type BotChatMessage, type ComputerBots } from '../../connection/bots'
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

function loadFileImage(bots: ComputerBots, botId: string, messageId: string, name: string, key: string): Promise<void> {
  const known = loading.get(key)
  if (known) return known
  const read = (async () => {
    try {
      const image = await bots.attachment(botId, messageId, name)
      const bytes = Uint8Array.from(atob(image.data), (char) => char.charCodeAt(0))
      remember(key, { url: URL.createObjectURL(new Blob([bytes], { type: image.mimeType })) })
    } catch (error) {
      if (isBotsUnsupported(error)) noAttachments.add(bots)
      remember(key, { failed: true })
    }
  })()
  loading.set(key, read)
  return read
}

function useFileImage(bots: ComputerBots, botId: string, messageId: string, name: string): FileImage | undefined {
  const key = `${botId}\n${messageId}\n${name}`
  const [image, setImage] = useState(() => fileImages.get(key))
  useEffect(() => {
    const update = () => setImage(fileImages.get(key))
    listeners.add(update)
    update()
    void loadFileImage(bots, botId, messageId, name, key)
    return () => { listeners.delete(update) }
  }, [bots, botId, messageId, name, key])
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

function FileThumb({ bots, botId, messageId, name }: { bots: ComputerBots; botId: string; messageId: string; name: string }) {
  const image = useFileImage(bots, botId, messageId, name)
  if (noAttachments.has(bots)) return <span className="bot-file-pill"><Paperclip size={12} aria-hidden />{name}</span>
  return <Thumb url={image?.url} name={name} failed={image?.failed} />
}

type BotFiles = NonNullable<BotChatMessage['attachments']>

/** A message's attached images: one large, several in a small grid. Without `bots` (a computer that can't send them) they are name pills. */
export function BotImageFiles({ files, bots, botId, messageId }: { files: BotFiles; bots?: ComputerBots; botId: string; messageId: string }) {
  const images = bots ? files.filter((file) => isImageFile(file.name)) : []
  if (!images.length || !bots) return null
  if (noAttachments.has(bots)) return <BotOtherFiles files={images} images={false} />
  return (
    <div className="bot-images" data-count={Math.min(images.length, 4)}>
      {images.map((file, index) => <FileThumb key={`${index}:${file.name}`} bots={bots} botId={botId} messageId={messageId} name={file.name} />)}
    </div>
  )
}

/** A message's other files (and its images when they can't be shown), as name pills. */
export function BotOtherFiles({ files, images }: { files: BotFiles; images: boolean }) {
  const others = images ? files.filter((file) => !isImageFile(file.name)) : files
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
