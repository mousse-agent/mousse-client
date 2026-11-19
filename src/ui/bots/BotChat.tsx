// A bot's chat on the phone, after the desktop's BotChatView (mousse/src/renderer/components/bots):
// messenger-shaped transcript (botChatShape), inter-bot bubbles (#1543), typing dots (#1275),
// failed-turn Retry (#1630), held tool action cards (#1390/#1556/#1545), quick-reply asks/questions/
// reminders, structured cards, expandable steps, memory tag, slash commands (#1266), find in chat,
// pinned open ask/error, work summary above composer, and pill composer.
import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import {
  isBotsUnsupported,
  type BotActionRefusal,
  type BotChatMessage,
  type BotChatQuote,
  type BotChip,
  type BotChipIcon,
  type BotDetail,
  type BotError,
  type BotSnoozeChoice,
  type BotWorkItem,
  type ComputerBots,
  type ListBot,
} from '../../connection/bots'
import type { ComposerCommand } from '../../connection/types'
import {
  AlertTriangle,
  ArrowDown,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  CircleAlert,
  Clock,
  Copy,
  FileText,
  Globe,
  Loader2,
  Pencil,
  Reply,
  Search,
  Shield,
  Sparkles,
  User,
  X,
  type IconComponent,
} from '../components/icons'
import { Composer } from '../components/Composer'
import { ShowQuotedContext, WithSentQuotes } from '../components/SentQuotes'
import { QUOTE_SOURCE_ATTRIBUTE } from '../components/SelectionReplyButton'
import { Markdown, MarkdownImageRenderer } from '../timeline/Markdown'
import { BotActionCard } from './BotActionCard'
import { BotAskReplies } from './BotAskReplies'
import { BotCards, galleryIndices } from './BotCards'
import { BotImageFiles, BotOtherFiles, isImageAttachment, renderBotImage } from './BotImages'
import { workDoing, workElapsed } from './BotPresenceSheet'
import { BotQuestionReplies } from './BotQuestionReplies'
import { BotReminderReplies } from './BotReminderReplies'
import { BotSteps } from './BotSteps'
import {
  chatRows,
  formatWorkedFor,
  liveResumeLine,
  plainCards,
  withNotes,
  workedMs,
  type BotChatRow,
  type BotWindowLine,
  type OwnerMarks,
} from './botChatShape'
import { parseBotCommand, statusText } from './botCommands'
import { botMessageFrom, type BotMessageFrom } from './botMessages'
import { botRetryOf } from './botRetry'
import { BotFace, type BotFaceState } from './face/BotFace'
import { LazyBotFace } from './face/LazyBotFace'
import { BOT_COLOUR_HEX, DEFAULT_BOT_LOOK, normalizeBotLook } from './look'
import { botFullTime, botGroupTime, botMessageLabel, placeMessages } from './messageGroups'
import { useMotionScale } from './motion'
import { useBotChatFind } from './useBotChatFind'
import './bots.css'

export { BotAboutSheet, nextRunText, reminderWhenText, reminderWhenLine } from './BotAboutSheet'
export { workElapsed } from './BotPresenceSheet'

const CHIP_ICONS: Record<BotChipIcon, IconComponent> = {
  search: Search,
  web: Globe,
  read: FileText,
  edit: Pencil,
  schedule: Clock,
  memory: Brain,
  ask: Shield,
  think: Sparkles,
  name: User,
  warning: AlertTriangle,
}

/** Messages per page, as the desktop reads them. A computer may send fewer so a page fits one reply. */
export const BOT_CHAT_PAGE = 50

const BOT_COMPOSER_COMMANDS: ComposerCommand[] = [
  { name: 'stop', description: 'Stop all running work' },
  { name: 'status', description: 'Show work, threads and schedules' },
  { name: 'pause', description: 'Turn off schedules and wake-ups' },
  { name: 'resume', description: 'Turn them back on' },
  { name: 'memory', description: 'Open saved memory' },
]

/** A message's time: the time today, "Yesterday", or the date. */
export function botMessageTime(at: string, now = new Date()): string {
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return ''
  if (date.toDateString() === now.toDateString()) return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday'
  return date.toLocaleDateString([], { day: 'numeric', month: 'short' })
}

/** The face's pose for a bot's state. */
export function botFaceState(bot: ListBot): BotFaceState {
  return bot.state
}

/** A message as a reply quote: who wrote it and its first line. */
export function quoteOf(message: BotChatMessage): BotChatQuote {
  const own = message.plainFrom === undefined ? message.text : message.text.slice(0, message.plainFrom).trimEnd()
  const line = (own || message.error?.text || plainCards(message.cards) || message.attachments?.map((file) => file.name).join(', ') || '').trim().split('\n').find((part) => part.trim())?.trim() ?? ''
  return { id: message.id, author: message.author, text: line.length > 160 ? `${line.slice(0, 159)}…` : line }
}

/** Something waiting on the owner, pinned above the composer: the message it is on (absent when not loaded) and its line. */
export interface BotPinned { kind: 'ask' | 'error'; id?: string; text: string }

/**
 * What stays pinned above the composer while the owner scrolls: the newest open ask, and the bot's current error.
 * Each points at its full message: the ask's own, and the newest message with that error (or any error).
 */
export function pinnedOf(messages: readonly BotChatMessage[], bot: Pick<ListBot, 'name' | 'error'> & Partial<Pick<ListBot, 'state'>>): BotPinned[] {
  const pinned: BotPinned[] = []
  const ask = messages.filter((message) => message.ask?.status === 'open').at(-1)
  if (ask) pinned.push({ kind: 'ask', id: ask.id, text: `${bot.name} wants to ${ask.ask!.title}` })
  if (bot.error && !(bot.state === 'paused' && bot.error.action?.kind === 'resume')) {
    const errors = messages.filter((message) => message.error)
    const shown = errors.filter((message) => message.error!.text === bot.error!.text).at(-1) ?? errors.at(-1)
    pinned.push({ kind: 'error', ...(shown ? { id: shown.id } : {}), text: bot.error.text })
  }
  return pinned
}

/** Messages by seq, each once: a newer copy of a message replaces the older. */
export function upsertMessages(held: readonly BotChatMessage[], incoming: readonly BotChatMessage[]): BotChatMessage[] {
  if (!incoming.length) return held as BotChatMessage[]
  const byId = new Map(held.map((message) => [message.id, message]))
  for (const message of incoming) byId.set(message.id, message)
  return [...byId.values()].sort((a, b) => a.seq - b.seq)
}

export function BotChipView({ chip }: { chip: BotChip }) {
  const Icon = chip.live ? Loader2 : CHIP_ICONS[chip.icon] ?? Sparkles
  return (
    <span className={`bot-chip${chip.live ? ' is-live' : ''}`}>
      <Icon size={13} aria-hidden />
      <span>{chip.text}{chip.highlight && <> <b>{chip.highlight}</b></>}</span>
    </span>
  )
}

const messageElement = (id: string) => {
  const element = document.querySelector(`.bot-chat [data-message-id="${CSS.escape(id)}"]`)
  return element instanceof HTMLElement ? element : null
}
const nextFrame = () => new Promise<void>((resolve) => { requestAnimationFrame(() => resolve()) })

const quoteOwner = (quote: BotChatQuote, botName: string) => (quote.author === 'owner' ? 'your message' : `${botName}'s message`)
const quoteLine = (quote: BotChatQuote) => (quote.gone ? 'This message was removed.' : quote.text || 'Files')

function QuoteLine({ quote, botName }: { quote: BotChatQuote; botName: string }) {
  return (
    <>
      <Reply size={14} className="bot-quote-mark" aria-hidden />
      {quote.author === 'bot' && <strong>{botName}</strong>}
      <span>{quoteLine(quote)}</span>
    </>
  )
}

function ReplyQuote({ quote, botName, onShow }: { quote: BotChatQuote; botName: string; onShow(id: string): void }) {
  return (
    <button type="button" className="bot-quote bot-reply-quote" data-author={quote.author} disabled={quote.gone} onClick={() => onShow(quote.id)} aria-label={`Replying to ${quoteOwner(quote, botName)}: ${quoteLine(quote)}`}>
      <QuoteLine quote={quote} botName={botName} />
    </button>
  )
}

function ErrorLine({ error, settled, onResume, onRetry }: { error: BotError; settled?: boolean; onResume(): void; onRetry?: () => void }) {
  // Sign in, provider set-up and pick_model happen on the computer; Resume and Retry work from here.
  const action = !settled && error.action && (error.action.kind === 'resume' || error.action.kind === 'retry') ? error.action : undefined
  const computerOnly = !settled && error.action && !action
  return (
    <div className={`bot-error${settled ? ' is-settled' : ''}`} role="status">
      <CircleAlert size={15} aria-hidden />
      <span>{error.text}{computerOnly ? ` ${error.action!.label} on the computer.` : ''}</span>
      {action && <button type="button" onClick={onResume}>{action.label}</button>}
      {onRetry && !settled && <button type="button" onClick={onRetry}>Retry</button>}
    </div>
  )
}

function CopyTextButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  const copy = () => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1400)
    }).catch(() => undefined)
  }
  return (
    <button type="button" className="bot-reply-button" aria-label={copied ? 'Copied' : 'Copy'} onClick={copy}>
      {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
    </button>
  )
}

function ReplyButton({ onReply }: { onReply(): void }) {
  return <button type="button" className="bot-reply-button" aria-label="Reply" onClick={onReply}><Reply size={15} aria-hidden /></button>
}

/** Three animated typing dots beside what the bot is doing now (#1275). */
function TypingBubble({ bot, offline, status }: { bot: ListBot; offline: boolean; status?: string }) {
  const still = useMotionScale() === 0
  return (
    <article className="bot-msg bot-msg--bot is-group-start bot-turn" aria-label={offline ? `${bot.name} waiting for internet` : `${bot.name} is working`}>
      <LazyBotFace look={bot.look} state={bot.state} size={32} view="head" className="bot-msg__face" still />
      <div className="bot-msg__body">
        <div className="bot-typing-bubble" role="status">
          {offline ? (
            <span className="bot-typing-status">Waiting for internet</span>
          ) : (
            <span className={`bot-typing-row${still ? ' is-still' : ''}`}>
              <span className="bot-typing-dots" aria-hidden><i /><i /><i /></span>
              <span className="bot-typing-status">{status || 'Working…'}</span>
            </span>
          )}
        </div>
      </div>
    </article>
  )
}

function senderOf(message: BotChatMessage): string {
  const from = message.author === 'bot' ? botMessageFrom(message) : undefined
  return from ? `bot:${from.botId ?? from.name}` : message.author
}

const senderName = (from: BotMessageFrom, sender: ListBot | undefined) => sender?.name ?? from.name

interface MessageProps {
  bot: ListBot
  allBots: readonly ListBot[]
  bots: ComputerBots
  message: BotChatMessage
  asked?: BotChatMessage
  marks?: OwnerMarks
  runs?: BotDetail['runs']
  /** Show the message this one answers (it is not the one right above). */
  quote: boolean
  /** The first of its group: the face and name, and the group's space above it. */
  starts: boolean
  pending?: boolean
  settled?: boolean
  found?: boolean
  onReply?(message: BotChatMessage): void
  onShow(id: string): void
  onAnswer(askId: string, answer: 'allow' | 'not_now'): Promise<string | undefined>
  onAnswerAction(actionId: string, digest: string, answer: 'send' | 'not_now', serverName: string): Promise<BotActionRefusal | null>
  onAnswerQuestion(questionId: string, choice: string): Promise<boolean>
  onSnoozeReminder(messageId: string, choice: BotSnoozeChoice): Promise<boolean>
  onStopWatcher(watcherId: string): Promise<void>
  onResume(): void
  onRetry?: () => void
  onOpenMemory?(focus?: string): void
  onOpenAbout?(): void
  onOpenThread?(threadId: string): void
}

const sameMessage = (a: MessageProps, b: MessageProps) =>
  a.message === b.message && a.asked === b.asked && a.marks === b.marks && a.quote === b.quote &&
  a.starts === b.starts && a.pending === b.pending && a.settled === b.settled && a.found === b.found &&
  a.onReply === b.onReply && a.onShow === b.onShow && a.onAnswer === b.onAnswer &&
  a.onAnswerAction === b.onAnswerAction && a.onAnswerQuestion === b.onAnswerQuestion &&
  a.onSnoozeReminder === b.onSnoozeReminder && a.onStopWatcher === b.onStopWatcher &&
  a.onResume === b.onResume && a.onRetry === b.onRetry && a.onOpenMemory === b.onOpenMemory &&
  a.onOpenAbout === b.onOpenAbout && a.onOpenThread === b.onOpenThread &&
  a.bots === b.bots && a.allBots === b.allBots && a.runs === b.runs && a.bot.watchers === b.bot.watchers &&
  a.bot.id === b.bot.id && a.bot.name === b.bot.name &&
  a.bot.look.colour === b.bot.look.colour && a.bot.look.accessory === b.bot.look.accessory &&
  a.bot.look.kind === b.bot.look.kind && a.bot.look.eyes === b.bot.look.eyes

const Message = memo(function Message({
  bot,
  allBots,
  bots,
  message: row,
  asked,
  marks,
  runs,
  quote,
  starts,
  pending,
  settled,
  found,
  onReply,
  onShow,
  onAnswer,
  onAnswerAction,
  onAnswerQuestion,
  onSnoozeReminder,
  onStopWatcher,
  onResume,
  onRetry,
  onOpenMemory,
  onOpenAbout,
  onOpenThread,
}: MessageProps) {
  const [stepsOpen, setStepsOpen] = useState(false)
  const cards = row.cards?.length ? row.cards : undefined
  const question = row.question
  // Slice plain fallback text when cards or interactive question choices are drawn below.
  const message = useMemo(() => {
    if ((!question && !cards) || row.plainFrom === undefined) return row
    return { ...row, text: row.text.slice(0, row.plainFrom).trimEnd() }
  }, [question, cards, row])

  const quoted = quote && message.replyTo
  const files = message.attachments ?? []
  const skipImages = useMemo(() => galleryIndices(cards), [cards])
  const images = !pending && files.some((file, index) => isImageAttachment(file) && !skipImages.has(index))

  if (message.author === 'owner') {
    return (
      <article
        className={`bot-msg bot-you${starts ? ' is-group-start' : ''}${quoted ? ' is-quoted' : ''}${pending ? ' is-pending' : ''}${found ? ' is-found' : ''}`}
        data-message-id={message.id}
        title={pending ? undefined : botFullTime(message.at)}
      >
        {quoted && <ReplyQuote quote={message.replyTo!} botName={bot.name} onShow={onShow} />}
        <div className="bot-you-line">
          {!pending && onReply && (
            <span className="bot-msg__tools">
              {message.text && <CopyTextButton text={message.text} />}
              <ReplyButton onReply={() => onReply(row)} />
            </span>
          )}
          <div className="bot-you-content">
            {images && <BotImageFiles files={files} skipIndices={skipImages} bots={bots} botId={bot.id} messageId={message.id} />}
            {message.text && (
              <div className="bot-you-bubble">
                <WithSentQuotes text={message.text} render={(part) => <Markdown text={part} />} />
                {marks?.reaction && (
                  <span className="bot-reaction" role="img" aria-label={`${bot.name} reacted ${marks.reaction}`}>{marks.reaction}</span>
                )}
              </div>
            )}
            {!!files.length && <BotOtherFiles files={files} images={images} />}
          </div>
        </div>
        {marks?.passedOn && <p className="bot-receipt" title={marks.title}>Noted</p>}
      </article>
    )
  }

  // Message from another of the owner's bots (#1543): show as that bot's bubble with its face, name and colour.
  const from = useMemo(() => botMessageFrom(row), [row])
  const sender = useMemo(
    () => (from ? allBots.find((other) => (from.botId ? other.id === from.botId : other.name === from.name)) : undefined),
    [from, allBots],
  )
  const fromStyle = from
    ? ({ '--from-colour': BOT_COLOUR_HEX[normalizeBotLook(sender?.look).colour] } as CSSProperties)
    : undefined

  const label = botMessageLabel(message)
  const openAsk = message.ask?.status === 'open' ? message.ask : undefined
  const steps = message.chips
  const ms = workedMs(message, asked)
  const saved = steps.find((chip) => chip.icon === 'memory' && chip.text.toLowerCase().startsWith('remembered'))
  const words = from ? from.message : message.text
  const copySource = from ? from.message : cards ? row.text : message.text
  const faceLook = from ? (sender?.look ?? DEFAULT_BOT_LOOK) : bot.look
  const displayName = from ? senderName(from, sender) : bot.name

  return (
    <article
      className={`bot-msg bot-msg--bot${from ? ' is-from-bot' : ''}${starts ? ' is-group-start' : ''}${quoted ? ' is-quoted' : ''}${message.kind === 'run_report' ? ' is-report' : ''}${found ? ' is-found' : ''}`}
      data-message-id={message.id}
      style={fromStyle}
      title={botFullTime(message.at)}
    >
      {starts
        ? <LazyBotFace look={faceLook} state="idle" size={32} view="head" className="bot-msg__face" still />
        : <div className="bot-msg__gutter" aria-hidden />}
      <div className="bot-msg__body">
        {starts && (
          <div className="bot-msg__meta">
            <strong className={from ? 'bot-from-name' : undefined}>{displayName}</strong>
            {label && <span className="bot-message-label">{label}</span>}
            {onReply && (
              <span className="bot-msg__tools">
                {copySource && <CopyTextButton text={copySource} />}
                <ReplyButton onReply={() => onReply(row)} />
              </span>
            )}
          </div>
        )}
        {!starts && (label || onReply) && (
          <div className="bot-msg__meta bot-msg__meta--later">
            {label && <span className="bot-message-label">{label}</span>}
            {onReply && (
              <span className="bot-msg__tools">
                {copySource && <CopyTextButton text={copySource} />}
                <ReplyButton onReply={() => onReply(row)} />
              </span>
            )}
          </div>
        )}
        {quoted && <ReplyQuote quote={message.replyTo!} botName={bot.name} onShow={onShow} />}
        {/* Bot reply pictures sit above the words, like a messenger image message. */}
        {images && (
          <div className="bot-message-media">
            <BotImageFiles files={files} skipIndices={skipImages} bots={bots} botId={bot.id} messageId={message.id} />
          </div>
        )}
        {message.action ? (
          <BotActionCard
            card={message.action}
            botName={bot.name}
            onAnswer={(choice) => onAnswerAction(message.action!.actionId, message.action!.digest, choice, message.action!.serverName)}
          />
        ) : message.actionSentAt ? (
          <p className="bot-question-settled" role="note">Sent · <time dateTime={message.actionSentAt}>{botGroupTime(message.actionSentAt)}</time></p>
        ) : (
          words && <Markdown text={words} className="bot-msg__text" />
        )}
        {cards && (
          <BotCards
            cards={cards}
            bots={bots}
            botId={bot.id}
            messageId={message.id}
            watchers={bot.watchers}
            runs={runs}
            onStopWatcher={onStopWatcher}
            onOpenAbout={onOpenAbout}
          />
        )}
        {openAsk && (
          <p className="bot-bubble-ask">
            <Shield size={14} aria-hidden />
            <span><strong>{bot.name}</strong> wants to <strong>{openAsk.title}</strong></span>
          </p>
        )}
        {!!files.length && <BotOtherFiles files={files} images={images} />}
        {message.error && <ErrorLine error={message.error} settled={settled} onResume={onResume} onRetry={onRetry} />}
        {stepsOpen && <BotSteps chips={steps} onOpenThread={onOpenThread} />}
        {steps.length > 0 && (
          <div className="bot-bubble-foot">
            <button
              type="button"
              className="bot-worked"
              aria-expanded={stepsOpen}
              onClick={() => setStepsOpen((open) => !open)}
            >
              {ms === undefined ? 'Steps' : formatWorkedFor(ms)}
              <ChevronRight size={13} className={`bot-worked__chevron${stepsOpen ? ' is-open' : ''}`} aria-hidden />
            </button>
          </div>
        )}
        {message.reaction && (
          <span className="bot-reaction is-mine" role="img" aria-label={`Reaction ${message.reaction}`}>{message.reaction}</span>
        )}
        {saved && onOpenMemory && (
          <button
            type="button"
            className="bot-memory-tag"
            onClick={() => onOpenMemory(saved.title?.startsWith('Put away:\n') ? saved.highlight?.replace(/ · put away \d+$/, '') : saved.highlight)}
          >
            <Brain size={12} aria-hidden />Saved to memory
          </button>
        )}
        {openAsk && <BotAskReplies botName={bot.name} ask={openAsk} onAnswer={(value) => onAnswer(openAsk.askId, value)} />}
        {message.reminder && (
          <BotReminderReplies reminder={message.reminder} onSnooze={(choice) => onSnoozeReminder(message.id, choice)} />
        )}
        {question && (
          <BotQuestionReplies
            question={question}
            onAnswer={(choice) => onAnswerQuestion(question.questionId, choice)}
            onOther={() => onReply?.(row)}
          />
        )}
      </div>
    </article>
  )
}, sameMessage)

function GroupTime({ message, pending }: { message: BotChatMessage; pending: boolean }) {
  return (
    <div className="bot-group-time" data-author={message.author}>
      {pending ? <span>Sending…</span> : <time dateTime={message.at}>{botGroupTime(message.at)}</time>}
    </div>
  )
}

function SystemLine({ row }: { row: Extract<BotChatRow, { kind: 'system' }> }) {
  const className = `bot-system-line${row.note ? ' is-note' : ''}${row.note === 'error' ? ' is-error' : ''}`
  return (
    <p
      className={className}
      role={row.note === 'error' ? 'alert' : 'note'}
      {...(row.title ? { title: row.title } : {})}
      {...(row.of ? { 'data-message-id': row.of } : {})}
    >
      <span>{row.text}</span>
    </p>
  )
}

const WorkLine = memo(function WorkLine({ item, chip, onStop }: { item: BotWorkItem; chip?: BotChip; onStop(): void }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [])
  const running = item.status === 'running'
  return (
    <li className={`bot-work-line${running ? ' is-running' : ''}`}>
      {running ? <Loader2 size={13} className="m-sb-spin" aria-hidden /> : <span className="bot-work-dot" aria-hidden />}
      <span className="bot-work-title">{item.title}</span>
      <span className="bot-work-doing">{workDoing(item, chip)} · {workElapsed(item.startedAt, now)}</span>
      <button type="button" aria-label={`Stop ${item.title}`} onClick={onStop}><X size={13} aria-hidden /></button>
    </li>
  )
})

const errorText = (error: unknown) => (error instanceof Error ? error.message : 'Something went wrong.')

const NO_WORK: BotWorkItem[] = []
const NO_MESSAGES: BotChatMessage[] = []
const NO_BOTS: ListBot[] = []

interface ChatCache { messages: BotChatMessage[]; hasMore: boolean; loadingOlder: boolean }

export interface BotChatProps {
  bot: ListBot
  allBots?: readonly ListBot[]
  bots: ComputerBots
  findSignal?: number
  prefill?: { text: string; key: number; append?: boolean }
  onOpenMemory?(focus?: string): void
  onOpenAbout?(): void
  onOpenThread?(threadId: string): void
}

/** The chat of one bot on its computer. `bot` follows the computer's lists. */
export function BotChat({
  bot,
  allBots = NO_BOTS,
  bots,
  findSignal = 0,
  prefill,
  onOpenMemory,
  onOpenAbout,
  onOpenThread,
}: BotChatProps) {
  const [chat, setChat] = useState<ChatCache>()
  const [detail, setDetail] = useState<BotDetail>()
  const [load, setLoad] = useState<'loading' | 'failed'>()
  const [pending, setPending] = useState<BotChatMessage[]>([])
  const [notes, setNotes] = useState<BotWindowLine[]>([])
  const [error, setError] = useState<string>()
  const [replying, setReplying] = useState<BotChatQuote>()
  const scroller = useRef<HTMLDivElement>(null)
  const reads = useRef(0)
  const chatRef = useRef(chat)
  chatRef.current = chat
  const older = useRef<Promise<boolean>>()
  const failedSend = useRef<{ text: string; clientRequestId: string }>()

  const addNote = useCallback((text: string, isError?: true) => {
    setNotes((current) => [...current, { id: `note:${crypto.randomUUID()}`, at: new Date().toISOString(), text, ...(isError ? { error: true as const } : {}) }])
  }, [])

  const put = useCallback((incoming: BotChatMessage[], page?: { hasMore?: boolean; replace?: boolean }) => {
    setChat((current) => {
      const held = page?.replace ? [] : current?.messages ?? []
      return { messages: upsertMessages(held, incoming), hasMore: page?.hasMore ?? current?.hasMore ?? false, loadingOlder: current?.loadingOlder ?? false }
    })
    const owned = new Set(incoming.flatMap((message) => (message.author === 'owner' && message.clientRequestId ? [`pending:${message.clientRequestId}`] : [])))
    if (owned.size) setPending((current) => current.filter((message) => !owned.has(message.id)))
  }, [])

  const changeKey = `${bot.last?.at ?? ''}|${bot.unread}|${bot.chat?.activationId ?? ''}|${bot.state}|${(bot.work ?? []).map((item) => `${item.id}:${item.status}`).join(',')}`
  const loadLatest = useCallback(async () => {
    const run = ++reads.current
    if (!chatRef.current) setLoad('loading')
    try {
      const page = await bots.chat(bot.id, { limit: BOT_CHAT_PAGE })
      if (run !== reads.current) return
      setLoad(undefined)
      const held = chatRef.current?.messages ?? []
      const first = page.messages[0]?.seq
      const gap = first !== undefined && held.length > 0 && held.at(-1)!.seq < first && !held.some((message) => message.seq === first)
      put(page.messages, { replace: gap || !chatRef.current, hasMore: gap || !chatRef.current ? page.messages.length > 0 : undefined })
    } catch (failure) {
      if (run !== reads.current) return
      if (chatRef.current) setError(errorText(failure))
      else setLoad('failed')
    }
  }, [bot.id, bots, put])
  useEffect(() => { void loadLatest() }, [loadLatest, changeKey])

  // Load detail when any automation card is visible so it shows live status.
  const hasAutomationCard = Boolean(chat?.messages.some((message) => message.cards?.some((card) => card.type === 'automation')))
  useEffect(() => {
    if (!hasAutomationCard) return
    let live = true
    bots.get(bot.id).then((value) => { if (live) setDetail(value) }, () => undefined)
    return () => { live = false }
  }, [hasAutomationCard, bot.id, bots, changeKey])

  const loadOlder = useCallback((): Promise<boolean> => {
    const cache = chatRef.current
    if (older.current) return older.current
    if (!cache?.hasMore || !cache.messages.length) return Promise.resolve(false)
    const botId = bot.id
    const oldestSeq = cache.messages[0]!.seq
    setChat((current) => current && { ...current, loadingOlder: true })
    const operation = (async () => {
      try {
        const page = await bots.chat(botId, { beforeSeq: oldestSeq, limit: BOT_CHAT_PAGE })
        setChat((current) => current && { messages: upsertMessages(current.messages, page.messages), hasMore: page.messages.length > 0, loadingOlder: false })
        return page.messages.length > 0 && page.messages[0]!.seq < oldestSeq
      } catch (failure) {
        setError(errorText(failure))
        setChat((current) => current && { ...current, loadingOlder: false })
        return false
      } finally {
        older.current = undefined
      }
    })()
    older.current = operation
    return operation
  }, [bot.id, bots])

  const showMessage = useCallback(async (id: string) => {
    let element = messageElement(id)
    for (let pages = 0; !element && pages < 40; pages += 1) {
      const before = chatRef.current
      if (!before?.hasMore || before.messages.some((message) => message.id === id)) break
      const loaded = await loadOlder()
      if (!loaded) break
    }
    for (let frame = 0; frame < 10 && !(element = messageElement(id)); frame += 1) await nextFrame()
    if (!element) return
    element.scrollIntoView?.({ block: 'center', behavior: 'smooth' })
    element.classList.remove('is-shown')
    void element.offsetWidth
    element.classList.add('is-shown')
    window.setTimeout(() => element!.classList.remove('is-shown'), 1400)
  }, [loadOlder])

  useEffect(() => {
    setChat(undefined); setDetail(undefined); setLoad(undefined); setPending([]); setNotes([]); setReplying(undefined); setError(undefined)
    failedSend.current = undefined
  }, [bot.id])

  const messages = chat?.messages ?? NO_MESSAGES
  const lastSeq = messages.at(-1)?.seq
  const firstId = messages[0]?.id
  useEffect(() => {
    if (lastSeq !== undefined && bot.unread > 0) void bots.markRead(bot.id, lastSeq).catch(() => undefined)
  }, [bot.id, bot.unread, bots, lastSeq])

  const legacy = bot.chat === undefined && bot.work === undefined && bot.threads === undefined
  const working = Boolean(bot.chat) || (legacy && bot.state === 'working')
  const offline = bot.chat ? Boolean(bot.chat.offline) : working && bot.waiting === 'internet'
  const work = bot.work ?? NO_WORK

  const resumeOn = useMemo(() => liveResumeLine(messages, { state: bot.state }), [messages, bot.state])
  const pauseLine = resumeOn ? messages.find((message) => message.id === resumeOn)?.error?.text : undefined

  const { rows, marks } = useMemo(() => {
    const shaped = chatRows(resumeOn ? messages.filter((message) => message.id !== resumeOn) : messages, bot.name)
    return { rows: withNotes(shaped.rows, notes), marks: shaped.marks }
  }, [messages, resumeOn, bot.name, notes])

  const shown = useMemo<BotChatRow[]>(
    () => (pending.length ? [...rows, ...pending.map((message) => ({ kind: 'message' as const, message }))] : rows),
    [rows, pending],
  )
  const places = useMemo(
    () => placeMessages(shown.map((row) => (row.kind === 'message' ? { author: senderOf(row.message), at: row.message.at } : { author: 'system', at: row.at }))),
    [shown],
  )
  const byId = useMemo(() => new Map(messages.map((message) => [message.id, message])), [messages])

  const retryOn = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]!
      if (message.author === 'owner') return ''
      if (message.kind === 'error' && botRetryOf(messages, message)) return message.id
    }
    return ''
  }, [messages])

  const anchor = useRef<{ firstId?: string; lastSeq?: number; height: number; atEnd: boolean }>({ height: 0, atEnd: true })
  const [unseen, setUnseen] = useState(false)
  const [away, setAway] = useState(false)
  useLayoutEffect(() => {
    const element = scroller.current
    if (!element) return
    const held = anchor.current
    if (held.firstId && firstId !== held.firstId && !held.atEnd) element.scrollTop += element.scrollHeight - held.height
    else if (held.atEnd) element.scrollTop = element.scrollHeight
    if (!held.atEnd && held.lastSeq !== undefined && lastSeq !== undefined && lastSeq > held.lastSeq && messages.at(-1)?.author === 'bot') setUnseen(true)
    anchor.current = { firstId, lastSeq, height: element.scrollHeight, atEnd: held.atEnd }
  }, [firstId, lastSeq, messages, pending.length, notes.length, working, bot.activity?.text, replying?.id, work.length])
  useEffect(() => { anchor.current = { height: 0, atEnd: true }; setUnseen(false); setAway(false) }, [bot.id])
  const toEnd = () => {
    const element = scroller.current
    if (element?.scrollTo) element.scrollTo({ top: element.scrollHeight, behavior: 'smooth' })
    else if (element) element.scrollTop = element.scrollHeight
    anchor.current.atEnd = true
    setUnseen(false)
    setAway(false)
  }

  // Find in chat (opened from BotMenuSheet).
  const find = useBotChatFind({
    botId: bot.id,
    rows: shown,
    hasMore: Boolean(chat?.hasMore),
    loadOlder,
    onNavigate: (id) => {
      anchor.current.atEnd = false
      void showMessage(id)
    },
  })
  const openFindRef = useRef(find.openFind)
  openFindRef.current = find.openFind
  useEffect(() => {
    if (findSignal > 0) openFindRef.current()
  }, [findSignal])

  const botError = bot.error?.text
  const botErrorAction = bot.error?.action
  const pinned = useMemo(
    () => pinnedOf(messages, { name: bot.name, state: bot.state, ...(botError ? { error: { text: botError, ...(botErrorAction ? { action: botErrorAction } : {}) } } : {}) }),
    [messages, bot.name, bot.state, botError, botErrorAction],
  )
  const pinnedKey = pinned.map((item) => `${item.kind}:${item.id ?? ''}`).join(' ')
  const [onScreen, setOnScreen] = useState('')
  const onScreenRef = useRef('')
  const measure = useCallback(() => {
    const element = scroller.current
    let visible = ''
    if (element && pinnedKey) {
      const view = element.getBoundingClientRect()
      visible = pinnedKey.split(' ').filter((entry) => {
        const id = entry.slice(entry.indexOf(':') + 1)
        const box = id ? element.querySelector(`[data-message-id="${CSS.escape(id)}"]`)?.getBoundingClientRect() : undefined
        return box && box.bottom > view.top + 24 && box.top < view.bottom - 24
      }).map((entry) => entry.slice(0, entry.indexOf(':'))).join(' ')
    }
    if (visible === onScreenRef.current) return
    onScreenRef.current = visible
    setOnScreen(visible)
  }, [pinnedKey])
  useLayoutEffect(() => { measure() }, [measure, messages.length, pending.length])
  const pinnedOff = pinned.filter((item) => !onScreen.split(' ').includes(item.kind))

  const sendDirect = useCallback(async (content: string, replyTarget?: BotChatQuote) => {
    const previous = failedSend.current
    const admission = previous?.text === content ? previous : { text: content, clientRequestId: crypto.randomUUID() }
    failedSend.current = undefined
    const local: BotChatMessage = {
      seq: Number.MAX_SAFE_INTEGER,
      id: `pending:${admission.clientRequestId}`,
      at: new Date().toISOString(),
      author: 'owner',
      kind: 'text',
      text: content,
      chips: [],
      ...(replyTarget ? { replyTo: replyTarget } : {}),
    }
    setPending((current) => [...current, local])
    setReplying(undefined)
    setError(undefined)
    anchor.current.atEnd = true
    try {
      const sent = await bots.send(bot.id, content, replyTarget?.id, admission.clientRequestId)
      setPending((current) => current.filter((message) => message.id !== local.id))
      put([sent])
      return true
    } catch (failure) {
      failedSend.current = admission
      setPending((current) => current.filter((message) => message.id !== local.id))
      setReplying((current) => current ?? replyTarget)
      setError(errorText(failure))
      return false
    }
  }, [bot.id, bots, put])

  const runCommand = useCallback(async (text: string): Promise<boolean> => {
    const command = parseBotCommand(text)
    if (!command) return false
    anchor.current.atEnd = true
    try {
      switch (command.kind) {
        case 'unknown':
          addNote(`/${command.name} isn't a command. Type / to see them.`, true)
          return true
        case 'invalid':
          addNote(command.text, true)
          return true
        case 'desktop_only':
          addNote(`/${command.name} runs on the computer. Open Mousse there to use it.`, true)
          return true
        case 'memory':
          if (onOpenMemory) onOpenMemory()
          else addNote('Open About to see saved memory.')
          return true
        case 'stop': {
          const ids = [...(bot.work ?? []).map((item) => item.id), ...(bot.watchers ?? []).map((item) => item.id)]
          const stops: Array<Promise<unknown>> = ids.map((id) => bots.stopWork(bot.id, id))
          if (bot.chat) stops.push(bots.stop(bot.id))
          if (!stops.length) { addNote('Nothing is running.'); return true }
          await Promise.all(stops)
          addNote(stops.length === 1 ? 'Stopped 1 thing.' : `Stopped ${stops.length} things.`)
          return true
        }
        case 'status': {
          const info = await bots.get(bot.id)
          addNote(statusText(bot, info))
          return true
        }
        case 'pause':
          if (bot.state === 'paused') { addNote('Already paused.'); return true }
          await bots.pause(bot.id)
          addNote('Paused: schedules and wake-ups are off.')
          return true
        case 'resume':
          await bots.resume(bot.id)
          addNote('Resumed.')
          return true
      }
    } catch (failure) {
      addNote(errorText(failure), true)
      return true
    }
  }, [addNote, bot, bots, onOpenMemory])

  const send = useCallback(async (text: string) => {
    const content = text.trim()
    if (!content) return false
    if (!replying && parseBotCommand(content)) {
      await runCommand(content)
      return true
    }
    return sendDirect(content, replying)
  }, [replying, runCommand, sendDirect])

  const retryFailed = useCallback(() => {
    if (!retryOn) return
    const failed = messages.find((message) => message.id === retryOn)
    if (!failed) return
    const payload = botRetryOf(messages, failed)
    if (!payload) return
    const quoted = payload.replyTo ? messages.find((message) => message.id === payload.replyTo) : undefined
    void sendDirect(payload.text, quoted ? quoteOf(quoted) : undefined)
  }, [retryOn, messages, sendDirect])

  const answer = useCallback(async (askId: string, value: 'allow' | 'not_now'): Promise<string | undefined> => {
    try {
      put([await bots.answer(bot.id, askId, value)])
      return undefined
    } catch (failure) {
      const msg = errorText(failure)
      if (value === 'allow' && /computer/i.test(msg)) return msg
      setError(msg)
      return undefined
    }
  }, [bot.id, bots, put])

  const answerAction = useCallback(async (actionId: string, digest: string, value: 'send' | 'not_now', serverName: string): Promise<BotActionRefusal | null> => {
    if (!bots.answerAction) return { reason: 'unsupported', text: 'Update Mousse on the computer to answer actions from your phone.' }
    const refused = await bots.answerAction(bot.id, actionId, digest, value, { botName: bot.name, serverName })
    void loadLatest()
    return refused
  }, [bot.id, bot.name, bots, loadLatest])

  const answerQuestion = useCallback(async (questionId: string, choice: string): Promise<boolean> => {
    if (!bots.answerQuestion) {
      setError('Update Mousse on the computer to tap answers from your phone.')
      return false
    }
    try {
      const result = await bots.answerQuestion(bot.id, questionId, choice)
      put([result.message, ...(result.question ? [result.question] : [])])
      return true
    } catch (failure) {
      setError(isBotsUnsupported(failure) ? 'Update Mousse on the computer to tap answers from your phone.' : errorText(failure))
      return false
    }
  }, [bot.id, bots, put])

  const snoozeReminder = useCallback(async (messageId: string, choice: BotSnoozeChoice): Promise<boolean> => {
    if (!bots.snoozeReminder) {
      setError('Update Mousse on the computer to snooze reminders from your phone.')
      return false
    }
    try {
      put([await bots.snoozeReminder(bot.id, messageId, choice)])
      return true
    } catch (failure) {
      setError(isBotsUnsupported(failure) ? 'Update Mousse on the computer to snooze reminders from your phone.' : errorText(failure))
      return false
    }
  }, [bot.id, bots, put])

  const stopWatcher = useCallback(async (watcherId: string) => {
    try {
      await bots.stopWork(bot.id, watcherId)
    } catch (failure) {
      setError(errorText(failure))
    }
  }, [bot.id, bots])

  const resume = useCallback(() => {
    void bots.resume(bot.id).catch((failure) => setError(errorText(failure)))
  }, [bot.id, bots])

  const reply = useCallback((message: BotChatMessage) => {
    setReplying(quoteOf(message))
    window.requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('.bot-chat .m-composer__input')?.focus())
  }, [])
  const show = useCallback((id: string) => { void showMessage(id) }, [showMessage])
  const stop = useCallback(() => {
    void bots.stop(bot.id).catch((failure) => setError(errorText(failure)))
  }, [bot.id, bots])

  const doingStatus = bot.activity ? `${bot.activity.text}${bot.activity.highlight ? ` ${bot.activity.highlight}` : ''}` : undefined
  const style = { '--bot-colour': BOT_COLOUR_HEX[normalizeBotLook(bot.look).colour] } as CSSProperties

  return (
    <MarkdownImageRenderer.Provider value={renderBotImage}>
      <ShowQuotedContext.Provider value={show}>
        <div className="m-thread bot-chat" style={style}>
          {find.open && (
            <div className="bot-find-bar" role="search" aria-label="Find in chat">
              <Search size={15} className="bot-find-bar__icon" aria-hidden />
              <input
                type="search"
                autoFocus
                placeholder="Find in chat"
                aria-label="Find in chat"
                value={find.query}
                onChange={(event) => find.setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') { event.preventDefault(); find.closeFind() }
                  if (event.key === 'Enter') { event.preventDefault(); if (event.shiftKey) find.prev(); else find.next() }
                }}
              />
              <span className="bot-find-bar__count" role="status">
                {find.query.trim()
                  ? find.matches.length
                    ? `${find.current + 1}/${find.matches.length}${find.loadingHistory ? '+' : ''}`
                    : find.loadingHistory ? '…' : '0'
                  : ''}
              </span>
              <button type="button" aria-label="Previous match" disabled={!find.matches.length} onClick={find.prev}><ChevronUp size={16} /></button>
              <button type="button" aria-label="Next match" disabled={!find.matches.length} onClick={find.next}><ChevronDown size={16} /></button>
              <button type="button" aria-label="Close find" onClick={find.closeFind}><X size={16} /></button>
            </div>
          )}
          <div
            ref={scroller}
            className="m-thread__scroll"
            {...{ [QUOTE_SOURCE_ATTRIBUTE]: '' }}
            onScroll={(event) => {
              const element = event.currentTarget
              anchor.current.atEnd = element.scrollHeight - element.scrollTop - element.clientHeight < 60
              anchor.current.height = element.scrollHeight
              if (anchor.current.atEnd) setUnseen(false)
              setAway(!anchor.current.atEnd)
              measure()
              if (element.scrollTop < 80 && chatRef.current?.hasMore) void loadOlder()
            }}
          >
            <div className="bot-transcript" role="log" aria-label={`${bot.name} messages`}>
              {!chat && load !== 'failed' && <div className="bot-load-state" role="status"><Loader2 size={14} className="m-sb-spin" aria-hidden />Loading messages…</div>}
              {!chat && load === 'failed' && (
                <div className="bot-load-state is-failed" role="status">
                  <span>Couldn’t load messages.</span>
                  <button type="button" onClick={() => void loadLatest()}>Retry</button>
                </div>
              )}
              {chat?.loadingOlder && <p className="bot-loading-older">Loading earlier messages…</p>}
              {chat && shown.length === 0 && (
                <div className="bot-empty">
                  <BotFace look={bot.look} state={botFaceState(bot)} size={104} view="full" />
                  <h2>{bot.name}</h2>
                  {bot.description && <p>{bot.description}</p>}
                </div>
              )}
              {shown.map((row, index) => {
                const place = places[index]!
                const day = place.day && <div className="bot-day" role="separator" aria-label={place.day}><span>{place.day}</span></div>
                if (row.kind === 'system') {
                  return (
                    <Fragment key={row.id}>
                      {day}
                      {row.expiredReviews?.length ? (
                        <details className="bot-expired-actions" aria-label="Expired action reviews">
                          <summary><span role="note">{row.text}</span></summary>
                          {row.expiredReviews.map((review) => (
                            <Message
                              key={review.id}
                              bot={bot}
                              allBots={allBots}
                              bots={bots}
                              message={review}
                              runs={detail?.runs}
                              quote={false}
                              starts={true}
                              onReply={reply}
                              onShow={show}
                              onAnswer={answer}
                              onAnswerAction={answerAction}
                              onAnswerQuestion={answerQuestion}
                              onSnoozeReminder={snoozeReminder}
                              onStopWatcher={stopWatcher}
                              onResume={resume}
                              onOpenMemory={onOpenMemory}
                              onOpenAbout={onOpenAbout}
                              onOpenThread={onOpenThread}
                            />
                          ))}
                        </details>
                      ) : (
                        <SystemLine row={row} />
                      )}
                    </Fragment>
                  )
                }
                const message = row.message
                const sending = index >= rows.length
                const above = shown[index - 1]
                const quote = Boolean(message.replyTo) && (sending || !((above?.kind === 'message' && above.message.id === message.replyTo!.id) || (above?.kind === 'system' && above.of === message.replyTo!.id)))
                return (
                  <Fragment key={message.id}>
                    {day}
                    <Message
                      bot={bot}
                      allBots={allBots}
                      bots={bots}
                      message={message}
                      asked={message.replyTo ? byId.get(message.replyTo.id) : undefined}
                      marks={marks.get(message.id)}
                      runs={detail?.runs}
                      pending={sending}
                      settled={message.error?.action?.kind === 'resume' && message.id !== resumeOn}
                      found={find.open && find.currentMessageId === message.id}
                      quote={quote}
                      starts={place.starts}
                      onReply={sending ? undefined : reply}
                      onShow={show}
                      onAnswer={answer}
                      onAnswerAction={answerAction}
                      onAnswerQuestion={answerQuestion}
                      onSnoozeReminder={snoozeReminder}
                      onStopWatcher={stopWatcher}
                      onResume={resume}
                      onRetry={message.id === retryOn ? retryFailed : undefined}
                      onOpenMemory={onOpenMemory}
                      onOpenAbout={onOpenAbout}
                      onOpenThread={onOpenThread}
                    />
                    {place.ends && <GroupTime message={message} pending={sending} />}
                  </Fragment>
                )
              })}
              {(working || offline) && <TypingBubble bot={bot} offline={offline} status={doingStatus} />}
              {bot.state === 'paused' && (
                <p className="bot-paused-line" role="status">
                  {(pauseLine ?? (bot.stateText.startsWith('Paused') ? bot.stateText : 'Paused')).replace(/\.$/, '')}. <button type="button" onClick={resume}>Resume</button>
                </p>
              )}
            </div>
          </div>
          <div className="m-thread__composer bot-chat__composer">
            {(unseen || away) && (
              <button type="button" className="bot-jump" onClick={toEnd}>
                <ArrowDown size={14} aria-hidden />{unseen ? 'New message' : 'Go to latest'}
              </button>
            )}
            {!!pinnedOff.length && (
              <div className="bot-pins" role="status" aria-label="Waiting on you">
                {pinnedOff.map((item) => {
                  const Icon = item.kind === 'ask' ? Shield : CircleAlert
                  return (
                    <button key={item.kind} type="button" className="bot-pinned" data-kind={item.kind} disabled={!item.id} onClick={() => { if (item.id) show(item.id) }}>
                      <Icon size={14} aria-hidden /><span>{item.text}</span>
                    </button>
                  )
                })}
              </div>
            )}
            {error && (
              <div className="bot-notice" role="alert">
                <CircleAlert size={15} aria-hidden /><span>{error}</span>
                <button type="button" aria-label="Dismiss" onClick={() => setError(undefined)}><X size={14} aria-hidden /></button>
              </div>
            )}
            {!!work.length && (
              <ul className="bot-work" aria-label={`${bot.name}'s work`}>
                {work.map((item) => (
                  <WorkLine key={item.id} item={item} chip={item.status === 'running' && !bot.chat ? bot.activity : undefined} onStop={() => void bots.stopWork(bot.id, item.id).catch((failure) => setError(errorText(failure)))} />
                ))}
              </ul>
            )}
            {replying && (
              <div className="bot-quote bot-replying" data-author={replying.author} role="status" aria-label={`Replying to ${quoteOwner(replying, bot.name)}: ${quoteLine(replying)}`}>
                <QuoteLine quote={replying} botName={bot.name} />
                <button type="button" aria-label="Don't reply to this message" onClick={() => setReplying(undefined)}><X size={14} aria-hidden /></button>
              </div>
            )}
            <Composer
              key={bot.id}
              active={working}
              placeholder={`Message ${bot.name}`}
              draftKey={`bot:${bot.id}`}
              prefill={prefill}
              slashCommands={BOT_COMPOSER_COMMANDS}
              onSend={(text) => send(text)}
              onStop={stop}
            />
          </div>
        </div>
      </ShowQuotedContext.Provider>
    </MarkdownImageRenderer.Provider>
  )
}
