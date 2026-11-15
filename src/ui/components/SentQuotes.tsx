import { createContext, Fragment, useContext, type ReactNode } from 'react'
import { Reply } from './icons'
import '../theme/quotes.css'
import { quoteSource, splitSentMessage } from '../lib/composerQuotes'

/** Scrolls the conversation to an item a quote came from, loading older pages when needed. */
export const ShowQuotedContext = createContext<((sourceId: string) => void) | undefined>(undefined)

/**
 * A quote a sent message replied to (the desktop's SentQuotePill): the reply mark and the quoted words, cut to three
 * lines. When this phone knows the message it came from, tapping it goes there.
 */
export function SentQuotePill({ text }: { text: string }) {
  const show = useContext(ShowQuotedContext)
  const source = quoteSource(text)
  const content = (
    <>
      <Reply size={13} strokeWidth={2} className="m-sent-quote__mark" aria-hidden />
      <span className="m-sent-quote__text">{text}</span>
    </>
  )
  if (show && source) {
    return (
      <button type="button" className="m-sent-quote" aria-label={`Replying to: ${text}. Show the quoted message`} onClick={() => show(source)}>
        {content}
      </button>
    )
  }
  return (
    <span className="m-sent-quote" title={text}>
      <span className="m-sr-only">Replying to: </span>
      {content}
    </span>
  )
}

/**
 * A sent message's words with each quote it replied to drawn as a pill. The words themselves are what the agent got:
 * every quote in double quotes, in a paragraph of its own (`lib/composerQuotes.ts`).
 */
export function WithSentQuotes({ text, render }: { text: string; render(text: string): ReactNode }) {
  const segments = splitSentMessage(text)
  if (segments.length === 1 && segments[0]!.kind === 'text') return <>{render(text)}</>
  return (
    <>
      {segments.map((segment, index) => (
        <Fragment key={index}>{segment.kind === 'quote' ? <SentQuotePill text={segment.text} /> : render(segment.text)}</Fragment>
      ))}
    </>
  )
}
