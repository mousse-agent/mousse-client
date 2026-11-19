// About this bot on the phone (lazy-loaded bottom sheet), ported from
// mousse/src/renderer/components/bots/BotAboutPanel.tsx: doing line, foldable Context & cache,
// Can use with per-permission switches (#1140, #1637), Automations, Reminders with wake labels,
// Memory row opening BotMemorySheet, quick Rename / Change look, and Pause / Resume.
import { useEffect, useState, type ReactNode } from 'react'
import {
  isBotsUnsupported,
  type BotContextSummary,
  type BotDetail,
  type BotMemoryItem,
  type BotPermissionItem,
  type BotReminderItem,
  type BotRunItem,
  type BotTurnUsageSummary,
  type ComputerBots,
  type ListBot,
} from '../../connection/bots'
import {
  Activity,
  Bell,
  Brain,
  BrowserTab,
  ChevronRight,
  CircleGauge,
  Clock,
  Coins,
  Cpu,
  FileText,
  Folder,
  FolderSearch,
  GitPullRequest,
  Globe,
  Image as ImageIcon,
  Lock,
  MessagesSquare,
  Monitor,
  Palette,
  Pause,
  Pencil,
  Play,
  Plug,
  Search,
  ShieldCheck,
  Sparkles,
  Terminal,
  Zap,
  type IconComponent,
} from '../components/icons'
import { Button, Spinner } from '../components/primitives'
import { Sheet } from '../components/Sheet'
import { BotFace } from './face/BotFace'
import { memorySplitText } from './BotMemorySheet'
import { threadAge } from '../sidebar/model'

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

/** A reminder's line in About → Reminders, including wake descriptions. */
export function reminderWhenLine(reminder: BotReminderItem, now = new Date()): string {
  if (reminder.wake) return `Follows up ${reminder.wake}`
  return `${reminder.work ? 'Starts' : reminder.wake === '' ? 'Follows up' : 'Reminds'}: ${reminderWhenText(reminder.dueAt, now)}`
}

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)
const errorText = (error: unknown) => (error instanceof Error ? error.message : 'Something went wrong.')

function tokensText(tokens: number): string {
  if (tokens < 1000) return String(Math.round(tokens))
  if (tokens < 1_000_000) return `${tokens < 10_000 ? (tokens / 1000).toFixed(1).replace(/\.0$/, '') : Math.round(tokens / 1000)}k`
  return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
}

function shortDuration(ms: number): string {
  const sec = Math.max(1, Math.round(ms / 1000))
  if (sec < 60) return `${sec}s`
  const min = Math.round(sec / 60)
  if (min < 60) return `${min}m`
  const hrs = Math.round(min / 60)
  if (hrs < 48) return `${hrs}h`
  return `${Math.round(hrs / 24)}d`
}

function scheduleText(label: string): string {
  return capital(label.replace(' · ', ' at '))
}

function agoText(at: string, now: number): string {
  const ms = now - Date.parse(at)
  if (!Number.isFinite(ms)) return ''
  if (ms < 60_000) return 'just now'
  if (ms >= 24 * 3_600_000 && ms < 48 * 3_600_000) return 'yesterday'
  return `${shortDuration(ms)} ago`
}

/** A permission's own icon, matching desktop BotAboutPanel.permissionIcon. */
export function permissionIcon(item: Pick<BotPermissionItem, 'title'>): IconComponent {
  const title = item.title.toLowerCase()
  if (/github|pull request/.test(title)) return GitPullRequest
  if (/^use your .+ tools|^use .+'s new tools|mcp servers/.test(title)) return Plug
  if (/search the web/.test(title)) return Search
  if (/web pages/.test(title)) return Globe
  if (/browser/.test(title)) return BrowserTab
  if (/the computer/.test(title)) return Monitor
  if (/run commands/.test(title)) return Terminal
  if (/threads/.test(title)) return MessagesSquare
  if (/search in files|look through folders/.test(title)) return FolderSearch
  if (/edit files|create files/.test(title)) return Pencil
  if (/files|folder/.test(title)) return title.includes('folder') ? Folder : FileText
  if (/memory/.test(title)) return Brain
  if (/spend/.test(title)) return Coins
  if (/steps|per run|keep working|each run/.test(title)) return Activity
  if (/schedule|automation/.test(title)) return Clock
  if (/secret/.test(title)) return Lock
  if (/quick action/.test(title)) return Zap
  if (/looks/.test(title)) return Palette
  if (/profiler/.test(title)) return CircleGauge
  if (/skill/.test(title)) return Sparkles
  if (/model|thinks/.test(title)) return Cpu
  return ShieldCheck
}

function doingText(bot: ListBot, now: number): string {
  if (bot.state === 'paused') return 'Paused'
  const work = bot.work?.find((item) => item.status === 'running') ?? bot.work?.[0]
  if (work) return capital(work.title)
  if (bot.chat) return bot.chat.offline ? 'Waiting for the internet' : 'Writing a reply'
  if (bot.error) return bot.stateText || 'Stuck'
  if (bot.needsOwner) return bot.stateText || 'Waiting for you'
  return bot.last ? `Free · last message ${threadAge(Date.parse(bot.last.at), now)}` : 'Free'
}

function permissionsSummary(detail: BotDetail | undefined): string | undefined {
  if (!detail) return undefined
  const off = detail.permissions.filter((item) => item.enabled === false || (item.mark && !item.asksFirst) || item.gone).length
  const on = detail.permissions.length - off
  if (!detail.permissions.length) return 'Asks when it needs something'
  return off ? `${on} on · ${off} off` : `${on} on`
}

function automationsSummary(runs: readonly BotRunItem[]): string {
  if (!runs.length) return 'None'
  const next = runs.filter((run) => run.nextAt && !run.paused).map((run) => run.nextAt!).sort()[0]
  return next ? `${runs.length} · next ${nextRunText(next)}` : `${runs.length} · paused`
}

interface CacheWords { text: string; tone: 'ok' | 'warn' | 'quiet'; line: string }

function cacheWords(context: BotContextSummary | undefined, now: number): CacheWords | null {
  if (!context) return null
  const age = Math.max(0, now - context.lastRequestAt)
  const size = context.used ? `${tokensText(context.used)} ` : ''
  if (context.cacheTtlMs && context.cacheTtlMs > 0) {
    const left = context.cacheTtlMs - age
    if (left > 0) return { text: `Warm, ${shortDuration(left)} left`, tone: 'ok', line: `Next message reads ${size}from cache.` }
    return { text: `Expired ${shortDuration(-left)} ago`, tone: 'warn', line: `Next message sends ${size ? `all ${size}` : 'everything '}again.` }
  }
  return { text: `Idle ${shortDuration(age)}`, tone: 'quiet', line: 'The provider gives no cache lifetime.' }
}

type FoldId = 'context' | 'permissions' | 'automations' | 'reminders'

function Fold({ id, icon: Icon, title, summary, open, onToggle, children }: {
  id: FoldId
  icon: IconComponent
  title: string
  summary?: string
  open: boolean
  onToggle(id: FoldId): void
  children: ReactNode
}) {
  return (
    <section className={`bot-about-fold${open ? ' is-open' : ''}`} aria-labelledby={`bot-about-${id}`}>
      <button type="button" id={`bot-about-${id}`} className="bot-about-fold__head" aria-expanded={open} onClick={() => onToggle(id)}>
        <Icon size={15} aria-hidden className="bot-about-fold__icon" />
        <span className="bot-about-fold__title">{title}</span>
        {summary && <span className="bot-about-fold__summary">{summary}</span>}
        <ChevronRight size={14} aria-hidden className="bot-about-fold__chevron" />
      </button>
      {open && <div className="bot-about-fold__body">{children}</div>}
    </section>
  )
}

function PermissionSwitch({ label, checked, disabled, onChange }: {
  label: string
  checked: boolean
  disabled?: boolean
  onChange(enabled: boolean): void
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={`bot-switch${checked ? ' is-on' : ''}`}
      onClick={() => onChange(!checked)}
    >
      <span className="bot-switch__thumb" aria-hidden />
    </button>
  )
}

function ContextPanel({ context, usage, cache }: { context?: BotContextSummary; usage?: BotTurnUsageSummary; cache: CacheWords | null }) {
  const hasBar = Boolean(context?.used && context.window)
  const percent = hasBar ? Math.min(100, Math.round((context!.used! / context!.window!) * 100)) : 0
  const input = context ? context.turn.cacheRead + context.turn.cacheWrite + context.turn.fresh : 0
  const parts = context && hasBar
    ? [
      { label: 'Read from cache', color: 'var(--success)', tokens: context.turn.cacheRead },
      { label: 'Written to cache', color: 'var(--status-waiting)', tokens: context.turn.cacheWrite },
      { label: 'Sent fresh', color: 'var(--accent)', tokens: context.turn.fresh },
    ].filter((part) => part.tokens > 0).map((part) => ({ ...part, share: input > 0 ? part.tokens / input : 0 }))
    : []

  return (
    <div className="bot-about-surface">
      {hasBar ? (
        <div className="bot-about-context" data-testid="bot-about-context">
          <div className="bot-about-context__top">
            <strong>{percent}%</strong>
            <span>{tokensText(context!.used!)} of {tokensText(context!.window!)} tokens</span>
          </div>
          <div className="bot-context-bar" role="img" aria-label={`Context ${percent}% full`}>
            {parts.map((part) => (
              <div key={part.label} style={{ width: `${(part.share * (context!.used! / context!.window!) * 100).toFixed(1)}%`, backgroundColor: part.color }} />
            ))}
          </div>
          {parts.length > 0 && (
            <ul className="bot-context-breakdown" aria-label="Last turn's input">
              {parts.map((part) => (
                <li key={part.label}>
                  <span className="bot-context-swatch" style={{ backgroundColor: part.color }} />
                  <span>{part.label}</span>
                  <span>{Math.round(part.share * 100)}%</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <p className="bot-about__empty">Measured after its next message.</p>
      )}
      {cache && (
        <div className="bot-about-stat-row">
          <span><strong>Prompt cache</strong><small>{cache.line}</small></span>
          <span className={`bot-about-stat is-${cache.tone}`}>{cache.text}</span>
        </div>
      )}
      {usage && (
        <div className="bot-about-stat-row" data-testid="bot-about-usage">
          <span><strong>Last 7 days</strong><small>{usage.turns} turns · {tokensText(usage.inputPerTurn)} in, {tokensText(usage.outputPerTurn)} out</small></span>
          <span className="bot-about-stat">{Math.round(usage.cachedShare * 100)}% cached</span>
        </div>
      )}
    </div>
  )
}

export function BotAboutSheet({ open, bot, bots, onClose, onError, onOpenMemory, onOpenRename, onOpenLook }: {
  open: boolean
  bot: ListBot
  bots: ComputerBots
  onClose(): void
  onError(message: string): void
  onOpenMemory?(): void
  onOpenRename?(): void
  onOpenLook?(): void
}) {
  const [detail, setDetail] = useState<BotDetail>()
  const [memory, setMemory] = useState<BotMemoryItem[]>()
  const [memoryError, setMemoryError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [switching, setSwitching] = useState<string>()
  const [openFolds, setOpenFolds] = useState<FoldId[]>(['permissions', 'automations', 'reminders'])
  const [now, setNow] = useState(() => Date.now())

  const changeKey = `${bot.last?.at ?? ''}|${bot.state}`
  useEffect(() => {
    if (!open) return
    setNow(Date.now())
    let live = true
    bots.get(bot.id).then(
      (value) => { if (live) setDetail(value) },
      (error) => { if (live) onError(errorText(error)) },
    )
    bots.memory(bot.id).then(
      (value) => { if (live) { setMemory(value); setMemoryError(undefined) } },
      (error) => { if (live) setMemoryError(isBotsUnsupported(error) ? 'Update Mousse on the computer' : errorText(error)) },
    )
    return () => { live = false }
  }, [open, bot.id, bots, onError, changeKey])

  const toggleFold = (id: FoldId) => {
    setOpenFolds((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]))
  }

  const paused = bot.state === 'paused'
  const togglePause = async () => {
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

  const change = async (run: () => Promise<BotDetail>, what: string) => {
    try {
      setDetail(await run())
    } catch (error) {
      onError(isBotsUnsupported(error) ? `${what} on the computer: update Mousse there to do it from your phone.` : errorText(error))
    }
  }

  const togglePermission = async (item: BotPermissionItem, enabled: boolean) => {
    if (!bots.setPermission) {
      onError('Switch permissions on the computer: update Mousse there to do it from your phone.')
      return
    }
    setSwitching(item.id)
    try {
      setDetail(await bots.setPermission(bot.id, item.id, enabled))
    } catch (error) {
      onError(isBotsUnsupported(error) ? 'Switch permissions on the computer: update Mousse there to do it from your phone.' : errorText(error))
    } finally {
      setSwitching(undefined)
    }
  }

  const forgetDirect = async (entry: BotMemoryItem) => {
    try {
      await bots.forgetMemory(bot.id, entry.id)
      setMemory((current) => current?.filter((item) => item.id !== entry.id))
    } catch (error) {
      onError(errorText(error))
    }
  }

  const runs = detail?.runs ?? []
  const reminders = detail?.reminders ?? []
  const cache = cacheWords(detail?.context, now)
  const hasContext = Boolean(detail?.context || detail?.usage)

  return (
    <Sheet
      open={open}
      title={`About ${bot.name}`}
      onClose={onClose}
      footer={
        <div className="bot-about__foot">
          <Button variant="ghost" disabled={busy} onClick={() => void togglePause()}>
            {paused ? <><Play size={15} /> Resume</> : <><Pause size={15} /> Pause</>}
          </Button>
        </div>
      }
    >
      <div className="bot-about">
        <div className="bot-about__head">
          <BotFace look={bot.look} state={bot.state} size={84} view="full" label={bot.name} />
          <h2>{bot.name}</h2>
          <p className="bot-about__doing">{doingText(bot, now)}</p>
          {bot.description && <p className="bot-about__desc">{bot.description}</p>}
          {(onOpenRename || onOpenLook) && bots.update && (
            <div className="bot-about__quick">
              {onOpenRename && <button type="button" onClick={() => { onClose(); onOpenRename() }}><Pencil size={13} aria-hidden />Rename</button>}
              {onOpenLook && <button type="button" onClick={() => { onClose(); onOpenLook() }}><ImageIcon size={13} aria-hidden />Change look</button>}
            </div>
          )}
        </div>

        {hasContext && (
          <Fold
            id="context"
            icon={CircleGauge}
            title="Context and cache"
            summary={detail?.context?.used && detail.context.window ? `${Math.min(100, Math.round((detail.context.used / detail.context.window) * 100))}%` : undefined}
            open={openFolds.includes('context')}
            onToggle={toggleFold}
          >
            <ContextPanel context={detail?.context} usage={detail?.usage} cache={cache} />
          </Fold>
        )}

        <Fold
          id="permissions"
          icon={ShieldCheck}
          title="Can use"
          summary={permissionsSummary(detail)}
          open={openFolds.includes('permissions')}
          onToggle={toggleFold}
        >
          {!detail ? (
            <Spinner size={16} label="Loading" />
          ) : detail.permissions.length === 0 ? (
            <p className="bot-about__empty">Nothing yet. It asks in the chat the first time it needs something.</p>
          ) : (
            <div className="bot-about-surface">
              {detail.permissions.map((item) => {
                const Icon = permissionIcon(item)
                const off = item.mark ?? (item.gone ? 'Gone from Mousse' : undefined)
                return (
                  <div
                    key={item.id}
                    className={`bot-about__row${item.enabled === false ? ' is-off' : ''}${item.under ? ' is-indent' : ''}`}
                    data-testid="bot-about-permission"
                  >
                    <Icon size={15} aria-hidden />
                    <span>
                      <span className="bot-about__title-line">
                        {capital(item.title)}
                        {off && <span className="bot-about__badge">{off}</span>}
                      </span>
                      {item.note && <small>{item.note}</small>}
                    </span>
                    <div className="bot-about__controls">
                      {item.enabled !== undefined && (
                        <PermissionSwitch
                          label={item.title}
                          checked={item.enabled}
                          disabled={switching === item.id}
                          onChange={(enabled) => void togglePermission(item, enabled)}
                        />
                      )}
                      {!item.builtIn && (
                        <button
                          type="button"
                          aria-label={`Remove ${item.title}`}
                          onClick={() => void change(() => bots.revokePermission(bot.id, item.id), 'Remove this permission')}
                        >
                          Remove
                        </button>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </Fold>

        <Fold
          id="automations"
          icon={Clock}
          title="Automations"
          summary={detail ? automationsSummary(runs) : undefined}
          open={openFolds.includes('automations')}
          onToggle={toggleFold}
        >
          {runs.length > 0 ? (
            <div className="bot-about-surface">
              {runs.map((run) => (
                <div key={run.id} className="bot-about__row">
                  <Clock size={15} aria-hidden />
                  <span>
                    <span className="bot-about__title-line">
                      {run.name ?? scheduleText(run.label)}
                      {run.paused && <span className="bot-about__badge">Paused</span>}
                    </span>
                    <small>
                      {scheduleText(run.label)}
                      {run.nextAt && !run.paused ? ` · next ${nextRunText(run.nextAt)}` : ''}
                    </small>
                    {run.does && <small className="bot-about__clamp">{run.does}</small>}
                    {run.lastAt && (
                      <small>
                        Last ran {agoText(run.lastAt, now)}
                        {run.lastOutcome === 'failed' ? ', failed' : run.lastOutcome === 'stopped' ? ', stopped' : ''}
                      </small>
                    )}
                  </span>
                  <button
                    type="button"
                    aria-label={`Remove ${run.label}`}
                    onClick={() => void change(() => bots.removeSchedule(bot.id, run.id), 'Remove this schedule')}
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <p className="bot-about__empty">{detail ? 'Only when you message it. Ask it to run on a schedule.' : 'Loading…'}</p>
          )}
        </Fold>

        {reminders.length > 0 && (
          <Fold
            id="reminders"
            icon={Bell}
            title="Reminders"
            summary={`${reminders.length} · next ${reminderWhenText(reminders[0]!.dueAt)}`}
            open={openFolds.includes('reminders')}
            onToggle={toggleFold}
          >
            <div className="bot-about-surface">
              {reminders.map((reminder) => (
                <div key={reminder.id} className="bot-about__row" data-testid="bot-about-reminder">
                  {reminder.wake !== undefined ? <Clock size={15} aria-hidden /> : <Bell size={15} aria-hidden />}
                  <span>
                    <span className="bot-about__clamp">{reminder.text}</span>
                    <small>{reminderWhenLine(reminder)}</small>
                  </span>
                  <button
                    type="button"
                    aria-label={`Cancel reminder: ${reminder.text}`}
                    onClick={() => void change(() => bots.cancelReminder(bot.id, reminder.id), 'Cancel this reminder')}
                  >
                    Cancel
                  </button>
                </div>
              ))}
            </div>
          </Fold>
        )}

        {onOpenMemory ? (
          <button type="button" className="bot-about-memory-row" data-testid="bot-about-memory-open" onClick={() => { onClose(); onOpenMemory() }}>
            <Brain size={15} aria-hidden />
            <span className="bot-about-fold__title">Memory</span>
            <span className="bot-about-fold__summary">{memory ? memorySplitText(memory) : memoryError ?? 'Loading…'}</span>
            <ChevronRight size={14} aria-hidden />
          </button>
        ) : (
          <div className="bot-about-inline-memory">
            <h3>Memory</h3>
            {memory?.length ? memory.map((entry) => (
              <div key={entry.id} className="bot-about__row" data-testid="bot-about-memory">
                <Brain size={15} aria-hidden />
                <span><span className="bot-about__clamp">{entry.text}</span></span>
                <button type="button" aria-label={`Remove memory: ${entry.text}`} onClick={() => void forgetDirect(entry)}>Remove</button>
              </div>
            )) : <p className="bot-about__empty">{memory ? 'Nothing yet. Tell it what to remember.' : memoryError ?? 'Loading…'}</p>}
          </div>
        )}
      </div>
    </Sheet>
  )
}
