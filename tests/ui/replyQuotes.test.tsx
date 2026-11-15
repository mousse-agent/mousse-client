import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { installMatchMedia, renderApp } from './helpers'
import type { FakeMousseConnection } from '../../src/ui/dev/fakeConnection'
import { expandQuotes, quotesOfMessage, registerQuote, resetQuoteRegistry, splitSentQuotes } from '../../src/ui/lib/composerQuotes'
import { placeReplyButton } from '../../src/ui/components/SelectionReplyButton'

function memoryStorage(): Storage {
  const entries = new Map<string, string>()
  return {
    get length() { return entries.size },
    key: (index) => [...entries.keys()][index] ?? null,
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => void entries.set(key, String(value)),
    removeItem: (key) => void entries.delete(key),
    clear: () => entries.clear(),
  }
}

const rect = (top: number, left = 20, width = 200, height = 20) => ({ top, bottom: top + height, left, right: left + width, width, height, x: left, y: top, toJSON: () => ({}) })

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage())
  resetQuoteRegistry()
  installMatchMedia()
  // jsdom lays nothing out: a selection sits on one line near the top of a tall view.
  Range.prototype.getClientRects = function getClientRects() { return [rect(100)] as unknown as DOMRectList }
  Range.prototype.getBoundingClientRect = function getBoundingClientRect() { return rect(100) as DOMRect }
  Element.prototype.scrollIntoView = vi.fn()
  const box = Element.prototype.getBoundingClientRect
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    return this.hasAttribute('data-quote-source') ? rect(0, 0, 400, 800) as DOMRect : box.call(this)
  })
})
afterEach(() => {
  window.getSelection()?.removeAllRanges()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** Selects `words` inside the element whose text holds them, as a long press and the handles would. */
function select(container: HTMLElement, words: string) {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const at = node.textContent!.indexOf(words)
    if (at < 0) continue
    const range = document.createRange()
    range.setStart(node, at)
    range.setEnd(node, at + words.length)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    act(() => { document.dispatchEvent(new Event('selectionchange')) })
    return
  }
  throw new Error(`"${words}" is not on screen`)
}

async function replyToSelection() {
  fireEvent.click(await screen.findByRole('button', { name: 'Reply to the selected text' }))
}

describe('reply quotes in messages', () => {
  it('sends quotes as the desktop does: each in double quotes, alone in its paragraph, before the words', () => {
    expect(expandQuotes([{ text: 'first part' }, { text: 'second\npart' }], '  why?  ')).toBe('"first part"\n\n"second\npart"\n\nwhy?')
    expect(expandQuotes([{ text: 'only a quote' }], '')).toBe('"only a quote"')
  })

  it('shows only quotes replied with here as pills, and gives a moved-back message its quotes again', () => {
    const sent = '"first part"\n\nwhy?'
    expect(splitSentQuotes(sent, ['first part'])).toEqual([{ kind: 'quote', text: 'first part' }, { kind: 'text', text: 'why?' }])
    // Words in quotes that were never replied to stay text.
    expect(splitSentQuotes('"just quoting"\n\nok', [])).toEqual([{ kind: 'text', text: '"just quoting"\n\nok' }])
    registerQuote({ text: 'first part', sourceId: 'i3' })
    expect(quotesOfMessage(sent)).toEqual({ quotes: [{ text: 'first part', sourceId: 'i3' }], text: 'why?' })
    // A quote after the words can't sit in the strip above them: the message stays plain text.
    expect(quotesOfMessage('why?\n\n"first part"')).toEqual({ quotes: [], text: 'why?\n\n"first part"' })
  })
})

describe('the Reply button beside a selection', () => {
  const view = { top: 60, bottom: 700, left: 0, right: 400 }
  it('sits under the selection past the handles, else over it past the system menu, inside the screen', () => {
    expect(placeReplyButton([rect(100), rect(120, 20, 100)], view, 400)).toEqual({ left: 76, top: 170 })
    // Near the bottom of the view (the composer or the keyboard): above the selection's first line.
    expect(placeReplyButton([rect(640)], view, 400)).toEqual({ left: 176, top: 544 })
    // At the right edge it stays on screen.
    expect(placeReplyButton([rect(100, 300, 100)], view, 400)!.left).toBe(304)
    // A conversation that is not shown (a closed pane) offers nothing.
    expect(placeReplyButton([rect(100)], { top: 0, bottom: 0, left: 0, right: 0 }, 400)).toBeUndefined()
    // Scrolled out of the conversation: nothing.
    expect(placeReplyButton([rect(10, 20, 100, 20)], view, 400)).toBeUndefined()
  })
})

describe('replying to selected text in a thread', () => {
  async function open() {
    const { connection } = renderApp({ signedIn: true, routes: [{ name: 'home' }, { name: 'thread', nodeId: 'node-studio', threadId: 't-voices' }] })
    await screen.findByLabelText('Message')
    await screen.findByRole('button', { name: /^Model: / })
    return () => (connection as FakeMousseConnection).lastSession!
  }

  it('attaches the selection above the text box, sends it with the message, and shows it in the sent message', async () => {
    const session = await open()
    const reply = await screen.findByText(/The working tree is clean/)
    select(reply, 'this starts from main')
    await replyToSelection()

    const quotes = screen.getByRole('list', { name: 'Replying to' })
    expect(within(quotes).getByText('this starts from main')).toBeInTheDocument()
    expect(window.getSelection()!.isCollapsed).toBe(true)

    // A second passage joins the first; Remove takes one off.
    select(reply, 'The working tree is clean')
    await replyToSelection()
    expect(within(quotes).getAllByRole('listitem')).toHaveLength(2)
    fireEvent.click(within(quotes).getAllByRole('button', { name: 'Remove quote' })[1]!)
    expect(within(quotes).getAllByRole('listitem')).toHaveLength(1)

    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Which branch is that?' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(session().sent.at(-1)).toMatchObject({ kind: 'send', threadId: 't-voices', text: '"this starts from main"\n\nWhich branch is that?' }))
    expect(screen.queryByRole('list', { name: 'Replying to' })).not.toBeInTheDocument()

    // The sent message shows the quote as a pill, and tapping it goes back to the quoted reply.
    const pill = await screen.findByRole('button', { name: 'Replying to: this starts from main. Show the quoted message' })
    expect(pill.closest('[data-role="user"]')).toHaveTextContent('Which branch is that?')
    fireEvent.click(pill)
    const quoted = document.querySelector('[data-item-id="i3"]')!
    await waitFor(() => expect(quoted.classList.contains('is-shown')).toBe(true))
    expect(quoted.scrollIntoView).toHaveBeenCalled()
  })

  it('offers nothing for a selection in the composer or outside the conversation', async () => {
    await open()
    await screen.findByText(/The working tree is clean/)
    select(screen.getByRole('button', { name: /^Model: / }), 'Opus')
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(screen.queryByRole('button', { name: 'Reply to the selected text' })).not.toBeInTheDocument()
  })

  it('keeps the quote on a message queued while a reply runs', async () => {
    const session = await open()
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Start' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await screen.findByRole('button', { name: 'Stop' })
    select(await screen.findByText(/The working tree is clean/), 'working tree')
    await replyToSelection()
    // Backspace in an empty box takes the last quote off, as it does a pill on the desktop; the next reply brings it back.
    fireEvent.keyDown(screen.getByLabelText('Message'), { key: 'Backspace' })
    expect(screen.queryByRole('list', { name: 'Replying to' })).not.toBeInTheDocument()
    select(await screen.findByText(/The working tree is clean/), 'working tree')
    await replyToSelection()
    fireEvent.click(screen.getByRole('button', { name: 'Queue message' }))
    await waitFor(() => expect(session().sent.at(-1)).toMatchObject({ kind: 'queue', text: '"working tree"' }))
  })
})

describe('replying to selected text in a bot chat', () => {
  it('sends the quote in the message and shows it in the bubble', async () => {
    const { connection } = renderApp({ signedIn: true, routes: [{ name: 'home' }, { name: 'bot', nodeId: 'node-studio', botId: 'bot-inbox' }] })
    const log = await screen.findByRole('log', { name: /messages$/ })
    await waitFor(() => expect(log.querySelector('.bot-msg__text')).not.toBeNull())
    const texts = [...log.querySelectorAll('.bot-msg__text')].flatMap((element) => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
      const found: string[] = []
      for (let node = walker.nextNode(); node; node = walker.nextNode()) found.push(node.textContent ?? '')
      return found
    })
    const passage = texts.find((text) => text.trim().length > 12)!.trim().slice(0, 12).trim()
    select(log, passage)
    await replyToSelection()
    expect(within(screen.getByRole('list', { name: 'Replying to' })).getByText(passage)).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Tell me more' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    const bots = (connection as FakeMousseConnection).lastSession!.bots
    await waitFor(() => expect(bots.sent.at(-1)).toMatchObject({ botId: 'bot-inbox', text: `"${passage}"\n\nTell me more` }))
    expect(await within(log).findByRole('button', { name: `Replying to: ${passage}. Show the quoted message` })).toBeInTheDocument()
  })
})
