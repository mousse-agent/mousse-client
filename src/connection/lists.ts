// A computer's sidebar lists (projects, threads with run status, agent chats), kept live from the
// desktop's signed lists stream. The desktop publishes the whole lists as a fresh snapshot
// (thread.snapshot.begin, chunk… and end records) shortly after anything in them changes.
// Desktops without that stream are polled through projects.list and threads.list instead.
import { equalBytes, fromB64url, fromUtf8 } from '../net/bytes'
import { sha256 } from '../net/crypto'
import { NetError } from '../net/errors'
import type { SessionLink, StreamHead, StreamRecord } from '../net/session'
import { parseBots } from './bots'
import type { ComputerLists, ListChat, ListProject, ListThread, ListsState, RunState, ThreadStatus } from './types'

/** The desktop's reserved id for the lists stream's snapshot records. */
export const LISTS_THREAD_ID = 'mousse:lists'
/** How often an older desktop without the lists stream is asked again. */
export const LISTS_POLL_MS = 10_000
const CHUNK_BYTES = 32 * 1024
const SNAPSHOT_MAX_BYTES = 32 * 1024 * 1024
const RUN_STATES = new Set<RunState>(['processing', 'awaiting_input', 'completed', 'failed'])

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const text = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined)
const time = (value: unknown): number | undefined => {
  const at = typeof value === 'string' ? Date.parse(value) : typeof value === 'number' ? value : NaN
  return Number.isFinite(at) ? at : undefined
}
const order = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

function project(value: unknown): ListProject | undefined {
  if (!isObject(value) || !text(value.id)) return undefined
  return {
    id: value.id as string,
    name: text(value.name) ?? (value.id as string),
    ...(text(value.path) ? { path: value.path as string } : {}),
    order: order(value.order),
    pinned: !!value.pinnedAt,
  }
}

/** One thread as the desktop's thread DTO describes it (lists stream, threads.list and threads.create). */
export function listThread(value: unknown): ListThread | undefined {
  if (!isObject(value) || !text(value.id)) return undefined
  const updatedAt = time(value.updatedAt) ?? 0
  const name = typeof value.name === 'string' ? value.name.trim() : ''
  return {
    id: value.id as string,
    title: name || 'New thread',
    ...(text(value.projectId) ? { projectId: value.projectId as string } : {}),
    createdAt: time(value.createdAt) ?? updatedAt,
    updatedAt,
    order: order(value.order),
    pinned: !!value.pinnedAt,
    settled: !!value.settledAt,
    // The desktop hides empty drafts: never sent to, still under their default name.
    started: !!value.startedAt || (!!name && !/^new (thread|chat)$/i.test(name)),
    ...(value.worktreeEnabled === true ? { worktree: true } : {}),
    ...expiryOf(value),
  }
}

/** When a thread deletes itself (`Thread.expiresAt`), from computers that list it; a time that is not one is ignored. */
function expiryOf(value: Record<string, unknown>): Pick<ListThread, 'expiresAt' | 'expiryStopsRun'> {
  const at = typeof value.expiresAt === 'string' && time(value.expiresAt) !== undefined ? value.expiresAt : undefined
  if (!at) return {}
  return { expiresAt: at, ...(value.expiryStopsRun === true ? { expiryStopsRun: true } : {}) }
}

function status(value: unknown): ThreadStatus | undefined {
  if (!isObject(value) || !RUN_STATES.has(value.state as RunState)) return undefined
  const since = time(value.since)
  return {
    state: value.state as RunState,
    ...(since !== undefined ? { since } : {}),
    ...(text(value.error) ? { error: value.error as string } : {}),
  }
}

function chat(value: unknown): ListChat | undefined {
  if (!isObject(value) || !text(value.id)) return undefined
  const run = isObject(value.run) && text(value.run.id) && text(value.run.state) ? value.run : undefined
  return {
    id: value.id as string,
    kind: value.kind === 'group' ? 'group' : 'direct',
    name: text(value.name) ?? 'Chat',
    ...(text(value.threadId) ? { threadId: value.threadId as string } : {}),
    ...(text(value.projectId) ? { projectId: value.projectId as string } : {}),
    network: value.network === true,
    agents: Array.isArray(value.agents) ? value.agents.filter((entry): entry is string => typeof entry === 'string') : [],
    updatedAt: time(value.updatedAt) ?? 0,
    ...(text(value.preview) ? { preview: value.preview as string } : {}),
    ...(run
      ? {
          run: {
            id: run.id as string,
            state: run.state as string,
            startedAt: time(run.startedAt) ?? 0,
            ...(text(run.error) ? { error: run.error as string } : {}),
          },
        }
      : {}),
  }
}

const listOf = <T>(value: unknown, parse: (entry: unknown) => T | undefined): T[] =>
  Array.isArray(value) ? value.map(parse).filter((entry): entry is T => !!entry) : []

/** Reads the desktop's lists snapshot; undefined when it is not one. */
export function parseLists(value: unknown, receivedAt = Date.now()): ComputerLists | undefined {
  if (!isObject(value) || value.kind !== 'mousse.lists' || value.version !== 1) return undefined
  const statuses: Record<string, ThreadStatus> = {}
  if (isObject(value.status))
    for (const [id, entry] of Object.entries(value.status)) {
      const parsed = status(entry)
      if (parsed) statuses[id] = parsed
    }
  return {
    projects: listOf(value.projects, project),
    threads: listOf(value.threads, listThread),
    chats: listOf(value.chats, chat),
    bots: parseBots(value.bots),
    status: statuses,
    receivedAt,
  }
}

interface Pending {
  id: string
  bytes: number
  chunks: number
  hash: Uint8Array
  parts: Uint8Array[]
  received: number
}

/** Puts a chunked JSON snapshot back together from verified stream records and checks its hash. */
export class SnapshotAssembler {
  private pending?: Pending

  constructor(private readonly threadId: string) {}

  /** Applies records in order; returns the last complete snapshot they finished, if any. */
  apply(records: StreamRecord[]): unknown {
    let done: unknown
    for (const record of records) {
      const { type, body } = record.envelope
      if (!isObject(body) || body.threadId !== this.threadId) continue
      if (type === 'thread.snapshot.begin') this.begin(body)
      else if (type === 'thread.snapshot.chunk') this.chunk(body)
      else if (type === 'thread.snapshot.end') {
        const value = this.end(body)
        if (value !== undefined) done = value
      }
    }
    return done
  }

  private begin(body: Record<string, unknown>): void {
    this.pending = undefined
    const { snapshot, totalBytes, chunks, sha256: hash } = body
    if (
      typeof snapshot !== 'string' ||
      !Number.isSafeInteger(totalBytes) ||
      (totalBytes as number) < 1 ||
      (totalBytes as number) > SNAPSHOT_MAX_BYTES ||
      chunks !== Math.ceil((totalBytes as number) / CHUNK_BYTES) ||
      typeof hash !== 'string'
    )
      return
    try {
      this.pending = { id: snapshot, bytes: totalBytes as number, chunks: chunks as number, hash: fromB64url(hash, 32), parts: [], received: 0 }
    } catch {
      this.pending = undefined
    }
  }

  private chunk(body: Record<string, unknown>): void {
    const held = this.pending
    if (!held) return
    try {
      if (body.snapshot !== held.id || body.index !== held.parts.length || typeof body.data !== 'string') throw new Error()
      const bytes = fromB64url(body.data)
      if (bytes.length !== Math.min(CHUNK_BYTES, held.bytes - held.received)) throw new Error()
      held.parts.push(bytes)
      held.received += bytes.length
    } catch {
      this.pending = undefined
    }
  }

  private end(body: Record<string, unknown>): unknown {
    const held = this.pending
    this.pending = undefined
    if (!held || body.snapshot !== held.id || held.received !== held.bytes || held.parts.length !== held.chunks) return undefined
    const bytes = new Uint8Array(held.bytes)
    let offset = 0
    for (const part of held.parts) {
      bytes.set(part, offset)
      offset += part.length
    }
    if (!equalBytes(sha256(bytes), held.hash)) return undefined
    try {
      return JSON.parse(fromUtf8(bytes))
    } catch {
      return undefined
    }
  }
}

const isHead = (value: unknown): value is StreamHead =>
  isObject(value) && Number.isSafeInteger(value.epoch) && Number.isSafeInteger(value.seq)

export interface ListsListener {
  lists(lists: ComputerLists): void
  state(state: ListsState, error?: Error): void
}

/**
 * Follows a computer's lists for as long as the session is open: the stream when the desktop has
 * one, otherwise a poll. After the stream asks for a snapshot, or ends while the session is still
 * open, the lists are read again in full.
 */
export class ListsWatch {
  private readonly listeners = new Set<ListsListener>()
  private assembler = new SnapshotAssembler(LISTS_THREAD_ID)
  private stream?: string
  private unsubscribe?: () => void
  private poll?: ReturnType<typeof setTimeout>
  private loading?: Promise<void>
  private closed = false
  private stateValue: ListsState = 'loading'
  current?: ComputerLists

  constructor(
    private readonly leaf: SessionLink,
    private readonly pollMs = LISTS_POLL_MS,
  ) {}

  get state(): ListsState {
    return this.stateValue
  }

  start(): void {
    this.reload()
  }

  add(listener: ListsListener): () => void {
    this.listeners.add(listener)
    if (this.current) listener.lists(this.current)
    listener.state(this.stateValue)
    return () => this.listeners.delete(listener)
  }

  get size(): number {
    return this.listeners.size
  }

  close(): void {
    this.closed = true
    this.unsubscribe?.()
    this.unsubscribe = undefined
    clearTimeout(this.poll)
    this.listeners.clear()
  }

  /** Reads everything again; a no-op while a read is already running. */
  reload(): void {
    if (this.closed || this.loading) return
    this.unsubscribe?.()
    this.unsubscribe = undefined
    clearTimeout(this.poll)
    const read = this.stateValue === 'polling' ? this.pollOnce() : this.stream === undefined ? this.open() : this.follow()
    this.loading = read
      .catch((error: unknown) => {
        if (this.closed || this.leaf.state !== 'open') return
        this.setState('error', error instanceof Error ? error : new Error('The lists could not be read.'))
        this.poll = setTimeout(() => this.reload(), this.pollMs)
      })
      .finally(() => {
        this.loading = undefined
      })
  }

  private async open(): Promise<void> {
    let opened: unknown
    try {
      opened = await this.leaf.rpc('bridge.lists.open', {})
    } catch (error) {
      // Desktops from before the lists stream refuse the method; read their lists the old way.
      if (error instanceof NetError && error.code === 'forbidden') return this.pollOnce()
      throw error
    }
    if (!isObject(opened) || !isObject(opened.descriptor) || !text(opened.descriptor.id))
      throw new NetError('bad_request', 'The computer sent an unexpected answer to bridge.lists.open.')
    this.stream = opened.descriptor.id as string
    await this.follow()
  }

  /** Reads the snapshot, then follows the stream from the snapshot's end. */
  private async follow(): Promise<void> {
    const stream = this.stream!
    const snapshot = await this.leaf.snapshot(stream)
    if (this.closed) return
    if (!isHead(snapshot.target)) throw new NetError('bad_request', 'The computer sent an unexpected lists snapshot.')
    this.assembler = new SnapshotAssembler(LISTS_THREAD_ID)
    this.accept(snapshot.records)
    if (!this.current) throw new NetError('bad_request', 'The computer sent no lists.')
    this.unsubscribe = this.leaf.subscribe(stream, snapshot.target, {
      records: (records) => this.accept(records),
      snapshotRequired: () => this.reload(),
      ended: () => {
        this.unsubscribe = undefined
        if (this.leaf.state === 'open') this.reload()
      },
    })
    this.setState('live')
  }

  private accept(records: StreamRecord[]): void {
    const value = this.assembler.apply(records)
    if (value === undefined) return
    const lists = parseLists(value)
    if (lists) this.publish(lists)
  }

  private async pollOnce(): Promise<void> {
    const [projects, threads] = await Promise.all([this.leaf.rpc('projects.list', {}), this.leaf.rpc('threads.list', {})])
    if (this.closed) return
    if (!isObject(projects) || !Array.isArray(projects.projects) || !isObject(threads) || !Array.isArray(threads.threads))
      throw new NetError('bad_request', 'The computer sent unexpected lists.')
    this.publish({
      projects: listOf(projects.projects, project),
      threads: listOf(threads.threads, listThread),
      chats: [],
      bots: [],
      status: {},
      receivedAt: Date.now(),
    })
    this.setState('polling')
    this.poll = setTimeout(() => this.reload(), this.pollMs)
  }

  private publish(lists: ComputerLists): void {
    this.current = lists
    for (const listener of this.listeners) listener.lists(lists)
  }

  private setState(state: ListsState, error?: Error): void {
    this.stateValue = state
    for (const listener of this.listeners) listener.state(state, error)
  }
}
