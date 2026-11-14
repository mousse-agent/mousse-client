import { useEffect } from 'react'

/** How much of the screen the keyboard covers, in CSS pixels; below this it is not a keyboard. */
const KEYBOARD_MIN = 80

/**
 * How far the keyboard pushes the page up. Two ways a keyboard shows up here:
 * - The page itself shrinks (Android: the app ends the WebView at the top of the keyboard, see
 *   MainActivity): innerHeight drops below the tallest height seen at this width.
 * - Only the visual viewport shrinks and the page keeps its height under the keyboard (iOS).
 */
function keyboardInset(view: { innerHeight: number; fullHeight: number; viewportHeight: number; viewportTop: number }): number {
  const shrunk = view.fullHeight - view.innerHeight
  const covered = view.innerHeight - view.viewportHeight - view.viewportTop
  return Math.max(0, shrunk, covered)
}

/**
 * Keeps the layout above the on-screen keyboard. We publish the visible height
 * as --vv-height and the keyboard's part as --keyboard-inset, and flag
 * html[data-keyboard='open'] so the composer can drop its safe-area padding
 * while the keyboard is up.
 */
export function useVisualViewport(): void {
  useEffect(() => {
    const viewport = window.visualViewport
    const root = document.documentElement
    if (!viewport) return
    let frame = 0
    // The tallest page seen at each width: rotating the phone changes it, the keyboard does not.
    const fullHeights = new Map<number, number>()
    const update = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const fullHeight = Math.max(fullHeights.get(window.innerWidth) ?? 0, window.innerHeight)
        fullHeights.set(window.innerWidth, fullHeight)
        const inset = keyboardInset({ innerHeight: window.innerHeight, fullHeight, viewportHeight: viewport.height, viewportTop: viewport.offsetTop })
        root.style.setProperty('--vv-height', `${Math.round(viewport.height)}px`)
        root.style.setProperty('--keyboard-inset', `${Math.round(inset)}px`)
        root.dataset.keyboard = inset > KEYBOARD_MIN ? 'open' : 'closed'
        // iOS scrolls the layout viewport when focusing an input; pin it back.
        if (viewport.offsetTop > 0 && inset > KEYBOARD_MIN) window.scrollTo(0, 0)
      })
    }
    update()
    viewport.addEventListener('resize', update)
    viewport.addEventListener('scroll', update)
    return () => {
      cancelAnimationFrame(frame)
      viewport.removeEventListener('resize', update)
      viewport.removeEventListener('scroll', update)
      root.style.removeProperty('--vv-height')
      root.style.removeProperty('--keyboard-inset')
      delete root.dataset.keyboard
    }
  }, [])
}
