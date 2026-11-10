// An image shown large over the whole screen, like the desktop's image-lightbox.tsx: tap anywhere,
// the close button, Back (Escape) closes it. Focus moves to Close and returns to the opener.
import { useEffect, useRef, useState, type ImgHTMLAttributes } from 'react'
import { createPortal } from 'react-dom'
import { X } from './icons'

export function ImageLightbox({ src, name, onClose }: { src: string; name: string; onClose: () => void }) {
  const close = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    close.current?.focus()
    return () => opener?.focus()
  }, [])
  // A portal keeps the overlay out of the paragraph or bubble that holds the image.
  return createPortal(
    <div className="m-tl-lightbox" role="dialog" aria-modal="true" aria-label={name} onClick={onClose}>
      <img src={src} alt={name} />
      <button ref={close} type="button" className="m-tl-lightbox__close" aria-label="Close image" onClick={onClose}>
        <X size={20} />
      </button>
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
