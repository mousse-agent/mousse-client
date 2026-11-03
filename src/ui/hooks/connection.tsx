import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { AutoJoin, joinQueue, type AutoJoinView, type JoinQueue } from '../../connection/autoJoin'
import { ComputerStore, storageListsCache, type ComputerView, type ListsCache } from '../../connection/computerStore'
import { deviceNetworkSignals } from '../../connection/networkSignals'
import type { AccountState, Computer, ComputerSession, MousseConnection } from '../../connection/types'
import { defaultDeviceName } from '../lib/deviceName'
import { errorMessage } from './useAsync'

/** The account's computers as last read, kept between app starts so saved lists show before Mousse ID answers. */
export interface ComputersCache {
  read(accountId: string): Computer[] | undefined
  write(accountId: string, computers: Computer[]): void
  remove(accountId: string): void
}

const COMPUTERS_PREFIX = 'mousse.computers.v1'

function storageComputersCache(): ComputersCache {
  const storage = (): Storage | undefined => {
    try {
      return typeof localStorage === 'undefined' ? undefined : localStorage
    } catch {
      return undefined
    }
  }
  return {
    read(accountId) {
      try {
        const value: unknown = JSON.parse(storage()?.getItem(`${COMPUTERS_PREFIX}:${accountId}`) ?? 'null')
        return Array.isArray(value) ? value.filter((row): row is Computer => typeof row?.nodeId === 'string' && typeof row?.name === 'string') : undefined
      } catch {
        return undefined
      }
    },
    write(accountId, computers) {
      try {
        storage()?.setItem(`${COMPUTERS_PREFIX}:${accountId}`, JSON.stringify(computers))
      } catch {
        // The next cold start only waits for Mousse ID.
      }
    },
    remove(accountId) {
      try {
        storage()?.removeItem(`${COMPUTERS_PREFIX}:${accountId}`)
      } catch {
        // Nothing to clean up.
      }
    },
  }
}

/** One queue per connection: an AutoJoin replaced by a remount never asks at the same time as the new one. */
const joinQueues = new WeakMap<MousseConnection, JoinQueue>()

function queueFor(connection: MousseConnection): JoinQueue {
  let queue = joinQueues.get(connection)
  if (!queue) joinQueues.set(connection, (queue = joinQueue()))
  return queue
}

function signedInId(state: AccountState): string | undefined {
  return state.status === 'signed-in' ? state.account.id : undefined
}

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
  private shownFor?: string

  constructor(
    private readonly load: () => Promise<Computer[]>,
    private readonly accountId: () => string | undefined,
    private readonly cache?: ComputersCache,
  ) {}

  get = (): ComputersView => {
    // The last list this account saw, until Mousse ID answers.
    const account = this.accountId()
    if (!this.view.data && account && this.shownFor !== account) {
      this.shownFor = account
      const saved = this.cache?.read(account)
      if (saved) this.view = { ...this.view, data: saved }
    }
    return this.view
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  reload = (): void => {
    const id = ++this.run
    this.set({ ...this.view, loading: true })
    const account = this.accountId()
    this.load().then(
      (data) => {
        if (id !== this.run) return
        if (account) this.cache?.write(account, data)
        this.set({ data, loading: false })
      },
      (cause) => { if (id === this.run) this.set({ ...this.view, error: errorMessage(cause), loading: false }) }
    )
  }

  reset(): void {
    this.run++
    this.shownFor = undefined
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
  /** Adds this phone to the account's computers on its own; undefined while signed out. */
  join?: AutoJoin
}

const ConnectionContext = createContext<ConnectionContextValue | null>(null)

export interface ConnectionProviderProps {
  connection: MousseConnection
  listsCache?: ListsCache
  computersCache?: ComputersCache
  /** Tests tune the waits of joining the computers on its own. */
  joinOptions?: { retryMs?: number[]; slowMs?: number }
  children: ReactNode
}

export function ConnectionProvider({ connection, listsCache, computersCache, joinOptions, children }: ConnectionProviderProps) {
  const sessions = useRef(new Map<string, Promise<ComputerSession>>())
  const stores = useRef(new Map<string, ComputerStore>())
  const cache = useMemo(() => listsCache ?? storageListsCache(), [listsCache])
  const savedComputers = useMemo(() => computersCache ?? storageComputersCache(), [computersCache])
  const computers = useMemo(
    () => new ComputersResource(() => connection.listComputers(), () => signedInId(connection.account()), savedComputers),
    [connection, savedComputers],
  )
  const [join, setJoin] = useState<AutoJoin>()
  const joinRetryMs = joinOptions?.retryMs
  const joinSlowMs = joinOptions?.slowMs

  // One AutoJoin per signed-in account: it checks at once and then on its own schedule.
  useEffect(() => {
    let current: AutoJoin | undefined
    let accountId: string | undefined
    const follow = (state: AccountState) => {
      const next = signedInId(state)
      if (next === accountId && (current || !next)) return
      accountId = next
      current?.dispose()
      current = next
        ? new AutoJoin({
            plan: () => connection.joinPlan(),
            enroll: (nodeId, onProgress) => connection.enrollWithComputer(nodeId, defaultDeviceName(), onProgress),
            network: deviceNetworkSignals,
            onJoined: () => computers.reload(),
            queue: queueFor(connection),
            ...(joinRetryMs ? { retryMs: joinRetryMs } : {}),
            ...(joinSlowMs ? { slowMs: joinSlowMs } : {}),
          })
        : undefined
      current?.start()
      setJoin(current)
    }
    follow(connection.account())
    const off = connection.onAccountChange(follow)
    return () => {
      off()
      current?.dispose()
    }
  }, [connection, computers, joinRetryMs, joinSlowMs])

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
        if (accountId) {
          cache.clearAccount(accountId)
          savedComputers.remove(accountId)
        }
        accountId = undefined
      } else accountId = state.account.id
    })
  }, [connection, closeAll, computers, cache, savedComputers])
  useEffect(() => closeAll, [closeAll])

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
      join,
      computer(nodeId) {
        const account = connection.account()
        const accountId = account.status === 'signed-in' ? account.account.id : ''
        const key = `${accountId}:${nodeId}`
        let store = stores.current.get(key)
        if (!store) {
          // Coming back to the app or to a network reconnects a dropped computer at once instead of waiting for a retry.
          store = new ComputerStore({ nodeId, accountId, cache, network: deviceNetworkSignals, open: () => session(nodeId), drop: () => dropSession(nodeId) })
          stores.current.set(key, store)
        }
        return store
      }
    }
  }, [connection, cache, computers, join])

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

/**
 * Several computers at once, by node id. Computers marked `connect` connect and stay connected;
 * the others only show what their store has (the saved lists), so an offline computer is not
 * dialled again and again.
 */
export function useComputerViews(entries: ReadonlyArray<{ nodeId: string; connect: boolean }>): ReadonlyMap<string, ComputerView> {
  const { computer } = useConnectionContext()
  const key = entries.map((entry) => `${entry.nodeId}:${entry.connect ? 1 : 0}`).join(',')
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const watched = useMemo(() => entries.map((entry) => ({ ...entry, store: computer(entry.nodeId) })), [key, computer])
  const last = useRef<{ views: ComputerView[]; map: ReadonlyMap<string, ComputerView> }>()
  const subscribe = useCallback((notify: () => void) => {
    const stops = watched.map((entry) => (entry.connect ? entry.store.subscribe(notify) : entry.store.watch(notify)))
    return () => { for (const stop of stops) stop() }
  }, [watched])
  const snapshot = useCallback(() => {
    const views = watched.map((entry) => entry.store.view())
    const held = last.current
    if (held && held.views.length === views.length && held.views.every((view, index) => view === views[index])) return held.map
    const map = new Map(views.map((view) => [view.nodeId, view]))
    last.current = { views, map }
    return map
  }, [watched])
  return useSyncExternalStore(subscribe, snapshot)
}

/** What joining the account's computers on its own is doing, for the one quiet line on the home screen. */
export function useAutoJoin(): AutoJoinView & { check(): void; rejoin(): Promise<void> } {
  const { join, connection } = useConnectionContext()
  const subscribe = useCallback((notify: () => void) => join?.subscribe(notify) ?? (() => undefined), [join])
  const view = useSyncExternalStore(subscribe, () => join?.view() ?? IDLE)
  return useMemo(() => ({
    ...view,
    check: () => join?.check(),
    // After the user's computers removed this phone: join them again, on the user's word.
    rejoin: async () => {
      await connection.allowRejoin()
      join?.check()
    },
  }), [view, join, connection])
}

const IDLE: AutoJoinView = { state: 'idle' }

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
