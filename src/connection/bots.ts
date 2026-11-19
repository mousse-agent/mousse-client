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
  eyeColour?: string
}

export interface BotError {
  text: string
  action?: { kind: 'sign_in' | 'open_providers' | 'resume' | 'retry' | 'pick_model'; label: string }
}

export interface BotChip {
  icon: BotChipIcon
  text: string
  highlight?: string
  live?: boolean
  /** A thread the call started, messaged or stopped: the step offers Open. */
  thread?: string
  /** The first line of what the bot sent to that thread. */
  said?: string
  /** Extra detail for the step. */
  title?: string
}

export type BotAskStatus = 'open' | 'allowed' | 'not_now' | 'withdrawn'

export interface BotAskCard {
  askId: string
  title: string
  note: string
  tip?: string
  status: BotAskStatus
  kind?: 'permission' | 'export_memory'
  carriesOn?: true
  carried?: number
  idle?: true
  details?: { summary: string; items: string[]; more?: string }
  loading?: true
}

export type BotActionStatus = 'open' | 'approved' | 'running' | 'done' | 'failed' | 'uncertain' | 'declined' | 'expired' | 'withdrawn'

/** Mousse's review of a held tool call, from its stored masked copy. */
export interface BotActionCard {
  actionId: string
  askedAt?: string
  digest: string
  title: string
  serverName: string
  args: unknown
  hasHiddenValues: boolean
  hiddenPaths: string[][]
  status: BotActionStatus
  at?: string
  result?: { text?: string; toolReportedError?: boolean; notSentInTime?: boolean }
  previous?: { status: 'done' | 'uncertain' | 'failed'; at: string }
  tooLarge?: boolean
  forgotten?: true
}

/** Application refusal codes for `bots.actions.answer` (mousse/src/shared/bots/personal/actionRefusal.ts). */
export const BOT_ACTION_REFUSAL_CODES = [
  'bot_action_work_ended', 'bot_action_owner_paused', 'bot_action_permission_changed', 'bot_action_disabled', 'bot_action_owner_removed', 'bot_action_binding_changed',
  'bot_action_schedule_changed', 'bot_action_expired', 'bot_action_withdrawn', 'bot_action_changed', 'bot_action_settled',
  'bot_action_gone', 'bot_action_paused', 'bot_action_unreachable', 'bot_action_too_large',
] as const
export type BotActionRefusalCode = (typeof BOT_ACTION_REFUSAL_CODES)[number]
export const isBotActionRefusalCode = (code: unknown): code is BotActionRefusalCode =>
  typeof code === 'string' && (BOT_ACTION_REFUSAL_CODES as readonly string[]).includes(code)

export interface BotActionRefusal {
  reason: string
  text: string
}

export function botActionRefusalText(code: BotActionRefusalCode, names: { botName?: string; serverName?: string } = {}): string {
  switch (code) {
    case 'bot_action_work_ended': return 'This work ended. Nothing was sent.'
    case 'bot_action_owner_paused': return 'This bot was paused, so nothing was sent.'
    case 'bot_action_permission_changed': return 'This tool or its permission changed, so nothing was sent.'
    case 'bot_action_disabled': return 'Withdrawn when asks first was turned off. Nothing was sent.'
    case 'bot_action_owner_removed': return 'You removed this request, so nothing was sent.'
    case 'bot_action_binding_changed': return 'This changed since you saw it. Nothing was sent.'
    case 'bot_action_schedule_changed': return 'This changed since you saw it. Nothing was sent.'
    case 'bot_action_expired': return 'This expired, so nothing was sent.'
    case 'bot_action_withdrawn': return 'No longer needed, so nothing was sent.'
    case 'bot_action_changed': return 'This changed since you saw it. Check it again before sending.'
    case 'bot_action_settled': return 'This was already answered.'
    case 'bot_action_gone': return "This can't be sent any more."
    case 'bot_action_paused': return `Resume ${names.botName || 'this bot'} to send this.`
    case 'bot_action_unreachable': return `${names.serverName || 'The service'} couldn't be reached. Nothing was sent. Try again when it is available.`
    case 'bot_action_too_large': return 'Open it on the computer to send.'
  }
}

export function botActionRefusal(error: unknown, names: { botName?: string; serverName?: string } = {}): BotActionRefusal | undefined {
  const value = error as { code?: unknown; reason?: unknown; details?: { reason?: unknown } } | null | undefined
  const raw = isBotActionRefusalCode(value?.code)
    ? value.code
    : value?.code === 'conflict'
      ? (value.reason ?? value.details?.reason)
      : undefined
  if (isBotActionRefusalCode(raw)) return { reason: raw, text: botActionRefusalText(raw, names) }
  if (value?.code === 'conflict') return { reason: 'conflict', text: 'This could not be sent from here. Open it on the computer to see what happened.' }
  return undefined
}

export type BotQuestionStatus = 'open' | 'answered' | 'defaulted' | 'moved_on' | 'withdrawn'

export interface BotQuestionChoice {
  label: string
  detail?: string
}

export interface BotChatQuestion {
  questionId: string
  choices: BotQuestionChoice[]
  other: boolean
  status: BotQuestionStatus
  answer?: string
  answeredWith?: 'choice' | 'text'
  by?: 'chat' | 'default'
  waits?: true
  default?: string
  defaultAt?: string
  late?: string
  nudge?: true
  nudged?: true
}

export type BotSnoozeChoice = '10m' | '1h' | 'tomorrow'

export interface BotMessageReminder {
  expiresAt?: string
  snoozedUntil?: string
}

export type BotChecklistState = 'done' | 'doing' | 'todo' | 'skipped'

export interface BotFactsCard {
  type: 'facts'
  title?: string
  rows: Array<{ label: string; value: string }>
}

export interface BotChecklistCard {
  type: 'checklist'
  title?: string
  items: Array<{ text: string; state: BotChecklistState }>
}

export interface BotProgressCard {
  type: 'progress'
  label: string
  done: number
  total: number
  note?: string
}

export interface BotRemoteGalleryCard {
  type: 'gallery'
  title?: string
  files: Array<{ name: string; caption?: string; index?: number }>
}

export interface BotAutomationCard {
  type: 'automation'
  jobId: string
  name: string
  label: string
}

export interface BotWatcherCard {
  type: 'watcher'
  watcherId: string
  title: string
  command: string
}

export type RemoteBotCard =
  | BotFactsCard
  | BotChecklistCard
  | BotProgressCard
  | BotRemoteGalleryCard
  | BotAutomationCard
  | BotWatcherCard

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
  systemLine?: true
  systemTitle?: string
  text: string
  chips: BotChip[]
  ask?: BotAskCard
  action?: BotActionCard
  expiredActionSchedule?: string
  actionSentAt?: string
  reminder?: BotMessageReminder
  question?: BotChatQuestion
  answers?: { questionId: string; tapped: boolean }
  cards?: RemoteBotCard[]
  plainFrom?: number
  reaction?: string
  error?: BotError
  activationId?: string
  /** A file's name and type; `image` when `attachment` can read it (a computer from before images sends the name only). */
  attachments?: BotChatFile[]
  replyTo?: BotChatQuote
  /** The owner's message: the request id it was sent with, which matches it to the bubble shown while it was on its way. */
  clientRequestId?: string
}

export type BotWakeEvent =
  | { kind: 'thread'; threadId: string; title?: string }
  | { kind: 'pr'; repo: string; number: number; on?: 'merged' | 'checks' | 'review' }
  | { kind: 'watcher'; title: string; command: string; match?: string; minutes: number }

export interface BotWorkItem {
  id: string
  title: string
  status: 'running' | 'queued' | 'waiting_for_internet' | 'paused'
  wait?: { dueAt: string; event: BotWakeEvent | null }
  waitsFor?: 'answer'
  detail?: string
  startedAt: string
  scheduled?: true
  model?: { name: string; detail: string }
  subagents?: Array<{ title: string; model: string; lacks?: string[] }>
}

export type BotLaunchedThreadStatus = 'running' | 'queued' | 'paused' | 'subagents' | 'needs_input' | 'on_hold' | 'idle' | 'done' | 'failed' | 'stopped'

export interface BotLaunchedThread {
  threadId: string
  title: string
  project?: string
  status: BotLaunchedThreadStatus
  startedAt: string
  updatedAt: string
  hidden?: true
}

export interface BotWatcherItem {
  id: string
  title: string
  command: string
  startedAt: string
  until: string
  lastLine?: string
}

export type BotTaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'blocked' | 'skipped' | 'cancelled'

export interface BotTaskItem {
  id: string
  text: string
  status: BotTaskStatus
  note?: string
}

/** One bot as the Bots section lists it. */
export interface ListBot {
  id: string
  name: string
  description: string
  promptEdited?: true
  look: BotLook
  state: BotState
  needsOwner?: true
  stateText: string
  waiting?: 'internet'
  error?: BotError
  last?: { text: string; at: string; author: 'owner' | 'bot' }
  lastReply?: string
  lastOutcome?: 'ok' | 'failed' | 'stopped'
  unread: number
  createdAt: string
  homeThreadId?: string
  /** The chat turn that runs now; absent while the chat is free. */
  chat?: { activationId: string; offline?: true }
  work?: BotWorkItem[]
  threads?: BotLaunchedThread[]
  watchers?: BotWatcherItem[]
  tasks?: BotTaskItem[]
  /** What the chat turn is doing right now. */
  activity?: BotChip
}

export interface BotChatPage {
  messages: BotChatMessage[]
  live?: { activationId: string; chip?: BotChip }
}

export interface BotPermissionItem {
  id: string
  title: string
  note: string
  grantedAt: string
  asksFirst?: true
  enabled?: boolean
  needsFullAccess?: true
  builtIn?: true
  under?: string
  gone?: true
  mark?: string
}

export interface BotRunItem {
  id: string
  label: string
  nextAt?: string
  kind: 'schedule'
  jobId?: string
  paused?: true
  name?: string
  does?: string
  lastAt?: string
  lastOutcome?: 'ok' | 'failed' | 'stopped'
}

/** One waiting reminder (one-off, not yet said). `work`: it starts work at its time rather than only saying `text`. */
export interface BotReminderItem {
  id: string
  dueAt: string
  text: string
  work?: true
  ownerSet?: boolean | null
  wake?: string
}

export interface BotTurnUsageSummary {
  turns: number
  inputPerTurn: number
  outputPerTurn: number
  cachedShare: number
}

export interface BotContextSummary {
  used?: number
  window?: number
  model?: string
  turn: { cacheRead: number; cacheWrite: number; fresh: number }
  lastRequestAt: number
  cacheTtlMs?: number
}

/** `reminders`, `usage`, and `context` are absent from computers that don't send them. */
export interface BotDetail {
  summary: ListBot
  permissions: BotPermissionItem[]
  runs: BotRunItem[]
  reminders?: BotReminderItem[]
  usage?: BotTurnUsageSummary
  context?: BotContextSummary
}

/** One thing the bot remembers, as Memory lists it (`bots.memory.list`, active entries with text only). */
export interface BotMemoryItem {
  id: string
  text: string
  kind: string
  ref?: string
  version?: number
  learnedAt?: string
  since?: string
  until?: string
  by?: 'you said' | 'a run' | 'cleanup'
}

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
  answerAction?(botId: string, actionId: string, digest: string, answer: 'send' | 'not_now', names?: { botName?: string; serverName?: string }): Promise<BotActionRefusal | null>
  answerQuestion?(botId: string, questionId: string, choice: string, clientRequestId?: string): Promise<{ message: BotChatMessage; question?: BotChatMessage }>
  snoozeReminder?(botId: string, messageId: string, choice: BotSnoozeChoice): Promise<BotChatMessage>
  get(botId: string): Promise<BotDetail>
  pause(botId: string): Promise<ListBot>
  resume(botId: string): Promise<ListBot>
  create(input: { look: BotLook; description: string; name?: string }): Promise<ListBot>
  update?(botId: string, change: { name?: string; look?: BotLook }): Promise<ListBot>
  /** Cancels a waiting reminder; it never fires. */
  cancelReminder(botId: string, reminderId: string): Promise<BotDetail>
  /** What the bot remembers. */
  memory(botId: string): Promise<BotMemoryItem[]>
  forgetMemory(botId: string, id: string): Promise<void>
  editMemory?(botId: string, id: string, text: string): Promise<BotMemoryItem | undefined>
  /** The image at `index` of message `messageId`'s files. */
  attachment(botId: string, messageId: string, index: number): Promise<BotAttachmentImage>
  /** About → Automations → Remove. */
  removeSchedule(botId: string, scheduleId: string): Promise<BotDetail>
  /** About → Can use → Switch on/off. */
  setPermission?(botId: string, permissionId: string, enabled: boolean): Promise<BotDetail>
  /** About → Can use → Remove. */
  revokePermission(botId: string, permissionId: string): Promise<BotDetail>
}

const BOT_STATES = new Set<BotState>(['idle', 'working', 'needs_you', 'stuck', 'paused'])
const CHIP_ICONS = new Set<BotChipIcon>(['search', 'web', 'read', 'edit', 'schedule', 'memory', 'ask', 'think', 'name', 'warning'])
const MESSAGE_KINDS = new Set<BotMessageKind>(['text', 'run_report', 'notice', 'error'])
const ASK_STATUSES = new Set<BotAskStatus>(['open', 'allowed', 'not_now', 'withdrawn'])
const ACTION_STATUSES = new Set<BotActionStatus>(['open', 'approved', 'running', 'done', 'failed', 'uncertain', 'declined', 'expired', 'withdrawn'])
const QUESTION_STATUSES = new Set<BotQuestionStatus>(['open', 'answered', 'defaulted', 'moved_on', 'withdrawn'])
const CHECKLIST_STATES = new Set<BotChecklistState>(['done', 'doing', 'todo', 'skipped'])
const WORK_STATUSES = new Set<BotWorkItem['status']>(['running', 'queued', 'waiting_for_internet', 'paused'])
const LAUNCHED_STATUSES = new Set<BotLaunchedThreadStatus>(['running', 'queued', 'paused', 'subagents', 'needs_input', 'on_hold', 'idle', 'done', 'failed', 'stopped'])
const TASK_STATUSES = new Set<BotTaskStatus>(['pending', 'in_progress', 'completed', 'failed', 'blocked', 'skipped', 'cancelled'])
const ACTION_KINDS = new Set(['sign_in', 'open_providers', 'resume', 'retry', 'pick_model'])

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
    ...(str(value.eyeColour) ? { eyeColour: value.eyeColour as string } : {}),
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
    ...(str(value.thread) ? { thread: value.thread as string } : {}),
    ...(str(value.said) ? { said: value.said as string } : {}),
    ...(str(value.title) ? { title: value.title as string } : {}),
  }
}

function ask(value: unknown): BotAskCard | undefined {
  if (!isObject(value) || !str(value.askId) || !str(value.title)) return undefined
  const details = isObject(value.details) && str(value.details.summary) && Array.isArray(value.details.items)
    ? {
      summary: value.details.summary as string,
      items: value.details.items.filter((item): item is string => typeof item === 'string'),
      ...(str(value.details.more) ? { more: value.details.more as string } : {}),
    }
    : undefined
  return {
    askId: value.askId as string,
    title: value.title as string,
    note: typeof value.note === 'string' ? value.note : '',
    ...(str(value.tip) ? { tip: value.tip as string } : {}),
    status: ASK_STATUSES.has(value.status as BotAskStatus) ? (value.status as BotAskStatus) : 'open',
    ...(value.kind === 'export_memory' || value.kind === 'permission' ? { kind: value.kind } : {}),
    ...(value.carriesOn === true ? { carriesOn: true as const } : {}),
    ...(typeof value.carried === 'number' ? { carried: value.carried } : {}),
    ...(value.idle === true ? { idle: true as const } : {}),
    ...(details ? { details } : {}),
    ...(value.loading === true ? { loading: true as const } : {}),
  }
}

function parseActionCard(value: unknown): BotActionCard | undefined {
  if (!isObject(value) || !str(value.actionId) || !str(value.digest) || typeof value.title !== 'string') return undefined
  const hiddenPaths = Array.isArray(value.hiddenPaths)
    ? value.hiddenPaths.filter((path): path is string[] => Array.isArray(path) && path.every((part) => typeof part === 'string'))
    : []
  const result = isObject(value.result)
    ? {
      ...(typeof value.result.text === 'string' ? { text: value.result.text } : {}),
      ...(value.result.toolReportedError === true ? { toolReportedError: true } : {}),
      ...(value.result.notSentInTime === true ? { notSentInTime: true } : {}),
    }
    : undefined
  const previous = isObject(value.previous) && (value.previous.status === 'done' || value.previous.status === 'uncertain' || value.previous.status === 'failed') && str(value.previous.at)
    ? { status: value.previous.status as 'done' | 'uncertain' | 'failed', at: value.previous.at as string }
    : undefined
  return {
    actionId: value.actionId as string,
    ...(str(value.askedAt) ? { askedAt: value.askedAt as string } : {}),
    digest: value.digest as string,
    title: value.title,
    serverName: typeof value.serverName === 'string' ? value.serverName : '',
    args: value.args,
    hasHiddenValues: value.hasHiddenValues === true,
    hiddenPaths,
    status: ACTION_STATUSES.has(value.status as BotActionStatus) ? (value.status as BotActionStatus) : 'open',
    ...(str(value.at) ? { at: value.at as string } : {}),
    ...(result ? { result } : {}),
    ...(previous ? { previous } : {}),
    ...(value.tooLarge === true ? { tooLarge: true } : {}),
    ...(value.forgotten === true ? { forgotten: true as const } : {}),
  }
}

function parseQuestion(value: unknown): BotChatQuestion | undefined {
  if (!isObject(value) || !str(value.questionId) || !Array.isArray(value.choices)) return undefined
  const choices = listOf(value.choices, (entry): BotQuestionChoice | undefined =>
    isObject(entry) && str(entry.label)
      ? { label: entry.label as string, ...(str(entry.detail) ? { detail: entry.detail as string } : {}) }
      : undefined)
  if (!choices.length) return undefined
  return {
    questionId: value.questionId as string,
    choices,
    other: value.other === true,
    status: QUESTION_STATUSES.has(value.status as BotQuestionStatus) ? (value.status as BotQuestionStatus) : 'open',
    ...(str(value.answer) ? { answer: value.answer as string } : {}),
    ...(value.answeredWith === 'choice' || value.answeredWith === 'text' ? { answeredWith: value.answeredWith } : {}),
    ...(value.by === 'chat' || value.by === 'default' ? { by: value.by } : {}),
    ...(value.waits === true ? { waits: true as const } : {}),
    ...(str(value.default) ? { default: value.default as string } : {}),
    ...(str(value.defaultAt) ? { defaultAt: value.defaultAt as string } : {}),
    ...(str(value.late) ? { late: value.late as string } : {}),
    ...(value.nudge === true ? { nudge: true as const } : {}),
    ...(value.nudged === true ? { nudged: true as const } : {}),
  }
}

function parseCard(value: unknown): RemoteBotCard | undefined {
  if (!isObject(value) || typeof value.type !== 'string') return undefined
  const title = str(value.title)
  if (value.type === 'facts' && Array.isArray(value.rows)) {
    const rows = listOf(value.rows, (row) =>
      isObject(row) && typeof row.label === 'string' && typeof row.value === 'string' ? { label: row.label, value: row.value } : undefined)
    return rows.length ? { type: 'facts', ...(title ? { title } : {}), rows } : undefined
  }
  if (value.type === 'checklist' && Array.isArray(value.items)) {
    const items = listOf(value.items, (item) =>
      isObject(item) && typeof item.text === 'string' && CHECKLIST_STATES.has(item.state as BotChecklistState)
        ? { text: item.text, state: item.state as BotChecklistState }
        : undefined)
    return items.length ? { type: 'checklist', ...(title ? { title } : {}), items } : undefined
  }
  if (value.type === 'progress' && str(value.label) && typeof value.done === 'number' && typeof value.total === 'number') {
    return { type: 'progress', label: value.label as string, done: value.done, total: value.total, ...(str(value.note) ? { note: value.note as string } : {}) }
  }
  if (value.type === 'gallery' && Array.isArray(value.files)) {
    const files = listOf(value.files, (file) =>
      isObject(file) && str(file.name)
        ? {
          name: file.name as string,
          ...(str(file.caption) ? { caption: file.caption as string } : {}),
          ...(typeof file.index === 'number' && Number.isSafeInteger(file.index) && file.index >= 0 ? { index: file.index } : {}),
        }
        : undefined)
    return files.length ? { type: 'gallery', ...(title ? { title } : {}), files } : undefined
  }
  if (value.type === 'automation' && str(value.jobId) && str(value.name) && typeof value.label === 'string') {
    return { type: 'automation', jobId: value.jobId as string, name: value.name as string, label: value.label }
  }
  if (value.type === 'watcher' && str(value.watcherId) && str(value.title) && typeof value.command === 'string') {
    return { type: 'watcher', watcherId: value.watcherId as string, title: value.title as string, command: value.command }
  }
  return undefined
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
  const action = parseActionCard(value.action)
  const question = parseQuestion(value.question)
  const cards = listOf(value.cards, parseCard)
  const error = botError(value.error)
  const reply = quote(value.replyTo)
  const reminder = isObject(value.reminder)
    ? { ...(str(value.reminder.expiresAt) ? { expiresAt: value.reminder.expiresAt as string } : {}), ...(str(value.reminder.snoozedUntil) ? { snoozedUntil: value.reminder.snoozedUntil as string } : {}) }
    : undefined
  const answers = isObject(value.answers) && str(value.answers.questionId)
    ? { questionId: value.answers.questionId as string, tapped: value.answers.tapped === true }
    : undefined
  return {
    seq: value.seq,
    id: value.id as string,
    at: str(value.at) ?? new Date(0).toISOString(),
    author: author(value.author),
    kind: MESSAGE_KINDS.has(value.kind as BotMessageKind) ? (value.kind as BotMessageKind) : 'text',
    ...(value.systemLine === true ? { systemLine: true as const } : {}),
    ...(str(value.systemTitle) ? { systemTitle: value.systemTitle as string } : {}),
    text: typeof value.text === 'string' ? value.text : '',
    chips: listOf(value.chips, parseChip),
    ...(asked ? { ask: asked } : {}),
    ...(action ? { action } : {}),
    ...(str(value.expiredActionSchedule) ? { expiredActionSchedule: value.expiredActionSchedule as string } : {}),
    ...(str(value.actionSentAt) ? { actionSentAt: value.actionSentAt as string } : {}),
    ...(reminder ? { reminder } : {}),
    ...(question ? { question } : {}),
    ...(answers ? { answers } : {}),
    ...(cards.length ? { cards } : {}),
    ...(typeof value.plainFrom === 'number' && Number.isSafeInteger(value.plainFrom) && value.plainFrom >= 0 ? { plainFrom: value.plainFrom } : {}),
    ...(str(value.reaction) ? { reaction: value.reaction as string } : {}),
    ...(error ? { error } : {}),
    ...(str(value.activationId) ? { activationId: value.activationId as string } : {}),
    ...(attachments.length ? { attachments } : {}),
    ...(reply ? { replyTo: reply } : {}),
    ...(str(value.clientRequestId) ? { clientRequestId: value.clientRequestId as string } : {}),
  }
}

function parseWakeEvent(value: unknown): BotWakeEvent | null {
  if (!isObject(value)) return null
  if (value.kind === 'thread' && str(value.threadId)) return { kind: 'thread', threadId: value.threadId as string, ...(str(value.title) ? { title: value.title as string } : {}) }
  if (value.kind === 'pr' && str(value.repo) && typeof value.number === 'number') {
    const on = value.on === 'merged' || value.on === 'checks' || value.on === 'review' ? value.on : undefined
    return { kind: 'pr', repo: value.repo as string, number: value.number, ...(on ? { on } : {}) }
  }
  if (value.kind === 'watcher' && str(value.title) && typeof value.command === 'string' && typeof value.minutes === 'number') {
    return { kind: 'watcher', title: value.title as string, command: value.command, ...(str(value.match) ? { match: value.match as string } : {}), minutes: value.minutes }
  }
  return null
}

function work(value: unknown): BotWorkItem | undefined {
  if (!isObject(value) || !str(value.id) || !WORK_STATUSES.has(value.status as BotWorkItem['status'])) return undefined
  const wait = isObject(value.wait) && str(value.wait.dueAt) ? { dueAt: value.wait.dueAt as string, event: parseWakeEvent(value.wait.event) } : undefined
  const model = isObject(value.model) && str(value.model.name) ? { name: value.model.name as string, detail: typeof value.model.detail === 'string' ? value.model.detail : '' } : undefined
  const subagents = Array.isArray(value.subagents)
    ? listOf(value.subagents, (entry) => isObject(entry) && str(entry.title) && str(entry.model)
      ? {
        title: entry.title as string,
        model: entry.model as string,
        ...(Array.isArray(entry.lacks) ? { lacks: entry.lacks.filter((item): item is string => typeof item === 'string') } : {}),
      }
      : undefined)
    : undefined
  return {
    id: value.id as string,
    title: str(value.title) ?? 'Work',
    status: value.status as BotWorkItem['status'],
    ...(wait ? { wait } : {}),
    ...(value.waitsFor === 'answer' ? { waitsFor: 'answer' as const } : {}),
    ...(str(value.detail) ? { detail: value.detail as string } : {}),
    startedAt: str(value.startedAt) ?? new Date().toISOString(),
    ...(value.scheduled === true ? { scheduled: true as const } : {}),
    ...(model ? { model } : {}),
    ...(subagents?.length ? { subagents } : {}),
  }
}

function parseLaunchedThread(value: unknown): BotLaunchedThread | undefined {
  if (!isObject(value) || !str(value.threadId) || !LAUNCHED_STATUSES.has(value.status as BotLaunchedThreadStatus)) return undefined
  return {
    threadId: value.threadId as string,
    title: str(value.title) ?? 'Untitled thread',
    ...(str(value.project) ? { project: value.project as string } : {}),
    status: value.status as BotLaunchedThreadStatus,
    startedAt: str(value.startedAt) ?? new Date(0).toISOString(),
    updatedAt: str(value.updatedAt) ?? str(value.startedAt) ?? new Date(0).toISOString(),
    ...(value.hidden === true ? { hidden: true as const } : {}),
  }
}

function parseWatcher(value: unknown): BotWatcherItem | undefined {
  if (!isObject(value) || !str(value.id) || !str(value.title)) return undefined
  return {
    id: value.id as string,
    title: value.title as string,
    command: typeof value.command === 'string' ? value.command : '',
    startedAt: str(value.startedAt) ?? new Date().toISOString(),
    until: str(value.until) ?? '',
    ...(str(value.lastLine) ? { lastLine: value.lastLine as string } : {}),
  }
}

function parseTask(value: unknown): BotTaskItem | undefined {
  if (!isObject(value) || !str(value.id) || !str(value.text)) return undefined
  return {
    id: value.id as string,
    text: value.text as string,
    status: TASK_STATUSES.has(value.status as BotTaskStatus) ? (value.status as BotTaskStatus) : 'pending',
    ...(str(value.note) ? { note: value.note as string } : {}),
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
  const threads = Array.isArray(value.threads) ? listOf(value.threads, parseLaunchedThread) : undefined
  const watchers = Array.isArray(value.watchers) ? listOf(value.watchers, parseWatcher) : undefined
  const tasks = Array.isArray(value.tasks) ? listOf(value.tasks, parseTask) : undefined
  const activity = parseChip(value.activity)
  return {
    id: value.id as string,
    name: str(value.name) ?? 'Bot',
    description: typeof value.description === 'string' ? value.description : '',
    ...(value.promptEdited === true ? { promptEdited: true as const } : {}),
    look: parseLook(value.look),
    state: BOT_STATES.has(value.state as BotState) ? (value.state as BotState) : 'idle',
    ...(value.needsOwner === true ? { needsOwner: true as const } : {}),
    stateText: typeof value.stateText === 'string' ? value.stateText : '',
    ...(value.waiting === 'internet' ? { waiting: 'internet' as const } : {}),
    ...(error ? { error } : {}),
    ...(last ? { last } : {}),
    ...(str(value.lastReply) ? { lastReply: value.lastReply as string } : {}),
    ...(value.lastOutcome === 'ok' || value.lastOutcome === 'failed' || value.lastOutcome === 'stopped' ? { lastOutcome: value.lastOutcome } : {}),
    unread: typeof value.unread === 'number' && value.unread > 0 ? Math.floor(value.unread) : 0,
    createdAt: str(value.createdAt) ?? new Date(0).toISOString(),
    ...(str(value.homeThreadId) ? { homeThreadId: value.homeThreadId as string } : {}),
    ...(chat ? { chat } : {}),
    ...(workItems ? { work: workItems } : {}),
    ...(threads ? { threads } : {}),
    ...(watchers ? { watchers } : {}),
    ...(tasks ? { tasks } : {}),
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

function parseUsage(value: unknown): BotTurnUsageSummary | undefined {
  if (!isObject(value)) return undefined
  const { turns, inputPerTurn, outputPerTurn, cachedShare } = value
  if (typeof turns !== 'number' || typeof inputPerTurn !== 'number' || typeof outputPerTurn !== 'number' || typeof cachedShare !== 'number') return undefined
  return { turns, inputPerTurn, outputPerTurn, cachedShare }
}

function parseContext(value: unknown): BotContextSummary | undefined {
  if (!isObject(value) || !isObject(value.turn) || typeof value.lastRequestAt !== 'number') return undefined
  const { cacheRead, cacheWrite, fresh } = value.turn
  if (typeof cacheRead !== 'number' || typeof cacheWrite !== 'number' || typeof fresh !== 'number') return undefined
  return {
    ...(typeof value.used === 'number' ? { used: value.used } : {}),
    ...(typeof value.window === 'number' ? { window: value.window } : {}),
    ...(str(value.model) ? { model: value.model as string } : {}),
    turn: { cacheRead, cacheWrite, fresh },
    lastRequestAt: value.lastRequestAt,
    ...(typeof value.cacheTtlMs === 'number' ? { cacheTtlMs: value.cacheTtlMs } : {}),
  }
}

export function parseDetail(value: unknown): BotDetail | undefined {
  if (!isObject(value)) return undefined
  const summary = parseBot(value.summary)
  if (!summary) return undefined
  const usage = parseUsage(value.usage)
  const context = parseContext(value.context)
  return {
    summary,
    permissions: listOf(value.permissions, (entry): BotPermissionItem | undefined =>
      isObject(entry) && str(entry.id) && str(entry.title)
        ? {
          id: entry.id as string,
          title: entry.title as string,
          note: typeof entry.note === 'string' ? entry.note : '',
          grantedAt: str(entry.grantedAt) ?? '',
          ...(entry.asksFirst === true ? { asksFirst: true as const } : {}),
          ...(typeof entry.enabled === 'boolean' ? { enabled: entry.enabled } : {}),
          ...(entry.needsFullAccess === true ? { needsFullAccess: true as const } : {}),
          ...(entry.builtIn === true ? { builtIn: true as const } : {}),
          ...(str(entry.under) ? { under: entry.under as string } : {}),
          ...(entry.gone === true ? { gone: true as const } : {}),
          ...(str(entry.mark) ? { mark: entry.mark as string } : {}),
        }
        : undefined),
    runs: listOf(value.runs, (entry): BotRunItem | undefined =>
      isObject(entry) && str(entry.id) && str(entry.label)
        ? {
          id: entry.id as string,
          label: entry.label as string,
          ...(str(entry.nextAt) ? { nextAt: entry.nextAt as string } : {}),
          kind: 'schedule' as const,
          ...(str(entry.jobId) ? { jobId: entry.jobId as string } : {}),
          ...(entry.paused === true ? { paused: true as const } : {}),
          ...(str(entry.name) ? { name: entry.name as string } : {}),
          ...(str(entry.does) ? { does: entry.does as string } : {}),
          ...(str(entry.lastAt) ? { lastAt: entry.lastAt as string } : {}),
          ...(entry.lastOutcome === 'ok' || entry.lastOutcome === 'failed' || entry.lastOutcome === 'stopped' ? { lastOutcome: entry.lastOutcome } : {}),
        }
        : undefined),
    ...(Array.isArray(value.reminders)
      ? {
        reminders: listOf(value.reminders, (entry): BotReminderItem | undefined =>
          isObject(entry) && str(entry.id) && str(entry.dueAt) && typeof entry.text === 'string'
            ? {
              id: entry.id as string,
              dueAt: entry.dueAt as string,
              text: entry.text,
              ...(entry.work === true ? { work: true as const } : {}),
              ...(typeof entry.ownerSet === 'boolean' || entry.ownerSet === null ? { ownerSet: entry.ownerSet } : {}),
              ...(typeof entry.wake === 'string' ? { wake: entry.wake } : {}),
            }
            : undefined),
      }
      : {}),
    ...(usage ? { usage } : {}),
    ...(context ? { context } : {}),
  }
}

export function parseMemoryEntry(entry: unknown): BotMemoryItem | undefined {
  if (!isObject(entry) || !str(entry.id) || !str(entry.text)) return undefined
  if (entry.status !== undefined && entry.status !== 'active') return undefined
  const by = entry.by === 'you said' || entry.by === 'a run' || entry.by === 'cleanup' ? entry.by : undefined
  return {
    id: entry.id as string,
    text: entry.text as string,
    kind: str(entry.kind) ?? 'note',
    ...(str(entry.ref) ? { ref: entry.ref as string } : {}),
    ...(typeof entry.version === 'number' ? { version: entry.version } : {}),
    ...(str(entry.learnedAt) ? { learnedAt: entry.learnedAt as string } : {}),
    ...(str(entry.since) ? { since: entry.since as string } : {}),
    ...(str(entry.until) ? { until: entry.until as string } : {}),
    ...(by ? { by } : {}),
  }
}

/** `bots.memory.list`: the entries every turn carries (active, with text). */
export function parseMemory(value: unknown): BotMemoryItem[] | undefined {
  if (!isObject(value) || !Array.isArray(value.entries)) return undefined
  return listOf(value.entries, parseMemoryEntry)
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
  'bots.reminders.snooze': 'This reminder is gone.',
  'bots.schedules.remove': 'This schedule is gone.',
  'bots.permissions.set': 'This permission is gone.',
  'bots.permissions.revoke': 'This permission is gone.',
  'bots.memory.forget': 'This memory is gone.',
  'bots.memory.edit': 'This memory is gone.',
  'bots.asks.answer': 'This ask is gone.',
  'bots.questions.answer': 'This question is gone.',
  'bots.actions.answer': 'This action is gone.',
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
    // A memory export ask or "use your threads" without Full access needs the computer.
    if (method === 'bots.asks.answer') return new Error('Answer this on the computer.')
    if (method === 'bots.permissions.set') return new Error('Allow this on the computer.')
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

  async answerAction(
    botId: string,
    actionId: string,
    digest: string,
    answer: 'send' | 'not_now',
    names: { botName?: string; serverName?: string } = {},
  ): Promise<BotActionRefusal | null> {
    try {
      const value = await this.rpc('bots.actions.answer', { botId, actionId, digest, answer }, { idem: crypto.randomUUID() })
      refusalOf(value)
      return null
    } catch (error) {
      const refused = botActionRefusal(error, names)
      if (refused) return refused
      throw plainBotError('bots.actions.answer', error)
    }
  }

  async answerQuestion(
    botId: string,
    questionId: string,
    choice: string,
    clientRequestId: string = crypto.randomUUID(),
  ): Promise<{ message: BotChatMessage; question?: BotChatMessage }> {
    const value = await this.call('bots.questions.answer', { botId, questionId, choice, clientRequestId }, true)
    const message = isObject(value) ? parseBotMessage(value.message) : undefined
    if (!message) throw new Error('The computer sent an unexpected answer to bots.questions.answer.')
    const question = isObject(value) && value.question ? parseBotMessage(value.question) : undefined
    return { message, ...(question ? { question } : {}) }
  }

  async snoozeReminder(botId: string, messageId: string, choice: BotSnoozeChoice): Promise<BotChatMessage> {
    const value = await this.call('bots.reminders.snooze', { botId, messageId, choice }, true)
    const message = parseBotMessage(value)
    if (!message) throw new Error('The computer sent an unexpected answer to bots.reminders.snooze.')
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

  update(botId: string, change: { name?: string; look?: BotLook }): Promise<ListBot> {
    const params: Record<string, unknown> = { botId }
    if (change.name !== undefined) {
      const trimmed = change.name.trim()
      if (!trimmed) return Promise.reject(new Error('Write a name first.'))
      params.name = trimmed
    }
    if (change.look !== undefined) params.look = change.look
    return this.summary('bots.update', params)
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

  async editMemory(botId: string, id: string, text: string): Promise<BotMemoryItem | undefined> {
    const content = text.trim()
    if (!content) throw new Error('Write something first.')
    const value = await this.call('bots.memory.edit', { botId, id, text: content }, true)
    return isObject(value) ? parseMemoryEntry(value.entry) : undefined
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

  async setPermission(botId: string, permissionId: string, enabled: boolean): Promise<BotDetail> {
    const value = parseDetail(await this.call('bots.permissions.set', { botId, permissionId, enabled }, true))
    if (!value) throw new Error('The computer sent an unexpected answer to bots.permissions.set.')
    return value
  }

  async revokePermission(botId: string, permissionId: string): Promise<BotDetail> {
    const value = parseDetail(await this.call('bots.permissions.revoke', { botId, permissionId }, true))
    if (!value) throw new Error('The computer sent an unexpected answer to bots.permissions.revoke.')
    return value
  }
}
