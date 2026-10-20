import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { ArrowUp, Stop } from './icons'
import { useFinePointer } from '../hooks/useMediaQuery'

export interface ComposerProps {
  /** A turn is running: the action button stops it instead of sending. */
  active: boolean
  disabled?: boolean
  placeholder?: string
  onSend(text: string): Promise<boolean> | boolean
  onStop(): void
}

const MAX_HEIGHT = 168

/**
 * The desktop composer material (radius 16, raised surface, glint on focus).
 * On touch screens Return inserts a new line and the button sends; with a
 * hardware keyboard and fine pointer, Enter sends and Shift+Enter breaks.
 */
export function Composer({ active, disabled = false, placeholder = 'Message', onSend, onStop }: ComposerProps) {
  const [text, setText] = useState('')
  const field = useRef<HTMLTextAreaElement>(null)
  const finePointer = useFinePointer()

  useEffect(() => {
    const element = field.current
    if (!element) return
    element.style.height = 'auto'
    element.style.height = `${Math.min(element.scrollHeight, MAX_HEIGHT)}px`
  }, [text])

  const canSend = !disabled && !active && text.trim().length > 0

  async function submit(event?: FormEvent) {
    event?.preventDefault()
    if (active) { onStop(); return }
    if (!canSend) return
    const draft = text
    setText('')
    const sent = await onSend(draft)
    if (!sent) setText((current) => current || draft)
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && finePointer && !event.nativeEvent.isComposing) {
      event.preventDefault()
      void submit()
    }
  }

  return (
    <form className="m-composer" onSubmit={submit} data-active={active || undefined}>
      <textarea
        ref={field}
        className="m-composer__input"
        rows={1}
        value={text}
        placeholder={placeholder}
        aria-label="Message"
        enterKeyHint={finePointer ? 'send' : 'enter'}
        disabled={disabled}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className="m-composer__actions">
        {active ? (
          <button type="button" className="m-composer__action m-composer__action--stop" aria-label="Stop" onClick={onStop}>
            <Stop size={18} />
          </button>
        ) : (
          <button type="submit" className="m-composer__action" aria-label="Send" disabled={!canSend} data-ready={canSend || undefined}>
            <ArrowUp size={19} />
          </button>
        )}
      </div>
    </form>
  )
}
