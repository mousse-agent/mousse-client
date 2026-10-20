import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { applyAppearance, loadAppearance, saveAppearance, type Appearance } from '../theme/appearance'

interface AppearanceContextValue {
  appearance: Appearance
  setAppearance(next: Partial<Appearance>): void
}

const AppearanceContext = createContext<AppearanceContextValue | null>(null)

export function AppearanceProvider({ children }: { children: ReactNode }) {
  const [appearance, setState] = useState<Appearance>(loadAppearance)

  useEffect(() => {
    applyAppearance(appearance)
    if (appearance.theme !== 'system') return
    const list = window.matchMedia?.('(prefers-color-scheme: light)')
    const onChange = () => applyAppearance(appearance)
    list?.addEventListener?.('change', onChange)
    return () => list?.removeEventListener?.('change', onChange)
  }, [appearance])

  const setAppearance = useCallback((next: Partial<Appearance>) => {
    setState((current) => {
      const merged = { ...current, ...next }
      saveAppearance(merged)
      return merged
    })
  }, [])

  return <AppearanceContext.Provider value={{ appearance, setAppearance }}>{children}</AppearanceContext.Provider>
}

export function useAppearance(): AppearanceContextValue {
  const value = useContext(AppearanceContext)
  if (!value) throw new Error('useAppearance must be used inside <AppearanceProvider>.')
  return value
}
