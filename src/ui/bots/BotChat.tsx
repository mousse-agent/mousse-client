// A bot's chat on the phone, after the desktop's BotChatView (mousse/src/renderer/components/bots):
// the owner's bubbles and the bot's messages with chips, ask cards, error lines and reply quotes; a
// status line while its chat turn runs; its work above the composer; and the composer without a
// thread's run settings (a bot picks its own model). Files can't be sent from the phone.
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { BotAskCard, BotChatMessage, BotChatQuote, BotChip, BotChipIcon, BotDetail, BotError, BotWorkItem, ComputerBots, ListBot } from '../../connection/bots'
import {
  AlertTriangle,
  Brain,
  CircleAlert,
  CircleCheck,
  Clock,
  FileText,
  Globe,
  Loader2,
  Paperclip,
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
import { Button, Notice, Spinner } from '../components/primitives'
import { Markdown } from '../timeline/Markdown'
import { BotFace, type BotFaceState } from './face/BotFace'
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

function showMessage(id: string): void {
  const element = document.querySelector(`.bot-chat [data-message-id="${CSS.escape(id)}"]`)
  if (!(element instanceof HTMLElement)) return
  element.scrollIntoView({ block: 'center', behavior: 'smooth' })
  element.classList.remove('is-shown')
  void element.offsetWidth
  element.classList.add('is-shown')
  window.setTimeout(() => element.classList.remove('is-shown'), 1400)
}

function ReplyQuote({ quote, botName }: { quote: BotChatQuote; botName: string }) {
  return (
    <button type="button" className="bot-reply-quote" disabled={quote.gone} onClick={() => showMessage(quote.id)} aria-label={`Replying to ${quote.author === 'owner' ? 'your message' : `${botName}'s message`}: ${quote.text}`}>
      <strong>{quote.author === 'owner' ? 'You' : botName}</strong>
      <span>{quote.gone ? 'This message was removed.' : quote.text || 'Files'}</span>
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

interface MessageProps {
  bot: ListBot
  message: BotChatMessage
  quote: boolean
  pending?: boolean
  onReply?(message: BotChatMessage): void
  onAnswer(askId: string, answer: 'allow' | 'not_now'): Promise<void>
  onResume(): void
}

const Message = memo(function Message({ bot, message, quote, pending, onReply, onAnswer, onResume }: MessageProps) {
  const reply = onReply && !pending
    ? <button type="button" className="bot-reply-button" aria-label="Reply" title="Reply" onClick={() => onReply(message)}><Reply size={14} aria-hidden /></button>
    : null
  if (message.author === 'owner') {
    return (
      <article className={`bot-msg bot-msg--you${pending ? ' is-pending' : ''}`} data-message-id={message.id}>
        {quote && message.replyTo && <ReplyQuote quote={message.replyTo} botName={bot.name} />}
        {message.text && <div className="bot-you-bubble"><Markdown text={message.text} /></div>}
        {!!message.attachments?.length && (
          <div className="bot-you-files">{message.attachments.map((file, index) => <span key={`${index}:${file.name}`} className="bot-file-pill"><Paperclip size={12} aria-hidden />{file.name}</span>)}</div>
        )}
        <div className="bot-msg__meta">{reply}<time dateTime={message.at}>{pending ? 'Sending…' : botMessageTime(message.at)}</time></div>
      </article>
    )
  }
  return (
    <article className={`bot-msg bot-msg--bot${message.kind === 'run_report' ? ' is-report' : ''}`} data-message-id={message.id}>
      <BotFace look={bot.look} state="idle" size={32} view="head" className="bot-msg__face" still />
      <div className="bot-msg__body">
        <div className="bot-msg__meta bot-msg__meta--bot"><strong>{bot.name}</strong><time dateTime={message.at}>{botMessageTime(message.at)}</time>{reply}</div>
        {quote && message.replyTo && <ReplyQuote quote={message.replyTo} botName={bot.name} />}
        {message.text && <Markdown text={message.text} />}
        <BotChips chips={message.chips} />
        {message.ask && <AskCard botName={bot.name} ask={message.ask} fromRun={message.kind === 'notice'} onAnswer={(answer) => onAnswer(message.ask!.askId, answer)} />}
        {message.error && <ErrorLine error={message.error} onResume={onResume} />}
      </div>
    </article>
  )
})

function workDoing(item: BotWorkItem, chip: BotChip | undefined): string {
  if (item.status === 'queued') return 'waiting its turn'
  if (item.status === 'waiting_for_internet') return 'waiting for internet'
  if (item.status === 'paused') return 'held'
  return chip ? `${chip.text}${chip.highlight ? ` ${chip.highlight}` : ''}` : 'working'
}

function WorkLine({ item, chip, onStop }: { item: BotWorkItem; chip?: BotChip; onStop(): void }) {
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
      <button type="button" aria-label={`Stop ${item.title}`} title="Stop" onClick={onStop}><X size={13} aria-hidden /></button>
    </li>
  )
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : 'Something went wrong.')

/** About this bot: what it does, what it can use, its schedules, and Pause or Resume. */
export function BotAboutSheet({ open, bot, bots, onClose, onError }: { open: boolean; bot: ListBot; bots: ComputerBots; onClose(): void; onError(message: string): void }) {
  const [detail, setDetail] = useState<BotDetail>()
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!open) return
    let live = true
    bots.get(bot.id).then((value) => { if (live) setDetail(value) }, (error) => { if (live) onError(errorText(error)) })
    return () => { live = false }
  }, [open, bot.id, bots, onError])
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
          ? <p className="bot-about__empty">Only its own files and the web. It asks before anything else.</p>
          : detail.permissions.map((item) => (
            <div key={item.id} className="bot-about__row"><Shield size={15} aria-hidden /><span>{item.title}{item.note && <small>{item.note}</small>}</span></div>
          ))}
        <h3>Runs</h3>
        {!detail ? null : detail.runs.length === 0
          ? <p className="bot-about__empty">No schedules. Ask {bot.name} to do something every day or week.</p>
          : detail.runs.map((run) => (
            <div key={run.id} className="bot-about__row"><Clock size={15} aria-hidden /><span>{run.label}{run.nextAt && <small>Next {new Date(run.nextAt).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}</small>}</span></div>
          ))}
        <p className="bot-about__empty bot-about__hint">Change its name, look, permissions and memory by asking it, or in Mousse on the computer.</p>
      </div>
    </Sheet>
  )
}

const NO_WORK: BotWorkItem[] = []

/** The chat of one bot on its computer. `bot` follows the computer's lists. */
export function BotChat({ bot, bots }: { bot: ListBot; bots: ComputerBots }) {
  const [messages, setMessages] = useState<BotChatMessage[]>()
  const [pending, setPending] = useState<BotChatMessage[]>([])
  const [error, setError] = useState<string>()
  const [replying, setReplying] = useState<BotChatQuote>()
  const scroller = useRef<HTMLDivElement>(null)
  const atEnd = useRef(true)
  const reads = useRef(0)

  // The lists stream says when the chat changed: a new message, an answered ask, a turn starting or ending.
  const changeKey = `${bot.last?.at ?? ''}|${bot.unread}|${bot.chat?.activationId ?? ''}|${bot.state}|${(bot.work ?? []).map((item) => `${item.id}:${item.status}`).join(',')}`
  const load = useCallback(async () => {
    const run = ++reads.current
    try {
      const page = await bots.chat(bot.id)
      if (run !== reads.current) return
      setMessages(page.messages)
      setPending((current) => current.filter((message) => !page.messages.some((seen) => seen.author === 'owner' && seen.text === message.text && seen.seq >= 0)))
    } catch (failure) {
      if (run === reads.current) setError(errorText(failure))
    }
  }, [bot.id, bots])
  useEffect(() => { void load() }, [load, changeKey])
  useEffect(() => { setMessages(undefined); setPending([]); setReplying(undefined); atEnd.current = true }, [bot.id])

  const lastSeq = messages?.at(-1)?.seq
  useEffect(() => {
    if (lastSeq !== undefined && bot.unread > 0) void bots.markRead(bot.id, lastSeq).catch(() => undefined)
  }, [bot.id, bot.unread, bots, lastSeq])

  const working = Boolean(bot.chat) || (bot.chat === undefined && bot.work === undefined && bot.state === 'working')
  const offline = bot.chat ? Boolean(bot.chat.offline) : working && bot.waiting === 'internet'
  const work = bot.work ?? NO_WORK

  useLayoutEffect(() => {
    const element = scroller.current
    if (element && atEnd.current) element.scrollTop = element.scrollHeight
  }, [messages, pending.length, working, bot.activity?.text, replying?.id, work.length])

  const send = useCallback(async (text: string) => {
    const content = text.trim()
    if (!content) return false
    const replyTo = replying
    const local: BotChatMessage = { seq: -1, id: `local-${Date.now()}`, at: new Date().toISOString(), author: 'owner', kind: 'text', text: content, chips: [], ...(replyTo ? { replyTo } : {}) }
    setPending((current) => [...current, local])
    setReplying(undefined)
    setError(undefined)
    atEnd.current = true
    try {
      const sent = await bots.send(bot.id, content, replyTo?.id)
      setPending((current) => current.filter((message) => message.id !== local.id))
      setMessages((current) => (current && !current.some((message) => message.id === sent.id) ? [...current, sent] : current))
      return true
    } catch (failure) {
      setPending((current) => current.filter((message) => message.id !== local.id))
      setReplying(replyTo)
      setError(errorText(failure))
      return false
    }
  }, [bot.id, bots, replying])

  const answer = useCallback(async (askId: string, value: 'allow' | 'not_now') => {
    try {
      const updated = await bots.answer(bot.id, askId, value)
      setMessages((current) => current?.map((message) => (message.id === updated.id ? updated : message)))
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
  const stop = useCallback(() => {
    void bots.stop(bot.id).catch((failure) => setError(errorText(failure)))
  }, [bot.id, bots])

  const shown = messages ?? []

  return (
    <div className="m-thread bot-chat">
      <div
        ref={scroller}
        className="m-thread__scroll"
        onScroll={(event) => {
          const element = event.currentTarget
          atEnd.current = element.scrollHeight - element.scrollTop - element.clientHeight < 60
        }}
      >
        <div className="bot-transcript" role="log" aria-label={`${bot.name} messages`} aria-live="polite">
          {!messages && !error && <div className="m-loading m-loading--late"><Spinner label="Loading chat" /></div>}
          {messages && shown.length === 0 && pending.length === 0 && (
            <div className="bot-empty">
              <BotFace look={bot.look} state={botFaceState(bot)} size={104} view="full" />
              <h2>{bot.name}</h2>
              {bot.description && <p>{bot.description}</p>}
            </div>
          )}
          {shown.map((message, index) => (
            <Message key={message.id} bot={bot} message={message} quote={Boolean(message.replyTo) && shown[index - 1]?.id !== message.replyTo!.id} onReply={reply} onAnswer={answer} onResume={resume} />
          ))}
          {pending.map((message) => <Message key={message.id} bot={bot} message={message} pending quote={Boolean(message.replyTo)} onAnswer={answer} onResume={resume} />)}
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
          {bot.error && !shown.some((message) => message.error?.text === bot.error!.text) && <ErrorLine error={bot.error} onResume={resume} />}
        </div>
      </div>
      <div className="m-thread__composer bot-chat__composer">
        {error && <Notice>{error}</Notice>}
        {!!work.length && (
          <ul className="bot-work" aria-label={`${bot.name}'s work`}>
            {work.map((item) => (
              <WorkLine key={item.id} item={item} chip={item.status === 'running' && !bot.chat ? bot.activity : undefined} onStop={() => void bots.stopWork(bot.id, item.id).catch((failure) => setError(errorText(failure)))} />
            ))}
          </ul>
        )}
        {replying && (
          <div className="bot-replying" role="status">
            <Reply size={14} aria-hidden />
            <div><strong>Replying to {replying.author === 'owner' ? 'yourself' : bot.name}</strong><span>{replying.text || 'Files'}</span></div>
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
  )
}
