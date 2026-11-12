// The thread timeline, after the desktop's MessageList (agent-elements/message-list.tsx): turns
// of a user message and its replies, consecutive tool activity collapsed into groups, a
// "Working for…" line, per-message actions, the turn's file changes, and the end-of-thread
// states (interrupted, failed, provider unreachable, questions waiting).
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import type { ChatItem, QuestionAnswers, ThreadDisplayState } from '../../connection/types'
import { normalizeToolName } from '../../connection/timelineItems'
import { copyText } from './actions'
import { PLAN_APPROVAL_PREFIX, RecoveredFailuresContext, TimelineActionsContext, type TimelineActions } from './context'
import {
  formatResponseTime,
  formatTimestamp,
  formatTokens,
  formatTokensPerSecond,
  formatWorkedFor,
  formatWorkingFor,
  groupLabel,
  groupTurns,
  recoveredFailures,
  segmentReplies,
  shortPath,
  turnEdits,
  type Turn,
} from './format'
import { Bot, Check, ChevronRight, CircleX, Copy, FileText, Folder, Globe, Image as ImageIcon, Info, Link, Monitor, MessageSquare, Paperclip, VolumeHigh, X } from './icons'
import { Markdown } from './Markdown'
import { ImageLightbox } from './ImageLightbox'
import { AppletCard, AppletPending } from './AppletCard'
import { ReadAloudButton as ComputerReadAloudButton, useComputerSpeech } from '../speech/readAloud'
import { QuestionPrompt } from './QuestionPrompt'
import { DiffStat, PlanCard, Shimmer, Spinner, ToolGroup, ToolItem } from './ToolCards'

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

const UserMessage = memo(function UserMessage({ item }: { item: ChatItem }) {
  const [viewing, setViewing] = useState<{ src: string; name: string }>()
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
      {item.text.trim() && <div className="m-tl-user__bubble">{item.text}</div>}
      <div className="m-tl-toolbar m-tl-toolbar--user">
        {item.createdAt > 0 && <time className="m-tl-toolbar__time" dateTime={new Date(item.createdAt).toISOString()}>{formatTimestamp(item.createdAt)}</time>}
        {item.text.trim() && <CopyButton text={item.text} />}
      </div>
      {viewing && <ImageLightbox src={viewing.src} name={viewing.name} onClose={() => setViewing(undefined)} />}
    </div>
  )
})

// ---- Assistant and system rows ----

function ErrorBox({ title = 'Request failed', message }: { title?: string; message: string }) {
  return (
    <div className="m-tl-error" role="alert">
      <CircleX size={16} className="m-tl-error__icon" />
      <div>
        <div className="m-tl-error__title">{title}</div>
        <div className="m-tl-error__message">{message}</div>
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
      {item.error && <ErrorBox message={item.error.message} />}
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

function WorkStatus({ live, startedAt, durationMs }: { live: boolean; startedAt?: number; durationMs?: number }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!live) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [live])
  const elapsed = live && startedAt ? Math.max(0, now - startedAt) : durationMs
  if (elapsed === undefined) return null
  return (
    <div className="m-tl-work" data-testid="work-status" data-live={live || undefined}>
      <Shimmer active={live} className="m-tl-work__label">{live ? formatWorkingFor(elapsed) : formatWorkedFor(elapsed)}</Shimmer>
      <div className="m-tl-work__rule" aria-hidden />
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

const TurnView = memo(function TurnView({ turn, live, startedAt, endedBadly = false }: { turn: Turn; live: boolean; startedAt?: number; endedBadly?: boolean }) {
  const { flow, nested } = useMemo(() => nestUnderTasks(turn.replies), [turn.replies])
  // A failure is loud only when nothing came after it and the turn failed or was cut off.
  const recovered = useMemo(() => recoveredFailures(turn.replies, !live && endedBadly), [turn.replies, live, endedBadly])
  const segments = useMemo(() => segmentReplies(flow), [flow])
  const lastReplyAt = turn.replies.reduce((latest, item) => Math.max(latest, item.createdAt), 0)
  const durationMs = turn.user && lastReplyAt > turn.user.createdAt && turn.user.createdAt > 0 ? lastReplyAt - turn.user.createdAt : undefined
  return (
    <RecoveredFailuresContext.Provider value={recovered}>
    <div className="m-tl-turn">
      {turn.user && <UserMessage item={turn.user} />}
      {turn.user && <WorkStatus live={live} startedAt={startedAt ?? turn.user.createdAt} durationMs={durationMs} />}
      <div className="m-tl-answer">
        {segments.map((segment) =>
          segment.kind === 'item' ? (
            <ReplyItem key={segment.item.id} item={segment.item} live={live} nested={nested.get(segment.item.id)} />
          ) : (
            <div key={`${segment.items[0].id}-group`} data-testid="chat-item" data-role="tool">
              <ToolGroup
                label={groupLabel(segment.items)}
                count={segment.items.length}
                running={live && segment.items.some((item) => item.status === 'streaming')}
              >
                {segment.items.map((item) => (
                  <ToolItem key={item.id} item={item} live={live} nested={nested.get(item.id)} />
                ))}
              </ToolGroup>
            </div>
          ),
        )}
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
