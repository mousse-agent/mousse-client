// Bot presence: activity sticker on the face, and bottom sheet listing work, background commands,
// and launched threads (adapted from mousse/src/renderer/components/bots/BotPresence.tsx).
import { Fragment, useEffect, useState, type ReactNode } from 'react'
import type { BotChip, BotLaunchedThread, BotWatcherItem, BotWorkItem, ListBot } from '../../connection/bots'
import {
  Activity,
  AppWindow,
  Brain,
  ChevronRight,
  Circle,
  CircleAlert,
  CircleCheck,
  CircleDotDashed,
  CircleX,
  Clock,
  EyeOff,
  FileText,
  Globe,
  Moon,
  Pencil,
  Search,
  Terminal,
  X,
} from '../components/icons'
import { Sheet } from '../components/Sheet'
import { threadAge } from '../sidebar/model'
import {
  launchedGroups,
  launchedLook,
  presenceOf,
  runningFor,
  stickerOf,
  type BotStickerKind,
  type LaunchedTone,
} from './botChatShape'
import { botDayLabel, botGroupTime } from './messageGroups'

/** How long work has run: "just now", "4 min", "1 h 20 min". */
export function workElapsed(startedAt: string, now = Date.now()): string {
  const minutes = Math.floor(Math.max(0, now - Date.parse(startedAt)) / 60_000)
  if (!Number.isFinite(minutes) || minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min`
  return `${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} min` : ''}`
}

export function workDoing(item: BotWorkItem, chip: BotChip | undefined): string {
  if (item.status === 'queued') return 'queued'
  if (item.status === 'waiting_for_internet') return 'waiting for internet'
  if (item.wait) {
    const event = item.wait.event
    if (!event) {
      const due = item.wait.dueAt
      const day = new Date(due).toDateString() === new Date().toDateString() ? '' : `${botDayLabel(due)} `
      return `checks again at ${day}${botGroupTime(due)}`
    }
    if (event.kind === 'pr') return `waits for ${event.repo}#${event.number}${event.on === 'checks' ? ' · its checks' : event.on === 'review' ? ' · a review' : ''}`
    return `waits for ${event.kind === 'thread' ? event.title ?? `thread ${event.threadId}` : event.title}`
  }
  if (item.status === 'paused') return item.waitsFor === 'answer' ? `waiting on you${item.detail ? ` · ${item.detail}` : ''}` : 'held'
  return chip ? `${chip.text}${chip.highlight ? ` ${chip.highlight}` : ''}` : 'working'
}

const STICKER_ICONS: Record<BotStickerKind, { icon: typeof Pencil; label: string }> = {
  typing: { icon: Pencil, label: 'Typing' },
  browser: { icon: AppWindow, label: 'Using the browser' },
  web: { icon: Globe, label: 'Reading the web' },
  search: { icon: Search, label: 'Searching the web' },
  command: { icon: Terminal, label: 'Running a command' },
  file: { icon: FileText, label: 'Working on files' },
  schedule: { icon: Clock, label: 'Setting a schedule' },
  memory: { icon: Brain, label: 'Remembering' },
  working: { icon: Activity, label: 'Working' },
  paused: { icon: Moon, label: 'Paused' },
}

export function BotActivitySticker({ bot, typing, offline }: { bot: ListBot; typing: boolean; offline: boolean }) {
  const presence = presenceOf(bot, { typing, offline })
  const chip = presence.lead && !bot.chat ? bot.activity : undefined
  const kind = stickerOf(presence, chip)
  if (!kind) return null
  const { icon: Icon, label } = STICKER_ICONS[kind]
  return (
    <span className="bot-sticker" data-kind={kind} role="img" aria-label={label} title={label}>
      <Icon size={10} strokeWidth={2.2} aria-hidden />
    </span>
  )
}

const TONE_ICONS: Record<LaunchedTone, typeof Circle> = {
  working: CircleDotDashed,
  waiting: CircleAlert,
  idle: Circle,
  done: CircleCheck,
  failed: CircleX,
}

function ThreadRow({ thread, now, onOpen }: { thread: BotLaunchedThread; now: number; onOpen?(threadId: string): void }) {
  const { tone, label } = launchedLook(thread.status)
  const Icon = TONE_ICONS[tone]
  const ago = threadAge(Date.parse(thread.updatedAt), now)
  const meta: ReactNode[] = [
    ...(thread.hidden ? [<span key="hidden" className="bot-thread-hidden"><EyeOff size={11} aria-hidden />Hidden</span>] : []),
    ...(thread.project ? [thread.project] : []),
    ...(ago ? [`updated ${ago}`] : []),
  ]
  return (
    <li className="bot-presence-item">
      <button
        type="button"
        className="bot-thread-line"
        data-tone={tone}
        disabled={!onOpen}
        onClick={() => onOpen?.(thread.threadId)}
      >
        <span className="bot-thread-top">
          <span className="bot-thread-title">{thread.title}</span>
          <span className="bot-thread-state"><Icon size={12} aria-hidden />{label}</span>
        </span>
        {meta.length > 0 && (
          <span className="bot-thread-meta">
            {meta.map((part, index) => <Fragment key={index}>{index > 0 && ' · '}{part}</Fragment>)}
          </span>
        )}
      </button>
    </li>
  )
}

export function BotPresenceSheet({ open, bot, onClose, onStopWork, onOpenThread }: {
  open: boolean
  bot: ListBot
  onClose(): void
  onStopWork(workId: string): void
  onOpenThread?(threadId: string): void
}) {
  const [now, setNow] = useState(() => Date.now())
  const [showRecent, setShowRecent] = useState(false)
  useEffect(() => {
    if (!open) return
    setNow(Date.now())
    setShowRecent(false)
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [open])

  const work = bot.work ?? []
  const ordered = [...work.filter((item) => item.status !== 'queued'), ...work.filter((item) => item.status === 'queued')]
  const watchers: BotWatcherItem[] = bot.watchers ?? []
  const { going, ended } = launchedGroups(bot.threads ?? [], now)
  const folds = ordered.length + watchers.length + going.length > 0 && ended.length > 0
  const recentShown = !folds || showRecent

  return (
    <Sheet open={open} title={`${bot.name}’s activity`} onClose={onClose}>
      <div className="bot-presence-sheet">
        {ordered.length > 0 && (
          <section aria-label="Work">
            <h3 className="bot-sheet-heading">Work</h3>
            <ul className="bot-presence-list">
              {ordered.map((item) => {
                const running = item.status === 'running'
                const chip = running && !bot.chat ? bot.activity : undefined
                const parts: string[] = [
                  workDoing(item, chip),
                  ...(item.model ? [item.model.name] : []),
                  ...(item.subagents?.length ? [item.subagents.length === 1 ? '1 subagent' : `${item.subagents.length} subagents`] : []),
                  ...(item.status === 'queued' ? [] : [workElapsed(item.startedAt, now)]),
                ]
                return (
                  <li key={item.id} className={`bot-presence-work${running ? ' is-running' : ''}`}>
                    <span className="bot-presence-work__text">
                      <strong>{item.title}</strong>
                      <small>{parts.join(' · ')}</small>
                    </span>
                    <button type="button" className="bot-presence-stop" aria-label={`Stop ${item.title}`} onClick={() => onStopWork(item.id)}>
                      <X size={15} aria-hidden />
                    </button>
                  </li>
                )
              })}
            </ul>
          </section>
        )}

        {watchers.length > 0 && (
          <section aria-label="Background work">
            <h3 className="bot-sheet-heading">Background work</h3>
            <ul className="bot-presence-list">
              {watchers.map((item) => (
                <li key={item.id} className="bot-presence-work is-running" title={item.lastLine ? `${item.command}\n${item.lastLine}` : item.command}>
                  <span className="bot-presence-work__text">
                    <strong>{item.title}</strong>
                    <small>{runningFor(item.startedAt, now)}{item.lastLine ? ` · ${item.lastLine}` : ''}</small>
                  </span>
                  <button type="button" className="bot-presence-stop" aria-label={`Stop ${item.title}`} onClick={() => onStopWork(item.id)}>
                    <X size={15} aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {going.length > 0 && (
          <section aria-label="Threads it started">
            <h3 className="bot-sheet-heading">Threads</h3>
            <ul className="bot-presence-list">
              {going.map((thread) => (
                <ThreadRow key={thread.threadId} thread={thread} now={now} onOpen={onOpenThread ? (id) => { onClose(); onOpenThread(id) } : undefined} />
              ))}
            </ul>
          </section>
        )}

        {ended.length > 0 && (
          <section aria-label="Recent threads">
            {folds ? (
              <button type="button" className="bot-presence-fold-toggle" aria-expanded={showRecent} onClick={() => setShowRecent((was) => !was)}>
                <ChevronRight size={14} className={showRecent ? 'is-open' : ''} aria-hidden />
                <span>Recent</span>
                <span className="bot-presence-count">{ended.length}</span>
              </button>
            ) : (
              <h3 className="bot-sheet-heading">Recent</h3>
            )}
            {recentShown && (
              <ul className="bot-presence-list">
                {ended.map((thread) => (
                  <ThreadRow key={thread.threadId} thread={thread} now={now} onOpen={onOpenThread ? (id) => { onClose(); onOpenThread(id) } : undefined} />
                ))}
              </ul>
            )}
          </section>
        )}

        {!ordered.length && !watchers.length && !going.length && !ended.length && (
          <p className="bot-about__empty">Nothing running right now.</p>
        )}
      </div>
    </Sheet>
  )
}
