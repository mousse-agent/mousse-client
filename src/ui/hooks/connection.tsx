import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useSyncExternalStore, type ReactNode } from 'react'
import { ComputerStore, storageListsCache, type ComputerView, type ListsCache } from '../../connection/computerStore'
import type { AccountState, Computer, ComputerSession, MousseConnection } from '../../connection/types'
import { errorMessage } from './useAsync'

export interface ComputersView {
  data?: Computer[]
  error?: string
  loading: boolean
}

/** The account's computers, kept between screens and read again in the background. */
class ComputersResource {
  private view: ComputersView = { loading: false }
  private readonly listeners = new Set<() => void>()
  private run = 0

  constructor(private readonly load: () => Promise<Computer[]>) {}

  get = (): ComputersView => this.view

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  reload = (): void => {
    const id = ++this.run
    this.set({ ...this.view, loading: true })
    this.load().then(
      (data) => { if (id === this.run) this.set({ data, loading: false }) },
      (cause) => { if (id === this.run) this.set({ ...this.view, error: errorMessage(cause), loading: false }) }
    )
  }

  reset(): void {
    this.run++
    this.set({ loading: false })
  }

  private set(view: ComputersView): void {
    this.view = view
    for (const listener of this.listeners) listener()
  }
}

interface ConnectionContextValue {
  connection: MousseConnection
  /** One session per computer, opened lazily and shared between screens. */
  session(nodeId: string): Promise<ComputerSession>
  dropSession(nodeId: string): void
  /** One store per computer for the signed-in account: link state, session and lists. */
  computer(nodeId: string): ComputerStore
  computers: ComputersResource
}

const ConnectionContext = createContext<ConnectionContextValue | null>(null)

export function ConnectionProvider({ connection, listsCache, children }: { connection: MousseConnection; listsCache?: ListsCache; children: ReactNode }) {
  const sessions = useRef(new Map<string, Promise<ComputerSession>>())
  const stores = useRef(new Map<string, ComputerStore>())
  const cache = useMemo(() => listsCache ?? storageListsCache(), [listsCache])
  const computers = useMemo(() => new ComputersResource(() => connection.listComputers()), [connection])

  const closeAll = useCallback(() => {
    for (const store of stores.current.values()) store.dispose()
    stores.current.clear()
    for (const pending of sessions.current.values()) void pending.then((session) => session.close(), () => undefined)
    sessions.current.clear()
  }, [])

  useEffect(() => {
    let accountId = connection.account().status === 'signed-in' ? (connection.account() as Extract<AccountState, { status: 'signed-in' }>).account.id : undefined
    return connection.onAccountChange((state) => {
      if (state.status === 'signed-out') {
        closeAll()
        computers.reset()
        // Lists belong to the account: a signed-out phone keeps none of them.
        if (accountId) cache.clearAccount(accountId)
        accountId = undefined
      } else accountId = state.account.id
    })
  }, [connection, closeAll, computers, cache])
  useEffect(() => closeAll, [closeAll])

  // Coming back to the app reconnects dropped computers at once instead of waiting for a retry.
  useEffect(() => {
    if (typeof document === 'undefined') return undefined
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return
      for (const store of stores.current.values()) store.resume()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [])

  const value = useMemo<ConnectionContextValue>(() => {
    const session = (nodeId: string): Promise<ComputerSession> => {
      const cached = sessions.current.get(nodeId)
      if (cached) return cached
      const pending = connection.openComputer(nodeId)
      sessions.current.set(nodeId, pending)
      pending.then((opened) => {
        opened.onStateChange((state) => { if (state === 'closed' && sessions.current.get(nodeId) === pending) sessions.current.delete(nodeId) })
      }, () => { if (sessions.current.get(nodeId) === pending) sessions.current.delete(nodeId) })
      return pending
    }
    const dropSession = (nodeId: string): void => {
      const pending = sessions.current.get(nodeId)
      sessions.current.delete(nodeId)
      void pending?.then((opened) => opened.close(), () => undefined)
    }
    return {
      connection,
      session,
      dropSession,
      computers,
      computer(nodeId) {
        const account = connection.account()
        const accountId = account.status === 'signed-in' ? account.account.id : ''
        const key = `${accountId}:${nodeId}`
        let store = stores.current.get(key)
        if (!store) {
          store = new ComputerStore({ nodeId, accountId, cache, open: () => session(nodeId), drop: () => dropSession(nodeId) })
          stores.current.set(key, store)
        }
        return store
      }
    }
  }, [connection, cache, computers])

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

/** One computer's link, session and lists; connects on first use and stays connected. */
export function useComputer(nodeId: string): ComputerView & { store: ComputerStore } {
  const { computer } = useConnectionContext()
  const store = computer(nodeId)
  const view = useSyncExternalStore(useCallback((notify) => store.subscribe(notify), [store]), () => store.view())
  return useMemo(() => ({ ...view, store }), [view, store])
}

/** The account's computers: the last known list right away, refreshed when a screen mounts. */
export function useComputers(): ComputersView & { reload(): void } {
  const { computers } = useConnectionContext()
  const view = useSyncExternalStore(computers.subscribe, computers.get)
  useEffect(() => { computers.reload() }, [computers])
  return useMemo(() => ({ ...view, loading: view.loading && !view.data, reload: computers.reload }), [view, computers])
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
