// How a bot's chat, presence and sidebar rows read on the phone, ported from
// mousse/src/renderer/components/bots/botChatShape.ts and shared/bots/personal/chat.ts.
import type {
  BotAskCard,
  BotChatMessage,
  BotChecklistState,
  BotChip,
  BotLaunchedThread,
  BotWorkItem,
  ListBot,
  RemoteBotCard,
} from '../../connection/bots'
import { botGroupTime } from './messageGroups'
import { guardTextCharacters } from './textGuard'

/** How long a thread the bot started stays under "Recent" after it was last updated: six hours. */
export const BOT_LAUNCHED_RECENT_MS = 6 * 60 * 60 * 1000

export function launchedRecent(thread: Pick<BotLaunchedThread, 'updatedAt'>, now: number): boolean {
  return Date.parse(thread.updatedAt) >= now - BOT_LAUNCHED_RECENT_MS
}

export function launchedActive(thread: Pick<BotLaunchedThread, 'status'>): boolean {
  return thread.status === 'running' || thread.status === 'queued' || thread.status === 'paused' || thread.status === 'subagents' || thread.status === 'needs_input'
}

export function launchedGoing(thread: Pick<BotLaunchedThread, 'status'>): boolean {
  return launchedActive(thread) || thread.status === 'on_hold'
}

function launchedRank(status: BotLaunchedThread['status']): number {
  if (status === 'needs_input' || status === 'on_hold') return 1
  if (status === 'idle') return 2
  if (status === 'done' || status === 'failed' || status === 'stopped') return 3
  return 0
}

export function compareLaunched(a: BotLaunchedThread, b: BotLaunchedThread): number {
  return launchedRank(a.status) - launchedRank(b.status)
    || (launchedGoing(a) ? a.startedAt.localeCompare(b.startedAt) : b.updatedAt.localeCompare(a.updatedAt))
    || a.threadId.localeCompare(b.threadId)
}

const CHECK_MARKS: Record<BotChecklistState, string> = { done: '[x]', doing: '[~]', todo: '[ ]', skipped: '[-]' }

export function plainCard(card: RemoteBotCard): string {
  if (card.type === 'automation') return `Automation: ${card.name} · ${card.label}`
  if (card.type === 'watcher') return `Background: ${card.title} · ${card.command}`
  const head = 'title' in card && card.title ? [card.title] : []
  if (card.type === 'facts') return [...head, ...card.rows.map((row) => `${row.label}: ${row.value}`)].join('\n')
  if (card.type === 'checklist') return [...head, ...card.items.map((item) => `${CHECK_MARKS[item.state]} ${item.text}`)].join('\n')
  if (card.type === 'progress') return `${card.done} of ${card.total} · ${card.label}${card.note ? `\n${card.note}` : ''}`
  return [...head, ...card.files.map((file) => `${file.name}${file.caption ? ` (${file.caption})` : ''}`)].join('\n')
}

export function plainCards(cards: readonly RemoteBotCard[] | undefined): string {
  return (cards ?? []).map(plainCard).join('\n\n')
}

export function isWorkStart(chip: BotChip): boolean {
  return chip.icon === 'think' && (chip.text === 'started' || chip.text === 'will start') && Boolean(chip.highlight)
}

export function isNotePassed(chip: BotChip): boolean {
  return chip.icon === 'think' && (chip.text === 'passed on your note' || chip.text === 'noted')
}

function workTitle(chip: BotChip): string {
  return chip.highlight!.split(' · ')[0]!
}

export function workSignalsOf(message: BotChatMessage): { titles: string[]; queued: boolean; noted: boolean; only: boolean; details: string[] } | null {
  if (message.author !== 'bot') return null
  const starts = message.chips.filter(isWorkStart)
  const noted = message.chips.some(isNotePassed)
  if (!starts.length && !noted) return null
  const only = message.kind === 'text' && !message.text.trim() && !message.ask && !message.action && !message.error && !message.question &&
    !message.attachments?.length && !message.cards?.length &&
    message.chips.every((chip) => isWorkStart(chip) || isNotePassed(chip))
  const details = message.chips.filter((chip) => isWorkStart(chip) || isNotePassed(chip)).flatMap((chip) => (chip.title ? [chip.title] : []))
  return { titles: starts.map(workTitle), queued: starts.length > 0 && starts.every((chip) => chip.text === 'will start'), noted, only, details }
}

export type BotChatRow =
  | { kind: 'message'; message: BotChatMessage }
  | { kind: 'system'; id: string; at: string; text: string; title?: string; of?: string; note?: 'info' | 'error'; expiredReviews?: BotChatMessage[] }

export interface BotWindowLine {
  id: string
  at: string
  text: string
  error?: true
}

export function withNotes(rows: readonly BotChatRow[], notes: readonly BotWindowLine[]): BotChatRow[] {
  if (!notes.length) return rows as BotChatRow[]
  const merged: BotChatRow[] = []
  let next = 0
  const at = (row: BotChatRow) => Date.parse(row.kind === 'message' ? row.message.at : row.at)
  const toRow = (note: BotWindowLine): BotChatRow => ({ kind: 'system', id: note.id, at: note.at, text: note.text, note: note.error ? 'error' : 'info' })
  for (const row of rows) {
    while (next < notes.length && Date.parse(notes[next]!.at) < at(row)) merged.push(toRow(notes[next++]!))
    merged.push(row)
  }
  while (next < notes.length) merged.push(toRow(notes[next++]!))
  return merged
}

export function tappedAnswerLine(label: string): string {
  return `You answered “${label}”`
}

export interface OwnerMarks { reaction?: string; passedOn?: boolean; title?: string }

function startedLine(botName: string, titles: readonly string[], queued: boolean): string {
  const named = titles.length > 2 ? `${titles.slice(0, -1).join(', ')} and ${titles.at(-1)}` : titles.join(' and ')
  return `${botName} ${queued ? 'will start' : 'started'} ${named}`
}

export function askOnlyNotice(message: BotChatMessage, botName: string): boolean {
  return message.author === 'bot' && !!message.ask && message.text === `${botName} wants to ${message.ask.title}.` &&
    !message.error && !message.question && !message.action && !message.attachments?.length && !message.cards?.length
}

export function askAnsweredLine(botName: string, ask: Pick<BotAskCard, 'title' | 'status'> & Partial<Pick<BotAskCard, 'note'>>): string | undefined {
  if (ask.status === 'allowed') return ask.title.startsWith('let ‘') ? `You let ${botName}’s automation ${ask.title.slice(4)}` : `You let ${botName} ${ask.title}`
  if (ask.status === 'not_now') return `You said not now to ${botName}: ${ask.title}`
  if (ask.status === 'withdrawn') return ask.title.startsWith('let ‘') && ask.note?.includes('Nothing was allowed.') ? ask.note : `${botName} no longer needs to ${ask.title}`
  return undefined
}

export function chatRows(messages: readonly BotChatMessage[], botName: string): { rows: BotChatRow[]; marks: Map<string, OwnerMarks> } {
  const rows: BotChatRow[] = []
  const marks = new Map<string, OwnerMarks>()
  let lastOwner: string | undefined
  let expired: { schedule: string; count: number; row: Extract<BotChatRow, { kind: 'system' }> } | undefined
  const latestAction = new Map<string, BotChatMessage>()
  for (const message of messages) if (message.action) {
    const first = latestAction.get(message.action.actionId)
    latestAction.set(message.action.actionId, { ...message, action: { ...message.action, askedAt: message.action.askedAt ?? first?.action?.askedAt ?? first?.at ?? message.at } })
  }
  const foldedActions = new Set(messages.filter((message) => message.expiredActionSchedule && message.action).map((message) => message.action!.actionId))
  const nudgeOf = (message: BotChatMessage) => Boolean(message.action && /^bm_action_.*_n[12]$/.test(message.id))
  const earlierLine = (message: BotChatMessage): Extract<BotChatRow, { kind: 'system' }> => ({
    kind: 'system',
    id: message.id,
    at: message.at,
    of: message.id,
    text: `${guardTextCharacters(message.action!.title).replace(/\s+/g, ' ')} · ${nudgeOf(message) ? 'Reminded' : 'Asked'} ${botGroupTime(message.at)}`,
  })
  for (const message of messages) {
    const nudge = nudgeOf(message)
    if (nudge && message.action && foldedActions.has(message.action.actionId)) continue
    if (!nudge && message.expiredActionSchedule) {
      if (expired?.schedule === message.expiredActionSchedule) expired.count++
      else {
        const line: Extract<BotChatRow, { kind: 'system' }> = { kind: 'system', id: message.id, at: message.at, text: 'Expired · not sent', of: message.id }
        expired = { schedule: message.expiredActionSchedule, count: 1, row: line }
        rows.push(line)
      }
      if (message.action) {
        const newest = latestAction.get(message.action.actionId) ?? message
        ;(expired.row.expiredReviews ??= []).push({ ...newest, action: { ...message.action, askedAt: message.action.askedAt ?? message.at } })
      }
      const reviews = expired.row.expiredReviews
      const names = reviews?.map((review) => guardTextCharacters(review.action!.title).replace(/\s+/g, ' '))
      const name = names?.length === expired.count && names.every((title) => title === names[0]) ? `: ${names[0]}` : ''
      expired.row.text = `${expired.count === 1 ? 'Expired' : `${expired.count} expired`} · not sent${name}`
      continue
    }
    if (!nudge) expired = undefined
    if (message.action && latestAction.get(message.action.actionId)?.id !== message.id) {
      rows.push(earlierLine(message))
      continue
    }
    if (message.author === 'owner') lastOwner = message.id
    if (message.author === 'owner' && message.answers?.tapped) {
      const question = message.replyTo && !message.replyTo.gone ? message.replyTo.text : ''
      rows.push({ kind: 'system', id: `${message.id}:answered`, at: message.at, text: tappedAnswerLine(message.text), of: message.id, ...(question ? { title: question } : {}) })
      continue
    }
    if (message.systemLine) {
      rows.push({ kind: 'system', id: message.id, at: message.at, text: message.text, of: message.id, ...(message.systemTitle ? { title: message.systemTitle } : {}) })
      continue
    }
    const signals = workSignalsOf(message)
    if (signals) {
      const target = message.replyTo?.author === 'owner' ? message.replyTo.id : lastOwner
      const tip = signals.details.join('\n')
      if (target) {
        const mark = { ...marks.get(target) }
        if (signals.titles.length) mark.reaction = '👍'
        if (signals.noted) mark.passedOn = true
        if (tip) mark.title = tip
        marks.set(target, mark)
      }
      if (signals.titles.length) rows.push({ kind: 'system', id: `${message.id}:started`, at: message.at, text: startedLine(botName, signals.titles, signals.queued), ...(tip ? { title: tip } : {}) })
      if (signals.only) continue
    }
    if (askOnlyNotice(message, botName)) {
      if (message.ask!.status === 'open') {
        rows.push({ kind: 'message', message: { ...message, text: '' } })
        continue
      }
      const answered = askAnsweredLine(botName, message.ask!)
      if (answered) {
        rows.push({ kind: 'system', id: `${message.id}:answered`, at: message.at, text: answered, of: message.id })
        continue
      }
    }
    rows.push({ kind: 'message', message: message.action ? latestAction.get(message.action.actionId)! : message })
    const answered = message.ask ? askAnsweredLine(botName, message.ask) : undefined
    if (answered) rows.push({ kind: 'system', id: `${message.id}:answered`, at: message.at, text: answered })
  }
  return { rows, marks }
}

/** The one chat line whose Resume still works: the newest usage-limit line while the bot is paused. */
export function liveResumeLine(messages: readonly BotChatMessage[], bot: Pick<ListBot, 'state'>): string | undefined {
  if (bot.state !== 'paused') return undefined
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]!.error?.action?.kind === 'resume') return messages[index]!.id
  }
  return undefined
}

export function stepText(chip: BotChip): string {
  const text = chip.text.charAt(0).toUpperCase() + chip.text.slice(1)
  return chip.highlight ? `${text}${chip.thread ? ': ' : ' · '}${chip.highlight}` : text
}

export function workedMs(message: Pick<BotChatMessage, 'at'>, asked: Pick<BotChatMessage, 'at'> | undefined): number | undefined {
  if (!asked) return undefined
  const ms = Date.parse(message.at) - Date.parse(asked.at)
  return Number.isFinite(ms) && ms >= 0 ? ms : undefined
}

export function formatWorkedFor(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000))
  if (seconds < 60) return `Worked for ${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const rem = seconds % 60
  return rem ? `Worked for ${minutes}m ${rem}s` : `Worked for ${minutes}m`
}

export function runningFor(startedAt: string, now = Date.now()): string {
  const minutes = Math.max(0, Math.floor((now - Date.parse(startedAt)) / 60_000))
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

export type BotPresence = { kind: 'typing' | 'busy' | 'free' | 'offline' | 'paused'; text: string; lead?: BotWorkItem }

export function leadWork(work: readonly BotWorkItem[]): BotWorkItem | undefined {
  const running = work.filter((item) => item.status !== 'queued')
  const pool = running.length ? running : work
  return [...pool].sort((a, b) => a.startedAt.localeCompare(b.startedAt))[0]
}

export function botActiveThreads(bot: Pick<ListBot, 'threads'>): BotLaunchedThread[] {
  return (bot.threads ?? []).filter(launchedActive).sort(compareLaunched)
}

export function presenceOf(bot: Pick<ListBot, 'state' | 'work' | 'threads' | 'watchers'>, chat: { typing: boolean; offline: boolean }): BotPresence {
  if (bot.state === 'paused') return { kind: 'paused', text: 'paused' }
  if (chat.offline) return { kind: 'offline', text: 'waiting for internet' }
  if (chat.typing) return { kind: 'typing', text: 'typing…' }
  const work = bot.work ?? []
  const threads = botActiveThreads(bot)
  const watchers = bot.watchers ?? []
  const lead = leadWork(work)
  if (lead) {
    const more = work.length - 1 + threads.length + watchers.length
    return { kind: 'busy', text: more > 0 ? `${lead.title} +${more}` : lead.title, lead }
  }
  const more = watchers.length ? ` +${watchers.length}` : ''
  if (threads.length === 1) return { kind: 'busy', text: `Managing ${threads[0]!.title}${more}` }
  if (threads.length) return { kind: 'busy', text: `Managing ${threads.length} threads${more}` }
  if (watchers.length === 1) return { kind: 'free', text: `Waiting on ${watchers[0]!.title}` }
  if (watchers.length) return { kind: 'free', text: `Waiting on ${watchers.length} things` }
  return { kind: 'free', text: 'free' }
}

export type BotRowTone = 'working' | 'needs' | 'idle'

/**
 * The line under a bot's name in the Bots list (#1404), in words coloured by `tone`.
 * `resting` is true only for "Idle": its face sleeps at full colour.
 */
export function botRowLine(bot: Pick<ListBot, 'state' | 'stateText' | 'needsOwner' | 'waiting' | 'chat' | 'work' | 'threads' | 'watchers'>): { tone: BotRowTone; text: string; resting: boolean } {
  const line = (tone: BotRowTone, text: string, resting = false) => ({ tone, text, resting })
  if (bot.state === 'paused') return line('idle', 'Paused')
  if (bot.needsOwner || bot.state === 'needs_you' || bot.state === 'stuck') return line('needs', bot.stateText || 'Needs you')
  const offline = Boolean(bot.chat?.offline) || bot.waiting === 'internet'
  const presence = presenceOf(bot, { typing: Boolean(bot.chat) && !offline, offline })
  if (presence.kind === 'offline') return line('idle', 'Waiting for internet')
  if (presence.kind === 'typing') return line('working', 'Typing…')
  if (presence.kind === 'busy') return line('working', presence.text)
  if (bot.state === 'working') return line('working', bot.stateText || 'Working…')
  if (presence.text !== 'free') return line('idle', presence.text)
  return line('idle', 'Idle', true)
}

export type LaunchedTone = 'working' | 'waiting' | 'idle' | 'done' | 'failed'

export function launchedLook(status: BotLaunchedThread['status']): { tone: LaunchedTone; label: string } {
  if (status === 'needs_input' || status === 'on_hold') return { tone: 'waiting', label: 'waiting on you' }
  if (status === 'queued') return { tone: 'working', label: 'queued' }
  if (status === 'paused') return { tone: 'working', label: 'held' }
  if (status === 'subagents') return { tone: 'working', label: 'waiting on subagents' }
  if (status === 'idle') return { tone: 'idle', label: 'idle' }
  if (status === 'done') return { tone: 'done', label: 'done' }
  if (status === 'failed') return { tone: 'failed', label: 'failed' }
  if (status === 'stopped') return { tone: 'failed', label: 'stopped' }
  return { tone: 'working', label: 'working' }
}

export function launchedGroups(threads: readonly BotLaunchedThread[], now: number): { going: BotLaunchedThread[]; ended: BotLaunchedThread[] } {
  const ordered = [...threads].sort(compareLaunched)
  return { going: ordered.filter(launchedGoing), ended: ordered.filter((thread) => !launchedGoing(thread) && launchedRecent(thread, now)) }
}

export type BotStickerKind = 'typing' | 'browser' | 'web' | 'search' | 'command' | 'file' | 'schedule' | 'memory' | 'working' | 'paused'

export function stickerOf(presence: BotPresence, chip: BotChip | undefined): BotStickerKind | undefined {
  if (presence.kind === 'typing') return 'typing'
  if (presence.kind === 'paused') return 'paused'
  if (presence.kind !== 'busy') return undefined
  if (!chip || presence.lead?.status !== 'running') return 'working'
  if (/browser/.test(chip.text)) return 'browser'
  if (/command/.test(chip.text)) return 'command'
  if (chip.icon === 'search') return 'search'
  if (chip.icon === 'web') return 'web'
  if (chip.icon === 'read' || chip.icon === 'edit') return 'file'
  if (chip.icon === 'schedule') return 'schedule'
  if (chip.icon === 'memory') return 'memory'
  return 'working'
}
