import type { MousseConnection } from '../connection/types'
import { ConnectionProvider, useAccount, type ConnectionProviderProps } from './hooks/connection'
import { AppearanceProvider } from './hooks/useAppearance'
import { useVisualViewport } from './hooks/useVisualViewport'
import { RouterProvider, useRouter, type Route } from './state/router'
import { SignInScreen } from './screens/SignInScreen'
import { HomeScreen } from './screens/HomeScreen'
import { NewThreadScreen } from './screens/NewThreadScreen'
import { SettingsScreen } from './screens/SettingsScreen'
import './theme/fonts.css'
import './theme/tokens.css'
import './theme/app.css'
import './theme/timeline.css'

function Screen() {
  const { route } = useRouter()
  switch (route.name) {
    case 'home': return <HomeScreen />
    case 'thread': return <HomeScreen selected={{ nodeId: route.nodeId, threadId: route.threadId }} />
    case 'new': return <NewThreadScreen key={`${route.nodeId ?? ''}:${route.projectId ?? ''}`} nodeId={route.nodeId} projectId={route.projectId} />
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
  /** Start somewhere other than the thread list (tests and screenshots). */
  initialRoutes?: Route[]
  /** Tests tune the waits of joining the computers on its own. */
  joinOptions?: ConnectionProviderProps['joinOptions']
}

export function App({ connection, initialRoutes, joinOptions }: AppProps) {
  return (
    <AppearanceProvider>
      <ConnectionProvider connection={connection} joinOptions={joinOptions}>
        <div className="m-app"><Gate initialRoutes={initialRoutes} /></div>
      </ConnectionProvider>
    </AppearanceProvider>
  )
}
