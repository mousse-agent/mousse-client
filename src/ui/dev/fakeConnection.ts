// A deterministic, in-memory MousseConnection for development, screenshots and
// UI tests. It simulates sign-in, enrollment stages and streamed replies; it
// never touches the network. Replace it with the real connection in main.tsx.
import type {
  AccountState,
  ChatItem,
  ComposerOptions,
  Computer,
  ComputerLists,
  ComputerSession,
  ContextUsage,
  ModelSelection,
  QueuedMessage,
  SendOptions,
  ThreadDetails,
  EnrollmentProgress,
  ListChat,
  ListsHandlers,
  ThreadStatus,
  MousseConnection,
  Project,
  SessionEndReason,
  SessionState,
  ThreadSummary
} from '../../connection/types'

export interface FakeConnectionOptions {
  /** Start signed in as demo@mousse.dev. */
  signedIn?: boolean
  /** Email of the demo account when signedIn is set. Null mimics a Mousse ID without an email on file. */
  email?: string | null
  /** Delay between enrollment stages, in ms. */
  stageDelayMs?: number
  /** Delay between streamed reply chunks, in ms. */
  tickMs?: number
  /** Delay for network-ish calls such as sign-in and listing, in ms. */
  latencyMs?: number
  /** Reference time for the demo timestamps; defaults to now. */
  now?: number
  /** How "Continue with Google" ends: signed in (default), cancelled in the browser, or refused. */
  googleSignIn?: 'ok' | 'cancelled' | 'failed'
}

export const FAKE_PASSWORD_REJECTED = 'wrong'
export const FAKE_GOOGLE_EMAIL = 'ada.lovelace@gmail.com'
export const FAKE_MATCH_CODE = '482913'
export const FAKE_ID_ORIGIN = 'https://id.mousse.dev'

/** Demo timestamps are relative to when the fake was created. */
let BASE_TIME = Date.now()

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function initialComputers(): Computer[] {
  return [
    { nodeId: 'node-studio', name: 'Studio Mac', kind: 'computer', online: true, enrolled: true, lastSeenAt: BASE_TIME },
    { nodeId: 'node-workstation', name: 'Linux workstation', kind: 'computer', online: true, enrolled: false, lastSeenAt: BASE_TIME },
    { nodeId: 'node-laptop', name: 'Travel laptop', kind: 'computer', online: false, enrolled: true, lastSeenAt: BASE_TIME - 3 * 86_400_000 },
    { nodeId: 'node-pixel', name: 'Pixel 9', kind: 'phone', online: true, enrolled: false, lastSeenAt: BASE_TIME }
  ]
}

const PROJECTS: Project[] = [
  { id: 'p-mousse', name: 'mousse', path: '~/code/mousse' },
  { id: 'p-client', name: 'mousse-client', path: '~/code/mousse-client' },
  { id: 'p-site', name: 'website', path: '~/code/website' }
]

function initialThreads(): ThreadSummary[] {
  return [
    { id: 't-redesign', projectId: 'p-client', title: 'Phone app redesign', updatedAt: BASE_TIME - 5 * 60_000, pinned: true, active: true },
    { id: 't-relay', projectId: 'p-mousse', title: 'Relay reconnect backoff', updatedAt: BASE_TIME - 40 * 60_000, pinned: true },
    { id: 't-voices', projectId: 'p-mousse', title: 'Fetch extra Kokoro voices on first use', updatedAt: BASE_TIME - 3 * 3_600_000 },
    { id: 't-landing', projectId: 'p-site', title: 'Landing page copy', updatedAt: BASE_TIME - 26 * 3_600_000 },
    { id: 't-icons', projectId: 'p-client', title: 'Swap lucide for Hugeicons', updatedAt: BASE_TIME - 50 * 3_600_000, settled: true }
  ]
}

function initialChats(): ListChat[] {
  return [
    { id: 'c-review', kind: 'direct', name: 'Reviewer', threadId: 'ct-review', network: false, agents: ['Reviewer'], updatedAt: BASE_TIME - 12 * 60_000, preview: 'The retry test still races the relay timeout; I left a note on line 88.' },
    { id: 'c-release', kind: 'group', name: 'Release crew', threadId: 'ct-release', network: false, agents: ['Planner', 'Tester'], updatedAt: BASE_TIME - 2 * 3_600_000, preview: '@tester the Android build is ready for a smoke test.' },
    { id: 'c-team', kind: 'group', name: 'Team space', network: true, agents: ['Planner'], updatedAt: BASE_TIME - 30 * 3_600_000 }
  ]
}

function initialItems(threadId: string, title: string): ChatItem[] {
  if (threadId === 't-redesign') {
    return [
      { id: 'i1', role: 'user', text: 'Make the phone app look like the desktop: same tokens, Geist, Hugeicons.', createdAt: BASE_TIME - 9 * 60_000, status: 'done' },
      { id: 'i2', role: 'tool', toolName: 'read_file', text: 'src/renderer/styles/polish.css\n1196 lines', createdAt: BASE_TIME - 8 * 60_000, status: 'done' },
      { id: 'i3', role: 'assistant', text: 'I read the desktop tokens. The phone app now uses the mousse dark surfaces, the raised composer with its specular rim, and the same accent ramp.', createdAt: BASE_TIME - 7 * 60_000, status: 'done' },
      { id: 'i4', role: 'user', text: 'Now add the split view for tablets.', createdAt: BASE_TIME - 6 * 60_000, status: 'done' },
      { id: 'i5', role: 'assistant', text: 'Working on the two-pane layout', createdAt: BASE_TIME - 5 * 60_000, status: 'streaming' }
    ]
  }
  return [
    { id: 'i1', role: 'user', text: `Let's pick up "${title}".`, createdAt: BASE_TIME - 3_600_000, status: 'done' },
    { id: 'i2', role: 'tool', toolName: 'shell', text: '$ git status\nOn branch main\nnothing to commit, working tree clean', createdAt: BASE_TIME - 3_590_000, status: 'done' },
    { id: 'i3', role: 'assistant', text: 'The working tree is clean, so this starts from main. Tell me what to change next.', createdAt: BASE_TIME - 3_580_000, status: 'done' }
  ]
}

/** The demo computer's models: two providers, efforts, a Fast variant and a long-context variant. */
export const FAKE_COMPOSER_OPTIONS: ComposerOptions = {
  providers: [
    {
      id: 'anthropic',
      instanceId: 'pi:anthropic',
      label: 'Anthropic',
      models: [
        { id: 'claude-opus-4-8', label: 'Claude Opus 4.8', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
        { id: 'claude-opus-4-8:fast', label: 'Claude Opus 4.8 (fast)', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], speed: 'fast' },
        { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 @ 200K', efforts: ['low', 'medium', 'high'] },
        { id: 'claude-sonnet-4-6@1m', label: 'Claude Sonnet 4.6 @ 1M', efforts: ['low', 'medium', 'high'] },
        { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' }
      ]
    },
    {
      id: 'openai',
      instanceId: 'pi:openai',
      label: 'OpenAI',
      models: [
        { id: 'gpt-5.5', label: 'GPT 5.5', efforts: ['minimal', 'low', 'medium', 'high', 'xhigh'] },
        { id: 'gpt-5.5-mini', label: 'GPT 5.5 mini', efforts: ['low', 'medium', 'high'] }
      ]
    }
  ],
  defaultModel: { instanceId: 'pi:anthropic', llmProvider: 'anthropic', model: 'claude-opus-4-8:high' },
  modes: ['plan', 'agent', 'build'],
  skills: [
    { id: 'skill-review', name: 'Code review', description: 'Review the current diff for bugs' },
    { id: 'skill-release', name: 'Release notes', description: 'Write release notes from merged PRs' }
  ],
  commands: [
    { name: 'help', description: 'List available channel commands' },
    { name: 'new', description: 'Start a new session (fresh thread + history)', aliases: ['reset'], argsHint: '[title]' },
    { name: 'status', description: 'Show session, model, and thread info' },
    { name: 'usage', description: 'Show subscription usage for the current provider' },
    { name: 'model', description: 'List or switch the model for this session', aliases: ['models'], argsHint: '[name] [--session|--global]' },
    { name: 'stop', description: 'Stop the in-flight reply for this session' },
    { name: 'steer', description: 'Inject guidance mid-turn (after the next tool call)', argsHint: '<prompt>' },
    { name: 'skills', description: 'Pick a skill to use as the chat mode', argsHint: '[filter]' }
  ]
}

function replyFor(text: string): string {
  return `Here is the plan for "${text.slice(0, 48)}": I will look at the relevant files, make the change, and run the focused tests before reporting back.`
}

export class FakeSession implements ComputerSession {
  private sessionState: SessionState = 'open'
  private stateListeners = new Set<(state: SessionState) => void>()
  private items = new Map<string, ChatItem[]>()
  private watchers = new Map<string, Set<(items: ChatItem[]) => void>>()
  private streams = new Map<string, ReturnType<typeof setInterval>>()
  private nextId = 1
  private endedWith?: string
  private listWatchers = new Set<ListsHandlers>()
  private chats = initialChats()
  /** Threads whose last turn finished and that show "Done" until their next turn. */
  private done = new Set<string>(['t-relay'])
  private waiting = new Set<string>(['t-voices'])
  private models = new Map<string, ModelSelection>()
  private queues = new Map<string, QueuedMessage[]>()
  /** Every send, queued message and steer, with its options, for tests. */
  readonly sent: Array<{ kind: 'send' | 'queue' | 'steer'; threadId: string; text: string; options?: SendOptions }> = []

  constructor(readonly nodeId: string, private threads: ThreadSummary[], private opts: Required<Omit<FakeConnectionOptions, 'now' | 'email'>>) {}

  watchLists(handlers: ListsHandlers): () => void {
    this.listWatchers.add(handlers)
    handlers.state?.('loading')
    setTimeout(() => {
      if (!this.listWatchers.has(handlers)) return
      handlers.lists(this.lists())
      handlers.state?.('live')
    }, this.opts.latencyMs)
    return () => { this.listWatchers.delete(handlers) }
  }

  private lists(): ComputerLists {
    const status: Record<string, ThreadStatus> = {}
    for (const thread of this.threads) {
      if (this.isActive(thread.id)) status[thread.id] = { state: 'processing', since: thread.updatedAt }
      else if (this.waiting.has(thread.id)) status[thread.id] = { state: 'awaiting_input', since: thread.updatedAt }
      else if (this.done.has(thread.id)) status[thread.id] = { state: 'completed' }
    }
    const chats = this.chats.map((chat) => chat.threadId && this.isActive(chat.threadId)
      ? { ...chat, run: { id: `run-${chat.id}`, state: 'running', startedAt: Date.now() } }
      : { ...chat })
    return {
      projects: PROJECTS.map((project, order) => ({ id: project.id, name: project.name, path: project.path, order, pinned: false })),
      threads: this.threads.map((thread, order) => ({
        id: thread.id,
        title: thread.title,
        projectId: thread.projectId,
        createdAt: thread.updatedAt,
        updatedAt: thread.updatedAt,
        order,
        pinned: !!thread.pinned,
        settled: !!thread.settled,
        started: true
      })),
      chats,
      status,
      receivedAt: Date.now()
    }
  }

  private emitLists(): void {
    if (!this.listWatchers.size) return
    const lists = this.lists()
    for (const watcher of this.listWatchers) watcher.lists(lists)
  }

  state(): SessionState { return this.sessionState }

  endReason(): SessionEndReason | undefined { return this.sessionState === 'closed' ? 'ended' : undefined }

  endMessage(): string | undefined { return this.sessionState === 'closed' ? this.endedWith : undefined }

  onStateChange(listener: (state: SessionState) => void): () => void {
    this.stateListeners.add(listener)
    return () => { this.stateListeners.delete(listener) }
  }

  async listProjects(): Promise<Project[]> {
    await sleep(this.opts.latencyMs)
    return PROJECTS.map((project) => ({ ...project }))
  }

  async listThreads(filter?: { projectId?: string; query?: string }): Promise<ThreadSummary[]> {
    await sleep(this.opts.latencyMs)
    const query = filter?.query?.trim().toLowerCase()
    return this.threads
      .filter((thread) => !filter?.projectId || thread.projectId === filter.projectId)
      .filter((thread) => !query || thread.title.toLowerCase().includes(query))
      .map((thread) => ({ ...thread, active: this.isActive(thread.id) }))
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  async createThread(input: { projectId: string; title?: string }): Promise<ThreadSummary> {
    await sleep(this.opts.latencyMs)
    const thread: ThreadSummary = {
      id: `t-new-${this.nextId++}`,
      projectId: input.projectId,
      title: input.title?.trim() || 'New thread',
      updatedAt: Date.now()
    }
    this.threads.unshift(thread)
    this.items.set(thread.id, [])
    this.emitLists()
    return { ...thread }
  }

  async openThread(threadId: string, onItems: (items: ChatItem[]) => void): Promise<() => void> {
    await sleep(this.opts.latencyMs)
    const list = this.itemsFor(threadId)
    let set = this.watchers.get(threadId)
    if (!set) this.watchers.set(threadId, (set = new Set()))
    set.add(onItems)
    onItems(list.map((item) => ({ ...item })))
    // The demo thread is mid-turn when first opened.
    const last = list[list.length - 1]
    if (last?.status === 'streaming' && !this.streams.has(threadId)) {
      this.stream(threadId, last.id, `${last.text}. The thread list moves to the left at 768px and wider, and the open thread fills the rest.`)
    }
    return () => { set?.delete(onItems) }
  }

  async send(threadId: string, text: string, options?: SendOptions): Promise<void> {
    await sleep(this.opts.latencyMs)
    if (this.isActive(threadId)) throw new Error('A turn is already running in this thread.')
    this.sent.push({ kind: 'send', threadId, text, ...(options ? { options } : {}) })
    const now = Date.now()
    const list = this.itemsFor(threadId)
    list.push({ id: `u${this.nextId++}`, role: 'user', text, createdAt: now, status: 'done' })
    list.push({ id: `tool${this.nextId++}`, role: 'tool', toolName: 'search_files', text: `query: ${text.slice(0, 32)}\n3 matches`, createdAt: now + 1, status: 'done' })
    const assistantId = `a${this.nextId++}`
    list.push({ id: assistantId, role: 'assistant', text: '', createdAt: now + 2, status: 'streaming' })
    this.touch(threadId)
    this.done.delete(threadId)
    this.waiting.delete(threadId)
    this.emit(threadId)
    this.stream(threadId, assistantId, replyFor(text))
    this.emitLists()
  }

  async abort(threadId: string): Promise<void> {
    const timer = this.streams.get(threadId)
    if (!timer) return
    clearInterval(timer)
    this.streams.delete(threadId)
    const list = this.itemsFor(threadId)
    for (const item of list) if (item.status === 'streaming') item.status = 'done'
    list.push({ id: `s${this.nextId++}`, role: 'system', text: 'Stopped', createdAt: Date.now(), status: 'done' })
    this.emit(threadId)
    this.emitLists()
  }

  async isTurnActive(threadId: string): Promise<boolean> {
    return this.isActive(threadId)
  }

  async composerOptions(): Promise<ComposerOptions> {
    await sleep(this.opts.latencyMs)
    return structuredClone(FAKE_COMPOSER_OPTIONS)
  }

  async getThread(threadId: string): Promise<ThreadDetails> {
    await sleep(this.opts.latencyMs)
    const thread = this.threads.find((entry) => entry.id === threadId)
    const model = this.models.get(threadId)
    return { id: threadId, ...(thread?.projectId ? { projectId: thread.projectId } : {}), ...(model ? { model: { ...model } } : {}) }
  }

  async setThreadModel(threadId: string, selection: ModelSelection): Promise<void> {
    await sleep(this.opts.latencyMs)
    this.models.set(threadId, { ...selection })
  }

  async steer(threadId: string, text: string): Promise<void> {
    await sleep(this.opts.latencyMs)
    if (!this.isActive(threadId)) throw new Error('No active turn to steer on this thread.')
    this.sent.push({ kind: 'steer', threadId, text })
  }

  async enqueue(threadId: string, text: string, options?: SendOptions): Promise<void> {
    await sleep(this.opts.latencyMs)
    this.sent.push({ kind: 'queue', threadId, text, ...(options ? { options } : {}) })
    const queue = this.queues.get(threadId) ?? []
    queue.push({
      id: `q${this.nextId++}`,
      content: text,
      ...(options?.mode ? { mode: options.mode } : {}),
      imageCount: options?.images?.length ?? 0,
      enqueuedAt: Date.now(),
      intent: 'normal',
      state: 'pending'
    })
    this.queues.set(threadId, queue)
  }

  async listQueue(threadId: string): Promise<QueuedMessage[]> {
    return (this.queues.get(threadId) ?? []).map((item) => ({ ...item }))
  }

  async removeQueued(threadId: string, itemId: string): Promise<void> {
    const queue = this.queues.get(threadId) ?? []
    if (!queue.some((item) => item.id === itemId)) throw new Error('This message already started or is no longer queued.')
    this.queues.set(threadId, queue.filter((item) => item.id !== itemId))
  }

  async reorderQueue(threadId: string, orderedIds: string[]): Promise<void> {
    const queue = this.queues.get(threadId) ?? []
    this.queues.set(threadId, orderedIds.map((id) => queue.find((item) => item.id === id)).filter((item): item is QueuedMessage => !!item))
  }

  async steerQueued(threadId: string, itemId: string): Promise<void> {
    const item = (this.queues.get(threadId) ?? []).find((entry) => entry.id === itemId)
    if (!item) throw new Error('This message already started or is no longer queued.')
    await this.steer(threadId, item.content)
    await this.removeQueued(threadId, itemId)
  }

  async contextUsage(threadId: string): Promise<ContextUsage | undefined> {
    const used = 18_000 + this.itemsFor(threadId).reduce((total, item) => total + item.text.length * 4, 0)
    const limit = 200_000
    return {
      percent: Math.round((used / limit) * 100),
      used,
      limit,
      modelName: 'Claude Opus 4.8',
      categories: [
        { label: 'System', color: '#8b7cf6', tokens: 12_000 },
        { label: 'Tools', color: '#4fb6a7', tokens: 6_000 },
        { label: 'Messages', color: '#e3a13b', tokens: used - 18_000 }
      ]
    }
  }

  /** Closes the session; `message` stands in for the close error a real session reports. */
  close(message?: string): void {
    this.endedWith = message
    for (const timer of this.streams.values()) clearInterval(timer)
    this.streams.clear()
    this.watchers.clear()
    this.listWatchers.clear()
    this.sessionState = 'closed'
    for (const listener of this.stateListeners) listener('closed')
  }

  private isActive(threadId: string): boolean {
    if (this.streams.has(threadId)) return true
    const list = this.items.get(threadId)
    if (list) return list.some((item) => item.status === 'streaming')
    return this.threads.find((thread) => thread.id === threadId)?.active === true
  }

  /** Like the computer: the next queued message runs once the turn ends. */
  private drain(threadId: string): void {
    const queue = this.queues.get(threadId)
    const next = queue?.shift()
    if (!next) return
    void this.send(threadId, next.content, next.mode ? { mode: next.mode } : undefined)
  }

  private itemsFor(threadId: string): ChatItem[] {
    let list = this.items.get(threadId)
    if (!list) {
      const title = this.threads.find((thread) => thread.id === threadId)?.title ?? 'this thread'
      list = initialItems(threadId, title)
      this.items.set(threadId, list)
    }
    return list
  }

  private touch(threadId: string): void {
    const thread = this.threads.find((entry) => entry.id === threadId)
    if (thread) thread.updatedAt = Date.now()
  }

  private emit(threadId: string): void {
    const list = this.itemsFor(threadId)
    for (const watcher of this.watchers.get(threadId) ?? []) watcher(list.map((item) => ({ ...item })))
  }

  private stream(threadId: string, itemId: string, fullText: string): void {
    const words = fullText.split(/(\s+)/)
    const item = this.itemsFor(threadId).find((entry) => entry.id === itemId)
    if (!item) return
    let index = Math.max(0, words.join('').startsWith(item.text) ? fullText.slice(0, item.text.length).split(/(\s+)/).length : 0)
    const timer = setInterval(() => {
      if (index >= words.length) {
        clearInterval(timer)
        this.streams.delete(threadId)
        item.text = fullText
        item.status = 'done'
        const thread = this.threads.find((entry) => entry.id === threadId)
        if (thread) thread.active = false
        this.done.add(threadId)
        const chat = this.chats.find((entry) => entry.threadId === threadId)
        if (chat) Object.assign(chat, { preview: fullText, updatedAt: Date.now() })
        this.emit(threadId)
        this.emitLists()
        this.drain(threadId)
        return
      }
      index += 2
      item.text = words.slice(0, index).join('')
      this.emit(threadId)
    }, this.opts.tickMs)
    this.streams.set(threadId, timer)
  }
}

export class FakeMousseConnection implements MousseConnection {
  private accountState: AccountState = { status: 'signed-out' }
  private listeners = new Set<(state: AccountState) => void>()
  private computers = initialComputers()
  private threadsByNode = new Map<string, ThreadSummary[]>()
  private readonly opts: Required<Omit<FakeConnectionOptions, 'now' | 'email'>>

  constructor(options: FakeConnectionOptions = {}) {
    BASE_TIME = options.now ?? Date.now()
    this.computers = initialComputers()
    this.opts = {
      signedIn: options.signedIn ?? false,
      stageDelayMs: options.stageDelayMs ?? 1200,
      tickMs: options.tickMs ?? 60,
      latencyMs: options.latencyMs ?? 250,
      googleSignIn: options.googleSignIn ?? 'ok'
    }
    if (this.opts.signedIn) this.setSignedIn(options.email === undefined ? 'demo@mousse.dev' : options.email)
  }

  account(): AccountState { return this.accountState }

  onAccountChange(listener: (state: AccountState) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  async signInWithPassword(email: string, password: string): Promise<void> {
    await sleep(this.opts.latencyMs)
    if (!email.includes('@')) throw new Error('Enter the email address of your Mousse ID.')
    if (!password || password === FAKE_PASSWORD_REJECTED) throw new Error('That email and password do not match a Mousse ID.')
    this.setSignedIn(email)
  }

  async signInWithGoogle(): Promise<void> {
    await sleep(this.opts.latencyMs)
    if (this.opts.googleSignIn === 'cancelled') throw new Error('Sign-in was cancelled when the browser closed.')
    if (this.opts.googleSignIn === 'failed') throw new Error('Google sign-in did not finish. Try again.')
    this.setSignedIn(FAKE_GOOGLE_EMAIL)
  }

  async signOut(): Promise<void> {
    this.accountState = { status: 'signed-out' }
    this.notify()
  }

  async openSignUp(): Promise<void> {
    if (typeof window !== 'undefined' && typeof window.open === 'function') {
      window.open(`${FAKE_ID_ORIGIN}/sign-up`, '_blank', 'noopener')
    }
  }

  async listComputers(): Promise<Computer[]> {
    await sleep(this.opts.latencyMs)
    this.requireAccount()
    return this.computers.map((computer) => ({ ...computer }))
  }

  async enrollWithComputer(nodeId: string, _deviceName: string, onProgress: (progress: EnrollmentProgress) => void): Promise<void> {
    this.requireAccount()
    const computer = this.computers.find((entry) => entry.nodeId === nodeId)
    if (!computer) throw new Error('That computer is no longer on this account.')
    if (!computer.online) {
      onProgress({ stage: 'error', message: `${computer.name} is offline. Open Mousse on it and try again.` })
      throw new Error(`${computer.name} is offline.`)
    }
    await this.runStages(onProgress)
    computer.enrolled = true
  }

  async enrollFromQr(payload: string, onProgress: (progress: EnrollmentProgress) => void): Promise<void> {
    if (!payload.trim().startsWith('mousse://net/join')) {
      onProgress({ stage: 'error', message: 'This QR code is not a Mousse pairing code.' })
      throw new Error('This QR code is not a Mousse pairing code.')
    }
    const name = new URLSearchParams(payload.split('?')[1] ?? '').get('name') ?? 'Scanned computer'
    await this.runStages(onProgress)
    const nodeId = `node-qr-${this.computers.length}`
    this.computers.push({ nodeId, name, kind: 'computer', online: true, enrolled: true, lastSeenAt: Date.now() })
  }

  async openComputer(nodeId: string): Promise<ComputerSession> {
    await sleep(this.opts.latencyMs)
    this.requireAccount()
    const computer = this.computers.find((entry) => entry.nodeId === nodeId)
    if (!computer) throw new Error('That computer is no longer on this account.')
    if (!computer.online) throw new Error(`${computer.name} is offline.`)
    if (!computer.enrolled) throw new Error(`Add this phone to ${computer.name} first.`)
    let threads = this.threadsByNode.get(nodeId)
    if (!threads) this.threadsByNode.set(nodeId, (threads = initialThreads()))
    this.lastSession = new FakeSession(nodeId, threads, this.opts)
    return this.lastSession
  }

  /** The most recently opened session, for tests. */
  lastSession?: FakeSession

  private async runStages(onProgress: (progress: EnrollmentProgress) => void): Promise<void> {
    onProgress({ stage: 'requesting' })
    await sleep(this.opts.stageDelayMs)
    onProgress({ stage: 'waiting-approval', matchCode: FAKE_MATCH_CODE })
    await sleep(this.opts.stageDelayMs * 2)
    onProgress({ stage: 'connecting', matchCode: FAKE_MATCH_CODE })
    await sleep(this.opts.stageDelayMs)
    onProgress({ stage: 'done' })
  }

  private requireAccount(): void {
    if (this.accountState.status !== 'signed-in') throw new Error('Sign in to your Mousse ID first.')
  }

  private setSignedIn(email: string | null): void {
    this.accountState = {
      status: 'signed-in',
      // The real AppSession can report a null email; types.ts still says string (see the types.ts proposal).
      account: { id: email ? `acct-${email.toLowerCase()}` : 'acct-demo', email: email as string },
      idOrigin: FAKE_ID_ORIGIN
    }
    this.notify()
  }

  private notify(): void {
    for (const listener of this.listeners) listener(this.accountState)
  }
}

export function createFakeConnection(options?: FakeConnectionOptions): MousseConnection {
  return new FakeMousseConnection(options)
}
