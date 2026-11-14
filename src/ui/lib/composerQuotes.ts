/**
 * Reply pills, as the desktop's (`src/renderer/lib/composerQuotes.ts`): text selected in a conversation is replied
 * to with a quote in the composer. On send each quote becomes the quoted words in double quotes, alone in its
 * paragraph, so the agent (and the computer) gets plain message text, exactly as from the desktop. The sent bubble
 * shows those paragraphs as pills again, for quotes this phone replied with (`splitSentMessage`).
 *
 * The desktop puts its pills inline at the caret; the phone keeps them in a strip above the text box, in the order
 * they were added, and sends them before the typed words, which is what the desktop sends for pills added to an
 * empty composer.
 */

const STORAGE_KEY = 'mousse.composerQuotes'
const DRAFT_KEY = 'mousse.composer.quotes.'
const MAX_KEPT = 200

/** A quote in the composer: the quoted words and, when known, the timeline item or bot message they came from. */
export interface ComposerQuote {
  text: string
  sourceId?: string
}

/** Quoted words → the item they were quoted from ('' when unknown). Kept across restarts, as drafts are. */
type QuoteRegistry = Map<string, string>

let shared: QuoteRegistry | null = null

function registry(): QuoteRegistry {
  if (shared) return shared
  shared = new Map()
  try {
    const saved = JSON.parse(globalThis.localStorage?.getItem(STORAGE_KEY) ?? '[]') as unknown
    if (Array.isArray(saved)) {
      for (const entry of saved) if (Array.isArray(entry) && typeof entry[0] === 'string') shared.set(entry[0], typeof entry[1] === 'string' ? entry[1] : '')
    }
  } catch {
    // A broken saved list starts empty: quotes in old messages then read as their plain text.
  }
  return shared
}

function persist(): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify([...registry()]))
  } catch {
    // Storage full or unavailable: the quote still shows until the app closes.
  }
}

/** Remembers a quote sent from here, so its message shows it as a pill. The newest are kept; the oldest go past the limit. */
export function registerQuote(quote: ComposerQuote): void {
  const known = registry()
  const source = quote.sourceId || known.get(quote.text) || ''
  known.delete(quote.text)
  known.set(quote.text, source)
  while (known.size > MAX_KEPT) known.delete(known.keys().next().value as string)
  persist()
}

/** Where a quote sent from here came from, when known. */
export function quoteSource(text: string): string | undefined {
  return registry().get(text) || undefined
}

/** Forgets every remembered quote (tests). */
export function resetQuoteRegistry(): void {
  shared = null
}

/** Normalises selected words: trimmed, with no blank-line runs (a quote is one paragraph). */
export function quoteTextOf(selected: string): string {
  return selected.replace(/\r\n?/g, '\n').replace(/\n{2,}/g, '\n').trim()
}

/** The message text the agent gets: each quote in double quotes, alone in its paragraph, then the typed words. */
export function expandQuotes(quotes: readonly ComposerQuote[], typed: string): string {
  const parts = quotes.map((quote) => `"${quote.text}"`)
  const words = typed.trim()
  if (words) parts.push(words)
  return parts.join('\n\n')
}

export type SentSegment = { kind: 'text'; text: string } | { kind: 'quote'; text: string }

/**
 * A sent message's text in parts: each paragraph that is a known quote in double quotes (as `expandQuotes` wrote it)
 * is a quote part, so the bubble can show it as a pill; the blank lines around it go. Words that only look like a
 * quote, but were never replied to here, stay text. The desktop's `splitSentQuotes`.
 */
export function splitSentQuotes(text: string, quotes: Iterable<string>): SentSegment[] {
  const spans: Array<{ index: number; end: number; text: string }> = []
  for (const quote of new Set(quotes)) {
    if (!quote) continue
    const wrapped = `"${quote}"`
    for (let at = text.indexOf(wrapped); at >= 0; at = text.indexOf(wrapped, at + 1)) {
      const end = at + wrapped.length
      const startsParagraph = at === 0 || text.startsWith('\n\n', at - 2)
      const endsParagraph = end === text.length || text.startsWith('\n\n', end)
      if (startsParagraph && endsParagraph) spans.push({ index: at, end, text: quote })
    }
  }
  if (!spans.length) return [{ kind: 'text', text }]
  spans.sort((a, b) => a.index - b.index || b.end - a.end)
  const segments: SentSegment[] = []
  let from = 0
  for (const span of spans) {
    if (span.index < from) continue
    let before = text.slice(from, span.index).replace(/\n\n$/, '')
    if (from > 0) before = before.replace(/^\n\n/, '')
    if (before) segments.push({ kind: 'text', text: before })
    segments.push({ kind: 'quote', text: span.text })
    from = span.end
  }
  const rest = text.slice(from).replace(/^\n\n/, '')
  if (rest) segments.push({ kind: 'text', text: rest })
  return segments
}

/** `splitSentQuotes` with the quotes this phone has replied with. */
export function splitSentMessage(text: string): SentSegment[] {
  if (!text.includes('"')) return [{ kind: 'text', text }]
  return splitSentQuotes(text, registry().keys())
}

/**
 * A message moved back into the composer (a queued message to edit, a failed send): the known quotes it starts with
 * go back to the strip, the rest is the text. A message with a quote after its words stays plain text.
 */
export function quotesOfMessage(text: string): { quotes: ComposerQuote[]; text: string } {
  const segments = splitSentMessage(text)
  const quotes: ComposerQuote[] = []
  let index = 0
  for (; index < segments.length && segments[index]!.kind === 'quote'; index += 1) {
    const words = segments[index]!.text
    const sourceId = quoteSource(words)
    quotes.push({ text: words, ...(sourceId ? { sourceId } : {}) })
  }
  const rest = segments.slice(index)
  if (!quotes.length || rest.some((segment) => segment.kind === 'quote')) return { quotes: [], text }
  return { quotes, text: rest.map((segment) => segment.text).join('') }
}

/** The quotes of an unsent draft, kept per draft key beside its text. */
export function loadDraftQuotes(key: string): ComposerQuote[] {
  try {
    const saved = JSON.parse(globalThis.localStorage?.getItem(DRAFT_KEY + key) ?? '[]') as unknown
    if (!Array.isArray(saved)) return []
    return saved.flatMap((entry) => (entry && typeof entry === 'object' && typeof (entry as ComposerQuote).text === 'string'
      ? [{ text: (entry as ComposerQuote).text, ...(typeof (entry as ComposerQuote).sourceId === 'string' ? { sourceId: (entry as ComposerQuote).sourceId } : {}) }]
      : []))
  } catch {
    return []
  }
}

export function saveDraftQuotes(key: string, quotes: readonly ComposerQuote[]): void {
  try {
    if (quotes.length) globalThis.localStorage?.setItem(DRAFT_KEY + key, JSON.stringify(quotes))
    else globalThis.localStorage?.removeItem(DRAFT_KEY + key)
  } catch {
    // Storage unavailable: the quotes stay until the composer closes.
  }
}

/** Asks the composer of the conversation a selection is in to take a quote. */
export const COMPOSER_QUOTE_EVENT = 'mousse:composer-quote'

export interface ComposerQuoteDetail {
  target: HTMLTextAreaElement
  quote: ComposerQuote
}
