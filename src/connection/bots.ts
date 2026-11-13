// The owner's personal bots on a computer (the desktop's Chats tab, Bots section): their summaries
// arrive in the lists stream, and their chats are read and written with the `bots.*` methods the
// computer offers phones. Shapes follow mousse/src/shared/bots/personal/chat.ts and the phone methods
// of mousse/src/mms/bridge/remote/RemoteBots.ts. No payload carries a model, an instance id or a
// computer path. A computer from before a method or field leaves that feature out on the phone: a
// method it does not offer fails with `BotsUnsupportedError`, and a missing field reads as absent. A
// computer whose "Share bots with other devices" is off lists no bots and refuses every call
// (`BotsNotSharedError`).

export type BotState = 'idle' | 'working' | 'needs_you' | 'stuck' | 'paused'
export type BotChipIcon = 'search' | 'web' | 'read' | 'edit' | 'schedule' | 'memory' | 'ask' | 'think' | 'name' | 'warning'

/** A bot's face: a clay mouse or a Mousse, a colour, an accessory and eyes. Unknown values read as the defaults. */
export interface BotLook {
  colour: string
  accessory: string
  kind?: string
  eyes?: string
}

export interface BotError {
  text: string
  action?: { kind: 'sign_in' | 'open_providers' | 'resume' | 'retry'; label: string }
}

export interface BotChip {
  icon: BotChipIcon
  text: string
  highlight?: string
  live?: boolean
}

export type BotAskStatus = 'open' | 'allowed' | 'not_now' | 'withdrawn'

export interface BotAskCard {
  askId: string
  title: string
  note: string
  status: BotAskStatus
  kind?: 'permission' | 'export_memory'
}

export type BotMessageKind = 'text' | 'run_report' | 'notice' | 'error'

export interface BotChatFile { name: string; mime?: string; image?: true }

export interface BotChatQuote {
  id: string
  author: 'owner' | 'bot'
  text: string
  gone?: boolean
}

export interface BotChatMessage {
  seq: number
  id: string
  at: string
  author: 'owner' | 'bot'
  kind: BotMessageKind
  text: string
  chips: BotChip[]
  ask?: BotAskCard
  error?: BotError
  activationId?: string
  /** A file's name and type; `image` when `attachment` can read it (a computer from before images sends the name only). */
  attachments?: BotChatFile[]
  replyTo?: BotChatQuote
  /** The owner's message: the request id it was sent with, which matches it to the bubble shown while it was on its way. */
  clientRequestId?: string
}

export interface BotWorkItem {
  id: string
  title: string
  status: 'running' | 'queued' | 'waiting_for_internet' | 'paused'
  startedAt: string
  scheduled?: true
}

/** One bot as the Bots section lists it. */
export interface ListBot {
  id: string
  name: string
  description: string
  look: BotLook
  state: BotState
  stateText: string
  waiting?: 'internet'
  error?: BotError
  last?: { text: string; at: string; author: 'owner' | 'bot' }
  lastOutcome?: 'ok' | 'failed' | 'stopped'
  unread: number
  createdAt: string
  /** The chat turn that runs now; absent while the chat is free. */
  chat?: { activationId: string; offline?: true }
  work?: BotWorkItem[]
  /** What the chat turn is doing right now. */
  activity?: BotChip
}

export interface BotChatPage {
  messages: BotChatMessage[]
  live?: { activationId: string; chip?: BotChip }
}

export interface BotPermissionItem { id: string; title: string; note: string; grantedAt: string }
export interface BotRunItem { id: string; label: string; nextAt?: string; kind: 'schedule' }
/** One waiting reminder (one-off, not yet said). `work`: it starts work at its time rather than only saying `text`. */
export interface BotReminderItem { id: string; dueAt: string; text: string; work?: true }
/** `reminders` is absent from computers that don't list them. */
export interface BotDetail { summary: ListBot; permissions: BotPermissionItem[]; runs: BotRunItem[]; reminders?: BotReminderItem[] }

/** One thing the bot remembers, as About lists it (`bots.memory.list`, active entries with text only). */
export interface BotMemoryItem { id: string; text: string; kind: string }

/** An image file of a chat message, read from the computer: PNG, JPEG, GIF or WebP. */
export interface BotAttachmentImage { mimeType: string; bytes: Uint8Array }

/** A method this computer does not offer phones: the phone leaves that feature out. */
export class BotsUnsupportedError extends Error {
  constructor(message = 'Update Mousse on this computer to use its bots from your phone.') {
    super(message)
    this.name = 'BotsUnsupportedError'
  }
}

export const isBotsUnsupported = (error: unknown): boolean => error instanceof BotsUnsupportedError

/** The computer's "Share bots with other devices" is off: every bot call is refused. */
export class BotsNotSharedError extends Error {
  constructor() {
    super('This computer doesn’t share its bots with other devices. Turn on Share bots with other devices in Mousse there (Settings, Devices).')
    this.name = 'BotsNotSharedError'
  }
}

/** The bot methods of one computer. Every call fails with a plain message when the computer is older and has none. */
export interface ComputerBots {
  chat(botId: string, page?: { beforeSeq?: number; limit?: number }): Promise<BotChatPage>
  /** `clientRequestId` matches the sent message to the bubble shown while it was on its way; a retry with the same one adds no second message. */
  send(botId: string, text: string, replyTo?: string, clientRequestId?: string): Promise<BotChatMessage>
  stop(botId: string): Promise<void>
  stopWork(botId: string, workId: string): Promise<void>
  markRead(botId: string, seq: number): Promise<void>
  answer(botId: string, askId: string, answer: 'allow' | 'not_now'): Promise<BotChatMessage>
  get(botId: string): Promise<BotDetail>
  pause(botId: string): Promise<ListBot>
  resume(botId: string): Promise<ListBot>
  create(input: { look: BotLook; description: string; name?: string }): Promise<ListBot>
  /** Cancels a waiting reminder; it never fires. */
  cancelReminder(botId: string, reminderId: string): Promise<BotDetail>
  /** What the bot remembers. */
  memory(botId: string): Promise<BotMemoryItem[]>
  forgetMemory(botId: string, id: string): Promise<void>
  /** The image at `index` of message `messageId`'s files. */
  attachment(botId: string, messageId: string, index: number): Promise<BotAttachmentImage>
  /** About → Runs → Remove. */
  removeSchedule(botId: string, scheduleId: string): Promise<BotDetail>
  /** About → Can use → Remove. */
  revokePermission(botId: string, permissionId: string): Promise<BotDetail>
}

const BOT_STATES = new Set<BotState>(['idle', 'working', 'needs_you', 'stuck', 'paused'])
const CHIP_ICONS = new Set<BotChipIcon>(['search', 'web', 'read', 'edit', 'schedule', 'memory', 'ask', 'think', 'name', 'warning'])
const MESSAGE_KINDS = new Set<BotMessageKind>(['text', 'run_report', 'notice', 'error'])
const ASK_STATUSES = new Set<BotAskStatus>(['open', 'allowed', 'not_now', 'withdrawn'])
const WORK_STATUSES = new Set<BotWorkItem['status']>(['running', 'queued', 'waiting_for_internet', 'paused'])
const ACTION_KINDS = new Set(['sign_in', 'open_providers', 'resume', 'retry'])

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const str = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined)
const author = (value: unknown): 'owner' | 'bot' => (value === 'owner' ? 'owner' : 'bot')
const listOf = <T>(value: unknown, parse: (entry: unknown) => T | undefined): T[] =>
  Array.isArray(value) ? value.map(parse).filter((entry): entry is T => !!entry) : []

export function parseLook(value: unknown): BotLook {
  if (!isObject(value)) return { colour: 'coral', accessory: 'none' }
  return {
    colour: str(value.colour) ?? 'coral',
    accessory: str(value.accessory) ?? 'none',
    ...(str(value.kind) ? { kind: value.kind as string } : {}),
    ...(str(value.eyes) ? { eyes: value.eyes as string } : {}),
  }
}

function botError(value: unknown): BotError | undefined {
  if (!isObject(value) || !str(value.text)) return undefined
  const action = isObject(value.action) && ACTION_KINDS.has(value.action.kind as string) && str(value.action.label)
    ? { kind: value.action.kind as NonNullable<BotError['action']>['kind'], label: value.action.label as string }
    : undefined
  return { text: value.text as string, ...(action ? { action } : {}) }
}

export function parseChip(value: unknown): BotChip | undefined {
  if (!isObject(value) || !str(value.text)) return undefined
  return {
    icon: CHIP_ICONS.has(value.icon as BotChipIcon) ? (value.icon as BotChipIcon) : 'think',
    text: value.text as string,
    ...(str(value.highlight) ? { highlight: value.highlight as string } : {}),
    ...(value.live === true ? { live: true } : {}),
  }
}

function ask(value: unknown): BotAskCard | undefined {
  if (!isObject(value) || !str(value.askId) || !str(value.title)) return undefined
  return {
    askId: value.askId as string,
    title: value.title as string,
    note: typeof value.note === 'string' ? value.note : '',
    status: ASK_STATUSES.has(value.status as BotAskStatus) ? (value.status as BotAskStatus) : 'open',
    ...(value.kind === 'export_memory' || value.kind === 'permission' ? { kind: value.kind } : {}),
  }
}

function quote(value: unknown): BotChatQuote | undefined {
  if (!isObject(value) || !str(value.id)) return undefined
  return { id: value.id as string, author: author(value.author), text: typeof value.text === 'string' ? value.text : '', ...(value.gone === true ? { gone: true } : {}) }
}

export function parseBotMessage(value: unknown): BotChatMessage | undefined {
  if (!isObject(value) || !str(value.id) || typeof value.seq !== 'number') return undefined
  const attachments = listOf(value.attachments, (entry): BotChatFile | undefined => (isObject(entry) && str(entry.name)
    ? { name: entry.name as string, ...(str(entry.mime) ? { mime: entry.mime as string } : {}), ...(entry.image === true ? { image: true as const } : {}) }
    : undefined))
  const asked = ask(value.ask)
  const error = botError(value.error)
  const reply = quote(value.replyTo)
  return {
    seq: value.seq,
    id: value.id as string,
    at: str(value.at) ?? new Date(0).toISOString(),
    author: author(value.author),
    kind: MESSAGE_KINDS.has(value.kind as BotMessageKind) ? (value.kind as BotMessageKind) : 'text',
    text: typeof value.text === 'string' ? value.text : '',
    chips: listOf(value.chips, parseChip),
    ...(asked ? { ask: asked } : {}),
    ...(error ? { error } : {}),
    ...(str(value.activationId) ? { activationId: value.activationId as string } : {}),
    ...(attachments.length ? { attachments } : {}),
    ...(reply ? { replyTo: reply } : {}),
    ...(str(value.clientRequestId) ? { clientRequestId: value.clientRequestId as string } : {}),
  }
}

function work(value: unknown): BotWorkItem | undefined {
  if (!isObject(value) || !str(value.id) || !WORK_STATUSES.has(value.status as BotWorkItem['status'])) return undefined
  return {
    id: value.id as string,
    title: str(value.title) ?? 'Work',
    status: value.status as BotWorkItem['status'],
    startedAt: str(value.startedAt) ?? new Date().toISOString(),
    ...(value.scheduled === true ? { scheduled: true as const } : {}),
  }
}

/** One bot of the lists stream or a `bots.*` answer; undefined when it is not one. */
export function parseBot(value: unknown): ListBot | undefined {
  if (!isObject(value) || !str(value.id)) return undefined
  const error = botError(value.error)
  const last = isObject(value.last) && typeof value.last.text === 'string' && str(value.last.at)
    ? { text: value.last.text, at: value.last.at as string, author: author(value.last.author) }
    : undefined
  const chat = isObject(value.chat) && str(value.chat.activationId)
    ? { activationId: value.chat.activationId as string, ...(value.chat.offline === true ? { offline: true as const } : {}) }
    : undefined
  const workItems = Array.isArray(value.work) ? listOf(value.work, work) : undefined
  const activity = parseChip(value.activity)
  return {
    id: value.id as string,
    name: str(value.name) ?? 'Bot',
    description: typeof value.description === 'string' ? value.description : '',
    look: parseLook(value.look),
    state: BOT_STATES.has(value.state as BotState) ? (value.state as BotState) : 'idle',
    stateText: typeof value.stateText === 'string' ? value.stateText : '',
    ...(value.waiting === 'internet' ? { waiting: 'internet' as const } : {}),
    ...(error ? { error } : {}),
    ...(last ? { last } : {}),
    ...(value.lastOutcome === 'ok' || value.lastOutcome === 'failed' || value.lastOutcome === 'stopped' ? { lastOutcome: value.lastOutcome } : {}),
    unread: typeof value.unread === 'number' && value.unread > 0 ? Math.floor(value.unread) : 0,
    createdAt: str(value.createdAt) ?? new Date(0).toISOString(),
    ...(chat ? { chat } : {}),
    ...(workItems ? { work: workItems } : {}),
    ...(activity ? { activity } : {}),
  }
}

export const parseBots = (value: unknown): ListBot[] => listOf(value, parseBot)

export function parseChatPage(value: unknown): BotChatPage | undefined {
  if (!isObject(value) || !Array.isArray(value.messages)) return undefined
  const live = isObject(value.live) && str(value.live.activationId) ? value.live : undefined
  const chip = live ? parseChip(live.chip) : undefined
  return {
    messages: listOf(value.messages, parseBotMessage).sort((a, b) => a.seq - b.seq),
    ...(live ? { live: { activationId: live.activationId as string, ...(chip ? { chip } : {}) } } : {}),
  }
}

export function parseDetail(value: unknown): BotDetail | undefined {
  if (!isObject(value)) return undefined
  const summary = parseBot(value.summary)
  if (!summary) return undefined
  return {
    summary,
    permissions: listOf(value.permissions, (entry) =>
      isObject(entry) && str(entry.id) && str(entry.title)
        ? { id: entry.id as string, title: entry.title as string, note: typeof entry.note === 'string' ? entry.note : '', grantedAt: str(entry.grantedAt) ?? '' }
        : undefined),
    runs: listOf(value.runs, (entry) =>
      isObject(entry) && str(entry.id) && str(entry.label)
        ? { id: entry.id as string, label: entry.label as string, ...(str(entry.nextAt) ? { nextAt: entry.nextAt as string } : {}), kind: 'schedule' as const }
        : undefined),
    ...(Array.isArray(value.reminders)
      ? {
        reminders: listOf(value.reminders, (entry) =>
          isObject(entry) && str(entry.id) && str(entry.dueAt) && typeof entry.text === 'string'
            ? { id: entry.id as string, dueAt: entry.dueAt as string, text: entry.text, ...(entry.work === true ? { work: true as const } : {}) }
            : undefined),
      }
      : {}),
  }
}

/** `bots.memory.list`: the entries every turn carries (active, with text). */
export function parseMemory(value: unknown): BotMemoryItem[] | undefined {
  if (!isObject(value) || !Array.isArray(value.entries)) return undefined
  return listOf(value.entries, (entry) =>
    isObject(entry) && str(entry.id) && str(entry.text) && (entry.status === undefined || entry.status === 'active')
      ? { id: entry.id as string, text: entry.text as string, kind: str(entry.kind) ?? 'note' }
      : undefined)
}

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
/** The largest image the phone reads, as the computer limits it. */
export const MAX_BOT_IMAGE_BYTES = 1536 * 1024

/** One part of `bots.chat.attachment`: a raster image's type, its size and the bytes from `offset`; undefined for anything else. */
export function parseAttachmentPart(value: unknown): { mime: string; size: number; offset: number; bytes: Uint8Array } | undefined {
  if (!isObject(value)) return undefined
  const mime = str(value.mime)?.toLowerCase()
  const data = typeof value.dataB64 === 'string' ? value.dataB64 : undefined
  const { size, offset } = value
  if (!mime || !IMAGE_TYPES.has(mime) || data === undefined || !/^[A-Za-z0-9+/=]*$/.test(data)) return undefined
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0 || size > MAX_BOT_IMAGE_BYTES) return undefined
  if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0 || offset > size) return undefined
  let bytes: Uint8Array
  try {
    bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0))
  } catch {
    return undefined
  }
  return offset + bytes.length <= size ? { mime, size, offset, bytes } : undefined
}

type Rpc = (method: string, params: Record<string, unknown>, options?: { idem?: string }) => Promise<unknown>

function refusalOf(value: unknown): void {
  if (isObject(value) && value.ok === false) throw new Error(str(value.error) ?? 'The computer refused the request.')
}

/** What a thing a method names is called when the computer says it is gone (`stream_unknown`). */
const GONE: Record<string, string> = {
  'bots.reminders.cancel': 'This reminder is gone.',
  'bots.schedules.remove': 'This schedule is gone.',
  'bots.permissions.revoke': 'This permission is gone.',
  'bots.memory.forget': 'This memory is gone.',
  'bots.asks.answer': 'This ask is gone.',
  'bots.chat.attachment': 'This picture is gone.',
}

/**
 * A computer's refusal in plain words. Its own words stay on the computer: only the code crosses the wire (and a
 * `forbidden` refusal's reason), so the phone says what each code means for the method it called.
 */
export function plainBotError(method: string, error: unknown): unknown {
  const code = (error as { code?: unknown } | undefined)?.code
  const reason = (error as { reason?: unknown } | undefined)?.reason
  if (code === 'forbidden') {
    if (reason === 'setting_off') return new BotsNotSharedError()
    // A memory export ask needs a folder picker on the computer.
    if (method === 'bots.asks.answer') return new Error('Answer this on the computer.')
    // A method a computer does not offer phones is refused with no reason.
    if (reason === undefined) return new BotsUnsupportedError()
    return new Error('This phone may not do this on the computer.')
  }
  if (code === 'stream_unknown') return new Error(GONE[method] ?? 'This bot is gone.')
  if (code === 'conflict') return new Error(method === 'bots.chat.attachment' ? 'This file can’t be shown here.' : 'The computer couldn’t do this now. It may have changed meanwhile.')
  if (code === 'bad_request') return new Error('The computer didn’t accept this request.')
  return error
}

/** `bots.*` over a computer session. */
export class SessionBots implements ComputerBots {
  constructor(private readonly rpc: Rpc) {}

  private async call(method: string, params: Record<string, unknown>, mutating: boolean): Promise<unknown> {
    try {
      const value = await this.rpc(method, params, mutating ? { idem: crypto.randomUUID() } : undefined)
      refusalOf(value)
      return value
    } catch (error) {
      throw plainBotError(method, error)
    }
  }

  async chat(botId: string, page: { beforeSeq?: number; limit?: number } = {}): Promise<BotChatPage> {
    const value = parseChatPage(await this.call('bots.chat.list', { botId, ...page }, false))
    if (!value) throw new Error('The computer sent an unexpected answer to bots.chat.list.')
    return value
  }

  async send(botId: string, text: string, replyTo?: string, clientRequestId: string = crypto.randomUUID()): Promise<BotChatMessage> {
    const content = text.trim()
    if (!content) throw new Error('Write a message first.')
    const value = await this.call('bots.chat.send', { botId, text: content, clientRequestId, ...(replyTo ? { replyTo } : {}) }, true)
    const message = isObject(value) ? parseBotMessage(value.message) : undefined
    if (!message) throw new Error('The computer sent an unexpected answer to bots.chat.send.')
    return message
  }

  async stop(botId: string): Promise<void> {
    await this.call('bots.chat.stop', { botId }, true)
  }

  async stopWork(botId: string, workId: string): Promise<void> {
    await this.call('bots.work.stop', { botId, workId }, true)
  }

  async markRead(botId: string, seq: number): Promise<void> {
    await this.call('bots.chat.markRead', { botId, seq }, true)
  }

  async answer(botId: string, askId: string, answer: 'allow' | 'not_now'): Promise<BotChatMessage> {
    const value = await this.call('bots.asks.answer', { botId, askId, answer }, true)
    const message = isObject(value) ? parseBotMessage(value.message) : undefined
    if (!message) throw new Error('The computer sent an unexpected answer to bots.asks.answer.')
    return message
  }

  async get(botId: string): Promise<BotDetail> {
    const value = parseDetail(await this.call('bots.get', { botId }, false))
    if (!value) throw new Error('The computer sent an unexpected answer to bots.get.')
    return value
  }

  private async summary(method: string, params: Record<string, unknown>): Promise<ListBot> {
    const value = await this.call(method, params, true)
    const bot = isObject(value) ? parseBot(value.bot) : undefined
    if (!bot) throw new Error(`The computer sent an unexpected answer to ${method}.`)
    return bot
  }

  pause(botId: string): Promise<ListBot> {
    return this.summary('bots.personal.pause', { botId })
  }

  resume(botId: string): Promise<ListBot> {
    return this.summary('bots.personal.resume', { botId })
  }

  create(input: { look: BotLook; description: string; name?: string }): Promise<ListBot> {
    const description = input.description.trim()
    if (!description) return Promise.reject(new Error('Say what the bot should do.'))
    return this.summary('bots.create', { look: input.look, description, ...(input.name?.trim() ? { name: input.name.trim() } : {}), clientRequestId: crypto.randomUUID() })
  }

  async cancelReminder(botId: string, reminderId: string): Promise<BotDetail> {
    const value = parseDetail(await this.call('bots.reminders.cancel', { botId, reminderId }, true))
    if (!value) throw new Error('The computer sent an unexpected answer to bots.reminders.cancel.')
    return value
  }

  async memory(botId: string): Promise<BotMemoryItem[]> {
    const value = parseMemory(await this.call('bots.memory.list', { botId }, false))
    if (!value) throw new Error('The computer sent an unexpected answer to bots.memory.list.')
    return value
  }

  async forgetMemory(botId: string, id: string): Promise<void> {
    await this.call('bots.memory.forget', { botId, id }, true)
  }

  async attachment(botId: string, messageId: string, index: number): Promise<BotAttachmentImage> {
    // Read in parts that each fit one reply, from the start to the size the first part names.
    const parts: Uint8Array[] = []
    let offset = 0
    let total: number | undefined
    let mime: string | undefined
    for (let reads = 0; reads < 64; reads += 1) {
      const part = parseAttachmentPart(await this.call('bots.chat.attachment', { botId, messageId, index, ...(offset ? { offset } : {}) }, false))
      if (!part || part.offset !== offset || (total !== undefined && (part.size !== total || part.mime !== mime))) throw new Error('This file can’t be shown here.')
      total = part.size
      mime = part.mime
      parts.push(part.bytes)
      offset += part.bytes.length
      if (offset >= total) {
        const bytes = new Uint8Array(total)
        let at = 0
        for (const chunk of parts) { bytes.set(chunk, at); at += chunk.length }
        return { mimeType: mime, bytes }
      }
      if (!part.bytes.length) break
    }
    throw new Error('This file can’t be shown here.')
  }

  async removeSchedule(botId: string, scheduleId: string): Promise<BotDetail> {
    const value = parseDetail(await this.call('bots.schedules.remove', { botId, scheduleId }, true))
    if (!value) throw new Error('The computer sent an unexpected answer to bots.schedules.remove.')
    return value
  }

  async revokePermission(botId: string, permissionId: string): Promise<BotDetail> {
    const value = parseDetail(await this.call('bots.permissions.revoke', { botId, permissionId }, true))
    if (!value) throw new Error('The computer sent an unexpected answer to bots.permissions.revoke.')
    return value
  }
}
