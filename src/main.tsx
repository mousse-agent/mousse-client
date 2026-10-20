// The one place the UI meets a connection. The UI only talks to the
// MousseConnection interface (src/connection/types.ts). Set
// VITE_FAKE_CONNECTION=1 to run against the demo data in src/ui/dev; the fake
// is also used until src/connection/index.ts exports createMousseConnection().
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import type { MousseConnection } from './connection/types'
import { App } from './ui/App'
import type { Route } from './ui/state/router'

type ConnectionModule = { createMousseConnection(): MousseConnection | Promise<MousseConnection> }
const realModules = import.meta.glob<ConnectionModule>('./connection/index.ts')

async function loadConnection(): Promise<{ connection: MousseConnection; routes?: Route[] }> {
  const loadReal = realModules['./connection/index.ts']
  if (import.meta.env.VITE_FAKE_CONNECTION !== '1' && loadReal) {
    const module = await loadReal()
    if (typeof module.createMousseConnection === 'function') return { connection: await module.createMousseConnection() }
  }
  const [{ createFakeConnection }, { demoRoutesFromQuery }] = await Promise.all([import('./ui/dev/fakeConnection'), import('./ui/dev/demoRoutes')])
  return {
    connection: createFakeConnection({ signedIn: new URLSearchParams(location.search).has('signedIn') }),
    routes: demoRoutesFromQuery(location.search)
  }
}

void loadConnection().then(({ connection, routes }) => {
  createRoot(document.getElementById('root')!).render(<StrictMode><App connection={connection} initialRoutes={routes} /></StrictMode>)
})
