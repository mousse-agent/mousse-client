// The one place the UI meets a connection. The UI only talks to the MousseConnection interface
// (src/connection/types.ts). Builds use the real connection; set VITE_FAKE_CONNECTION=1 to run
// against the demo data in src/ui/dev instead. There is no silent fallback to the demo.
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createMousseConnection } from './connection'
import type { MousseConnection } from './connection/types'
import { App } from './ui/App'
import type { Route } from './ui/state/router'

async function loadConnection(): Promise<{ connection: MousseConnection; routes?: Route[] }> {
  if (import.meta.env.VITE_FAKE_CONNECTION === '1') {
    const [{ createFakeConnection }, { demoRoutesFromQuery }] = await Promise.all([import('./ui/dev/fakeConnection'), import('./ui/dev/demoRoutes')])
    return {
      connection: createFakeConnection({ signedIn: new URLSearchParams(location.search).has('signedIn') }),
      routes: demoRoutesFromQuery(location.search)
    }
  }
  return { connection: await createMousseConnection() }
}

function StartupError({ message }: { message: string }) {
  return (
    <main style={{ padding: '24px', fontFamily: 'system-ui, sans-serif' }}>
      <h1 style={{ fontSize: '20px' }}>Mousse could not start</h1>
      <p>{message}</p>
    </main>
  )
}

const root = createRoot(document.getElementById('root')!)
loadConnection().then(
  ({ connection, routes }) => root.render(<StrictMode><App connection={connection} initialRoutes={routes} /></StrictMode>),
  (error: unknown) => root.render(<StartupError message={error instanceof Error ? error.message : String(error)} />)
)
