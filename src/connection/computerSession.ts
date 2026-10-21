// A ComputerSession over a LeafSession: the phone's view of one computer, through the desktop's
// bridge RPCs (projects.list, threads.*, orchestrator.*, bridge.thread.open) and its signed thread
// display stream.
import { newId } from '../net/canonical'
import { NetError } from '../net/errors'
import type { LeafSession, StreamHead } from '../net/session'
import { ListsWatch } from './lists'
import { ThreadProjection } from './threadProjection'
import type { ChatItem, ComputerSession, ListChat, ListsHandlers, Project, SessionEndReason, SessionState, ThreadSummary } from './types'

/** How long a reply may run before the phone stops waiting for its result. */
export const SEND_DEADLINE_MS = 6 * 60 * 60 * 1000
/** Errors within this window after sending are thrown to the caller; later ones land in the chat. */
const SEND_EARLY_WINDOW_MS = 1_500
const SEARCH_LIMIT = 50

/** The longest close message shown to the user. */
const END_MESSAGE_MAX = 160

/** The close error's message as one short line of plain text. */
function shortMessage(error?: Error): string | undefined {
  const text = error?.message?.replace(/\s+/g, ' ').trim()
  if (!text) return undefined
  return text.length > END_MESSAGE_MAX ? `${text.slice(0, END_MESSAGE_MAX - 1)}…` : text
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function badAnswer(method: string): never {
  throw new NetError('bad_request', `The computer sent an unexpected answer to ${method}.`)
}

function project(value: unknown): Project | undefined {
  if (!isObject(value) || typeof value.id !== 'string' || !value.id) return undefined
  return {
    id: value.id,
    name: typeof value.name === 'string' && value.name ? value.name : value.id,
    ...(typeof value.path === 'string' && value.path ? { path: value.path } : {}),
  }
}

function threadSummary(value: unknown): ThreadSummary | undefined {
  if (!isObject(value) || typeof value.id !== 'string' || !value.id) return undefined
  const updatedAt = typeof value.updatedAt === 'string' ? Date.parse(value.updatedAt) : typeof value.updatedAt === 'number' ? value.updatedAt : NaN
  return {
    id: value.id,
    ...(typeof value.projectId === 'string' && value.projectId ? { projectId: value.projectId } : {}),
    title: typeof value.name === 'string' && value.name.trim() ? value.name : 'Untitled thread',
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0,
    pinned: !!value.pinnedAt,
    settled: !!value.settledAt,
  }
}

function threadsOf(value: unknown, method: string): ThreadSummary[] {
  if (!isObject(value) || !Array.isArray(value.threads)) return badAnswer(method)
  return value.threads.map(threadSummary).filter((thread): thread is ThreadSummary => !!thread)
}

function isHead(value: unknown): value is StreamHead {
  return isObject(value) && Number.isSafeInteger(value.epoch) && Number.isSafeInteger(value.seq)
}

/** One thread's display stream, shared by every open view of that thread. */
class ThreadWatch {
  readonly projection: ThreadProjection
  private readonly listeners = new Set<(items: ChatItem[]) => void>()
  private stream?: string
  private unsubscribe?: () => void
  private resyncing?: Promise<void>
  private closed = false

  constructor(
    private readonly leaf: LeafSession,
    readonly threadId: string,
  ) {
    this.projection = new ThreadProjection(threadId)
  }

  get size(): number {
    return this.listeners.size
  }

  async start(): Promise<void> {
    const opened = await this.leaf.rpc('bridge.thread.open', { threadId: this.threadId })
    if (!isObject(opened) || !isObject(opened.descriptor) || typeof opened.descriptor.id !== 'string' || !opened.descriptor.id)
      badAnswer('bridge.thread.open')
    this.stream = opened.descriptor.id as string
    await this.load()
  }

  add(listener: (items: ChatItem[]) => void): void {
    this.listeners.add(listener)
    listener(this.projection.items())
  }

  remove(listener: (items: ChatItem[]) => void): void {
    this.listeners.delete(listener)
  }

  emit(): void {
    const items = this.projection.items()
    for (const listener of this.listeners) listener(items)
  }

  close(): void {
    this.closed = true
    this.unsubscribe?.()
    this.unsubscribe = undefined
    this.listeners.clear()
  }

  /** Reads the snapshot, then follows the stream from the snapshot's end. */
  private async load(): Promise<void> {
    const stream = this.stream!
    const snapshot = await this.leaf.snapshot(stream)
    if (this.closed) return
    if (!isHead(snapshot.target)) badAnswer('snapshot.get')
    if (this.projection.apply(snapshot.records)) this.emit()
    this.unsubscribe = this.leaf.subscribe(stream, snapshot.target, {
      records: (records) => {
        if (this.projection.apply(records)) this.emit()
      },
      snapshotRequired: () => this.resync(),
      ended: () => {
        this.unsubscribe = undefined
        if (this.leaf.state === 'open') this.resync()
      },
    })
  }

  private resync(): void {
    if (this.closed || this.resyncing) return
    this.unsubscribe?.()
    this.unsubscribe = undefined
    this.resyncing = this.load()
      .catch((error: unknown) => {
        if (this.closed) return
        this.projection.addLocal({
          id: `local-${newId('rpc')}`,
          role: 'system',
          text: `This thread stopped updating: ${error instanceof Error ? error.message : 'unknown error'}. Open it again to reload.`,
          createdAt: Date.now(),
          status: 'error',
        })
        this.emit()
      })
      .finally(() => {
        this.resyncing = undefined
      })
  }
}

export interface RealSessionOptions {
  nodeId: string
  leaf: LeafSession
  /** Called once when the session closes, for example to stop registration renewal. */
  onClose?: () => void
  /** Why the session closed; asked once, before state listeners learn of the close. */
  endReason?: (error?: Error) => SessionEndReason
}

export class RealComputerSession implements ComputerSession {
  readonly nodeId: string
  private readonly leaf: LeafSession
  private readonly watches = new Map<string, Promise<ThreadWatch>>()
  /** Runs this phone started, by thread: the `orchestrator.send` RPC id that `orchestrator.abort` names. */
  private readonly runs = new Map<string, string>()
  private ended?: SessionEndReason
  private endedWith?: string
  private lists?: ListsWatch

  constructor(options: RealSessionOptions) {
    this.nodeId = options.nodeId
    this.leaf = options.leaf
    const decide = (error?: Error) => {
      this.ended ??= options.endReason?.(error) ?? 'ended'
      this.endedWith ??= shortMessage(error)
    }
    // State listeners run before close listeners, so the reason is set on the closing state change.
    this.leaf.onStateChange((state) => {
      if (state === 'closed') decide(this.leaf.closeReason)
    })
    this.leaf.onClose(() => {
      this.lists?.close()
      for (const watch of this.watches.values()) void watch.then((entry) => entry.close(), () => undefined)
      this.watches.clear()
      options.onClose?.()
    })
  }

  state(): SessionState {
    return this.leaf.state
  }

  onStateChange(listener: (state: SessionState) => void): () => void {
    return this.leaf.onStateChange(listener)
  }

  endReason(): SessionEndReason | undefined {
    return this.ended
  }

  endMessage(): string | undefined {
    return this.endedWith
  }

  async listProjects(): Promise<Project[]> {
    const value = await this.leaf.rpc('projects.list', {})
    if (!isObject(value) || !Array.isArray(value.projects)) return badAnswer('projects.list')
    return value.projects.map(project).filter((entry): entry is Project => !!entry)
  }

  async listThreads(filter: { projectId?: string; query?: string } = {}): Promise<ThreadSummary[]> {
    const listParams = filter.projectId ? { projectId: filter.projectId } : {}
    const query = filter.query?.trim()
    if (!query) {
      const threads = threadsOf(await this.leaf.rpc('threads.list', listParams), 'threads.list')
      return threads.sort((a, b) => b.updatedAt - a.updatedAt)
    }
    const [found, listed] = await Promise.all([
      this.leaf.rpc('threads.search', { query, limit: SEARCH_LIMIT }),
      this.leaf.rpc('threads.list', listParams),
    ])
    if (!isObject(found) || !Array.isArray(found.results)) return badAnswer('threads.search')
    const byId = new Map(threadsOf(listed, 'threads.list').map((thread) => [thread.id, thread]))
    const out: ThreadSummary[] = []
    const seen = new Set<string>()
    for (const result of found.results) {
      if (!isObject(result) || typeof result.threadId !== 'string' || seen.has(result.threadId)) continue
      const thread = byId.get(result.threadId)
      if (!thread) continue
      seen.add(thread.id)
      out.push(thread)
    }
    return out
  }

  async createThread(input: { projectId: string; title?: string }): Promise<ThreadSummary> {
    const name = input.title?.trim() || 'New thread'
    const value = await this.leaf.rpc(
      'threads.create',
      { name, ...(input.projectId ? { projectId: input.projectId } : {}) },
      { idem: crypto.randomUUID() },
    )
    const thread = isObject(value) ? threadSummary(value.thread) : undefined
    if (!thread) return badAnswer('threads.create')
    return thread
  }

  async openThread(threadId: string, onItems: (items: ChatItem[]) => void): Promise<() => void> {
    let pending = this.watches.get(threadId)
    if (!pending) {
      const watch = new ThreadWatch(this.leaf, threadId)
      pending = watch.start().then(() => watch)
      this.watches.set(threadId, pending)
      pending.catch(() => {
        if (this.watches.get(threadId) === pending) this.watches.delete(threadId)
        watch.close()
      })
    }
    const watch = await pending
    watch.add(onItems)
    let done = false
    return () => {
      if (done) return
      done = true
      watch.remove(onItems)
      if (watch.size === 0 && this.watches.get(threadId) === pending) {
        this.watches.delete(threadId)
        watch.close()
      }
    }
  }

  async send(threadId: string, text: string): Promise<void> {
    const content = text.trim()
    if (!content) throw new Error('Write a message first.')
    const chat = this.chatOf(threadId)
    if (chat) return this.sendChat(chat, content)
    if (this.runs.has(threadId)) throw new Error('A reply is already running in this thread.')
    const id = newId('rpc')
    this.runs.set(threadId, id)
    const call = this.leaf.rpc('orchestrator.send', { threadId, content }, { id, idem: crypto.randomUUID(), deadlineMs: SEND_DEADLINE_MS })
    let early = true
    const settled = call.then(
      () => undefined,
      (error: unknown) => {
        if (early) throw error
        this.reportLate(threadId, error)
      },
    )
    void settled
      .catch(() => undefined)
      .finally(() => {
        if (this.runs.get(threadId) === id) this.runs.delete(threadId)
      })
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([settled, new Promise<void>((resolve) => (timer = setTimeout(resolve, SEND_EARLY_WINDOW_MS)))])
    } finally {
      clearTimeout(timer)
      early = false
    }
  }

  async abort(threadId: string): Promise<void> {
    const chat = this.chatOf(threadId)
    if (chat) return this.stopChat(chat)
    const run = this.runs.get(threadId)
    if (!run) throw new Error('This reply was started on another device. Stop it there.')
    await this.leaf.rpc('orchestrator.abort', { threadId, run }, { idem: crypto.randomUUID() })
  }

  async isTurnActive(threadId: string): Promise<boolean> {
    const chat = this.chatOf(threadId)
    if (chat) return chat.run?.state === 'running'
    const value = await this.leaf.rpc('orchestrator.isTurnActive', { threadId })
    if (!isObject(value) || typeof value.active !== 'boolean') return badAnswer('orchestrator.isTurnActive')
    return value.active
  }

  watchLists(handlers: ListsHandlers): () => void {
    if (!this.lists) {
      this.lists = new ListsWatch(this.leaf)
      this.lists.start()
    }
    return this.lists.add({ lists: handlers.lists, state: (state, error) => handlers.state?.(state, error) })
  }

  close(): void {
    this.leaf.close()
  }

  /** The agent chat a thread belongs to: its messages are sent and stopped through the chat. */
  private chatOf(threadId: string): ListChat | undefined {
    return this.lists?.current?.chats.find((chat) => chat.threadId === threadId && !chat.network)
  }

  private async sendChat(chat: ListChat, text: string): Promise<void> {
    if (chat.run?.state === 'running') throw new Error('Wait for this reply, or stop it first.')
    await this.leaf.rpc('chats.send', { chatId: chat.id, text }, { idem: crypto.randomUUID() })
  }

  private async stopChat(chat: ListChat): Promise<void> {
    if (!chat.run || chat.run.state !== 'running') return
    await this.leaf.rpc('chats.cancel', { chatId: chat.id, runId: chat.run.id }, { idem: crypto.randomUUID() })
  }

  /** A send that failed after the phone stopped waiting: show it in the thread instead of dropping it. */
  private reportLate(threadId: string, error: unknown): void {
    if (error instanceof NetError && error.code === 'cancelled') return
    const message = error instanceof Error ? error.message : 'unknown error'
    void this.watches.get(threadId)?.then(
      (watch) => {
        watch.projection.addLocal({ id: `local-${newId('rpc')}`, role: 'system', text: `The reply failed: ${message}`, createdAt: Date.now(), status: 'error' })
        watch.emit()
      },
      () => undefined,
    )
  }
}
