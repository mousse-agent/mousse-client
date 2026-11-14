import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { Reply, X } from './icons'
import '../theme/quotes.css'
import { COMPOSER_QUOTE_EVENT, loadDraftQuotes, saveDraftQuotes, type ComposerQuote, type ComposerQuoteDetail } from '../lib/composerQuotes'

export interface ComposerQuotesState {
  quotes: ComposerQuote[]
  setQuotes(next: ComposerQuote[] | ((current: ComposerQuote[]) => ComposerQuote[])): void
}

/**
 * The reply quotes of one composer: kept with its draft, and fed by the Reply button beside text selected in the
 * same conversation (SelectionReplyButton), which names this composer's text box as its target.
 */
export function useComposerQuotes(field: RefObject<HTMLTextAreaElement>, draftKey?: string): ComposerQuotesState {
  const [held, setHeld] = useState(() => ({ key: draftKey, quotes: draftKey ? loadDraftQuotes(draftKey) : [] as ComposerQuote[] }))
  // Another draft (another thread in the same composer) brings its own quotes.
  const quotes = held.key === draftKey ? held.quotes : draftKey ? loadDraftQuotes(draftKey) : []
  const current = useRef(quotes)
  current.current = quotes
  const setQuotes = useCallback((next: ComposerQuote[] | ((current: ComposerQuote[]) => ComposerQuote[])) => {
    const value = typeof next === 'function' ? next(current.current) : next
    current.current = value
    setHeld({ key: draftKey, quotes: value })
    if (draftKey) saveDraftQuotes(draftKey, value)
  }, [draftKey])
  useEffect(() => {
    const onQuote = (event: Event) => {
      const detail = (event as CustomEvent<ComposerQuoteDetail>).detail
      if (!detail || detail.target !== field.current) return
      // The same words twice are one quote.
      setQuotes((list) => (list.some((quote) => quote.text === detail.quote.text) ? list : [...list, detail.quote]))
      field.current?.focus()
    }
    window.addEventListener(COMPOSER_QUOTE_EVENT, onQuote)
    return () => window.removeEventListener(COMPOSER_QUOTE_EVENT, onQuote)
  }, [field, setQuotes])
  return { quotes, setQuotes }
}

/** The quotes being replied to, above the text box: each with the reply mark, its words cut to a few lines, and Remove. */
export function ComposerQuoteStrip({ quotes, onRemove }: { quotes: readonly ComposerQuote[]; onRemove(index: number): void }) {
  if (!quotes.length) return null
  return (
    <ul className="m-composer__quotes" aria-label="Replying to">
      {quotes.map((quote, index) => (
        <li key={`${index}:${quote.text}`} className="m-composer-quote">
          <Reply size={14} strokeWidth={2} className="m-composer-quote__mark" aria-hidden />
          <span className="m-composer-quote__text">{quote.text}</span>
          <button
            type="button"
            className="m-composer-quote__remove"
            aria-label="Remove quote"
            // Removing keeps the keyboard up and the caret in the box.
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => onRemove(index)}
          >
            <X size={14} aria-hidden />
          </button>
        </li>
      ))}
    </ul>
  )
}
