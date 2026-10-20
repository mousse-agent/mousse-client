import { useCallback, useSyncExternalStore } from 'react'

export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback((notify: () => void) => {
    const list = typeof window !== 'undefined' ? window.matchMedia?.(query) : undefined
    if (!list) return () => undefined
    list.addEventListener?.('change', notify)
    return () => list.removeEventListener?.('change', notify)
  }, [query])
  return useSyncExternalStore(subscribe, () => typeof window !== 'undefined' && window.matchMedia?.(query).matches === true, () => false)
}

export const useIsWide = () => useMediaQuery('(min-width: 768px)')
export const useReducedMotion = () => useMediaQuery('(prefers-reduced-motion: reduce)')
export const useFinePointer = () => useMediaQuery('(pointer: fine)')
