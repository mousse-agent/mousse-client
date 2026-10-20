import { useEffect } from 'react'

/**
 * Keeps the layout above the on-screen keyboard. The visual viewport shrinks
 * when the keyboard opens; we publish its height as --vv-height and the
 * covered part as --keyboard-inset, and flag html[data-keyboard='open'] so the
 * composer can drop its safe-area padding while the keyboard is up.
 */
export function useVisualViewport(): void {
  useEffect(() => {
    const viewport = window.visualViewport
    const root = document.documentElement
    if (!viewport) return
    let frame = 0
    const update = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const inset = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop)
        root.style.setProperty('--vv-height', `${Math.round(viewport.height)}px`)
        root.style.setProperty('--keyboard-inset', `${Math.round(inset)}px`)
        root.dataset.keyboard = inset > 80 ? 'open' : 'closed'
        // iOS scrolls the layout viewport when focusing an input; pin it back.
        if (viewport.offsetTop > 0 && inset > 80) window.scrollTo(0, 0)
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
