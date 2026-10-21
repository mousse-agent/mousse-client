// A ComputerSession over a LeafSession: the phone's view of one computer, through the desktop's
// bridge RPCs (projects.list, threads.*, orchestrator.*, bridge.thread.open) and its signed thread
// display stream.
import { newId } from '../net/canonical'
import { NetError } from '../net/errors'
import type { LeafSession, StreamHead } from '../net/session'
import { ListsWatch } from './lists'
import { ThreadProjection } from './threadProjection'
import { LeafComputerSpeech, type ComputerSpeech } from './speech'
import type {
  ChatItem,
  ChatMode,
  ComposerOptions,
  ComputerSession,
  ContextUsage,
  ImageAttachment,
  ListChat,
  ListsHandlers,
  LlmModelOption,
  LlmProviderOption,
  ModelSelection,
  Project,
  QuestionAnswers,
  QueuedMessage,
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
  }
}

/** An upload id: letters, digits, `_` and `-`, as the computer requires. */
const uploadId = (): string => newId('rpc')

function isHead(value: unknown): value is StreamHead {
  return isObject(value) && Number.isSafeInteger(value.epoch) && Number.isSafeInteger(value.seq)
}

type ItemsListener = (items: ChatItem[], state?: ThreadDisplayState) => void

/** One thread's display stream, shared by every open view of that thread. */
class ThreadWatch {
  readonly projection: ThreadProjection
  private readonly listeners = new Set<ItemsListener>()
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
      delta: (data) => {
        if (this.projection.applyDelta(data)) this.emit()
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
  readonly speech: ComputerSpeech
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
    this.speech = new LeafComputerSpeech((method, params, rpcOptions) => this.leaf.rpc(method, params, rpcOptions))
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

  async openThread(threadId: string, onItems: ItemsListener): Promise<() => void> {
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
    const watch = await this.watches.get(threadId)?.catch(() => undefined)
    if (!watch) return
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
    void this.watches.get(threadId)?.then(
      (watch) => {
        watch.projection.addLocal({ id: `local-${newId('rpc')}`, role: 'system', text: `The reply failed: ${message}`, createdAt: Date.now(), status: 'error' })
        watch.emit()
      },
      () => undefined,
    )
  }
}
