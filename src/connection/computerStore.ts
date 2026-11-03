// One computer as the phone's screens see it: the shared session, its connection state, and the
// lists (projects, threads, chats, run status). Lists come from memory first, then from what the
// phone saved last time, and then live from the computer, so screens never wait to draw them.
import type { ComputerLists, ComputerSession, ListsState, SessionEndReason } from './types'
import { isUnreachable } from './types'
import type { NetworkSignals } from './networkSignals'

export type LinkState = 'idle' | 'connecting' | 'open' | 'closed' | 'removed' | 'error'

export interface ComputerView {
  nodeId: string
  link: LinkState
  /** Set while the link is open. */
  session?: ComputerSession
  /** Why the link failed or dropped, when known. */
  error?: string
  lists?: ComputerLists
  /** Where the shown lists come from: none yet, saved on this phone, or the computer. */
  listsState: ListsState | 'none' | 'saved'
}

/** Last-known lists, kept per account and computer between app starts. */
export interface ListsCache {
  read(accountId: string, nodeId: string): ComputerLists | undefined
  write(accountId: string, nodeId: string, lists: ComputerLists): void
  remove(accountId: string, nodeId: string): void
  clearAccount(accountId: string): void
}

const PREFIX = 'mousse.lists.v1'
const keyOf = (accountId: string, nodeId: string) => `${PREFIX}:${accountId}:${nodeId}`

function validLists(value: unknown): value is ComputerLists {
  if (typeof value !== 'object' || value === null) return false
  const lists = value as Record<string, unknown>
  return (
    Array.isArray(lists.projects) &&
    Array.isArray(lists.threads) &&
    Array.isArray(lists.chats) &&
    typeof lists.status === 'object' &&
    lists.status !== null &&
    typeof lists.receivedAt === 'number'
  )
}

/** A cache in the webview's localStorage, which Capacitor keeps across app starts. Never throws. */
export function storageListsCache(storage: Storage | undefined = safeLocalStorage()): ListsCache {
  return {
    read(accountId, nodeId) {
      try {
        const text = storage?.getItem(keyOf(accountId, nodeId))
        if (!text) return undefined
        const value: unknown = JSON.parse(text)
        return validLists(value) ? value : undefined
      } catch {
        return undefined
      }
    },
    write(accountId, nodeId, lists) {
      try {
        storage?.setItem(keyOf(accountId, nodeId), JSON.stringify(lists))
      } catch {
        // Full or unavailable storage only costs the next cold start its instant lists.
      }
    },
    remove(accountId, nodeId) {
      try {
        storage?.removeItem(keyOf(accountId, nodeId))
      } catch {
        // Nothing to clean up.
      }
    },
    clearAccount(accountId) {
      try {
        if (!storage) return
        const prefix = `${PREFIX}:${accountId}:`
        const keys: string[] = []
        for (let index = 0; index < storage.length; index++) {
          const key = storage.key(index)
          if (key?.startsWith(prefix)) keys.push(key)
        }
        for (const key of keys) storage.removeItem(key)
      } catch {
        // Nothing to clean up.
      }
    },
  }
}

function safeLocalStorage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage
  } catch {
    return undefined
  }
}

/** A cache that forgets on reload, for tests and for when storage is unavailable. */
export function memoryListsCache(): ListsCache {
  const entries = new Map<string, ComputerLists>()
  return {
    read: (accountId, nodeId) => entries.get(keyOf(accountId, nodeId)),
    write: (accountId, nodeId, lists) => void entries.set(keyOf(accountId, nodeId), lists),
    remove: (accountId, nodeId) => void entries.delete(keyOf(accountId, nodeId)),
    clearAccount: (accountId) => {
      for (const key of [...entries.keys()]) if (key.startsWith(`${PREFIX}:${accountId}:`)) entries.delete(key)
    },
  }
}

/**
 * Waits before each automatic reconnect. After the last one the phone keeps trying at the last wait
 * for as long as a screen shows the computer, and at once when the network changes or the app returns.
 */
export const RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000]
/** The shortest wait after Mousse ID refused a connection for the account's hourly budget. */
export const QUOTA_RETRY_MS = 60_000
/**
 * How long after an open link dropped the phone keeps reconnecting without saying so: a relay
 * restart (Mousse ID deploys restart it) or a network change heals within this time. A failure
 * that is not about reaching the computer, or one still there after this time, is shown.
 */
export const QUIET_RECONNECT_MS = 30_000
const SAVE_DELAY_MS = 500

export interface ComputerStoreOptions {
  nodeId: string
  accountId: string
  cache: ListsCache
  /** Opens or reuses the session to the computer. */
  open(): Promise<ComputerSession>
  /** Closes and forgets the shared session, so the next open starts a new one. */
  drop(): void
  reconnectDelaysMs?: number[]
  quietReconnectMs?: number
  /** Network changes and app resumes, which reconnect a dropped link at once. */
  network?: NetworkSignals
}

export class ComputerStore {
  private current: ComputerView
  private readonly listeners = new Set<() => void>()
  /** Listeners that follow the view without connecting, such as a list of computers that are offline. */
  private readonly watchers = new Set<() => void>()
  private attached?: { session: ComputerSession; stop: () => void }
  private retryTimer?: ReturnType<typeof setTimeout>
  private saveTimer?: ReturnType<typeof setTimeout>
  private attempts = 0
  private opening = 0
  /** An open started by `connect` has not settled yet. */
  private inFlight = false
  private disposed = false
  /** While set, an open link dropped and reconnect attempts that cannot reach the computer stay quiet until then. */
  private quietUntil?: number
  private readonly offNetwork?: () => void

  constructor(private readonly options: ComputerStoreOptions) {
    this.offNetwork = options.network?.onChange(() => this.resume())
    const saved = options.cache.read(options.accountId, options.nodeId)
    this.current = { nodeId: options.nodeId, link: 'idle', listsState: saved ? 'saved' : 'none', ...(saved ? { lists: saved } : {}) }
  }

  /** The same object until something changes, for useSyncExternalStore. */
  view(): ComputerView {
    return this.current
  }

  /** The first listener connects; the link and lists then stay up while the app runs. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    this.connect()
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Follows the view without connecting: the saved lists, and the live ones while something else keeps the link up. */
  watch(listener: () => void): () => void {
    this.watchers.add(listener)
    return () => {
      this.watchers.delete(listener)
    }
  }

  /** Connects unless connected, already opening, or removed from the computer. */
  connect(): void {
    if (this.disposed || this.inFlight || ['open', 'removed'].includes(this.current.link)) return
    clearTimeout(this.retryTimer)
    this.retryTimer = undefined
    const attempt = ++this.opening
    this.inFlight = true
    this.set({ link: 'connecting', error: undefined })
    this.options.open().then(
      (session) => {
        if (this.disposed || attempt !== this.opening) return
        this.inFlight = false
        this.attach(session)
      },
      (error: unknown) => {
        if (this.disposed || attempt !== this.opening) return
        this.inFlight = false
        if (isUnreachable(error) && this.quietRetry()) return
        this.quietUntil = undefined
        this.set({ link: 'error', error: error instanceof Error && error.message ? error.message : 'Could not connect.' })
        // Each attempt uses one of the account's relay connections for the hour: after a refusal
        // for that, quick retries would only keep the account over its budget.
        this.scheduleRetry((error as { code?: unknown } | null)?.code === 'quota_exceeded' ? QUOTA_RETRY_MS : 0)
      },
    )
  }

  /** Starts over now, with a new session. */
  retry(): void {
    if (this.disposed) return
    this.quietUntil = undefined
    this.inFlight = false
    this.detach()
    this.options.drop()
    this.attempts = 0
    this.set({ link: 'idle', session: undefined })
    this.connect()
  }

  /** Called when the app returns to the foreground or the network changes: reconnect at once if the link dropped. */
  resume(): void {
    const waiting = this.current.link === 'connecting' && !this.inFlight && this.retryTimer !== undefined
    if (this.current.link === 'closed' || this.current.link === 'error' || waiting) {
      this.attempts = 0
      this.connect()
    }
  }

  dispose(): void {
    this.disposed = true
    this.offNetwork?.()
    clearTimeout(this.retryTimer)
    this.flushSave()
    this.detach()
    this.listeners.clear()
    this.watchers.clear()
  }

  private attach(session: ComputerSession): void {
    this.detach()
    if (session.state() === 'closed') {
      this.closed(session.endReason() ?? 'ended', session.endMessage?.())
      return
    }
    const stopLists = session.watchLists({
      lists: (lists) => {
        if (this.attached?.session !== session) return
        this.set({ lists, listsState: this.current.listsState === 'polling' ? 'polling' : 'live' })
        this.save(lists)
      },
      state: (state, error) => {
        if (this.attached?.session !== session) return
        // Keep showing the lists already on screen while the computer is read again.
        if (state === 'loading') return
        this.set({ listsState: state === 'error' && this.current.lists ? this.current.listsState : state, error: state === 'error' ? error?.message : undefined })
      },
    })
    const stopState = session.onStateChange((state) => {
      if (state === 'closed' && this.attached?.session === session) this.closed(session.endReason() ?? 'ended', session.endMessage?.())
    })
    this.attached = { session, stop: () => { stopLists(); stopState() } }
    this.attempts = 0
    this.quietUntil = undefined
    this.set({ link: 'open', session, error: undefined })
  }

  private detach(): void {
    const attached = this.attached
    this.attached = undefined
    attached?.stop()
  }

  /** `message` says why the link dropped, when the session knows. */
  private closed(reason: SessionEndReason, message?: string): void {
    const wasOpen = this.current.link === 'open'
    this.detach()
    if (reason === 'removed') {
      clearTimeout(this.saveTimer)
      this.options.cache.remove(this.options.accountId, this.options.nodeId)
      this.set({ link: 'removed', session: undefined, lists: undefined, listsState: 'none' })
      return
    }
    const listsState = this.current.lists ? 'saved' : 'none'
    // A link that was up and only lost its path reconnects without a banner: the lists stay on
    // screen and the computer reads "Connecting…" until it is back.
    if (reason === 'lost' && wasOpen) {
      this.quietUntil = Date.now() + (this.options.quietReconnectMs ?? QUIET_RECONNECT_MS)
      if (this.quietRetry({ session: undefined, listsState })) return
    }
    this.quietUntil = undefined
    this.set({ link: 'closed', session: undefined, error: message, listsState })
    this.scheduleRetry()
  }

  /**
   * Schedules the next attempt and keeps the link "connecting" without an error, while the quiet
   * window lasts and that attempt starts inside it. Returns false when the failure must show.
   */
  private quietRetry(change: Partial<ComputerView> = {}): boolean {
    const delay = this.nextDelay()
    if (this.quietUntil === undefined || delay === undefined || Date.now() + delay > this.quietUntil) return false
    this.set({ ...change, link: 'connecting', error: undefined })
    this.scheduleRetry()
    return true
  }

  private nextDelay(): number | undefined {
    const delays = this.options.reconnectDelaysMs ?? RECONNECT_DELAYS_MS
    if (this.disposed || !this.listeners.size || !delays.length) return undefined
    return delays[Math.min(this.attempts, delays.length - 1)]
  }

  private scheduleRetry(atLeastMs = 0): void {
    const next = this.nextDelay()
    if (next === undefined) return
    const delay = Math.max(next, atLeastMs)
    this.attempts++
    clearTimeout(this.retryTimer)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined
      this.connect()
    }, delay)
  }

  private save(lists: ComputerLists): void {
    clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined
      this.options.cache.write(this.options.accountId, this.options.nodeId, lists)
    }, SAVE_DELAY_MS)
  }

  private flushSave(): void {
    if (this.saveTimer === undefined) return
    clearTimeout(this.saveTimer)
    this.saveTimer = undefined
    if (this.current.lists) this.options.cache.write(this.options.accountId, this.options.nodeId, this.current.lists)
  }

  private set(patch: Partial<ComputerView>): void {
    const next = { ...this.current, ...patch }
    for (const key of Object.keys(next) as Array<keyof ComputerView>) if (next[key] === undefined) delete next[key]
    const changed = (Object.keys({ ...this.current, ...next }) as Array<keyof ComputerView>).some((key) => this.current[key] !== next[key])
    if (!changed) return
    this.current = next
    for (const listener of [...this.listeners, ...this.watchers]) listener()
  }
}
