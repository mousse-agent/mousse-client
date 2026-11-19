// Structured cards on a bot's message (facts, checklist, progress, gallery, automation, watcher),
// ported from mousse/src/renderer/components/bots/BotCards.tsx and BotStartedCards.tsx.
import { useEffect, useState, type ReactNode } from 'react'
import type {
  BotAutomationCard,
  BotChecklistCard,
  BotChecklistState,
  BotFactsCard,
  BotProgressCard,
  BotRemoteGalleryCard,
  BotRunItem,
  BotWatcherCard,
  BotWatcherItem,
  ComputerBots,
  RemoteBotCard,
} from '../../connection/bots'
import { Circle, CircleCheck, CircleDotDashed, CircleMinus, Clock, Paperclip, Terminal, X } from '../components/icons'
import { openLink } from '../timeline/actions'
import { runningFor } from './botChatShape'
import { BotImageFiles } from './BotImages'

/** A fact's value: plain words with inline `code`, **bold**, and [links](url). */
export function CardValue({ text }: { text: string }) {
  const parts: ReactNode[] = []
  const pattern = /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]\n]+)\]\(([^)\s]+)\)/g
  let at = 0
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0
    if (index > at) parts.push(text.slice(at, index))
    const key = `${index}`
    if (match[1] !== undefined) parts.push(<code key={key} className="bot-card-code">{match[1]}</code>)
    else if (match[2] !== undefined) parts.push(<strong key={key}>{match[2]}</strong>)
    else {
      const href = match[4]!
      const safe = /^https?:\/\//i.test(href)
      parts.push(
        safe
          ? <a key={key} href={href} onClick={(event) => { event.preventDefault(); openLink(href) }}>{match[3]}</a>
          : <span key={key}>{match[3]}</span>,
      )
    }
    at = index + match[0].length
  }
  if (at < text.length) parts.push(text.slice(at))
  return <>{parts}</>
}

function FactsCard({ card }: { card: BotFactsCard }) {
  return (
    <section className="bot-card bot-facts" aria-label={card.title ?? 'Details'}>
      {card.title && <p className="bot-card-title">{card.title}</p>}
      <dl className="bot-facts-rows">
        {card.rows.map((row, index) => (
          <div key={index} className="bot-facts-row">
            <dt>{row.label}</dt>
            <dd><CardValue text={row.value} /></dd>
          </div>
        ))}
      </dl>
    </section>
  )
}

const CHECK_ICON: Record<BotChecklistState, typeof Circle> = { done: CircleCheck, doing: CircleDotDashed, todo: Circle, skipped: CircleMinus }
const CHECK_LABEL: Record<BotChecklistState, string> = { done: 'Done', doing: 'In progress', todo: 'To do', skipped: 'Skipped' }

function ChecklistCard({ card }: { card: BotChecklistCard }) {
  return (
    <section className="bot-card bot-checklist" aria-label={card.title ?? 'Checklist'}>
      {card.title && <p className="bot-card-title">{card.title}</p>}
      <ul>
        {card.items.map((item, index) => {
          const Icon = CHECK_ICON[item.state]
          return (
            <li key={index} className={`is-${item.state}`}>
              <Icon size={15} aria-hidden />
              <span><span className="m-sr-only">{CHECK_LABEL[item.state]}: </span>{item.text}</span>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

function ProgressCard({ card }: { card: BotProgressCard }) {
  const share = card.total > 0 ? Math.min(1, Math.max(0, card.done / card.total)) : 0
  return (
    <section className="bot-card bot-progress" aria-label={card.label}>
      <p className="bot-progress-head">
        <span className="bot-progress-label">{card.label}</span>
        <span className="bot-progress-count">{card.done} of {card.total}</span>
      </p>
      <div className="bot-progress-track" role="progressbar" aria-label={card.label} aria-valuemin={0} aria-valuemax={card.total} aria-valuenow={card.done}>
        <div className="bot-progress-fill" style={{ width: `${(share * 100).toFixed(1)}%` }} />
      </div>
      {card.note && <p className="bot-progress-note">{card.note}</p>}
    </section>
  )
}

function GalleryCard({ card, bots, botId, messageId }: { card: BotRemoteGalleryCard; bots: ComputerBots; botId: string; messageId: string }) {
  const withIndex = card.files.filter((file): file is { name: string; caption?: string; index: number } => file.index !== undefined)
  const withoutIndex = card.files.filter((file) => file.index === undefined)
  return (
    <section className="bot-card bot-gallery" aria-label={card.title ?? 'Pictures'}>
      {card.title && <p className="bot-card-title">{card.title}</p>}
      {withIndex.length > 0 && (
        <BotImageFiles
          bots={bots}
          botId={botId}
          messageId={messageId}
          indexedFiles={withIndex.map((file) => ({ name: file.caption ?? file.name, index: file.index }))}
        />
      )}
      {withoutIndex.length > 0 && (
        <div className="bot-you-files">
          {withoutIndex.map((file, index) => (
            <span key={index} className="bot-file-pill"><Paperclip size={12} aria-hidden />{file.caption ?? file.name}</span>
          ))}
        </div>
      )}
    </section>
  )
}

export function BotWatcherRow({ card, watcher, onStop }: {
  card: BotWatcherCard
  watcher?: BotWatcherItem
  onStop?(): Promise<void>
}) {
  const [now, setNow] = useState(() => Date.now())
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!watcher) return
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [watcher])
  const stop = () => {
    if (busy || !onStop) return
    setBusy(true)
    void onStop().finally(() => setBusy(false))
  }
  return (
    <div className="bot-started-card" data-testid="bot-watcher-card" data-state={watcher ? 'running' : 'ended'} title={card.command}>
      <span className="bot-started-card__icon" aria-hidden><Terminal size={14} /></span>
      <span className="bot-started-card__body">
        <span className="bot-started-card__head">
          <span className="bot-started-card__title">{card.title}</span>
          <span className="bot-started-card__tag">Background</span>
        </span>
        <span className="bot-started-card__line">{watcher ? `Running · ${runningFor(watcher.startedAt, now)}` : 'Ended'}</span>
      </span>
      {watcher && onStop && (
        <button type="button" className="bot-started-card__action" disabled={busy} aria-label={`Stop ${card.title}`} onClick={stop}>
          <X size={13} aria-hidden />
          <span>Stop</span>
        </button>
      )}
    </div>
  )
}

export function BotAutomationRow({ card, runs, onOpenAbout }: {
  card: BotAutomationCard
  runs?: readonly BotRunItem[]
  onOpenAbout?(): void
}) {
  const run = runs?.find((entry) => entry.jobId === card.jobId)
  const gone = runs !== undefined && !run
  const paused = run?.paused === true
  const note = gone ? 'Removed' : paused ? 'Paused' : null
  const line = run?.label ?? card.label
  return (
    <div className="bot-started-card" data-testid="bot-automation-card" data-state={gone ? 'removed' : paused ? 'paused' : 'on'}>
      <span className="bot-started-card__icon" aria-hidden><Clock size={14} /></span>
      <span className="bot-started-card__body">
        <span className="bot-started-card__head">
          <span className="bot-started-card__title">{card.name}</span>
          <span className="bot-started-card__tag">Automation</span>
        </span>
        <span className="bot-started-card__line">
          {note && <span className="bot-started-card__note">{note} · </span>}
          {line}
        </span>
      </span>
      {!gone && onOpenAbout && (
        <button type="button" className="bot-started-card__action" onClick={onOpenAbout}>
          Manage
        </button>
      )}
    </div>
  )
}

/** Attachment indices already displayed inside a message's gallery cards, so the strip above the text skips them. */
export function galleryIndices(cards: readonly RemoteBotCard[] | undefined): ReadonlySet<number> {
  const indices = new Set<number>()
  for (const card of cards ?? []) {
    if (card.type === 'gallery') {
      for (const file of card.files) if (file.index !== undefined) indices.add(file.index)
    }
  }
  return indices
}

export function BotCards({ cards, bots, botId, messageId, watchers, runs, onStopWatcher, onOpenAbout }: {
  cards: readonly RemoteBotCard[]
  bots: ComputerBots
  botId: string
  messageId: string
  watchers?: readonly BotWatcherItem[]
  runs?: readonly BotRunItem[]
  onStopWatcher?(watcherId: string): Promise<void>
  onOpenAbout?(): void
}) {
  if (!cards.length) return null
  return (
    <div className="bot-cards">
      {cards.map((card, index) => {
        if (card.type === 'facts') return <FactsCard key={index} card={card} />
        if (card.type === 'checklist') return <ChecklistCard key={index} card={card} />
        if (card.type === 'progress') return <ProgressCard key={index} card={card} />
        if (card.type === 'gallery') return <GalleryCard key={index} card={card} bots={bots} botId={botId} messageId={messageId} />
        if (card.type === 'watcher') {
          const running = watchers?.find((item) => item.id === card.watcherId)
          return <BotWatcherRow key={index} card={card} watcher={running} {...(onStopWatcher ? { onStop: () => onStopWatcher(card.watcherId) } : {})} />
        }
        if (card.type === 'automation') return <BotAutomationRow key={index} card={card} runs={runs} onOpenAbout={onOpenAbout} />
        return null
      })}
    </div>
  )
}
