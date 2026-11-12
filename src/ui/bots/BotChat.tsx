// A bot's chat on the phone, after the desktop's BotChatView (mousse/src/renderer/components/bots):
// messages in groups (the bot's face and name once, one time under the last, a day line per day),
// chips, ask cards, error lines, reply quotes tinted by author, pictures; a status line while its
// chat turn runs; what waits on the owner pinned above the composer; its work above the composer;
// and a pill composer without a thread's run settings (a bot picks its own model). Files can't be
// sent from the phone.
import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { isBotsUnsupported, type BotAskCard, type BotChatMessage, type BotChatQuote, type BotChip, type BotChipIcon, type BotDetail, type BotError, type BotMemoryItem, type BotWorkItem, type ComputerBots, type ListBot } from '../../connection/bots'
import {
  AlertTriangle,
  ArrowDown,
  Bell,
  Brain,
  CircleAlert,
  CircleCheck,
  Clock,
  FileText,
  Globe,
  Loader2,
  Pause,
  Pencil,
  Play,
  Reply,
  Search,
  Shield,
  Sparkles,
  User,
  X,
  type IconComponent,
} from '../components/icons'
import { Composer } from '../components/Composer'
import { Sheet } from '../components/Sheet'
import { Button, Spinner } from '../components/primitives'
import { Markdown, MarkdownImageRenderer } from '../timeline/Markdown'
import { BotFace, type BotFaceState } from './face/BotFace'
import { BOT_COLOUR_HEX, normalizeBotLook } from './look'
import { botFullTime, botGroupTime, botMessageLabel, placeMessages } from './messageGroups'
import { BotImageFiles, BotOtherFiles, isImageAttachment, renderBotImage } from './BotImages'
import './bots.css'

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

/** How long work has run: "just now", "4 min", "1 h 20 min". */
export function workElapsed(startedAt: string, now = Date.now()): string {
  const minutes = Math.floor(Math.max(0, now - Date.parse(startedAt)) / 60_000)
  if (!Number.isFinite(minutes) || minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min`
  return `${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} min` : ''}`
}

/** The face's pose for a bot's state. */
export function botFaceState(bot: ListBot): BotFaceState {
  return bot.state
}

/** A message as a reply quote: who wrote it and its first line. */
export function quoteOf(message: BotChatMessage): BotChatQuote {
  const line = (message.text || message.error?.text || message.attachments?.map((file) => file.name).join(', ') || '').trim().split('\n').find((part) => part.trim())?.trim() ?? ''
  return { id: message.id, author: message.author, text: line.length > 160 ? `${line.slice(0, 159)}…` : line }
}

/** Something waiting on the owner, pinned above the composer: the message it is on (absent when not loaded) and its line. */
export interface BotPinned { kind: 'ask' | 'error'; id?: string; text: string }

/**
 * What stays pinned above the composer while the owner scrolls: the newest open ask, and the bot's current error.
 * Each points at its full message: the ask's own, and the newest message with that error (or any error).
 */
export function pinnedOf(messages: readonly BotChatMessage[], bot: Pick<ListBot, 'name' | 'error'>): BotPinned[] {
  const pinned: BotPinned[] = []
  const ask = messages.filter((message) => message.ask?.status === 'open').at(-1)
  if (ask) pinned.push({ kind: 'ask', id: ask.id, text: `${bot.name} wants to ${ask.ask!.title}` })
  if (bot.error) {
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

function BotChips({ chips }: { chips: BotChip[] }) {
  if (!chips.length) return null
  return <div className="bot-chips">{chips.map((chip, index) => <BotChipView key={`${index}:${chip.text}`} chip={chip} />)}</div>
}

const messageElement = (id: string) => {
  const element = document.querySelector(`.bot-chat [data-message-id="${CSS.escape(id)}"]`)
  return element instanceof HTMLElement ? element : null
}
const nextFrame = () => new Promise<void>((resolve) => { requestAnimationFrame(() => resolve()) })

/** Whose message a quote is, in its label. */
const quoteOwner = (quote: BotChatQuote, botName: string) => (quote.author === 'owner' ? 'your message' : `${botName}'s message`)
/** A quote's one line: the message's first line, "Files" for files alone, or that it was removed. */
const quoteLine = (quote: BotChatQuote) => (quote.gone ? 'This message was removed.' : quote.text || 'Files')

/** A quote's mark and line. The owner's are told by the accent tint, the bot's by its own colour; only the bot's carry a name. */
function QuoteLine({ quote, botName }: { quote: BotChatQuote; botName: string }) {
  return <>
    <Reply size={14} className="bot-quote-mark" aria-hidden />
    {quote.author === 'bot' && <strong>{botName}</strong>}
    <span>{quoteLine(quote)}</span>
  </>
}

function ReplyQuote({ quote, botName, onShow }: { quote: BotChatQuote; botName: string; onShow(id: string): void }) {
  return (
    <button type="button" className="bot-quote bot-reply-quote" data-author={quote.author} disabled={quote.gone} onClick={() => onShow(quote.id)} aria-label={`Replying to ${quoteOwner(quote, botName)}: ${quoteLine(quote)}`}>
      <QuoteLine quote={quote} botName={botName} />
    </button>
  )
}

function AskCard({ botName, ask, fromRun, onAnswer }: { botName: string; ask: BotAskCard; fromRun: boolean; onAnswer(answer: 'allow' | 'not_now'): Promise<void> }) {
  const [busy, setBusy] = useState(false)
  const answer = async (value: 'allow' | 'not_now') => {
    setBusy(true)
    try { await onAnswer(value) } finally { setBusy(false) }
  }
  const status = ask.status === 'allowed' ? 'Allowed' : ask.status === 'not_now' ? 'Not now' : ask.status === 'withdrawn' ? 'No longer needed' : undefined
  return (
    <div className="bot-ask" role="group" aria-label={`${botName} wants to ${ask.title}`}>
      <div className="bot-ask__title"><Shield size={16} aria-hidden /><span><strong>{botName}</strong> wants to {ask.title}</span></div>
      {ask.note && <p className="bot-ask__note">{ask.note}</p>}
      {status ? (
        <span className="bot-ask__answer"><CircleCheck size={13} aria-hidden />{status}</span>
      ) : ask.kind === 'export_memory' ? (
        <p className="bot-ask__note">Answer this on the computer: it needs a folder there.</p>
      ) : (
        <div className="bot-ask__actions">
          <Button variant="ghost" disabled={busy} onClick={() => void answer('not_now')}>Not now</Button>
          <Button disabled={busy} onClick={() => void answer('allow')}>{fromRun ? 'Allow from next run' : 'Allow'}</Button>
        </div>
      )}
    </div>
  )
}

function ErrorLine({ error, onResume }: { error: BotError; onResume(): void }) {
  // Sign in and provider set-up happen on the computer; Resume and Retry work from here.
  const action = error.action && (error.action.kind === 'resume' || error.action.kind === 'retry') ? error.action : undefined
  return (
    <div className="bot-error" role="status">
      <CircleAlert size={15} aria-hidden /><span>{error.text}{error.action && !action ? ` ${error.action.label} on the computer.` : ''}</span>
      {action && <button type="button" onClick={onResume}>{action.label}</button>}
    </div>
  )
}

function ReplyButton({ onReply }: { onReply(): void }) {
  return <button type="button" className="bot-reply-button" aria-label="Reply" onClick={onReply}><Reply size={15} aria-hidden /></button>
}

interface MessageProps {
  bot: ListBot
  bots: ComputerBots
  message: BotChatMessage
  /** Show the message this one answers (it is not the one right above). */
  quote: boolean
  /** The first of its group: the face and name, and the group's space above it. */
  starts: boolean
  pending?: boolean
  onReply?(message: BotChatMessage): void
  onShow(id: string): void
  onAnswer(askId: string, answer: 'allow' | 'not_now'): Promise<void>
  onResume(): void
}

// Messages render again only when they change: a lists push, a live chip or the bot starting work leaves them alone.
const sameMessage = (a: MessageProps, b: MessageProps) =>
  a.message === b.message && a.quote === b.quote && a.starts === b.starts && a.pending === b.pending && a.onReply === b.onReply && a.onShow === b.onShow &&
  a.onAnswer === b.onAnswer && a.onResume === b.onResume && a.bots === b.bots && a.bot.id === b.bot.id && a.bot.name === b.bot.name &&
  a.bot.look.colour === b.bot.look.colour && a.bot.look.accessory === b.bot.look.accessory && a.bot.look.kind === b.bot.look.kind && a.bot.look.eyes === b.bot.look.eyes

const Message = memo(function Message({ bot, bots, message, quote, starts, pending, onReply, onShow, onAnswer, onResume }: MessageProps) {
  const quoted = quote && message.replyTo
  const files = message.attachments ?? []
  // Images the computer marks as readable show as pictures; the rest (and every file on an older computer) as name pills.
  const images = !pending && files.some(isImageAttachment)
  if (message.author === 'owner') {
    return (
      <article className={`bot-msg bot-you${starts ? ' is-group-start' : ''}${quoted ? ' is-quoted' : ''}${pending ? ' is-pending' : ''}`} data-message-id={message.id} title={pending ? undefined : botFullTime(message.at)}>
        {quoted && <ReplyQuote quote={message.replyTo!} botName={bot.name} onShow={onShow} />}
        <div className="bot-you-line">
          {!pending && onReply && <ReplyButton onReply={() => onReply(message)} />}
          {/* As in a messaging app: the pictures first, the words under them, then any other files. */}
          <div className="bot-you-content">
            {images && <BotImageFiles files={files} bots={bots} botId={bot.id} messageId={message.id} />}
            {message.text && <div className="bot-you-bubble"><Markdown text={message.text} /></div>}
            {!!files.length && <BotOtherFiles files={files} images={images} />}
          </div>
        </div>
      </article>
    )
  }
  const label = botMessageLabel(message)
  return (
    <article className={`bot-msg bot-msg--bot${starts ? ' is-group-start' : ''}${quoted ? ' is-quoted' : ''}${message.kind === 'run_report' ? ' is-report' : ''}`} data-message-id={message.id} title={botFullTime(message.at)}>
      {/* Transcript faces are still: one baked pose per look, shared by every message. */}
      {starts
        ? <BotFace look={bot.look} state="idle" size={32} view="head" className="bot-msg__face" still />
        : <div className="bot-msg__gutter" aria-hidden />}
      <div className="bot-msg__body">
        {starts && <div className="bot-msg__meta"><strong>{bot.name}</strong>{label && <span className="bot-message-label">{label}</span>}{onReply && <ReplyButton onReply={() => onReply(message)} />}</div>}
        {!starts && (label || onReply) && (
          <div className="bot-msg__meta bot-msg__meta--later">{label && <span className="bot-message-label">{label}</span>}{onReply && <ReplyButton onReply={() => onReply(message)} />}</div>
        )}
        {quoted && <ReplyQuote quote={message.replyTo!} botName={bot.name} onShow={onShow} />}
        {message.text && <Markdown text={message.text} className="bot-msg__text" />}
        {!!files.length && <div className="bot-message-files"><BotImageFiles files={files} bots={bots} botId={bot.id} messageId={message.id} /><BotOtherFiles files={files} images={images} /></div>}
        <BotChips chips={message.chips} />
        {message.ask && <AskCard botName={bot.name} ask={message.ask} fromRun={message.kind === 'notice'} onAnswer={(answer) => onAnswer(message.ask!.askId, answer)} />}
        {message.error && <ErrorLine error={message.error} onResume={onResume} />}
      </div>
    </article>
  )
}, sameMessage)

/** One small time under a group's last message, on its sender's side; "Sending…" while that message is on its way. */
function GroupTime({ message, pending }: { message: BotChatMessage; pending: boolean }) {
  return (
    <div className="bot-group-time" data-author={message.author}>
      {pending ? <span>Sending…</span> : <time dateTime={message.at}>{botGroupTime(message.at)}</time>}
    </div>
  )
}

function workDoing(item: BotWorkItem, chip: BotChip | undefined): string {
  if (item.status === 'queued') return 'waiting its turn'
  if (item.status === 'waiting_for_internet') return 'waiting for internet'
  if (item.status === 'paused') return 'held'
  return chip ? `${chip.text}${chip.highlight ? ` ${chip.highlight}` : ''}` : 'working'
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

/** "Mon 09:00" for a run's next time; today's runs show the time alone. */
export function nextRunText(at: string, now = new Date()): string {
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return ''
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return date.toDateString() === now.toDateString() ? time : `${date.toLocaleDateString([], { weekday: 'short' })} ${time}`
}

/** When a reminder fires: like a run's next time within the week, else "14 Nov 09:00". */
export function reminderWhenText(at: string, now = new Date()): string {
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return ''
  if (date.getTime() - now.getTime() < 6 * 24 * 60 * 60_000) return nextRunText(at, now)
  return `${date.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
}

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

/** What the bot remembers, each with Remove; read again with the detail. An older computer says so plainly. */
function Memory({ bot, bots, detail }: { bot: ListBot; bots: ComputerBots; detail: BotDetail | undefined }) {
  const [entries, setEntries] = useState<BotMemoryItem[]>()
  const [error, setError] = useState<string>()
  const [unsupported, setUnsupported] = useState(false)
  useEffect(() => {
    if (!detail) return
    let live = true
    bots.memory(bot.id).then(
      (value) => { if (live) { setEntries(value); setError(undefined) } },
      (failure) => { if (!live) return; if (isBotsUnsupported(failure)) setUnsupported(true); else setError(errorText(failure)) },
    )
    return () => { live = false }
  }, [bot.id, bots, detail])
  if (unsupported) return <p className="bot-about__empty">Update Mousse on the computer to see what {bot.name} remembers here.</p>
  const remove = async (entry: BotMemoryItem) => {
    setError(undefined)
    try {
      await bots.forgetMemory(bot.id, entry.id)
      setEntries((current) => current?.filter((item) => item.id !== entry.id))
    } catch (failure) {
      setError(errorText(failure))
    }
  }
  return <>
    {entries?.length
      ? entries.map((entry) => (
        <div key={entry.id} className="bot-about__row" data-testid="bot-about-memory">
          <Brain size={15} aria-hidden /><span><span className="bot-about__clamp">{entry.text}</span></span>
          <button type="button" aria-label={`Remove memory: ${entry.text}`} onClick={() => void remove(entry)}>Remove</button>
        </div>
      ))
      : !error && <p className="bot-about__empty">{entries ? 'Nothing yet. Tell it what to remember.' : 'Loading…'}</p>}
    {error && <p className="bot-about__empty" role="alert">{error}</p>}
  </>
}

/** About this bot: what it does, what it can use, its reminders and schedules, what it remembers, and Pause or Resume. */
export function BotAboutSheet({ open, bot, bots, onClose, onError }: { open: boolean; bot: ListBot; bots: ComputerBots; onClose(): void; onError(message: string): void }) {
  const [detail, setDetail] = useState<BotDetail>()
  const [busy, setBusy] = useState(false)
  // The detail reads again when the bot's chat or state changes (an entry it just saved, a reminder said).
  const changeKey = `${bot.last?.at ?? ''}|${bot.state}`
  useEffect(() => {
    if (!open) return
    let live = true
    bots.get(bot.id).then((value) => { if (live) setDetail(value) }, (error) => { if (live) onError(errorText(error)) })
    return () => { live = false }
  }, [open, bot.id, bots, onError, changeKey])
  const paused = bot.state === 'paused'
  const toggle = async () => {
    setBusy(true)
    try {
      await (paused ? bots.resume(bot.id) : bots.pause(bot.id))
      onClose()
    } catch (error) {
      onError(errorText(error))
    } finally {
      setBusy(false)
    }
  }
  /** Cancel and Remove: the detail comes back without the item. An older computer can't, and says where to do it. */
  const change = async (run: () => Promise<BotDetail>, what: string) => {
    try {
      setDetail(await run())
    } catch (error) {
      onError(isBotsUnsupported(error) ? `${what} on the computer: update Mousse there to do it from your phone.` : errorText(error))
    }
  }
  const reminders = detail?.reminders ?? []
  return (
    <Sheet open={open} title={`About ${bot.name}`} onClose={onClose} footer={
      <div className="bot-about__foot">
        <Button variant="ghost" disabled={busy} onClick={() => void toggle()}>{paused ? <><Play size={15} /> Resume</> : <><Pause size={15} /> Pause</>}</Button>
      </div>
    }>
      <div className="bot-about">
        <div className="bot-about__head">
          <BotFace look={bot.look} state={botFaceState(bot)} size={96} view="full" label={bot.name} />
          <h2>{bot.name}</h2>
          {bot.description && <p>{bot.description}</p>}
        </div>
        <h3>Can use</h3>
        {!detail ? <Spinner size={16} label="Loading" /> : detail.permissions.length === 0
          ? <p className="bot-about__empty">Nothing yet. It asks in the chat the first time it needs something.</p>
          : detail.permissions.map((item) => (
            <div key={item.id} className="bot-about__row">
              <Shield size={15} aria-hidden /><span>{capital(item.title)}{item.note && <small>{item.note}</small>}</span>
              <button type="button" aria-label={`Remove ${item.title}`} onClick={() => void change(() => bots.revokePermission(bot.id, item.id), 'Remove this permission')}>Remove</button>
            </div>
          ))}
        <h3>Runs</h3>
        {reminders.map((reminder) => (
          <div key={reminder.id} className="bot-about__row" data-testid="bot-about-reminder">
            <Bell size={15} aria-hidden /><span><span className="bot-about__clamp">{reminder.text}</span><small>{reminder.work ? 'Starts' : 'Reminds'}: {reminderWhenText(reminder.dueAt)}</small></span>
            <button type="button" aria-label={`Cancel reminder: ${reminder.text}`} onClick={() => void change(() => bots.cancelReminder(bot.id, reminder.id), 'Cancel this reminder')}>Cancel</button>
          </div>
        ))}
        {detail?.runs.map((run) => (
          <div key={run.id} className="bot-about__row">
            <Clock size={15} aria-hidden /><span>{capital(run.label)}{run.nextAt && <small>Next: {nextRunText(run.nextAt)}</small>}</span>
            <button type="button" aria-label={`Remove ${run.label}`} onClick={() => void change(() => bots.removeSchedule(bot.id, run.id), 'Remove this schedule')}>Remove</button>
          </div>
        ))}
        {detail && !detail.runs.length && !reminders.length && <p className="bot-about__empty">Only when you message it. Ask it to run on a schedule.</p>}
        <h3>Memory</h3>
        <Memory bot={bot} bots={bots} detail={detail} />
        <p className="bot-about__empty bot-about__hint">Change its name and look by asking it, or in Mousse on the computer.</p>
      </div>
    </Sheet>
  )
}

const NO_WORK: BotWorkItem[] = []
const NO_MESSAGES: BotChatMessage[] = []

interface ChatCache { messages: BotChatMessage[]; hasMore: boolean; loadingOlder: boolean }

/** The chat of one bot on its computer. `bot` follows the computer's lists. */
export function BotChat({ bot, bots }: { bot: ListBot; bots: ComputerBots }) {
  const [chat, setChat] = useState<ChatCache>()
  const [load, setLoad] = useState<'loading' | 'failed'>()
  const [pending, setPending] = useState<BotChatMessage[]>([])
  const [error, setError] = useState<string>()
  const [replying, setReplying] = useState<BotChatQuote>()
  const scroller = useRef<HTMLDivElement>(null)
  const reads = useRef(0)
  const chatRef = useRef(chat)
  chatRef.current = chat
  const older = useRef<Promise<void>>()
  // The same words sent again after a failure reuse their request id, so they are not sent twice.
  const failedSend = useRef<{ text: string; clientRequestId: string }>()

  /** Puts messages in the chat; a confirmed owner message clears only the bubble sent with its request id. */
  const put = useCallback((incoming: BotChatMessage[], page?: { hasMore?: boolean; replace?: boolean }) => {
    setChat((current) => {
      const held = page?.replace ? [] : current?.messages ?? []
      return { messages: upsertMessages(held, incoming), hasMore: page?.hasMore ?? current?.hasMore ?? false, loadingOlder: current?.loadingOlder ?? false }
    })
    const owned = new Set(incoming.flatMap((message) => (message.author === 'owner' && message.clientRequestId ? [`pending:${message.clientRequestId}`] : [])))
    if (owned.size) setPending((current) => current.filter((message) => !owned.has(message.id)))
  }, [])

  // The lists stream says when the chat changed: a new message, an answered ask, a turn starting or ending.
  const changeKey = `${bot.last?.at ?? ''}|${bot.unread}|${bot.chat?.activationId ?? ''}|${bot.state}|${(bot.work ?? []).map((item) => `${item.id}:${item.status}`).join(',')}`
  const loadLatest = useCallback(async () => {
    const run = ++reads.current
    if (!chatRef.current) setLoad('loading')
    try {
      const page = await bots.chat(bot.id, { limit: BOT_CHAT_PAGE })
      if (run !== reads.current) return
      setLoad(undefined)
      const held = chatRef.current?.messages ?? []
      // A page that does not reach what is held leaves a gap (rows were missed): it starts the chat over.
      const first = page.messages[0]?.seq
      const gap = first !== undefined && held.length > 0 && held.at(-1)!.seq < first && !held.some((message) => message.seq === first)
      // A computer cuts a page to what fits one reply, so any page may have older messages before it.
      put(page.messages, { replace: gap || !chatRef.current, hasMore: gap || !chatRef.current ? page.messages.length > 0 : undefined })
    } catch (failure) {
      if (run !== reads.current) return
      if (chatRef.current) setError(errorText(failure))
      else setLoad('failed')
    }
  }, [bot.id, bots, put])
  useEffect(() => { void loadLatest() }, [loadLatest, changeKey])

  const loadOlder = useCallback((): Promise<void> => {
    const cache = chatRef.current
    if (older.current) return older.current
    if (!cache?.hasMore || !cache.messages.length) return Promise.resolve()
    const botId = bot.id
    setChat((current) => current && { ...current, loadingOlder: true })
    const operation = (async () => {
      try {
        const page = await bots.chat(botId, { beforeSeq: cache.messages[0]!.seq, limit: BOT_CHAT_PAGE })
        setChat((current) => current && { messages: upsertMessages(current.messages, page.messages), hasMore: page.messages.length > 0, loadingOlder: false })
      } catch (failure) {
        setError(errorText(failure))
        setChat((current) => current && { ...current, loadingOlder: false })
      } finally {
        older.current = undefined
      }
    })()
    older.current = operation
    return operation
  }, [bot.id, bots])

  /** Scrolls to a message and lights it briefly; one not loaded yet is loaded first, page by page of older history. */
  const showMessage = useCallback(async (id: string) => {
    let element = messageElement(id)
    for (let pages = 0; !element && pages < 40; pages += 1) {
      const before = chatRef.current
      if (!before?.hasMore || before.messages.some((message) => message.id === id)) break
      await loadOlder()
      const after = chatRef.current
      if (!after?.messages.length || after.messages[0]!.seq >= before.messages[0]!.seq) break
    }
    // The loaded page renders on its own schedule: wait a few frames for the message to be drawn.
    for (let frame = 0; frame < 10 && !(element = messageElement(id)); frame += 1) await nextFrame()
    if (!element) return
    element.scrollIntoView({ block: 'center', behavior: 'smooth' })
    element.classList.remove('is-shown')
    void element.offsetWidth
    element.classList.add('is-shown')
    window.setTimeout(() => element!.classList.remove('is-shown'), 1400)
  }, [loadOlder])

  useEffect(() => {
    setChat(undefined); setLoad(undefined); setPending([]); setReplying(undefined); setError(undefined)
    failedSend.current = undefined
  }, [bot.id])

  const messages = chat?.messages ?? NO_MESSAGES
  const lastSeq = messages.at(-1)?.seq
  const firstId = messages[0]?.id
  useEffect(() => {
    if (lastSeq !== undefined && bot.unread > 0) void bots.markRead(bot.id, lastSeq).catch(() => undefined)
  }, [bot.id, bot.unread, bots, lastSeq])

  // The chat's own turn: its status line and Stop. Work beside it has its line above the composer, and the chat stays free.
  // A computer from before work (no `chat` or `work` in its summary) says only that the bot works: that is the chat's.
  const legacy = bot.chat === undefined && bot.work === undefined
  const working = Boolean(bot.chat) || (legacy && bot.state === 'working')
  const offline = bot.chat ? Boolean(bot.chat.offline) : working && bot.waiting === 'internet'
  const work = bot.work ?? NO_WORK

  const shown = useMemo(() => (pending.length ? [...messages, ...pending] : messages), [messages, pending])
  const places = useMemo(() => placeMessages(shown), [shown])

  // New messages keep the end in view; a page loaded above keeps the reader where they were.
  // Scrolled up, a new message from the bot leaves the reader where they are and offers New message instead.
  const anchor = useRef<{ firstId?: string; lastSeq?: number; height: number; atEnd: boolean }>({ height: 0, atEnd: true })
  const [unseen, setUnseen] = useState(false)
  useLayoutEffect(() => {
    const element = scroller.current
    if (!element) return
    const held = anchor.current
    if (held.firstId && firstId !== held.firstId && !held.atEnd) element.scrollTop += element.scrollHeight - held.height
    else if (held.atEnd) element.scrollTop = element.scrollHeight
    if (!held.atEnd && held.lastSeq !== undefined && lastSeq !== undefined && lastSeq > held.lastSeq && messages.at(-1)?.author === 'bot') setUnseen(true)
    anchor.current = { firstId, lastSeq, height: element.scrollHeight, atEnd: held.atEnd }
  }, [firstId, lastSeq, messages, pending.length, working, bot.activity?.text, replying?.id, work.length])
  useEffect(() => { anchor.current = { height: 0, atEnd: true }; setUnseen(false) }, [bot.id])
  const toEnd = () => {
    const element = scroller.current
    if (element?.scrollTo) element.scrollTo({ top: element.scrollHeight, behavior: 'smooth' })
    else if (element) element.scrollTop = element.scrollHeight
    anchor.current.atEnd = true
    setUnseen(false)
  }

  // A pinned line hides while its full message is on screen, so it never shows twice. Measured by what it reads
  // (a string key), and set only when it changes: a re-render must never measure and set again in a loop.
  const botError = bot.error?.text
  const pinned = useMemo(() => pinnedOf(messages, { name: bot.name, ...(botError ? { error: { text: botError } } : {}) }), [messages, bot.name, botError])
  const pinnedKey = pinned.map((item) => `${item.kind}:${item.id ?? ''}`).join(' ')
  const [onScreen, setOnScreen] = useState('')
  const onScreenRef = useRef('')
  const measure = useCallback(() => {
    const element = scroller.current
    let shown = ''
    if (element && pinnedKey) {
      const view = element.getBoundingClientRect()
      shown = pinnedKey.split(' ').filter((entry) => {
        const id = entry.slice(entry.indexOf(':') + 1)
        const box = id ? element.querySelector(`[data-message-id="${CSS.escape(id)}"]`)?.getBoundingClientRect() : undefined
        return box && box.bottom > view.top + 24 && box.top < view.bottom - 24
      }).map((entry) => entry.slice(0, entry.indexOf(':'))).join(' ')
    }
    if (shown === onScreenRef.current) return
    onScreenRef.current = shown
    setOnScreen(shown)
  }, [pinnedKey])
  useLayoutEffect(() => { measure() }, [measure, messages.length, pending.length])
  const pinnedOff = pinned.filter((item) => !onScreen.split(' ').includes(item.kind))

  const send = useCallback(async (text: string) => {
    const content = text.trim()
    if (!content) return false
    const replyTo = replying
    const previous = failedSend.current
    const admission = previous?.text === content ? previous : { text: content, clientRequestId: crypto.randomUUID() }
    failedSend.current = undefined
    const local: BotChatMessage = { seq: Number.MAX_SAFE_INTEGER, id: `pending:${admission.clientRequestId}`, at: new Date().toISOString(), author: 'owner', kind: 'text', text: content, chips: [], ...(replyTo ? { replyTo } : {}) }
    setPending((current) => [...current, local])
    setReplying(undefined)
    setError(undefined)
    anchor.current.atEnd = true
    try {
      const sent = await bots.send(bot.id, content, replyTo?.id, admission.clientRequestId)
      setPending((current) => current.filter((message) => message.id !== local.id))
      put([sent])
      return true
    } catch (failure) {
      failedSend.current = admission
      setPending((current) => current.filter((message) => message.id !== local.id))
      setReplying((current) => current ?? replyTo)
      setError(errorText(failure))
      return false
    }
  }, [bot.id, bots, replying, put])

  const answer = useCallback(async (askId: string, value: 'allow' | 'not_now') => {
    try {
      put([await bots.answer(bot.id, askId, value)])
    } catch (failure) {
      setError(errorText(failure))
    }
  }, [bot.id, bots, put])
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

  // The bot's colour tints the quotes of its messages.
  const style = { '--bot-colour': BOT_COLOUR_HEX[normalizeBotLook(bot.look).colour] } as CSSProperties

  return (
    <MarkdownImageRenderer.Provider value={renderBotImage}>
      <div className="m-thread bot-chat" style={style}>
        <div
          ref={scroller}
          className="m-thread__scroll"
          onScroll={(event) => {
            const element = event.currentTarget
            anchor.current.atEnd = element.scrollHeight - element.scrollTop - element.clientHeight < 60
            anchor.current.height = element.scrollHeight
            if (anchor.current.atEnd) setUnseen(false)
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
            {shown.map((message, index) => {
              const place = places[index]!
              const sending = index >= messages.length
              // A reply shows what it answers unless that is the message right above it.
              const quote = Boolean(message.replyTo) && (sending || messages[index - 1]?.id !== message.replyTo!.id)
              return (
                <Fragment key={message.id}>
                  {place.day && <div className="bot-day" role="separator" aria-label={place.day}><span>{place.day}</span></div>}
                  <Message bot={bot} bots={bots} message={message} pending={sending} quote={quote} starts={place.starts} onReply={sending ? undefined : reply} onShow={show} onAnswer={answer} onResume={resume} />
                  {place.ends && <GroupTime message={message} pending={sending} />}
                </Fragment>
              )
            })}
            {offline
              ? <div className="bot-run-status" role="status">Waiting for internet</div>
              : working && (
                <div className="bot-run-status" role="status">
                  <Loader2 size={14} className="m-sb-spin" aria-hidden />{bot.name} is working…
                  {bot.activity && <BotChipView chip={{ ...bot.activity, live: true }} />}
                </div>
              )}
            {bot.state === 'paused' && (
              <p className="bot-paused-line" role="status">{bot.stateText.startsWith('Paused') ? bot.stateText : 'Paused'}. <button type="button" onClick={resume}>Resume</button></p>
            )}
          </div>
        </div>
        <div className="m-thread__composer bot-chat__composer">
          {unseen && <button type="button" className="bot-jump" onClick={toEnd}><ArrowDown size={14} aria-hidden />New message</button>}
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
            onSend={(text) => send(text)}
            onStop={stop}
          />
        </div>
      </div>
    </MarkdownImageRenderer.Provider>
  )
}
