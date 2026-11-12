// The thread timeline, after the desktop's MessageList (agent-elements/message-list.tsx): turns
// of a user message and its replies, consecutive tool activity collapsed into groups, a
// "Working for…" line, per-message actions, the turn's file changes, and the end-of-thread
// states (interrupted, failed, provider unreachable, questions waiting).
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import type { ChatItem, QuestionAnswers, ThreadDisplayState, TurnEnd } from '../../connection/types'
import { normalizeToolName } from '../../connection/timelineItems'
import { copyText } from './actions'
import { PLAN_APPROVAL_PREFIX, RecoveredFailuresContext, TimelineActionsContext, type TimelineActions } from './context'
import {
  describeTurnProgress,
  foldTurnWork,
  formatResponseTime,
  formatTimestamp,
  formatTokens,
  formatTokensPerSecond,
  formatWorkedFor,
  formatWorkingFor,
  groupTurns,
  isActivity,
  isLiveThought,
  isRunningCall,
  recoveredFailures,
  segmentReplies,
  settleFinishedTurn,
  shortPath,
  toolFailed,
  turnEdits,
  workGroupIcon,
  workGroupTitle,
  type FoldRow,
  type Segment,
  type Turn,
} from './format'
import { Bot, Check, ChevronRight, CircleX, ThinkingIcon, Copy, FileText, Folder, Globe, Image as ImageIcon, Info, Link, Monitor, MessageSquare, Paperclip, VolumeHigh, X } from './icons'
import { Markdown } from './Markdown'
import { ImageLightbox } from './ImageLightbox'
import { AppletCard, AppletPending } from './AppletCard'
import { ReadAloudButton as ComputerReadAloudButton, useComputerSpeech } from '../speech/readAloud'
import { QuestionPrompt } from './QuestionPrompt'
import { DiffStat, PlanCard, Shimmer, Spinner, SubagentGroup, ToolGroup, ToolIcon, ToolItem } from './ToolCards'

// ---- Message actions ----

function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      className="m-tl-action"
      aria-label={copied ? 'Copied' : label}
      data-pinned={copied || undefined}
      onClick={() => {
        void copyText(text).then((ok) => {
          if (!ok) return
          setCopied(true)
          setTimeout(() => setCopied(false), 2000)
        })
      }}
    >
      {copied ? <Check size={14} /> : <Copy size={14} />}
    </button>
  )
}

const canSpeak = (): boolean => typeof window !== 'undefined' && 'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined'

function plainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#*_>~|-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Reads a reply aloud with the computer's read aloud model and voice. Without a computer that
 * offers speech (an older Mousse, the demo), the phone's own voice reads it instead.
 */
function ReadAloudButton({ text, speechKey }: { text: string; speechKey: string }) {
  const speech = useComputerSpeech()
  if (speech) return <ComputerReadAloudButton speechKey={speechKey} text={text} toolbar />
  return <DeviceReadAloudButton text={text} />
}

function DeviceReadAloudButton({ text }: { text: string }) {
  const [speaking, setSpeaking] = useState(false)
  useEffect(() => () => {
    if (speaking) window.speechSynthesis.cancel()
  }, [speaking])
  if (!canSpeak()) return null
  return (
    <button
      type="button"
      className="m-tl-action"
      aria-label={speaking ? 'Stop reading' : 'Read aloud'}
      data-pinned={speaking || undefined}
      onClick={() => {
        const synth = window.speechSynthesis
        if (speaking) {
          synth.cancel()
          setSpeaking(false)
          return
        }
        synth.cancel()
        const utterance = new SpeechSynthesisUtterance(plainText(text))
        utterance.onend = () => setSpeaking(false)
        utterance.onerror = () => setSpeaking(false)
        setSpeaking(true)
        synth.speak(utterance)
      }}
    >
      {speaking ? <X size={14} /> : <VolumeHigh size={14} />}
    </button>
  )
}

function MetadataButton({ item }: { item: ChatItem }) {
  const [open, setOpen] = useState(false)
  const meta = item.meta
  if (!meta) return null
  return (
    <span className="m-tl-meta">
      <button type="button" className="m-tl-action" aria-label="Response metadata" aria-expanded={open} data-pinned={open || undefined} onClick={() => setOpen((value) => !value)}>
        <Info size={14} />
      </button>
      {open && (
        <div className="m-tl-meta__panel" role="dialog" aria-label="Response metadata">
          <div className="m-tl-meta__title">
            Response metadata
            <button type="button" className="m-tl-meta__close" aria-label="Close" onClick={() => setOpen(false)}>
              <X size={12} />
            </button>
          </div>
          <dl>
            <dt>Model</dt>
            <dd>{meta.modelName || 'Unavailable'}</dd>
            <dt>Time taken</dt>
            <dd>{formatResponseTime(meta.totalResponseTimeMs)}</dd>
            <dt>Tokens</dt>
            <dd>{formatTokens(meta.tokensUsed)}</dd>
            <dt>Speed</dt>
            <dd>{meta.tokensPerSecond === undefined ? 'Unavailable' : `${formatTokensPerSecond(meta.tokensPerSecond)} tok/s`}</dd>
          </dl>
        </div>
      )}
    </span>
  )
}

// ---- User messages ----

const REFERENCE_ICONS = { file: FileText, project: Folder, thread: MessageSquare, terminal: Monitor, browser: Globe, agent: Bot } as const

/** A long prompt shows this much (px) until "Show full message" is tapped (user-message.tsx). */
export const PROMPT_FOLD_HEIGHT = 176

/** True when the text is at least twice the fold height, so folding it hides enough to matter. */
function useTallEnoughToFold(ref: RefObject<HTMLElement | null>, text: string): boolean {
  const [tall, setTall] = useState(false)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const measure = () => setTall(element.scrollHeight >= PROMPT_FOLD_HEIGHT * 2)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref, text])
  return tall
}

const UserMessage = memo(function UserMessage({ item }: { item: ChatItem }) {
  const [viewing, setViewing] = useState<{ src: string; name: string }>()
  const [expanded, setExpanded] = useState(false)
  const textRef = useRef<HTMLDivElement>(null)
  const foldable = useTallEnoughToFold(textRef, item.text)
  const folded = foldable && !expanded
  const images = item.images ?? []
  return (
    <div className="m-tl-user" data-testid="chat-item" data-role="user">
      {images.length > 0 && (
        <div className="m-tl-user__images">
          {images.map((image, index) =>
            image.data ? (
              <button key={index} type="button" className="m-tl-user__image" aria-label={`Open ${image.name}`} onClick={() => setViewing({ src: `data:${image.mimeType};base64,${image.data}`, name: image.name })}>
                <img src={`data:${image.mimeType};base64,${image.data}`} alt={image.name} />
              </button>
            ) : (
              <span key={index} className="m-tl-pill">
                <ImageIcon size={14} /> {image.name}
              </span>
            ),
          )}
        </div>
      )}
      {(item.files?.length || item.references?.length) && (
        <div className="m-tl-user__pills">
          {item.references?.map((reference, index) => {
            const Icon = REFERENCE_ICONS[reference.kind as keyof typeof REFERENCE_ICONS] ?? Link
            return (
              <span key={`r${index}`} className="m-tl-pill" title={reference.path ?? reference.url ?? reference.title}>
                <Icon size={14} /> {reference.title}
              </span>
            )
          })}
          {item.files?.map((name, index) => (
            <span key={`f${index}`} className="m-tl-pill" title={name}>
              <Paperclip size={14} /> {name.length > 24 ? `${name.slice(0, 20)}…${name.slice(name.lastIndexOf('.'))}` : name}
            </span>
          ))}
        </div>
      )}
      {item.text.trim() && (
        <div className="m-tl-user__bubble">
          <div ref={textRef} className={`m-tl-user__text${folded ? ' m-tl-user__text--folded' : ''}`}>
            {item.text}
          </div>
          {foldable && (
            <button type="button" className="m-tl-user__fold" aria-expanded={expanded} onClick={() => setExpanded((open) => !open)}>
              {expanded ? 'Show less' : 'Show full message'}
            </button>
          )}
        </div>
      )}
      <div className="m-tl-toolbar m-tl-toolbar--user">
        {item.createdAt > 0 && <time className="m-tl-toolbar__time" dateTime={new Date(item.createdAt).toISOString()}>{formatTimestamp(item.createdAt)}</time>}
        {item.text.trim() && <CopyButton text={item.text} />}
      </div>
      {viewing && <ImageLightbox src={viewing.src} name={viewing.name} onClose={() => setViewing(undefined)} />}
    </div>
  )
})

// ---- Assistant and system rows ----

/** The title of a failed request: the provider's own refusal, or Mousse's (mousseToUI.ts errorTitle). */
export function errorTitle(code: string | undefined): string {
  if (code === 'provider_usage_limit') return 'Usage limit reached'
  return code?.startsWith('provider_') ? 'Provider error' : 'Request failed'
}

/** A message and the reference it was logged under at its end (`… Reference: 1ecec6b5-…`), apart. */
export function splitErrorReference(message: string): { text: string; reference?: string } {
  const match = /\s*Reference:\s*(\S+)\s*$/.exec(message)
  if (!match) return { text: message.trim() }
  return { text: message.slice(0, match.index).trim(), reference: match[1] }
}

/**
 * A failed request (error-message.tsx): the title in the danger colour, then the message as the provider or Mousse
 * gave it, and the reference it was logged under on a quiet line.
 */
function ErrorBox({ title = 'Request failed', message }: { title?: string; message: string }) {
  const { text, reference } = splitErrorReference(message)
  return (
    <div className="m-tl-error" role="alert">
      <CircleX size={16} className="m-tl-error__icon" />
      <div>
        <div className="m-tl-error__title">{title}</div>
        <div className="m-tl-error__message">{text}</div>
        {reference && <div className="m-tl-error__meta">Reference {reference}</div>}
      </div>
    </div>
  )
}

const AssistantMessage = memo(function AssistantMessage({ item, live }: { item: ChatItem; live: boolean }) {
  const streaming = item.status === 'streaming' && live
  const showActions = !streaming && !item.incomplete && item.status !== 'streaming' && !!item.text.trim()
  return (
    <div className="m-tl-assistant" data-testid="chat-item" data-role="assistant" data-status={item.status} aria-busy={streaming || undefined}>
      {item.parts ? (
        item.parts.map((part, index) =>
          part.type === 'applet' ? (
            <AppletCard key={`a${index}`} applet={part.applet} />
          ) : part.type === 'applet-pending' ? (
            <AppletPending key={`p${index}`} />
          ) : part.text.trim() ? (
            <div key={`t${index}`} className="m-tl-assistant__text">
              <Markdown text={part.text} streaming={streaming} />
            </div>
          ) : null,
        )
      ) : item.text.trim() && (
        <div className="m-tl-assistant__text">
          <Markdown text={item.text} streaming={streaming} />
        </div>
      )}
      {item.error && <ErrorBox title={errorTitle(item.error.code)} message={item.error.message} />}
      {item.incomplete && !streaming && <div className="m-tl-note">This reply stopped before it finished.</div>}
      {showActions && (
        <div className="m-tl-toolbar">
          <CopyButton text={item.text} />
          <ReadAloudButton text={item.text} speechKey={item.id} />
          <MetadataButton item={item} />
        </div>
      )}
    </div>
  )
})

function SystemRow({ item, live }: { item: ChatItem; live: boolean }) {
  switch (item.kind) {
    case 'compaction': {
      const compacting = item.status === 'streaming' && live
      return (
        <div className="m-tl-chrome m-tl-row" data-testid="chat-item" data-role="system" data-animating={compacting || undefined}>
          <div className="m-tl-row__header">
            <span className="m-tl-row__icon">{compacting ? <Spinner size={16} /> : <Check size={16} />}</span>
            <Shimmer active={compacting} className="m-tl-row__label">{compacting ? 'Compacting context…' : 'Context compacted'}</Shimmer>
            {!compacting && item.text.trim() && <span className="m-tl-row__detail">{item.text.trim().split('\n')[0]}</span>}
          </div>
        </div>
      )
    }
    case 'handoff':
      return (
        <div className="m-tl-handoff" data-testid="chat-item" data-role="system">
          <span>{item.handoff?.from || 'Model'}</span>
          <ChevronRight size={12} />
          <span>{item.handoff?.to || 'Model'}</span>
        </div>
      )
    case 'warning':
      return (
        <div className="m-tl-warning" data-testid="chat-item" data-role="system">
          <Markdown text={item.text} />
        </div>
      )
    case 'progress':
      return (
        <div className="m-tl-progress" data-testid="chat-item" data-role="system">
          <Markdown text={item.text} />
        </div>
      )
    default:
      return (
        <div className={`m-tl-system${item.status === 'error' ? ' m-tl-system--error' : ''}`} data-testid="chat-item" data-role="system">
          {item.text}
        </div>
      )
  }
}

/** Items from older code paths name a tool but carry no call; show them as a generic tool. */
function withTool(item: ChatItem): ChatItem {
  if (item.tool || item.role !== 'tool') return item
  const name = item.toolName || 'tool'
  const [title = '', ...rest] = item.text.split('\n')
  const subject = title.replace(/^\$\s*/, '')
  const input = { file_path: subject, command: subject, pattern: subject }
  return { ...item, kind: 'tool', tool: { name: normalizeToolName(name), rawName: name, title: name, summary: title, details: [], input, output: [title, ...rest].join('\n') } }
}

function ReplyItem({ item: raw, live, nested }: { item: ChatItem; live: boolean; nested?: ChatItem[] }) {
  const item = withTool(raw)
  if (item.kind === 'plan' && item.plan)
    return <PlanCard id={item.id} title={item.plan.title} markdown={item.plan.markdown} running={item.status === 'streaming' && live} />
  if (item.kind === 'thinking' || item.kind === 'tool' || item.role === 'tool')
    return (
      <div data-testid="chat-item" data-role="tool">
        <ToolItem item={item} live={live} nested={nested} />
      </div>
    )
  if (item.role === 'system' || item.kind === 'compaction' || item.kind === 'handoff' || item.kind === 'progress' || item.kind === 'warning')
    return <SystemRow item={item} live={live} />
  return <AssistantMessage item={item} live={live} />
}

// ---- Turn decorations ----

function WorkStatus({
  live,
  startedAt,
  durationMs,
  fold,
  end,
}: {
  live: boolean
  startedAt?: number
  durationMs?: number
  /** A finished turn whose work folds behind this line: the line opens it in place ("Worked for 32s ›"). */
  fold?: { open: boolean; onToggle: () => void }
  /** A finished turn that a Stop, a restart or a crash cut off: " · Stopped" after its time. */
  end?: TurnEnd
}) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!live) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [live])
  const elapsed = live && startedAt ? Math.max(0, now - startedAt) : durationMs
  // A turn with work to open always has its line, even with no time to show.
  const label = elapsed !== undefined ? (live ? formatWorkingFor(elapsed) : formatWorkedFor(elapsed)) : fold && !live ? 'Worked' : undefined
  const mark = !live && end ? <TurnEndLabel end={end} separate={label !== undefined} /> : null
  if (label === undefined && !mark) return null
  return (
    <div className="m-tl-work" data-testid="work-status" data-live={live || undefined}>
      {fold && !live ? (
        <button type="button" className="m-tl-work__label m-tl-work__toggle" aria-expanded={fold.open} onClick={fold.onToggle}>
          {label}
          {mark}
          <ChevronRight size={14} className={`m-tl-work__chevron${fold.open ? ' m-tl-work__chevron--open' : ''}`} />
        </button>
      ) : (
        <Shimmer active={live} className="m-tl-work__label">
          {label}
          {mark}
        </Shimmer>
      )}
      <div className="m-tl-work__rule" aria-hidden />
    </div>
  )
}

const TURN_END_WORDS: Record<TurnEnd['cause'], { word: string; detail: string }> = {
  user: { word: 'Stopped', detail: 'You stopped this turn before it finished.' },
  agent: { word: 'Stopped', detail: 'An agent in another thread stopped this turn.' },
  daemon_restart: { word: 'Interrupted', detail: 'Mousse restarted during this turn.' },
  crash: { word: 'Interrupted', detail: 'Mousse quit during this turn.' },
}

/** " · Stopped" after a cut-off turn's time: one muted word; why goes to its tooltip and to screen readers. */
function TurnEndLabel({ end, separate }: { end: TurnEnd; separate: boolean }) {
  const { word, detail } = TURN_END_WORDS[end.cause] ?? TURN_END_WORDS.user
  const title = end.tools?.length ? `${detail} May have run: ${end.tools.join(', ')}` : detail
  return (
    <>
      {separate ? ' · ' : null}
      <span className="m-tl-work__end" data-turn-end={end.cause} title={title}>
        {word}
        <span className="m-sr-only">: {title}</span>
      </span>
    </>
  )
}

/**
 * The live line at the end of a running turn (turn-progress.tsx): what it does now, in a few words. Thinking shows
 * the turning atom; a running tool its own icon, pulsing; anything else three small dots.
 */
function TurnProgressRow({ replies, phase, waiting }: { replies: ChatItem[]; phase?: string; waiting: boolean }) {
  const progress = describeTurnProgress(replies, phase, waiting)
  if (!progress) return null
  const thinking = progress.kind === 'thinking' || progress.kind === 'starting' || progress.kind === 'finishing'
  return (
    <div className="m-tl-progress-line" role="status" data-testid="turn-progress" data-kind={progress.kind}>
      {thinking ? (
        <span className="m-tl-icon"><ThinkingIcon size={18} active /></span>
      ) : progress.tool ? (
        <ToolIcon name={progress.tool} state="running" />
      ) : (
        <span className="m-tl-dots" aria-hidden><span /><span /><span /></span>
      )}
      <span className="m-tl-progress-line__label">{progress.label}</span>
      {progress.detail && <span className="m-tl-progress-line__detail">{progress.detail}</span>}
    </div>
  )
}

function EditSummary({ replies }: { replies: ChatItem[] }) {
  const edits = useMemo(() => turnEdits(replies), [replies])
  const [open, setOpen] = useState(true)
  if (!edits) return null
  return (
    <div className="m-tl-edits" data-testid="turn-edits">
      <button type="button" className="m-tl-edits__header" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <span>
          {edits.files.length} changed {edits.files.length === 1 ? 'file' : 'files'}
        </span>
        <DiffStat added={edits.added} removed={edits.removed} />
        <ChevronRight size={14} className="m-tl-row__chevron" />
      </button>
      {open && (
        <ul className="m-tl-edits__list">
          {edits.files.map((file) => (
            <li key={file.path} className="m-tl-edits__file">
              <FileText size={14} />
              <span className="m-tl-edits__path" title={file.path}>
                {shortPath(file.path)}
              </span>
              <DiffStat added={file.added} removed={file.removed} />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** Tool calls whose id is `<task id>:<child>` belong inside that task's card, like the desktop. */
function nestUnderTasks(replies: ChatItem[]): { flow: ChatItem[]; nested: Map<string, ChatItem[]> } {
  const tasks = new Set(replies.filter((item) => item.tool?.name === 'Task' || item.tool?.name === 'Agent').map((item) => item.id))
  const nested = new Map<string, ChatItem[]>()
  if (!tasks.size) return { flow: replies, nested }
  const flow: ChatItem[] = []
  for (const item of replies) {
    const parent = item.id.includes(':') ? item.id.split(':')[0] : undefined
    if (parent && tasks.has(parent) && item.kind === 'tool') {
      const list = nested.get(parent) ?? []
      list.push(item)
      nested.set(parent, list)
    } else flow.push(item)
  }
  return { flow, nested }
}

/** What folding needs to know of one segment of a finished turn. */
function foldRowOf(segment: Segment, recovered: ReadonlySet<string>): FoldRow {
  const unrecovered = (item: ChatItem) => toolFailed(item) && !recovered.has(item.id)
  if (segment.kind === 'group') return { kind: 'tools', keep: segment.items.some(unrecovered) }
  // Subagents still working stay in view.
  if (segment.kind === 'cards') return { kind: 'cards', running: segment.items.some((item) => item.status === 'streaming') }
  const item = segment.item
  if (isActivity(item)) return { kind: 'message', toolsOnly: true, keep: unrecovered(item) }
  // Errors, questions, plans, quick actions, notices, Mousse's own markers and applets stay in view.
  if (item.role !== 'assistant' || item.kind !== 'message' || item.error || item.parts) return { kind: 'message', keep: true }
  return { kind: 'message', text: !!item.text.trim() }
}

const TurnView = memo(function TurnView({
  turn,
  live,
  startedAt,
  endedBadly = false,
  phase,
  waiting = false,
  hideEnd = false,
}: {
  turn: Turn
  live: boolean
  startedAt?: number
  endedBadly?: boolean
  /** The running turn's phase, for its live line. */
  phase?: string
  waiting?: boolean
  /** The last turn's Stopped mark gives way while the "Run interrupted" notice shows for it. */
  hideEnd?: boolean
}) {
  // Mousse's line that a Stop or a restart cut the turn off shows nothing itself: the Worked line reads it.
  const end = useMemo(() => [...turn.replies].reverse().find((item) => item.turnEnd)?.turnEnd, [turn.replies])
  const replies = useMemo(() => (end ? turn.replies.filter((item) => !item.turnEnd) : turn.replies), [turn.replies, end])
  const { flow, nested } = useMemo(() => nestUnderTasks(replies), [replies])
  const cutOff = endedBadly || !!end
  // A finished turn ends on its answer: the work that led to it comes above it. A cut-off one keeps its order.
  const ordered = useMemo(() => (live ? flow : settleFinishedTurn(flow, cutOff)), [flow, live, cutOff])
  const segments = useMemo(() => segmentReplies(ordered, live), [ordered, live])
  // A failure is loud only when nothing came after it and the turn failed or was cut off.
  const recovered = useMemo(() => recoveredFailures(replies, !live && cutOff), [replies, live, cutOff])
  const folded = useMemo(() => (live ? segments.map(() => false) : foldTurnWork(segments.map((segment) => foldRowOf(segment, recovered)))), [segments, live, recovered])
  const hasFold = folded.some(Boolean)
  const [workOpen, setWorkOpen] = useState(false)
  const lastReplyAt = turn.replies.reduce((latest, item) => Math.max(latest, item.createdAt), 0)
  const durationMs = turn.user && lastReplyAt > turn.user.createdAt && turn.user.createdAt > 0 ? lastReplyAt - turn.user.createdAt : undefined
  const renderGroup = (items: ChatItem[]) => {
    // A thought still being written stays out of the group: its own row is the turn's live line.
    const liveThought = live && isLiveThought(items[items.length - 1]) ? items[items.length - 1] : undefined
    const grouped = liveThought ? items.slice(0, -1) : items
    const unrecovered = grouped.filter((item) => toolFailed(item) && !recovered.has(item.id)).length
    // One finished call left beside the live thought is its own row: it says more than "Read 1 file".
    const single = grouped.length === 1 && !isRunningCall(grouped[0]) ? grouped[0] : undefined
    const icon = workGroupIcon(grouped)
    return (
      <>
        {single ? (
          <ToolItem item={single} live={live} nested={nested.get(single.id)} />
        ) : grouped.length ? (
          <ToolGroup
            title={workGroupTitle(grouped)}
            icon={icon === 'Thinking' ? <ThinkingIcon size={18} /> : <ToolIcon name={icon} state="done" />}
            count={grouped.length}
            failed={unrecovered}
            live={live}
          >
            {grouped.map((item) => (
              <ToolItem key={item.id} item={item} live={live} nested={nested.get(item.id)} />
            ))}
          </ToolGroup>
        ) : null}
        {liveThought && <ToolItem item={liveThought} live={live} />}
      </>
    )
  }
  return (
    <RecoveredFailuresContext.Provider value={recovered}>
      <div className="m-tl-turn">
        {turn.user && <UserMessage item={turn.user} />}
        {turn.user && (
          <WorkStatus
            live={live}
            startedAt={startedAt ?? turn.user.createdAt}
            durationMs={durationMs}
            fold={hasFold ? { open: workOpen, onToggle: () => setWorkOpen((open) => !open) } : undefined}
            end={hideEnd ? undefined : end}
          />
        )}
        <div className="m-tl-answer">
          {segments.map((segment, index) => {
            if (folded[index] && !workOpen) return null
            if (segment.kind === 'cards')
              return (
                <div key={`${segment.items[0].id}-subagents`} data-testid="chat-item" data-role="tool">
                  <SubagentGroup items={segment.items} live={live} nested={nested} />
                </div>
              )
            return segment.kind === 'item' ? (
              <ReplyItem key={segment.item.id} item={segment.item} live={live} nested={nested.get(segment.item.id)} />
            ) : (
              <div key={`${segment.items[0].id}-group`} data-testid="chat-item" data-role="tool">
                {renderGroup(segment.items)}
              </div>
            )
          })}
          {live && <TurnProgressRow replies={flow} phase={phase} waiting={waiting} />}
        </div>
        {!live && <EditSummary replies={turn.replies} />}
      </div>
    </RecoveredFailuresContext.Provider>
  )
})

export interface TimelineProps {
  items: ChatItem[]
  display: ThreadDisplayState
  /** True while the computer works on a turn in this thread. */
  active: boolean
  onApprovePlan?: (markdown: string) => Promise<void>
  /** Adds an applet's request to the message being written. */
  onAddToDraft?: (text: string) => void
  onAnswer?: (requestId: string, answers: QuestionAnswers) => Promise<void>
  onDismiss?: (requestId: string) => Promise<void>
}

export function Timeline({ items, display, active, onApprovePlan, onAddToDraft, onAnswer, onDismiss }: TimelineProps) {
  const turns = useMemo(() => groupTurns(items), [items])
  const approvedPlans = useMemo(() => {
    const approved = new Set<string>()
    let open: string[] = []
    for (const item of items) {
      if (item.kind === 'plan' || item.tool?.name === 'PlanWrite') open.push(item.id)
      else if (item.role === 'user' && item.text.startsWith(PLAN_APPROVAL_PREFIX)) {
        for (const id of open) approved.add(id)
        open = []
      }
    }
    return approved
  }, [items])
  const actions = useMemo<TimelineActions>(
    () => ({ approvePlan: onApprovePlan, busy: active, approvedPlans, addToDraft: onAddToDraft }),
    [onApprovePlan, active, approvedPlans, onAddToDraft],
  )
  const lastTurn = turns[turns.length - 1]
  const lastHasError = !!lastTurn?.replies.some((item) => item.error || item.status === 'error')
  const stoppedAfterLast = display.phase === 'stopped' && !active
  const failed = display.phase === 'failed' && !active && !lastHasError
  const waiting = display.phase === 'awaiting_input' || display.questions.length > 0

  return (
    <TimelineActionsContext.Provider value={actions}>
      <div className="m-tl" data-testid="timeline">
        {turns.map((turn, index) => {
          const last = index === turns.length - 1
          return (
            <TurnView
              key={turn.key}
              turn={turn}
              live={last && active}
              startedAt={last && active ? display.turnStartedAt : undefined}
              endedBadly={last && (display.phase === 'failed' || display.phase === 'stopped')}
              phase={last && active ? display.phase : undefined}
              waiting={last && active && waiting}
              hideEnd={last && stoppedAfterLast}
            />
          )
        })}
        {stoppedAfterLast && (
          <div className="m-tl-interrupted" data-testid="run-interrupted">
            <X size={12} /> Run interrupted
          </div>
        )}
        {failed && <ErrorBox title="The run failed" message={display.turnError || 'The computer reported an error.'} />}
        {display.connectionFailed && !active && (
          <div className="m-tl-connection" role="alert" data-testid="connection-failed">
            <span className="m-tl-connection__title">Connection failed</span>
            <span className="m-tl-connection__detail">{display.connectionFailed} Retry from the computer, or send again.</span>
          </div>
        )}
        {waiting && display.questions.length === 0 && (
          <div className="m-tl-waiting" data-testid="awaiting-input">
            <span className="m-tl-waiting__dot" aria-hidden /> Waiting for your input on the computer
          </div>
        )}
        {display.questions.map((pending) => (
          <QuestionPrompt key={pending.requestId} pending={pending} onAnswer={onAnswer} onDismiss={onDismiss} />
        ))}
      </div>
    </TimelineActionsContext.Provider>
  )
}

/**
 * Go to latest, as the desktop's quiet pill: chevron and label on a subtle fill, with a live dot while a
 * reply streams. Mounted while the thread has messages so it fades both ways; hidden and inert while the
 * view follows the end of the thread.
 */
export function JumpToLatest({ live, shown, onClick }: { live: boolean; shown: boolean; onClick: () => void }) {
  const ref = useRef<HTMLButtonElement>(null)
  // React 18 has no `inert` prop; set the attribute so a hidden pill takes no taps or focus.
  useEffect(() => {
    ref.current?.toggleAttribute('inert', !shown)
  }, [shown])
  return (
    <button
      ref={ref}
      type="button"
      className="m-tl-jump"
      data-hidden={shown ? undefined : true}
      aria-hidden={!shown || undefined}
      onClick={onClick}
    >
      {live && <span className="m-tl-jump__live" aria-hidden />}
      <ChevronRight size={14} className="m-tl-jump__icon" aria-hidden />
      <span>Go to latest</span>
    </button>
  )
}
