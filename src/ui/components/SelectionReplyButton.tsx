import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Reply } from './icons'
import '../theme/quotes.css'
import { COMPOSER_QUOTE_EVENT, quoteTextOf, type ComposerQuoteDetail } from '../lib/composerQuotes'

/** Marks a conversation whose selected text can be replied to from its composer. */
export const QUOTE_SOURCE_ATTRIBUTE = 'data-quote-source'

export interface ReplySpot {
  left: number
  top: number
  text: string
  sourceId?: string
  target: HTMLTextAreaElement
}

export const BUTTON_WIDTH = 88
export const BUTTON_HEIGHT = 36
/** Below the selection, clear of Android's teardrop selection handles that hang under its ends. */
const HANDLE_CLEARANCE = 30
/** Above the selection, clear of Android's own selection menu, which floats over it. */
const MENU_CLEARANCE = 60
const EDGE = 8

function elementOf(node: Node): Element | null {
  return node instanceof Element ? node : node.parentElement
}

/** The shown composer nearest to `source`: the one of the same conversation. */
function composerFor(source: Element): HTMLTextAreaElement | null {
  for (let node: Element | null = source.parentElement; node; node = node.parentElement) {
    const found = [...node.querySelectorAll<HTMLTextAreaElement>('textarea.m-composer__input')].find((input) => !input.disabled && !input.closest('[inert]'))
    if (found) return found
  }
  return null
}

interface Box { top: number; bottom: number; left: number; right: number }

/**
 * Where the button goes for a selection whose lines are `rects`, inside `view` (the visible conversation, above the
 * composer and the keyboard): under the selection's end, past the handles; else over its start, past Android's menu;
 * else at the bottom of the view. Undefined when the selection is scrolled out of the view.
 */
export function placeReplyButton(rects: readonly Box[], view: Box, screenWidth: number): { left: number; top: number } | undefined {
  // A selection in a conversation that is not shown (a closed pane) has no size: nothing to offer.
  if (!rects.length || view.bottom - view.top <= 0) return undefined
  const first = rects[0]!
  const end = rects[rects.length - 1]!
  if (end.bottom < view.top || first.top > view.bottom) return undefined
  const left = Math.max(EDGE, Math.min(end.right - BUTTON_WIDTH / 2, screenWidth - BUTTON_WIDTH - EDGE))
  const below = end.bottom + HANDLE_CLEARANCE
  if (below + BUTTON_HEIGHT <= view.bottom - EDGE) return { left, top: below }
  const above = first.top - MENU_CLEARANCE - BUTTON_HEIGHT
  if (above >= view.top + EDGE) return { left, top: above }
  return { left, top: Math.max(view.top + EDGE, view.bottom - BUTTON_HEIGHT - EDGE) }
}

function readSpot(): ReplySpot | null {
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null
  const text = quoteTextOf(selection.toString())
  if (!text) return null
  const range = selection.getRangeAt(0)
  const source = elementOf(range.startContainer)?.closest(`[${QUOTE_SOURCE_ATTRIBUTE}]`)
  if (!source || source !== elementOf(range.endContainer)?.closest(`[${QUOTE_SOURCE_ATTRIBUTE}]`)) return null
  if (elementOf(range.commonAncestorContainer)?.closest('textarea, input, [contenteditable="true"]')) return null
  if (source.closest('[inert]')) return null
  const target = composerFor(source)
  if (!target) return null
  const sourceId = elementOf(range.startContainer)?.closest<HTMLElement>('[data-item-id], [data-message-id]')
  const id = sourceId?.dataset.itemId ?? sourceId?.dataset.messageId
  const rects = [...range.getClientRects()].filter((rect) => rect.height > 0)
  const box = source.getBoundingClientRect()
  // The keyboard covers the bottom of the layout viewport when it does not resize the page.
  const screen = window.visualViewport
  const view = {
    top: Math.max(box.top, screen ? screen.offsetTop : 0),
    bottom: Math.min(box.bottom, screen ? screen.offsetTop + screen.height : window.innerHeight),
    left: box.left,
    right: box.right
  }
  const place = placeReplyButton(rects, view, window.innerWidth)
  if (!place) return null
  return { ...place, text, ...(id && !id.startsWith('pending:') ? { sourceId: id } : {}), target }
}

/**
 * The Reply button beside text selected in a conversation (the desktop's SelectionReplyButton). A long press selects
 * words with Android's own handles and menu; this small button floats near the selection, follows it as the handles
 * move, and puts the words in that conversation's composer as a reply quote.
 */
export function SelectionReplyButton() {
  const [spot, setSpot] = useState<ReplySpot | null>(null)
  const dragging = useRef(false)

  useEffect(() => {
    let frame = 0
    const update = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => setSpot(dragging.current ? null : readSpot()))
    }
    // With a mouse the button waits until it lets go; a finger moves Android's handles, and the button follows them.
    const down = (event: PointerEvent) => {
      if (event.pointerType !== 'mouse') return
      if ((event.target as Element | null)?.closest?.('.m-selection-reply')) return
      dragging.current = true
      setSpot(null)
    }
    // Any tap may have moved the page (another screen, a pane closed): read the selection again.
    const up = () => {
      dragging.current = false
      update()
    }
    const screen = window.visualViewport
    document.addEventListener('selectionchange', update)
    document.addEventListener('pointerdown', down, true)
    document.addEventListener('pointerup', up, true)
    window.addEventListener('scroll', update, true)
    window.addEventListener('resize', update)
    window.addEventListener('popstate', update)
    screen?.addEventListener('resize', update)
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('selectionchange', update)
      document.removeEventListener('pointerdown', down, true)
      document.removeEventListener('pointerup', up, true)
      window.removeEventListener('scroll', update, true)
      window.removeEventListener('resize', update)
      window.removeEventListener('popstate', update)
      screen?.removeEventListener('resize', update)
    }
  }, [])

  if (!spot) return null
  const reply = () => {
    const detail: ComposerQuoteDetail = { target: spot.target, quote: { text: spot.text, ...(spot.sourceId ? { sourceId: spot.sourceId } : {}) } }
    window.dispatchEvent(new CustomEvent(COMPOSER_QUOTE_EVENT, { detail }))
    window.getSelection()?.removeAllRanges()
    setSpot(null)
  }
  return createPortal(
    <button
      type="button"
      className="m-selection-reply"
      style={{ left: spot.left, top: spot.top }}
      // Pressing it must not clear the selection it quotes.
      onPointerDown={(event) => event.preventDefault()}
      onMouseDown={(event) => event.preventDefault()}
      onClick={reply}
      aria-label="Reply to the selected text"
    >
      <Reply size={15} strokeWidth={2} aria-hidden />
      <span>Reply</span>
    </button>,
    document.body
  )
}
