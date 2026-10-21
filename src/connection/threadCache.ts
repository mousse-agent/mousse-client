// Last-known thread contents, so a thread opens at once and then follows the computer's stream
// from where the phone left off. Recent threads stay in memory; the rest live in the webview's
// IndexedDB, per account, computer and thread, bounded by count and size. Only state the signed
// records gave is saved: live reply text and pending questions never are.
import type { StreamHead } from '../net/session'
import type { SettledThreadState } from './threadProjection'

/** Bump when the saved shape changes: entries of another format are dropped, never read. */
export const THREAD_CACHE_FORMAT = 1
export const THREAD_CACHE_MAX_THREADS = 50
export const THREAD_CACHE_MAX_BYTES = 25 * 1024 * 1024
/** A thread larger than this stays in memory only. */
export const THREAD_CACHE_MAX_THREAD_BYTES = 8 * 1024 * 1024
export const THREAD_CACHE_MEMORY_THREADS = 16

/** One thread as the phone last saw it: the stream and position its state is current through. */
export interface CachedThread {
  stream: string
  head: StreamHead
  state: SettledThreadState
  /** When the phone saved it, ms. */
  savedAt: number
}

/** What the persistent store keeps about each entry, readable without loading the entry. */
export interface ThreadCacheRow {
  key: string
  format: number
  accountId: string
  nodeId: string
  threadId: string
  bytes: number
  usedAt: number
  savedAt: number
}

/** Where entries persist: IndexedDB in the app, memory in tests. Methods may throw; the cache absorbs it. */
export interface ThreadCacheBackend {
  rows(): Promise<ThreadCacheRow[]>
  get(key: string): Promise<string | undefined>
  put(row: ThreadCacheRow, data: string): Promise<void>
  touch(row: ThreadCacheRow): Promise<void>
  delete(keys: string[]): Promise<void>
}

/** One computer's threads for one account, as a session uses them. */
export interface ThreadCacheScope {
  /** The thread from memory, without waiting. */
  peek(threadId: string): CachedThread | undefined
  /** The thread from memory or from the phone's storage. */
  read(threadId: string): Promise<CachedThread | undefined>
  write(threadId: string, entry: CachedThread): void
  remove(threadId: string): void
}

export interface ThreadCacheOptions {
  maxThreads?: number
  maxBytes?: number
  maxThreadBytes?: number
  memoryThreads?: number
  now?: () => number
}

const keyOf = (accountId: string, nodeId: string, threadId: string) => JSON.stringify([accountId, nodeId, threadId])

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function isHead(value: unknown): value is StreamHead {
  return isObject(value) && Number.isSafeInteger(value.epoch) && Number.isSafeInteger(value.seq)
}

function parseEntry(text: string): CachedThread | undefined {
  try {
    const value: unknown = JSON.parse(text)
    if (!isObject(value) || value.format !== THREAD_CACHE_FORMAT) return undefined
    if (typeof value.stream !== 'string' || !value.stream || !isHead(value.head) || !isObject(value.state)) return undefined
    if (!Array.isArray(value.state.messages) || typeof value.savedAt !== 'number') return undefined
    return { stream: value.stream, head: { epoch: value.head.epoch, seq: value.head.seq }, state: value.state as unknown as SettledThreadState, savedAt: value.savedAt }
  } catch {
    return undefined
  }
}

export class ThreadCache {
  private readonly memory = new Map<string, CachedThread>()
  private index?: Promise<Map<string, ThreadCacheRow>>
  /** Persistent writes and deletions run one at a time, in order. */
  private queue: Promise<void> = Promise.resolve()
  /** Raised by every clear, so sessions opened before it can no longer write. */
  private readonly revisions = new Map<string, number>()
  private readonly maxThreads: number
  private readonly maxBytes: number
  private readonly maxThreadBytes: number
  private readonly memoryThreads: number
  private readonly now: () => number

  constructor(
    private readonly backend: ThreadCacheBackend | undefined,
    options: ThreadCacheOptions = {},
  ) {
    this.maxThreads = options.maxThreads ?? THREAD_CACHE_MAX_THREADS
    this.maxBytes = options.maxBytes ?? THREAD_CACHE_MAX_BYTES
    this.maxThreadBytes = options.maxThreadBytes ?? THREAD_CACHE_MAX_THREAD_BYTES
    this.memoryThreads = options.memoryThreads ?? THREAD_CACHE_MEMORY_THREADS
    this.now = options.now ?? Date.now
  }

  scope(accountId: string, nodeId: string): ThreadCacheScope {
    const revision = this.revision(accountId, nodeId)
    const current = () => this.revision(accountId, nodeId) === revision
    return {
      peek: (threadId) => (current() ? this.peek(keyOf(accountId, nodeId, threadId)) : undefined),
      read: async (threadId) => (current() ? this.read(keyOf(accountId, nodeId, threadId), current) : undefined),
      write: (threadId, entry) => {
        if (current()) this.write({ accountId, nodeId, threadId }, entry)
      },
      remove: (threadId) => {
        if (current()) this.remove([keyOf(accountId, nodeId, threadId)])
      },
    }
  }

  /** Forgets every thread of the account, in memory and on the phone. */
  clearAccount(accountId: string): Promise<void> {
    this.bump(accountId)
    return this.clear((row) => row.accountId === accountId, (key) => JSON.parse(key)[0] === accountId)
  }

  /** Forgets every thread of one computer for the account. */
  clearComputer(accountId: string, nodeId: string): Promise<void> {
    this.bump(`${accountId}\n${nodeId}`)
    return this.clear(
      (row) => row.accountId === accountId && row.nodeId === nodeId,
      (key) => {
        const [account, node] = JSON.parse(key) as string[]
        return account === accountId && node === nodeId
      },
    )
  }

  /** Resolves once queued persistent writes have finished; for tests and measurements. */
  settle(): Promise<void> {
    return this.queue
  }

  /** Persisted sizes, for tests and measurements. */
  async usage(): Promise<{ threads: number; bytes: number }> {
    const rows = [...(await this.rows()).values()]
    return { threads: rows.length, bytes: rows.reduce((sum, row) => sum + row.bytes, 0) }
  }

  private revision(accountId: string, nodeId: string): string {
    return `${this.revisions.get(accountId) ?? 0}:${this.revisions.get(`${accountId}\n${nodeId}`) ?? 0}`
  }

  private bump(key: string): void {
    this.revisions.set(key, (this.revisions.get(key) ?? 0) + 1)
  }

  private peek(key: string): CachedThread | undefined {
    const entry = this.memory.get(key)
    if (!entry) return undefined
    this.remember(key, entry)
    void this.touch(key)
    return entry
  }

  private async read(key: string, current: () => boolean): Promise<CachedThread | undefined> {
    const held = this.peek(key)
    if (held || !this.backend) return held
    try {
      const row = (await this.rows()).get(key)
      if (!row) return undefined
      const text = await this.backend.get(key)
      const entry = text === undefined ? undefined : parseEntry(text)
      if (!entry) {
        this.remove([key])
        return undefined
      }
      if (!current()) return undefined
      // A write that landed while reading is newer.
      const newer = this.memory.get(key)
      if (newer) return newer
      this.remember(key, entry)
      void this.touch(key)
      return entry
    } catch {
      return undefined
    }
  }

  private write(id: { accountId: string; nodeId: string; threadId: string }, entry: CachedThread): void {
    const key = keyOf(id.accountId, id.nodeId, id.threadId)
    this.remember(key, entry)
    if (!this.backend) return
    const backend = this.backend
    this.enqueue(async () => {
      // A later write of the same thread replaces this one before it reaches the disk.
      if (this.memory.get(key) !== entry && this.memory.has(key)) return
      const rows = await this.rows()
      const data = JSON.stringify({ format: THREAD_CACHE_FORMAT, stream: entry.stream, head: entry.head, savedAt: entry.savedAt, state: entry.state })
      if (data.length > this.maxThreadBytes) {
        if (rows.has(key)) {
          rows.delete(key)
          await backend.delete([key])
        }
        return
      }
      const row: ThreadCacheRow = { key, format: THREAD_CACHE_FORMAT, ...id, bytes: data.length, usedAt: this.now(), savedAt: entry.savedAt }
      rows.set(key, row)
      await backend.put(row, data)
      await this.evict(rows, key)
    })
  }

  private remove(keys: string[]): void {
    for (const key of keys) this.memory.delete(key)
    if (!this.backend) return
    const backend = this.backend
    this.enqueue(async () => {
      const rows = await this.rows()
      for (const key of keys) rows.delete(key)
      await backend.delete(keys)
    })
  }

  private clear(matchRow: (row: ThreadCacheRow) => boolean, matchKey: (key: string) => boolean): Promise<void> {
    for (const key of [...this.memory.keys()]) if (matchKey(key)) this.memory.delete(key)
    if (!this.backend) return Promise.resolve()
    const backend = this.backend
    return this.enqueue(async () => {
      const rows = await this.rows()
      const keys = [...rows.values()].filter(matchRow).map((row) => row.key)
      for (const key of keys) rows.delete(key)
      if (keys.length) await backend.delete(keys)
    })
  }

  /** Drops least recently used threads until the count and size fit; `keep` was just written. */
  private async evict(rows: Map<string, ThreadCacheRow>, keep: string): Promise<void> {
    const ordered = [...rows.values()].filter((row) => row.key !== keep).sort((a, b) => a.usedAt - b.usedAt)
    let bytes = [...rows.values()].reduce((sum, row) => sum + row.bytes, 0)
    const drop: string[] = []
    while (ordered.length && (rows.size - drop.length > this.maxThreads || bytes > this.maxBytes)) {
      const row = ordered.shift()!
      drop.push(row.key)
      bytes -= row.bytes
    }
    if (!drop.length) return
    for (const key of drop) {
      rows.delete(key)
      this.memory.delete(key)
    }
    await this.backend!.delete(drop)
  }

  private touch(key: string): Promise<void> {
    if (!this.backend) return Promise.resolve()
    const backend = this.backend
    return this.enqueue(async () => {
      const row = (await this.rows()).get(key)
      if (!row) return
      row.usedAt = this.now()
      await backend.touch(row)
    })
  }

  /** Keeps the entry in memory as the most recent, dropping the oldest beyond the limit. */
  private remember(key: string, entry: CachedThread): void {
    this.memory.delete(key)
    this.memory.set(key, entry)
    while (this.memory.size > this.memoryThreads) this.memory.delete(this.memory.keys().next().value!)
  }

  private rows(): Promise<Map<string, ThreadCacheRow>> {
    if (!this.index) {
      const backend = this.backend
      this.index = (async () => {
        const rows = new Map<string, ThreadCacheRow>()
        if (!backend) return rows
        try {
          const stale: string[] = []
          for (const row of await backend.rows()) {
            if (row.format === THREAD_CACHE_FORMAT && typeof row.key === 'string') rows.set(row.key, row)
            else if (typeof row.key === 'string') stale.push(row.key)
          }
          if (stale.length) await backend.delete(stale)
        } catch {
          // An unreadable store starts empty; writes try again.
        }
        return rows
      })()
    }
    return this.index
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.queue.then(task).catch(() => undefined)
    this.queue = run
    return run
  }
}

/** Entries kept in plain maps: for tests, and when IndexedDB is unavailable. */
export function memoryThreadCacheBackend(): ThreadCacheBackend & { data: Map<string, string>; index: Map<string, ThreadCacheRow> } {
  const data = new Map<string, string>()
  const index = new Map<string, ThreadCacheRow>()
  return {
    data,
    index,
    rows: async () => [...index.values()].map((row) => ({ ...row })),
    get: async (key) => data.get(key),
    put: async (row, text) => {
      index.set(row.key, { ...row })
      data.set(row.key, text)
    },
    touch: async (row) => {
      if (index.has(row.key)) index.set(row.key, { ...row })
    },
    delete: async (keys) => {
      for (const key of keys) {
        index.delete(key)
        data.delete(key)
      }
    },
  }
}

const DB_NAME = 'mousse-thread-cache'
/** Raising it drops every store on the next open. */
const DB_VERSION = 1
const ROWS = 'rows'
const DATA = 'data'

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed.'))
  })
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onabort = tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed.'))
  })
}

/** The webview's IndexedDB, or undefined when it has none. */
export function indexedDbThreadCacheBackend(factory: IDBFactory | undefined = safeIndexedDb()): ThreadCacheBackend | undefined {
  if (!factory) return undefined
  let opened: Promise<IDBDatabase> | undefined
  const db = () => {
    opened ??= new Promise<IDBDatabase>((resolve, reject) => {
      const req = factory.open(DB_NAME, DB_VERSION)
      req.onupgradeneeded = () => {
        const database = req.result
        for (const name of [...database.objectStoreNames]) database.deleteObjectStore(name)
        database.createObjectStore(ROWS, { keyPath: 'key' })
        database.createObjectStore(DATA)
      }
      req.onsuccess = () => {
        const database = req.result
        // Another tab opening a newer version closes this one; the next call opens again.
        database.onversionchange = () => {
          database.close()
          opened = undefined
        }
        resolve(database)
      }
      req.onerror = () => reject(req.error ?? new Error('IndexedDB is unavailable.'))
      req.onblocked = () => reject(new Error('IndexedDB is blocked.'))
    })
    opened.catch(() => {
      opened = undefined
    })
    return opened
  }
  return {
    async rows() {
      const tx = (await db()).transaction(ROWS, 'readonly')
      return (await request(tx.objectStore(ROWS).getAll())) as ThreadCacheRow[]
    },
    async get(key) {
      const tx = (await db()).transaction(DATA, 'readonly')
      const value: unknown = await request(tx.objectStore(DATA).get(key))
      return typeof value === 'string' ? value : undefined
    },
    async put(row, data) {
      const tx = (await db()).transaction([ROWS, DATA], 'readwrite')
      tx.objectStore(ROWS).put(row)
      tx.objectStore(DATA).put(data, row.key)
      await done(tx)
    },
    async touch(row) {
      const tx = (await db()).transaction(ROWS, 'readwrite')
      tx.objectStore(ROWS).put(row)
      await done(tx)
    },
    async delete(keys) {
      const tx = (await db()).transaction([ROWS, DATA], 'readwrite')
      for (const key of keys) {
        tx.objectStore(ROWS).delete(key)
        tx.objectStore(DATA).delete(key)
      }
      await done(tx)
    },
  }
}

function safeIndexedDb(): IDBFactory | undefined {
  try {
    return typeof indexedDB === 'undefined' ? undefined : indexedDB
  } catch {
    return undefined
  }
}
