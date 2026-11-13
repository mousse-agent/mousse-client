import { useSyncExternalStore } from 'react'

// The phone's motion scale for the bot faces: 0 when the OS asks for reduced motion, else 1.
const QUERY = '(prefers-reduced-motion: reduce)'

function query(): MediaQueryList | undefined {
  return typeof globalThis.matchMedia === 'function' ? globalThis.matchMedia(QUERY) : undefined
}

function subscribe(listener: () => void): () => void {
  const list = query()
  list?.addEventListener?.('change', listener)
  return () => list?.removeEventListener?.('change', listener)
}

export function useMotionScale(): number {
  return useSyncExternalStore(subscribe, () => (query()?.matches ? 0 : 1), () => 1)
}
