import { cleanup, render } from '@testing-library/react'
import { afterEach } from 'vitest'
import { App } from '../../src/ui/App'
import type { Route } from '../../src/ui/state/router'
import { createFakeConnection, type FakeConnectionOptions } from '../../src/ui/dev/fakeConnection'

// Vitest runs without globals, so Testing Library cannot register its own cleanup.
afterEach(() => cleanup())

/** jsdom has no matchMedia; the UI and the orb read it for motion and layout. Also resets saved appearance. */
export function installMatchMedia(matches: (query: string) => boolean = () => false): void {
  try { globalThis.localStorage?.clear?.() } catch { /* storage unavailable in this runtime */ }
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: matches(query),
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false
    })
  })
}

export function renderApp(options: FakeConnectionOptions & { routes?: Route[] } = {}) {
  const { routes, ...fake } = options
  const connection = createFakeConnection({ latencyMs: 0, stageDelayMs: 15, tickMs: 5, ...fake })
  const utils = render(<App connection={connection} initialRoutes={routes} />)
  return { connection, ...utils }
}
