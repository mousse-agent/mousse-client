// A tiny stack router. Screens push and pop routes; the Android back button
// pops. No URL syncing: the app runs in a Capacitor webview.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { App as CapacitorApp } from '@capacitor/app'
import { Capacitor } from '@capacitor/core'

export type Route =
  | { name: 'home' }
  | { name: 'thread'; nodeId: string; threadId: string }
  /** A bot's chat on its computer. */
  | { name: 'bot'; nodeId: string; botId: string }
  /** A new thread; the computer and project start as given, or as last used. */
  | { name: 'new'; nodeId?: string; projectId?: string }
  | { name: 'settings' }

interface RouterValue {
  route: Route
  stack: Route[]
  push(route: Route): void
  pop(): void
  replace(route: Route): void
  reset(route?: Route): void
}

const RouterContext = createContext<RouterValue | null>(null)
const ROOT: Route = { name: 'home' }

export function RouterProvider({ children, initial = [ROOT] }: { children: ReactNode; initial?: Route[] }) {
  const [stack, setStack] = useState<Route[]>(initial.length ? initial : [ROOT])

  const push = useCallback((route: Route) => setStack((current) => [...current, route]), [])
  const pop = useCallback(() => setStack((current) => (current.length > 1 ? current.slice(0, -1) : current)), [])
  const replace = useCallback((route: Route) => setStack((current) => [...current.slice(0, -1), route]), [])
  const reset = useCallback((route: Route = ROOT) => setStack(route.name === 'home' ? [route] : [ROOT, route]), [])

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return
    const handle = CapacitorApp.addListener('backButton', () => {
      setStack((current) => {
        if (current.length > 1) return current.slice(0, -1)
        void CapacitorApp.exitApp()
        return current
      })
    })
    return () => { void handle.then((listener) => listener.remove()) }
  }, [])

  const value = useMemo<RouterValue>(() => ({ route: stack[stack.length - 1], stack, push, pop, replace, reset }), [stack, push, pop, replace, reset])
  return <RouterContext.Provider value={value}>{children}</RouterContext.Provider>
}

export function useRouter(): RouterValue {
  const value = useContext(RouterContext)
  if (!value) throw new Error('useRouter must be used inside <RouterProvider>.')
  return value
}
