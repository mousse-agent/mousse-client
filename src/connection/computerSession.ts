// A ComputerSession over a LeafSession: the phone's view of one computer, through the desktop's
// bridge RPCs (projects.list, threads.*, orchestrator.*, bridge.thread.open) and its signed thread
// display stream.
import { SessionBots, type ComputerBots } from './bots'
import { newId } from '../net/canonical'
import { equalBytes, fromB64url, fromUtf8 } from '../net/bytes'
import { sha256 } from '../net/crypto'
import { NetError } from '../net/errors'
import type { SessionLink, StreamHead, StreamRecord } from '../net/session'
import { ListsWatch } from './lists'
import { ThreadProjection } from './threadProjection'
import type { CachedThread, ThreadCacheScope } from './threadCache'
import { LeafComputerSpeech, type ComputerSpeech } from './speech'
import type {
  ChatItem,
  ChatMode,
  ComposerOptions,
  ComputerSession,
  ContextUsage,
  ImageAttachment,
  ComputerLists,
  ListChat,
  ListThread,
  ListsHandlers,
  LlmModelOption,
  LlmProviderOption,
  ModelSelection,
  PermissionMode,
  Project,
  QuestionAnswers,
  QueuedMessage,
  QueueEditResult,
  SendOptions,
  SessionEndReason,
  SessionState,
  ThreadDetails,
  ThreadDisplayState,
  ThreadSummary,
} from './types'
import { pendingQuestionsOf } from './timelineItems'

/** How long a reply may run before the phone stops waiting for its result. */
export const SEND_DEADLINE_MS = 6 * 60 * 60 * 1000
/** Errors within this window after sending are thrown to the caller; later ones land in the chat. */
const SEND_EARLY_WINDOW_MS = 1_500
const SEARCH_LIMIT = 50
/** Base64 characters per `attachments.stage` request; the computer accepts up to 48 KiB. */
export const IMAGE_CHUNK_CHARS = 48 * 1024
/** Largest image the computer accepts, in base64 characters. */
export const IMAGE_MAX_CHARS = 3 * 1024 * 1024

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

const PERMISSION_MODES: readonly PermissionMode[] = ['ask', 'accept_edits', 'auto', 'full']

function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === 'string' && (PERMISSION_MODES as readonly string[]).includes(value)
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

function selection(value: unknown): ModelSelection | undefined {
  if (!isObject(value) || typeof value.model !== 'string' || !value.model) return undefined
  const llmProvider = typeof value.llmProvider === 'string' ? value.llmProvider : ''
  const instanceId = typeof value.instanceId === 'string' && value.instanceId ? value.instanceId : undefined
  if (!llmProvider && !instanceId) return undefined
  return { ...(instanceId ? { instanceId } : {}), llmProvider, model: value.model }
}

function chatMode(value: unknown): ChatMode | undefined {
  if (typeof value === 'string' && value) return value
  if (isObject(value) && value.type === 'skill' && typeof value.skillId === 'string') return { type: 'skill', skillId: value.skillId }
  return undefined
}

function queued(value: unknown): QueuedMessage | undefined {
  if (!isObject(value) || typeof value.id !== 'string' || typeof value.content !== 'string') return undefined
  const mode = chatMode(value.mode)
  const at = typeof value.enqueuedAt === 'string' ? Date.parse(value.enqueuedAt) : NaN
  return {
    id: value.id,
    content: value.content,
    ...(mode ? { mode } : {}),
    imageCount: Array.isArray(value.images) ? value.images.length : 0,
    enqueuedAt: Number.isFinite(at) ? at : 0,
    intent: typeof value.intent === 'string' ? value.intent : 'normal',
    state: typeof value.state === 'string' ? value.state : 'pending',
  }
}

function queueOf(value: unknown, method: string): QueuedMessage[] {
  if (!isObject(value) || !Array.isArray(value.items)) return badAnswer(method)
  return value.items.map(queued).filter((item): item is QueuedMessage => !!item)
}

/** Composer writes answer `{ ok: false, error }` for expected refusals; turn them into errors. */
function refusal(value: unknown): void {
  if (isObject(value) && value.ok === false) throw new Error(typeof value.error === 'string' && value.error ? value.error : 'The computer refused the request.')
}

function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : undefined
}

function composerOptionsOf(value: unknown): ComposerOptions {
  if (!isObject(value) || !Array.isArray(value.providers)) return badAnswer('composer.options')
  const providers = value.providers.flatMap((provider): LlmProviderOption[] => {
    if (!isObject(provider) || typeof provider.id !== 'string' || !Array.isArray(provider.models)) return []
    const models = provider.models.flatMap((model): LlmModelOption[] => {
      if (!isObject(model) || typeof model.id !== 'string' || !model.id) return []
      const efforts = stringList(model.efforts)
      return [{
        id: model.id,
        label: typeof model.label === 'string' && model.label ? model.label : model.id,
        ...(efforts ? { efforts } : {}),
        ...(model.speed === 'fast' || model.speed === 'slow' ? { speed: model.speed } : {}),
      }]
    })
    return [{
      id: provider.id,
      ...(typeof provider.instanceId === 'string' && provider.instanceId ? { instanceId: provider.instanceId } : {}),
      label: typeof provider.label === 'string' && provider.label ? provider.label : provider.id,
      models,
    }]
  })
  const named = <T extends { name: string }>(rows: unknown, map: (row: Record<string, unknown>) => T | undefined): T[] =>
    Array.isArray(rows) ? rows.flatMap((row) => (isObject(row) && typeof row.name === 'string' ? [map(row)].filter((entry): entry is T => !!entry) : [])) : []
  const defaultModel = selection(value.defaultModel)
  const permission = isObject(value.permission) && isPermissionMode(value.permission.defaultMode)
    ? { defaultMode: value.permission.defaultMode, ...(isPermissionMode(value.permission.limit) ? { limit: value.permission.limit } : {}) }
    : undefined
  return {
    providers,
    ...(defaultModel ? { defaultModel } : {}),
    modes: stringList(value.modes) ?? ['plan', 'agent', 'build'],
    skills: named(value.skills, (row) =>
      typeof row.id === 'string' ? { id: row.id, name: row.name as string, description: typeof row.description === 'string' ? row.description : '' } : undefined),
    commands: named(value.commands, (row) => ({
      name: row.name as string,
      description: typeof row.description === 'string' ? row.description : '',
      ...(stringList(row.aliases) ? { aliases: stringList(row.aliases) } : {}),
      ...(typeof row.argsHint === 'string' ? { argsHint: row.argsHint } : {}),
    })),
    ...(permission ? { permission } : {}),
  }
}

/** An upload id: letters, digits, `_` and `-`, as the computer requires. */
const uploadId = (): string => newId('rpc')

function isHead(value: unknown): value is StreamHead {
  return isObject(value) && Number.isSafeInteger(value.epoch) && Number.isSafeInteger(value.seq)
}

type ItemsListener = (items: ChatItem[], state?: ThreadDisplayState) => void

/** Saved copies of this many recent threads are read into memory once the lists arrive. */
const WARM_THREADS = 8
/** On a direct path, this many recent threads are brought up to date in the background. */
export const PREFETCH_THREADS = 3
/** When to look for a direct path again, after the lists arrive over the relay. */
const PREFETCH_CHECKS_MS = [5_000, 15_000]
const PREFETCH_TIMEOUT_MS = 10_000

/** The longest an open waits for the phone's storage before asking the computer instead. */
const SAVED_READ_TIMEOUT_MS = 400
/** How long after the last change a followed thread is saved. */
export const THREAD_SAVE_DELAY_MS = 1_000
/** Codes that mean the thread is gone from the computer, so its saved copy is too. */
const GONE = new Set(['not_found', 'stream_unknown'])
/** The most a reply sent in parts (`reply.page`) may be: what the computer holds for one caller. */
const PAGED_REPLY_MAX_BYTES = 32 * 1024 * 1024

/** Standard base64, as `reply.page` sends it. */
function fromBase64(text: string): Uint8Array {
  return fromB64url(text.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''))
}

/**
 * A reply as the computer meant it. One too large for an RPC reply comes as `{ paged: { id, bytes, pages, sha256 } }`;
 * its parts are fetched with `reply.page` and checked against the length and the hash. A failure throws.
 */
export async function wholeReply(leaf: Pick<SessionLink, 'rpc'>, method: string, reply: unknown): Promise<unknown> {
  if (!isObject(reply) || !isObject(reply.paged)) return reply
  const { id, bytes, pages, sha256: hash } = reply.paged
  if (
    typeof id !== 'string' ||
    typeof hash !== 'string' ||
    !/^[0-9a-f]{64}$/.test(hash) ||
    !Number.isSafeInteger(bytes) ||
    (bytes as number) < 1 ||
    (bytes as number) > PAGED_REPLY_MAX_BYTES ||
    !Number.isSafeInteger(pages) ||
    (pages as number) < 1 ||
    (pages as number) > 4096
  )
    badAnswer(method)
  const whole = new Uint8Array(bytes as number)
  let received = 0
  for (let index = 0; index < (pages as number); index++) {
    const part = await leaf.rpc('reply.page', { id, index })
    if (!isObject(part) || part.index !== index || typeof part.data !== 'string') badAnswer(method)
    const data = fromBase64(part.data)
    if (received + data.length > whole.length) badAnswer(method)
    whole.set(data, received)
    received += data.length
  }
  const expected = new Uint8Array((hash.match(/../g) ?? []).map((pair) => parseInt(pair, 16)))
  if (received !== whole.length || !equalBytes(sha256(whole), expected)) badAnswer(method)
  try {
    return JSON.parse(fromUtf8(whole))
  } catch {
    return badAnswer(method)
  }
}

const atOrBefore = (record: { epoch: number; seq: number }, head: StreamHead) =>
  record.epoch < head.epoch || (record.epoch === head.epoch && record.seq <= head.seq)
/** Live records held past a gap while the replay catches up; more than this reads the thread again. */
const EARLY_MAX_RECORDS = 1_000

/** An error's message as a clause inside a sentence: without its own closing full stop. */
function reason(error: unknown): string {
  const text = error instanceof Error ? error.message.trim() : ''
  return text.replace(/[.!?]+$/, '') || 'unknown error'
}

/** One thread's display stream, shared by every open view of that thread. */
class ThreadWatch {
  readonly projection: ThreadProjection
  /** Settles once the thread is current: its snapshot is applied, or the resumed stream caught up. */
  readonly ready: Promise<void>
  private markReady!: () => void
  private readonly listeners = new Set<ItemsListener>()
  private stream?: string
  /** The last record applied; the projection's state is current through it. */
  private head?: StreamHead
  /** The saved copy the projection started from, until the stream confirms or replaces it. */
  private seed?: CachedThread
  private unsubscribe?: () => void
  private resyncing?: Promise<void>
  /** Records past a gap, by sequence: live ones can overtake the replay that fills it. */
  private early = new Map<number, StreamRecord>()
  /** The subscription finished its replay; a gap now means the computer skipped records. */
  private caught = false
  private saveTimer?: ReturnType<typeof setTimeout>
  private loadingEarlier?: Promise<void>
  private dirty = false
  private closed = false

  constructor(
    private readonly leaf: SessionLink,
    readonly threadId: string,
    private readonly cache?: ThreadCacheScope,
  ) {
    this.projection = new ThreadProjection(threadId)
    this.ready = new Promise<void>((resolve) => (this.markReady = resolve))
  }

  get size(): number {
    return this.listeners.size
  }

  /** Starts from a saved copy, so listeners see it before the computer answers. */
  restore(entry: CachedThread): boolean {
    if (!this.projection.restore(entry.state)) return false
    this.seed = entry
    this.stream = entry.stream
    this.head = { ...entry.head }
    return true
  }

  async start(): Promise<void> {
    let opened: unknown
    try {
      opened = await this.leaf.rpc('bridge.thread.open', { threadId: this.threadId })
    } catch (error) {
      if (error instanceof NetError && GONE.has(error.code)) this.cache?.remove(this.threadId)
      throw error
    }
    if (this.closed) return
    if (!isObject(opened) || !isObject(opened.descriptor) || typeof opened.descriptor.id !== 'string' || !opened.descriptor.id)
      badAnswer('bridge.thread.open')
    const stream = opened.descriptor.id as string
    const head = isHead(opened.head) ? opened.head : undefined
    const seed = this.seed
    this.seed = undefined
    // The saved copy is current through its position. Follow on from there unless the computer
    // started a new generation of the stream (it restarted) or holds fewer records than the copy.
    if (seed && seed.stream === stream && this.head && (!head || (head.epoch === this.head.epoch && head.seq >= this.head.seq))) {
      this.stream = stream
      this.follow(this.head, true)
      void this.readQuestions()
      return
    }
    this.stream = stream
    await this.load()
  }

  add(listener: ItemsListener): void {
    this.listeners.add(listener)
    listener(this.projection.items(), this.projection.state())
  }

  remove(listener: ItemsListener): void {
    this.listeners.delete(listener)
  }

  emit(): void {
    const items = this.projection.items()
    const state = this.projection.state()
    for (const listener of this.listeners) listener(items, state)
  }

  /**
   * The thread can no longer be followed: what was saved stays as it was, and the copy on screen stops
   * showing a running turn it cannot confirm, then says why.
   */
  giveUp(text: string): void {
    this.save()
    this.projection.stopRun()
    this.report(text)
  }

  /** Shows a phone-only error line, for example when the thread could not be read. */
  report(text: string): void {
    this.projection.addLocal({ id: `local-${newId('rpc')}`, role: 'system', text, createdAt: Date.now(), status: 'error' })
    this.emit()
  }

  close(): void {
    if (this.closed) return
    this.save()
    this.closed = true
    this.markReady()
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
    // A saved copy on screen is replaced in one step: the snapshot's end record swaps every message.
    const changed = this.projection.apply(snapshot.records)
    this.head = { epoch: snapshot.target.epoch, seq: snapshot.target.seq }
    this.changed()
    if (changed) this.emit()
    this.markReady()
    this.follow(this.head, false)
  }

  private follow(after: StreamHead, resumed: boolean): void {
    const stream = this.stream!
    this.early.clear()
    this.caught = false
    this.unsubscribe = this.leaf.subscribe(stream, after, {
      records: (records) => this.receive(records),
      delta: (data) => {
        if (this.projection.applyDelta(data)) this.emit()
      },
      caughtUp: () => {
        this.caught = true
        // A gap the replay did not fill: records are missing, so the state cannot follow on.
        if (this.early.size) return this.resync()
        if (resumed) this.markReady()
      },
      snapshotRequired: () => this.resync(),
      ended: () => {
        this.unsubscribe = undefined
        if (this.leaf.state === 'open') this.resync()
      },
    })
  }

  /** Applies records in stream order, exactly once; a record the stream skipped reads the thread again. */
  private receive(records: StreamRecord[]): void {
    let head = this.head!
    const ready: StreamRecord[] = []
    for (const record of records) {
      if (atOrBefore(record, head) || this.early.has(record.seq)) continue
      // A new generation (the computer restarted) cannot follow on from this one.
      if (record.epoch !== head.epoch) return this.resync()
      if (record.seq !== head.seq + 1) {
        this.early.set(record.seq, record)
        continue
      }
      ready.push(record)
      head = { epoch: record.epoch, seq: record.seq }
      for (let next = this.early.get(head.seq + 1); next; next = this.early.get(head.seq + 1)) {
        this.early.delete(next.seq)
        ready.push(next)
        head = { epoch: next.epoch, seq: next.seq }
      }
    }
    if (ready.length) {
      const changed = this.projection.apply(ready)
      this.head = head
      this.changed()
      if (changed) this.emit()
    }
    if (this.early.size && (this.caught || this.early.size > EARLY_MAX_RECORDS)) this.resync()
  }

  /** A resumed thread missed the snapshot that carries pending questions; ask for them. */
  private async readQuestions(): Promise<void> {
    try {
      const value = await this.leaf.rpc('orchestrator.pendingQuestions', { threadId: this.threadId })
      const pending = isObject(value) ? pendingQuestionsOf(value.pending, this.threadId) : undefined
      if (!pending || this.closed) return
      this.projection.setQuestions(pending)
      this.emit()
    } catch {
      // Older computers refuse; the live questions delta still arrives.
    }
  }

  private resync(): void {
    if (this.closed || this.resyncing) return
    this.unsubscribe?.()
    this.unsubscribe = undefined
    this.early.clear()
    this.resyncing = this.load()
      .catch((error: unknown) => {
        if (this.closed) return
        this.markReady()
        this.giveUp(`This thread stopped updating: ${reason(error)}. Open it again to reload.`)
      })
      .finally(() => {
        this.resyncing = undefined
      })
  }

  /**
   * Reads the page of messages before the oldest one the phone has, and puts it in front. One read at a time; a page
   * that arrives after a new snapshot moved the start is dropped. Resolves once the page is shown.
   */
  loadEarlier(): Promise<void> {
    if (this.loadingEarlier) return this.loadingEarlier
    const before = this.projection.earlierBefore
    if (!before || this.closed) return Promise.resolve()
    const loading = (async () => {
      let page: unknown
      try {
        page = await wholeReply(this.leaf, 'thread.messages', await this.leaf.rpc('thread.messages', { threadId: this.threadId, before }))
      } catch (error) {
        // A computer that predates paged reads refuses the method: say where the messages are.
        if (error instanceof NetError && (error.code === 'forbidden' || error.code === 'unknown_method' || error.code === 'not_found'))
          throw new Error('This computer cannot send older messages to the phone yet. Update Mousse on it, or read them there.')
        throw error
      }
      if (this.closed || !this.projection.prependEarlier(before, page)) return
      this.changed()
      this.emit()
    })()
    this.loadingEarlier = loading
    return loading.finally(() => {
      if (this.loadingEarlier === loading) this.loadingEarlier = undefined
    })
  }

  /** The records moved the state on: save it soon. */
  private changed(): void {
    if (!this.cache || this.closed) return
    this.dirty = true
    if (this.saveTimer !== undefined) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined
      this.save()
    }, THREAD_SAVE_DELAY_MS)
  }

  private save(): void {
    clearTimeout(this.saveTimer)
    this.saveTimer = undefined
    // Half a snapshot is not a state the stream can resume from; the snapshot's end saves again.
    if (!this.dirty || !this.cache || !this.stream || !this.head || this.projection.midSnapshot) return
    this.dirty = false
    this.cache.write(this.threadId, { stream: this.stream, head: { ...this.head }, state: this.projection.settled(), savedAt: Date.now() })
  }
}

interface WatchEntry {
  watch: ThreadWatch
  /** Until the watch can take listeners: reading the saved copy, or the first snapshot. */
  opening?: Promise<unknown>
  /** The watch started from a saved copy. */
  restored: boolean
}

export interface RealSessionOptions {
  nodeId: string
  leaf: SessionLink
  /** Called once when the session closes, for example to stop registration renewal. */
  onClose?: () => void
  /** Why the session closed; asked once, before state listeners learn of the close. */
  endReason?: (error?: Error) => SessionEndReason
  /** Saved thread contents for this account and computer; without it every thread opens from the computer. */
  threadCache?: ThreadCacheScope
}

/** The desktop's default name for a new thread (mousse/src/shared/threadTitle.ts). */
export const DEFAULT_THREAD_NAME = 'New Thread'

export class RealComputerSession implements ComputerSession {
  readonly nodeId: string
  readonly speech: ComputerSpeech
  readonly bots: ComputerBots
  private readonly leaf: SessionLink
  private readonly watches = new Map<string, WatchEntry>()
  /** Runs this phone started, by thread: the `orchestrator.send` RPC id that `orchestrator.abort` names. */
  private readonly runs = new Map<string, string>()
  /** The computer does not let a phone call `queue.edit` (Mousse before it was exposed to devices). */
  private queueEditRefused = false
  private ended?: SessionEndReason
  private endedWith?: string
  private lists?: ListsWatch
  private readonly cache?: ThreadCacheScope
  private warmed = false
  private prefetching = false
  private prefetched = false
  private prefetchChecks = 0
  private prefetchTimer?: ReturnType<typeof setTimeout>
  private prefetchList: ListThread[] = []

  constructor(options: RealSessionOptions) {
    this.nodeId = options.nodeId
    this.leaf = options.leaf
    this.cache = options.threadCache
    this.speech = new LeafComputerSpeech((method, params, rpcOptions) => this.leaf.rpc(method, params, rpcOptions))
    this.bots = new SessionBots((method, params, rpcOptions) => this.leaf.rpc(method, params, rpcOptions))
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
      clearTimeout(this.prefetchTimer)
      for (const entry of this.watches.values()) entry.watch.close()
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

  async createThread(input: { projectId: string; title?: string; worktreeEnabled?: boolean }): Promise<ThreadSummary> {
    // The computer names a thread from its first message only while it has its default name, which is
    // exactly "New Thread": any other name counts as one the person chose and is kept.
    const name = input.title?.trim() || DEFAULT_THREAD_NAME
    const value = await this.leaf.rpc(
      'threads.create',
      { name, ...(input.projectId ? { projectId: input.projectId, ...(input.worktreeEnabled ? { worktreeEnabled: true } : {}) } : {}) },
      { idem: crypto.randomUUID() },
    )
    const thread = isObject(value) ? threadSummary(value.thread) : undefined
    if (!thread) return badAnswer('threads.create')
    return thread
  }

  /**
   * A thread saved on this phone shows at once, before the computer answers, and then follows the
   * stream from the saved position. Others wait for the computer's snapshot. A thread already open
   * or kept in memory calls `onItems` before this returns.
   */
  async openThread(threadId: string, onItems: ItemsListener): Promise<() => void> {
    const entry = this.watches.get(threadId) ?? this.watchThread(threadId)
    if (entry.opening) await entry.opening
    const { watch } = entry
    watch.add(onItems)
    let done = false
    return () => {
      if (done) return
      done = true
      watch.remove(onItems)
      if (watch.size === 0 && this.watches.get(threadId) === entry) {
        this.watches.delete(threadId)
        watch.close()
      }
    }
  }

  /** Starts following a thread, from its saved copy when the phone has one. */
  private watchThread(threadId: string): WatchEntry {
    const watch = new ThreadWatch(this.leaf, threadId, this.cache)
    const entry: WatchEntry = { watch, restored: false }
    this.watches.set(threadId, entry)
    const fail = (error: unknown) => {
      if (this.watches.get(threadId) === entry) this.watches.delete(threadId)
      // A saved copy stays on screen with a note; without one the open itself fails.
      if (entry.restored && watch.size) watch.giveUp(`Could not update this thread: ${reason(error)}. Open it again to retry.`)
      watch.close()
    }
    const restore = (saved: CachedThread | undefined): boolean => {
      entry.restored = !!saved && watch.restore(saved)
      if (entry.restored) watch.start().catch(fail)
      return entry.restored
    }
    // Memory first, without waiting, so a recent thread draws on the first frame.
    if (restore(this.cache?.peek(threadId))) return entry
    const opening = this.savedCopy(threadId).then((saved) => (restore(saved) ? undefined : watch.start()))
    entry.opening = opening
    opening.then(
      () => {
        if (entry.opening === opening) entry.opening = undefined
      },
      fail,
    )
    return entry
  }

  /** The saved copy from the phone's storage, unless reading it takes longer than asking the computer would. */
  private savedCopy(threadId: string): Promise<CachedThread | undefined> {
    if (!this.cache) return Promise.resolve(undefined)
    let timer: ReturnType<typeof setTimeout> | undefined
    return Promise.race([
      this.cache.read(threadId).catch(() => undefined),
      new Promise<undefined>((resolve) => (timer = setTimeout(() => resolve(undefined), SAVED_READ_TIMEOUT_MS))),
    ]).finally(() => clearTimeout(timer))
  }

  async loadEarlier(threadId: string): Promise<void> {
    await this.watches.get(threadId)?.watch.loadEarlier()
  }

  async send(threadId: string, text: string, options: SendOptions = {}): Promise<void> {
    const content = text.trim()
    if (!content) throw new Error('Write a message first.')
    const chat = this.chatOf(threadId)
    if (chat) return this.sendChat(chat, content)
    if (this.runs.has(threadId)) throw new Error('A reply is already running in this thread.')
    const id = newId('rpc')
    this.runs.set(threadId, id)
    let extras: Record<string, unknown>
    try {
      extras = await this.chatExtras(options)
    } catch (error) {
      if (this.runs.get(threadId) === id) this.runs.delete(threadId)
      throw error
    }
    const call = this.leaf.rpc('orchestrator.send', { threadId, content, ...extras }, { id, idem: crypto.randomUUID(), deadlineMs: SEND_DEADLINE_MS })
    let early = true
    const settled = call.then(
      (value) => {
        // A turn the computer refused (for example, another turn holds the thread) answers with an error.
        if (!isObject(value) || typeof value.error !== 'string' || !value.error) return
        const refused = new Error(value.error)
        if (early) throw refused
        this.reportLate(threadId, refused)
      },
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

  async answerQuestions(threadId: string, requestId: string, answers: QuestionAnswers): Promise<boolean> {
    const value = await this.leaf.rpc('orchestrator.answerQuestions', { threadId, requestId, answers }, { idem: crypto.randomUUID() })
    if (!isObject(value) || typeof value.ok !== 'boolean') return badAnswer('orchestrator.answerQuestions')
    await this.settleQuestions(threadId, requestId)
    return value.ok
  }

  async dismissQuestions(threadId: string, requestId: string): Promise<boolean> {
    const value = await this.leaf.rpc('orchestrator.dismissQuestions', { threadId, requestId }, { idem: crypto.randomUUID() })
    if (!isObject(value) || typeof value.ok !== 'boolean') return badAnswer('orchestrator.dismissQuestions')
    await this.settleQuestions(threadId, requestId)
    return value.ok
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
      if (this.cache) this.lists.add({ lists: (lists) => this.prefetch(lists), state: () => undefined })
    }
    return this.lists.add({ lists: handlers.lists, state: (state, error) => handlers.state?.(state, error) })
  }

  async composerOptions(threadId?: string): Promise<ComposerOptions> {
    return composerOptionsOf(await this.leaf.rpc('composer.options', threadId ? { threadId } : {}))
  }

  async getThread(threadId: string): Promise<ThreadDetails> {
    const value = await this.leaf.rpc('threads.get', { threadId })
    const thread = isObject(value) && isObject(value.thread) ? value.thread : undefined
    if (!thread || thread.id !== threadId) return badAnswer('threads.get')
    const model = selection(thread.modelOverride)
    return {
      id: threadId,
      ...(typeof thread.projectId === 'string' && thread.projectId ? { projectId: thread.projectId } : {}),
      ...(model ? { model } : {}),
      ...(isPermissionMode(thread.permissionMode) ? { permissionMode: thread.permissionMode } : {}),
    }
  }

  async setThreadModel(threadId: string, model: ModelSelection): Promise<void> {
    const params = {
      threadId,
      model: { ...(model.instanceId ? { instanceId: model.instanceId } : {}), ...(model.llmProvider ? { llmProvider: model.llmProvider } : {}), model: model.model },
    }
    refusal(await this.leaf.rpc('threads.setModel', params, { idem: crypto.randomUUID() }))
  }

  async steer(threadId: string, text: string): Promise<void> {
    const content = text.trim()
    if (!content) throw new Error('Write the guidance first.')
    const run = this.runs.get(threadId)
    if (run) {
      const value = await this.leaf.rpc('orchestrator.steer', { threadId, run, text: content }, { idem: crypto.randomUUID() })
      if (isObject(value) && value.ok === true) return
    }
    // A turn this phone did not start: queue the text, then move it into that turn.
    const item = await this.enqueueItem(threadId, content, {})
    if (item) await this.steerQueued(threadId, item)
  }

  async enqueue(threadId: string, text: string, options: SendOptions = {}): Promise<void> {
    const content = text.trim()
    if (!content) throw new Error('Write a message first.')
    // Agent chats run one reply at a time and have no queue.
    const chat = this.chatOf(threadId)
    if (chat) return this.sendChat(chat, content)
    await this.enqueueItem(threadId, content, options)
  }

  async listQueue(threadId: string): Promise<QueuedMessage[]> {
    return queueOf(await this.leaf.rpc('queue.list', { threadId }), 'queue.list')
  }

  async removeQueued(threadId: string, itemId: string): Promise<void> {
    refusal(await this.leaf.rpc('queue.remove', { threadId, itemId }, { idem: crypto.randomUUID() }))
  }

  async reorderQueue(threadId: string, orderedIds: string[]): Promise<void> {
    refusal(await this.leaf.rpc('queue.reorder', { threadId, orderedIds }, { idem: crypto.randomUUID() }))
  }

  async editQueued(threadId: string, itemId: string, content: string, expectedContent?: string): Promise<QueueEditResult> {
    const text = content.trim()
    if (!text) throw new Error('Write a message first.')
    // Read the message with the queue's revision, so text changed elsewhere is not overwritten.
    const listed = await this.leaf.rpc('queue.list', { threadId })
    const items = queueOf(listed, 'queue.list')
    const revision = isObject(listed) && typeof listed.revision === 'string' ? listed.revision : undefined
    const current = items.find((item) => item.id === itemId)
    if (!current || current.state !== 'pending') throw new Error('This message already started or is no longer queued.')
    if (expectedContent !== undefined && current.content !== expectedContent) return { item: current, changed: true }
    if (current.content === text) return { item: current }
    if (!this.queueEditRefused) {
      try {
        const value = await this.leaf.rpc('queue.edit', { threadId, itemId, content: text, ...(revision ? { expectedRevision: revision } : {}) }, { idem: crypto.randomUUID() })
        refusal(value)
        return { item: (isObject(value) ? queued(value.item) : undefined) ?? { ...current, content: text } }
      } catch (error) {
        if (!(error instanceof NetError && error.code === 'forbidden')) throw error
        this.queueEditRefused = true
      }
    }
    return this.replaceQueued(threadId, current, text, items.map((item) => item.id))
  }

  /**
   * An edit on a computer that does not let a phone edit: the new text is queued, the old message
   * removed (the copy goes again if that fails, so nothing is lost or doubled) and the copy moved to
   * the old one's place.
   */
  private async replaceQueued(threadId: string, current: QueuedMessage, text: string, order: string[]): Promise<QueueEditResult> {
    if (current.imageCount > 0) throw new Error('This computer cannot edit a queued message with images. Remove it and send it again.')
    const copy = await this.enqueueItem(threadId, text, current.mode !== undefined ? { mode: current.mode } : {})
    if (!copy) return badAnswer('queue.enqueue')
    try {
      await this.removeQueued(threadId, current.id)
    } catch (error) {
      await this.removeQueued(threadId, copy).catch(() => undefined)
      throw error
    }
    const now = (await this.listQueue(threadId)).map((item) => item.id)
    const after = order.slice(order.indexOf(current.id) + 1).find((id) => id !== copy && now.includes(id))
    const ids = now.filter((id) => id !== copy)
    ids.splice(after ? ids.indexOf(after) : ids.length, 0, copy)
    if (ids.join('\n') !== now.join('\n')) await this.reorderQueue(threadId, ids).catch(() => undefined)
    return { item: { ...current, id: copy, content: text } }
  }

  async steerQueued(threadId: string, itemId: string): Promise<void> {
    refusal(await this.leaf.rpc('queue.promoteToSteer', { threadId, itemId }, { idem: crypto.randomUUID() }))
  }

  async contextUsage(threadId: string): Promise<ContextUsage | undefined> {
    const value = await this.leaf.rpc('orchestrator.contextUsage', { threadId })
    if (!isObject(value) || typeof value.percent !== 'number' || typeof value.used !== 'number' || typeof value.limit !== 'number') return undefined
    return {
      percent: value.percent,
      used: value.used,
      limit: value.limit,
      modelName: typeof value.modelName === 'string' ? value.modelName : null,
      categories: Array.isArray(value.categories)
        ? value.categories.flatMap((row) =>
            isObject(row) && typeof row.label === 'string' && typeof row.tokens === 'number'
              ? [{ label: row.label, color: typeof row.color === 'string' ? row.color : 'currentColor', tokens: row.tokens }]
              : [])
        : [],
    }
  }

  close(): void {
    this.leaf.close()
  }

  /**
   * Gets the most recent threads ready to open at once: saved copies are read into memory, and on a
   * direct path the newest few are brought up to date from the computer, one at a time.
   */
  private prefetch(lists: ComputerLists): void {
    const recent = [...lists.threads].filter((thread) => thread.started).sort((a, b) => b.updatedAt - a.updatedAt)
    if (!this.warmed) {
      this.warmed = true
      const cache = this.cache!
      void (async () => {
        for (const thread of recent.slice(0, WARM_THREADS)) await cache.read(thread.id)
      })()
    }
    this.prefetchList = recent.slice(0, PREFETCH_THREADS)
    if (this.prefetching || this.prefetched || this.leaf.state !== 'open') return
    // The path moves to direct a few seconds after opening, when it can; look again then.
    if ((this.leaf as { path?: string }).path !== 'direct') {
      if (this.prefetchChecks < PREFETCH_CHECKS_MS.length && this.prefetchTimer === undefined) {
        this.prefetchTimer = setTimeout(() => {
          this.prefetchTimer = undefined
          if (this.lists?.current) this.prefetch(this.lists.current)
        }, PREFETCH_CHECKS_MS[this.prefetchChecks++])
      }
      return
    }
    this.prefetching = true
    void (async () => {
      for (const thread of this.prefetchList) {
        if (this.leaf.state !== 'open') break
        if (this.watches.has(thread.id)) continue
        const saved = await this.cache!.read(thread.id)
        if (saved && saved.savedAt >= thread.updatedAt) continue
        try {
          const stop = await this.openThread(thread.id, () => undefined)
          const watch = this.watches.get(thread.id)?.watch
          let timer: ReturnType<typeof setTimeout> | undefined
          await Promise.race([watch?.ready, new Promise<void>((resolve) => (timer = setTimeout(resolve, PREFETCH_TIMEOUT_MS)))])
          clearTimeout(timer)
          stop()
        } catch {
          // Prefetching is a convenience; opening the thread tries again.
        }
      }
      this.prefetched = true
      this.prefetching = false
    })()
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

  private async enqueueItem(threadId: string, content: string, options: SendOptions): Promise<string | undefined> {
    const extras = await this.chatExtras(options)
    const value = await this.leaf.rpc('queue.enqueue', { threadId, content, ...extras }, { idem: crypto.randomUUID() })
    refusal(value)
    return isObject(value) && isObject(value.item) && typeof value.item.id === 'string' ? value.item.id : undefined
  }

  /** The mode and staged image ids a send or queued message carries. */
  private async chatExtras(options: SendOptions): Promise<Record<string, unknown>> {
    const extras: Record<string, unknown> = {}
    if (options.mode !== undefined) extras.mode = options.mode
    if (options.images?.length) {
      const ids: string[] = []
      for (const image of options.images) ids.push(await this.stageImage(image))
      extras.attachments = ids
    }
    return extras
  }

  /** Uploads one image in chunks the computer reassembles; returns the id a send names. */
  private async stageImage(image: ImageAttachment): Promise<string> {
    if (image.data.length > IMAGE_MAX_CHARS) throw new Error(`${image.name} is too large to send.`)
    const upload = uploadId()
    const total = Math.max(1, Math.ceil(image.data.length / IMAGE_CHUNK_CHARS))
    for (let index = 0; index < total; index++) {
      const data = image.data.slice(index * IMAGE_CHUNK_CHARS, (index + 1) * IMAGE_CHUNK_CHARS)
      const value = await this.leaf.rpc(
        'attachments.stage',
        { upload, index, total, name: image.name.slice(0, 512) || 'image', mimeType: image.mimeType, data },
        { idem: crypto.randomUUID() },
      )
      refusal(value)
    }
    return upload
  }

  /** Drops an answered request at once, then reads the thread's pending questions again. */
  private async settleQuestions(threadId: string, requestId: string): Promise<void> {
    const entry = this.watches.get(threadId)
    await entry?.opening?.catch(() => undefined)
    const watch = entry?.watch
    if (!watch || this.watches.get(threadId) !== entry) return
    watch.projection.setQuestions(watch.projection.questions.filter((entry) => entry.requestId !== requestId))
    watch.emit()
    try {
      const value = await this.leaf.rpc('orchestrator.pendingQuestions', { threadId })
      const pending = isObject(value) ? pendingQuestionsOf(value.pending, threadId) : undefined
      if (pending) {
        watch.projection.setQuestions(pending)
        watch.emit()
      }
    } catch {
      // The live questions delta keeps the list current.
    }
  }

  /** A send that failed after the phone stopped waiting: show it in the thread instead of dropping it. */
  private reportLate(threadId: string, error: unknown): void {
    if (error instanceof NetError && error.code === 'cancelled') return
    const message = error instanceof Error ? error.message : 'unknown error'
    const entry = this.watches.get(threadId)
    if (!entry) return
    void (entry.opening ?? Promise.resolve()).then(
      () => entry.watch.report(`The reply failed: ${message}`),
      () => undefined,
    )
  }
}
