// An image shown large over the whole screen, like the desktop's image-lightbox.tsx: tap anywhere, the close button or
// Back (Escape) closes it. Focus moves to Close and returns to the opener. Previous and Next step through
// every image the thread shows (image-gallery.tsx), with a swipe, the arrow keys and a "3 / 12" counter.
import { createContext, useContext, useEffect, useRef, useState, type ImgHTMLAttributes } from 'react'
import { createPortal } from 'react-dom'
import { ChevronLeft, ChevronRight, X } from './icons'

export interface GalleryImage {
  src: string
  name: string
}

/** Every image the thread shows, in order: prompt attachments and images in replies, folded work included. */
export const ImageGalleryContext = createContext<readonly GalleryImage[]>([])

/** How far (px) a sideways swipe goes before it steps to the next image. */
const SWIPE_PX = 50

export function ImageLightbox({ src, name, onClose }: { src: string; name: string; onClose: () => void }) {
  const close = useRef<HTMLButtonElement>(null)
  const gallery = useContext(ImageGalleryContext)
  const start = gallery.findIndex((image) => image.src === src)
  // An image that is not in the thread's set (or a set of one) shows alone, with no arrows or counter.
  const images = start === -1 ? [{ src, name }] : gallery
  const [index, setIndex] = useState(Math.max(0, start))
  const current = images[Math.min(index, images.length - 1)]
  const hasPrevious = index > 0
  const hasNext = index < images.length - 1
  const step = (by: number) => setIndex((value) => Math.min(Math.max(value + by, 0), images.length - 1))
  const swipe = useRef<number | undefined>(undefined)
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
      else if (event.key === 'ArrowLeft') step(-1)
      else if (event.key === 'ArrowRight') step(1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    close.current?.focus()
    return () => opener?.focus()
  }, [])
  // The images either side load in the background.
  useEffect(() => {
    for (const near of [images[index - 1], images[index + 1]]) if (near) new Image().src = near.src
  }, [images, index])
  // A portal keeps the overlay out of the paragraph or bubble that holds the image.
  return createPortal(
    <div
      className="m-tl-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={current.name}
      onClick={onClose}
      onTouchStart={(event) => {
        swipe.current = event.touches.length === 1 ? event.touches[0].clientX : undefined
      }}
      onTouchEnd={(event) => {
        const from = swipe.current
        swipe.current = undefined
        if (from === undefined) return
        const dx = event.changedTouches[0].clientX - from
        if (Math.abs(dx) >= SWIPE_PX) step(dx < 0 ? 1 : -1)
      }}
    >
      <img src={current.src} alt={current.name} />
      <button ref={close} type="button" className="m-tl-lightbox__close" aria-label="Close image" onClick={onClose}>
        <X size={20} />
      </button>
      {images.length > 1 && (
        <>
          {hasPrevious && (
            <button type="button" className="m-tl-lightbox__nav m-tl-lightbox__nav--prev" aria-label="Previous image" onClick={(event) => (event.stopPropagation(), step(-1))}>
              <ChevronLeft size={22} />
            </button>
          )}
          {hasNext && (
            <button type="button" className="m-tl-lightbox__nav m-tl-lightbox__nav--next" aria-label="Next image" onClick={(event) => (event.stopPropagation(), step(1))}>
              <ChevronRight size={22} />
            </button>
          )}
          <div className="m-tl-lightbox__count" aria-live="polite">
            {index + 1} / {images.length}
          </div>
        </>
      )}
    </div>,
    document.body,
  )
}

/** An image in a reply: a tap opens it large. */
export function MessageImage({ src, alt, ...props }: ImgHTMLAttributes<HTMLImageElement> & { src: string }) {
  const [open, setOpen] = useState(false)
  const label = alt?.trim() || undefined
  return (
    <>
      <button type="button" className="m-md-image" aria-label={label ? `Open image: ${label}` : 'Open image'} onClick={() => setOpen(true)}>
        <img {...props} className="m-md-img" src={src} alt={alt ?? ''} loading="lazy" decoding="async" />
      </button>
      {open && <ImageLightbox src={src} name={label ?? 'Image'} onClose={() => setOpen(false)} />}
    </>
  )
}
