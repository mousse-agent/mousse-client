import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useSyncExternalStore, type ReactNode } from 'react'
import type { AccountState, ComputerSession, MousseConnection } from '../../connection/types'

interface ConnectionContextValue {
  connection: MousseConnection
  /** One session per computer, opened lazily and shared between screens. */
  session(nodeId: string): Promise<ComputerSession>
  dropSession(nodeId: string): void
}

const ConnectionContext = createContext<ConnectionContextValue | null>(null)

export function ConnectionProvider({ connection, children }: { connection: MousseConnection; children: ReactNode }) {
  const sessions = useRef(new Map<string, Promise<ComputerSession>>())

  const closeAll = useCallback(() => {
    for (const pending of sessions.current.values()) void pending.then((session) => session.close(), () => undefined)
    sessions.current.clear()
  }, [])

  useEffect(() => connection.onAccountChange((state) => { if (state.status === 'signed-out') closeAll() }), [connection, closeAll])
  useEffect(() => closeAll, [closeAll])

  const value = useMemo<ConnectionContextValue>(() => ({
    connection,
    session(nodeId) {
      const cached = sessions.current.get(nodeId)
      if (cached) return cached
      const pending = connection.openComputer(nodeId)
      sessions.current.set(nodeId, pending)
      pending.then((session) => {
        session.onStateChange((state) => { if (state === 'closed' && sessions.current.get(nodeId) === pending) sessions.current.delete(nodeId) })
      }, () => { if (sessions.current.get(nodeId) === pending) sessions.current.delete(nodeId) })
      return pending
    },
    dropSession(nodeId) {
      const pending = sessions.current.get(nodeId)
      sessions.current.delete(nodeId)
      void pending?.then((session) => session.close(), () => undefined)
    }
  }), [connection])

  return <ConnectionContext.Provider value={value}>{children}</ConnectionContext.Provider>
}

export function useConnectionContext(): ConnectionContextValue {
  const value = useContext(ConnectionContext)
  if (!value) throw new Error('useConnection must be used inside <ConnectionProvider>.')
  return value
}

export function useConnection(): MousseConnection {
  return useConnectionContext().connection
}

export function useAccount(): AccountState {
  const connection = useConnection()
  return useSyncExternalStore(
    useCallback((notify) => connection.onAccountChange(() => notify()), [connection]),
    () => connection.account()
  )
}

/** Every Mousse ID can hold this many devices (computers and phones). There are no paid plans. */
export const MOUSSE_ID_DEVICE_LIMIT = 5

/** The account email, or null when the Mousse ID has none on file (the connection layer may report null). */
export function accountEmail(state: AccountState): string | null {
  if (state.status !== 'signed-in') return null
  const email: unknown = state.account.email
  return typeof email === 'string' && email.trim() ? email : null
}

/** Device usage for Settings. Uses an optional `devices` field when the connection provides one. */
export function deviceUsage(state: AccountState, listedDevices: number | undefined): { used: number; limit: number } | undefined {
  if (state.status !== 'signed-in') return undefined
  const provided = (state as AccountState & { devices?: { used?: unknown; limit?: unknown } }).devices
  if (typeof provided?.used === 'number' && typeof provided.limit === 'number') return { used: provided.used, limit: provided.limit }
  if (listedDevices === undefined) return undefined
  return { used: listedDevices, limit: MOUSSE_ID_DEVICE_LIMIT }
}
