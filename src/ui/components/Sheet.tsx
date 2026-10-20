import { useEffect, useId, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { X } from './icons'
import { IconButton } from './primitives'

export interface SheetProps {
  open: boolean
  title: string
  onClose(): void
  children: ReactNode
  /** Prevent closing by backdrop tap or Escape, e.g. while waiting on a computer. */
  dismissible?: boolean
}

/** Bottom sheet on phones, centred dialog on wide screens (see app.css). */
export function Sheet({ open, title, onClose, children, dismissible = true }: SheetProps) {
  const titleId = useId()
  const panel = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const previous = document.activeElement as HTMLElement | null
    panel.current?.focus()
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && dismissible) onClose() }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      previous?.focus?.()
    }
  }, [open, dismissible, onClose])

  if (!open) return null
  return createPortal(
    <div className="m-sheet" onClick={() => dismissible && onClose()}>
      <div
        ref={panel}
        className="m-sheet__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="m-sheet__grabber" aria-hidden="true" />
        <div className="m-sheet__header">
          <h2 id={titleId}>{title}</h2>
          {dismissible && <IconButton label="Close" onClick={onClose}><X /></IconButton>}
        </div>
        <div className="m-sheet__body">{children}</div>
      </div>
    </div>,
    document.body
  )
}
