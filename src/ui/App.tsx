import type { MousseConnection } from '../connection/types'
import { ConnectionProvider, useAccount } from './hooks/connection'
import { AppearanceProvider } from './hooks/useAppearance'
import { useVisualViewport } from './hooks/useVisualViewport'
import { RouterProvider, useRouter, type Route } from './state/router'
import { SignInScreen } from './screens/SignInScreen'
import { ComputersScreen } from './screens/ComputersScreen'
import { ComputerScreen } from './screens/ComputerScreen'
import { SettingsScreen } from './screens/SettingsScreen'
import './theme/fonts.css'
import './theme/tokens.css'
import './theme/app.css'
import './theme/timeline.css'

function Screen() {
  const { route } = useRouter()
  switch (route.name) {
    case 'computers': return <ComputersScreen />
    case 'computer': return <ComputerScreen key={route.nodeId} nodeId={route.nodeId} />
    case 'thread': return <ComputerScreen key={route.nodeId} nodeId={route.nodeId} threadId={route.threadId} />
    case 'settings': return <SettingsScreen />
  }
}

function Gate({ initialRoutes }: { initialRoutes?: Route[] }) {
  const account = useAccount()
  useVisualViewport()
  if (account.status !== 'signed-in') return <SignInScreen />
  return <RouterProvider initial={initialRoutes}><Screen /></RouterProvider>
}

export interface AppProps {
  connection: MousseConnection
  /** Start somewhere other than the computer list (tests and screenshots). */
  initialRoutes?: Route[]
}

export function App({ connection, initialRoutes }: AppProps) {
  return (
    <AppearanceProvider>
      <ConnectionProvider connection={connection}>
        <div className="m-app"><Gate initialRoutes={initialRoutes} /></div>
      </ConnectionProvider>
    </AppearanceProvider>
  )
}
