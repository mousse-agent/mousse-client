// Tool call rows, after the desktop's agent-elements tools: one quiet row per call (tool-row-base.tsx) with the
// tool's own icon (tool-icon.tsx), which pulses while the call runs and turns red when it fails. Commands, edits,
// searches and to-do lists are rows too; a plan keeps its card. Finished rows dim until touched, like
// `.an-tool-chrome`.
import { memo, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { ChatItem, ChatToolCall } from '../../connection/types'
import {
  baseName,
  bashCommand,
  bashOutput,
  bashOutputLines,
  commandLabel,
  diffStats,
  displayPath,
  editDiff,
  filePathOf,
  formatBytes,
  formatCommandDuration,
  formatElapsed,
  genericTitle,
  hunks,
  liveThoughtLine,
  mcpArgs,
  mcpTitle,
  outputText,
  searchLabels,
  searchResults,
  shortPath,
  thoughtHeading,
  todosOf,
  toolState,
  truncate,
  type DiffLine,
  type ToolState,
} from './format'
import { languageForPath, useHighlight } from './useHighlight'
import {
  ThinkingIcon,
  Check,
  ChevronRight,
  ClipboardList,
  Copy,
  FileText,
  FilePlus,
  FolderSearch,
  GitBranch,
  Globe,
  Logout,
  MessageQuestion,
  Pencil,
  Plug,
  Search,
  Sparkles,
  Terminal,
  Wrench,
  X,
  type TimelineIcon,
} from './icons'
import { CodeBlock, Markdown } from './Markdown'
import { RecoveredFailuresContext, useTimelineActions } from './context'
import { copyText } from './actions'

export function Shimmer({ active, children, className = '' }: { active: boolean; children: ReactNode; className?: string }) {
  return <span className={`m-tl-shimmer${active ? ' m-tl-shimmer--active' : ''} ${className}`.trim()}>{children}</span>
}

export function Spinner({ size = 14 }: { size?: number }) {
  return (
    <svg className="m-tl-spin" width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" strokeDasharray="28" strokeDashoffset="7" strokeLinecap="round" />
    </svg>
  )
}

// ---- Tool icons (tool-icon.tsx) ----

/** The icon of each tool the rows know by name; anything else takes a wrench. */
const TOOL_ICONS: Record<string, TimelineIcon> = {
  Bash: Terminal,
  Read: FileText,
  Edit: Pencil,
  NotebookEdit: Pencil,
  Write: FilePlus,
  Grep: Search,
  Glob: FolderSearch,
  WebFetch: Globe,
  WebSearch: Globe,
  TodoWrite: ClipboardList,
  ToolSearch: Plug,
  Mcp: Plug,
  Skill: Sparkles,
  Task: Sparkles,
  Agent: Sparkles,
  ExitPlanMode: Logout,
  PlanWrite: ClipboardList,
  KillShell: X,
  cloning: GitBranch,
  Question: MessageQuestion,
  QuickAction: Wrench,
}

export function toolIconFor(name: string | undefined): TimelineIcon {
  return (name && TOOL_ICONS[name]) || Wrench
}

export type ToolIconState = 'running' | 'done' | 'failed'

/**
 * A row's icon in its state: running, it pulses gently in steps (opacity only); done, it is still and dimmed;
 * failed, it takes the danger colour, or only leans toward it when the agent got past the failure.
 */
export function ToolStateIcon({ state, recovered = false, children }: { state: ToolIconState; recovered?: boolean; children: ReactNode }) {
  return (
    <span className="m-tl-icon" data-state={state === 'failed' && recovered ? 'recovered' : state} aria-hidden>
      {children}
    </span>
  )
}

export function ToolIcon({ name, state, size = 18 }: { name: string | undefined; state: ToolIconState; size?: number }) {
  const Icon = toolIconFor(name)
  return (
    <ToolStateIcon state={state}>
      <Icon size={size} />
    </ToolStateIcon>
  )
}

/** Whether this call's failure was one the agent got past. */
function useRecovered(id: string): boolean {
  return useContext(RecoveredFailuresContext).has(id)
}

interface RowProps {
  icon?: ReactNode
  label: string
  detail?: string
  /** The detail is code (a command, a file name). */
  detailMono?: boolean
  /** The detail is a thought being written: too long for the row, it is cut at its start, not its end. */
  liveDetail?: boolean
  animating?: boolean
  /** A failed call: the icon turns red, and the label too unless the agent got past it (`recovered`). */
  failed?: boolean
  recovered?: boolean
  /** The icon draws its own state (the thinking atom); otherwise it pulses, dims or reddens with the row. */
  plainIcon?: boolean
  /** Whether a running row's label shimmers; a thought turns its icon instead. */
  shimmer?: boolean
  /** Short status after the detail (a failure count, an exit code); never cut. */
  badge?: ReactNode
  /** Children make the row expandable. */
  children?: ReactNode
  defaultOpen?: boolean
  /** Controlled open state, with `onToggle`. */
  open?: boolean
  onToggle?: () => void
  testId?: string
}

/** The desktop's ToolRowBase: icon, label, muted detail, a badge and an optional chevron. */
export function ToolRow({
  icon,
  label,
  detail,
  detailMono = false,
  liveDetail = false,
  animating = false,
  failed = false,
  recovered = false,
  plainIcon = false,
  shimmer = true,
  badge,
  children,
  defaultOpen = false,
  open: controlled,
  onToggle,
  testId,
}: RowProps) {
  const [ownOpen, setOwnOpen] = useState(defaultOpen)
  const open = controlled ?? ownOpen
  const expandable = !!children
  const loud = failed && !animating && !recovered
  const quiet = failed && !animating && recovered
  const header = (
    <>
      {icon &&
        (plainIcon ? (
          <span className="m-tl-icon">{icon}</span>
        ) : (
          <ToolStateIcon state={failed && !animating ? 'failed' : animating ? 'running' : 'done'} recovered={recovered}>
            {icon}
          </ToolStateIcon>
        ))}
      <Shimmer active={animating && shimmer} className={`m-tl-row__label${detail ? '' : ' m-tl-row__label--alone'}${loud ? ' m-tl-row__label--error' : ''}`}>
        {label}
      </Shimmer>
      {detail &&
        (liveDetail ? (
          <span className="m-tl-row__detail m-tl-live-thought" title={detail}>
            <bdi>{detail}</bdi>
          </span>
        ) : (
          <span className={`m-tl-row__detail${detailMono ? ' m-tl-mono' : ''}`}>{detail}</span>
        ))}
      {quiet && <span className="m-tl-failed-mark" aria-label="failed">×</span>}
      {badge && <span className="m-tl-row__badge">{badge}</span>}
      {expandable && <ChevronRight size={16} className="m-tl-row__chevron" />}
    </>
  )
  return (
    <div className="m-tl-chrome m-tl-row" data-open={open || undefined} data-animating={animating || undefined} data-failed={loud || undefined} data-testid={testId}>
      {expandable ? (
        <button
          type="button"
          className="m-tl-row__header"
          aria-expanded={open}
          onClick={() => (onToggle ? onToggle() : setOwnOpen((value) => !value))}
        >
          {header}
        </button>
      ) : (
        <div className="m-tl-row__header">{header}</div>
      )}
      {expandable && open && (
<div className="m-tl-row__body">{children}</div>
      )}
    </div>
  )
}

function CopyIconButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      className="m-tl-out__copy"
      aria-label={copied ? 'Copied' : label}
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

// ---- Thinking ----

export function ThinkingRow({ item, live }: { item: ChatItem; live: boolean }) {
  const running = item.status === 'streaming' && live
  const heading = thoughtHeading(item.text)
  // While it streams, the thought as it is written follows the label on one line: its newest words show.
  const line = running ? liveThoughtLine(item.text) : ''
  return (
    <ToolRow
      icon={<ThinkingIcon size={18} active={running} />}
      plainIcon
      label={running || !heading ? 'Thinking' : heading}
      detail={line || undefined}
      liveDetail
      animating={running}
      shimmer={false}
      testId="tool-thinking"
    >
      {item.text.trim() ? (
        <div className="m-tl-thought">
          <Markdown text={item.text} />
        </div>
      ) : undefined}
    </ToolRow>
  )
}

// ---- Bash (bash-tool.tsx) ----

/**
 * A command as one quiet row: the terminal icon, "Ran" and the command in mono, cut by the row's width. It opens to
 * the full command, the folder it ran in, its output in mono and an exit line (red when not 0).
 */
function BashRow({ tool, state, recovered }: { tool: ChatToolCall; state: ToolState; recovered: boolean }) {
  const command = bashCommand(tool)
  const summary = commandLabel(command)
  const result = bashOutput(tool)
  const { text } = result
  const interrupted = state === 'interrupted'
  const failed = state === 'error' || (state === 'done' && !result.ok)
  const running = state === 'running'
  const [open, setOpen] = useState(false)
  const verb = running ? 'Running' : interrupted ? 'Interrupted' : failed ? 'Failed' : 'Ran'
  const exitFailed = result.exitCode !== undefined && result.exitCode !== 0
  // While the command runs its output follows the tail, unless the reader scrolled up.
  const outputRef = useRef<HTMLDivElement>(null)
  const followRef = useRef(true)
  useEffect(() => {
    const element = outputRef.current
    if (element && running && followRef.current) element.scrollTop = element.scrollHeight
  }, [text, running, open])
  const hasBody = !!(command || text || result.cwd || result.truncated || result.exitCode !== undefined)
  return (
    <ToolRow
      testId="tool-bash"
      icon={<Terminal size={18} />}
      label={summary ? verb : `${verb} command`}
      detail={summary || undefined}
      detailMono
      animating={running}
      failed={failed}
      recovered={recovered}
      badge={exitFailed && !open && !recovered ? <span className="m-tl-row__exit">exit {result.exitCode}</span> : undefined}
      open={open}
      onToggle={() => setOpen((value) => !value)}
    >
      {hasBody ? (
        <div className="m-tl-out m-tl-mono">
          {command && (
            <div className="m-tl-out__row">
              <div className="m-tl-out__cmd">
                <span className="m-tl-out__prompt">$ </span>
                {command}
              </div>
              <CopyIconButton text={command} label="Copy command" />
            </div>
          )}
          {result.cwd && <div className="m-tl-out__meta">in {result.cwd}</div>}
          {result.truncated && (
            <div className="m-tl-out__meta m-tl-out__note">
              Earlier output not shown{result.bytes !== undefined ? ` (${formatBytes(result.bytes)} total)` : ''}
            </div>
          )}
          {text && (
            <div className="m-tl-out__row">
              <div
                ref={outputRef}
                className="m-tl-out__text"
                onScroll={(event) => {
                  const box = event.currentTarget
                  followRef.current = box.scrollHeight - box.scrollTop - box.clientHeight <= 8
                }}
              >
                {bashOutputLines(text.length > 20_000 ? text.slice(-20_000) : text).map((line, index) => (
                  <span key={index} className={line.failed ? 'm-tl-out__fail' : undefined}>
                    {index > 0 ? '\n' : ''}
                    {line.text}
                  </span>
                ))}
              </div>
              {!running && <CopyIconButton text={text} label="Copy output" />}
            </div>
          )}
          {(result.exitCode !== undefined || result.durationMs !== undefined || interrupted) && (
            <div className="m-tl-out__exit">
              {result.exitCode !== undefined && <span className={exitFailed ? 'm-tl-out__fail' : undefined}>exit {result.exitCode}</span>}
              {result.durationMs !== undefined && <span>{formatCommandDuration(result.durationMs)}</span>}
              {interrupted && <span className="m-tl-out__sans">Interrupted</span>}
            </div>
          )}
        </div>
      ) : undefined}
    </ToolRow>
  )
}

// ---- Edit / Write ----

function DiffView({ lines, path }: { lines: DiffLine[]; path: string }) {
  const language = languageForPath(path)
  const shown = useMemo(() => hunks(lines).slice(0, 2000), [lines])
  return (
    <div className="m-tl-diff" role="table" aria-label={`Changes to ${baseName(path)}`}>
      {shown.map((line, index) =>
        line === null ? (
          <div key={index} className="m-tl-diff__gap">⋯</div>
        ) : (
          <div key={index} className={`m-tl-diff__line m-tl-diff__line--${line.type}`}>
            <span className="m-tl-diff__sign">{line.type === 'add' ? '+' : line.type === 'remove' ? '−' : ' '}</span>
            <DiffText text={line.text} language={language} />
          </div>
        ),
      )}
    </div>
  )
}

function DiffText({ text, language }: { text: string; language?: string }) {
  const html = useHighlight(text, language)
  return html !== undefined ? <span className="m-tl-diff__text hljs" dangerouslySetInnerHTML={{ __html: html || ' ' }} /> : <span className="m-tl-diff__text">{text || ' '}</span>
}

export function DiffStat({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="m-tl-stat">
      {added > 0 && <span className="m-tl-stat__add">+{added}</span>}
      {removed > 0 && <span className="m-tl-stat__del">-{removed}</span>}
    </span>
  )
}

/** "Edited relay.ts +3 -1" as one row with the pencil (or new-file) icon, opening to its diff (edit-tool.tsx). */
function EditRow({ tool, state, recovered }: { tool: ChatToolCall; state: ToolState; recovered: boolean }) {
  const path = filePathOf(tool.input)
  const file = path ? baseName(path) : ''
  const lines = useMemo(() => editDiff(tool), [tool])
  const stats = diffStats(lines)
  const writing = tool.name === 'Write'
  const running = state === 'running'
  const failed = state === 'error'
  const verb = running ? (writing ? 'Creating' : 'Editing') : failed ? (writing ? 'Failed to create' : 'Failed to edit') : writing ? 'Created' : 'Edited'
  const Icon = writing ? FilePlus : Pencil
  return (
    <ToolRow
      testId="tool-edit"
      icon={<Icon size={18} />}
      label={verb}
      detail={file || undefined}
      detailMono
      animating={running}
      failed={failed}
      recovered={recovered}
      badge={!running && (stats.added > 0 || stats.removed > 0) ? <DiffStat {...stats} /> : undefined}
    >
      {lines.length ? (
        <div className="m-tl-out m-tl-out--diff">
          {path && <div className="m-tl-diff__path" title={path}>{shortPath(displayPath(path), 48)}</div>}
          <DiffView lines={lines} path={path} />
        </div>
      ) : undefined}
    </ToolRow>
  )
}

// ---- Search ----

function SearchRow({ tool, state, recovered }: { tool: ChatToolCall; state: ToolState; recovered: boolean }) {
  const running = state === 'running'
  const failed = state === 'error'
  const { count, lines } = searchResults(tool)
  const { done, detail } = searchLabels(tool, count)
  const query = (typeof tool.input?.query === 'string' ? tool.input.query : typeof tool.input?.pattern === 'string' ? tool.input.pattern : '').trim()
  const Icon = toolIconFor(tool.name)
  const label = running ? 'Searching...' : state === 'interrupted' ? 'Search interrupted' : failed ? `Failed ${tool.name === 'WebSearch' ? 'web search' : tool.name}` : done
  return (
    <ToolRow
      testId="tool-search"
      icon={<Icon size={18} />}
      label={label}
      // A failed row names the tool in its label, so its detail is the query alone.
      detail={failed && query ? `“${query}”` : detail}
      animating={running}
      failed={failed}
      recovered={recovered}
    >
      {lines.length ? (
        <ul className="m-tl-out m-tl-results">
          {lines.slice(0, 200).map((line, index) => (
            <li key={index} className="m-tl-results__item">{displayPath(line)}</li>
          ))}
        </ul>
      ) : undefined}
    </ToolRow>
  )
}

// ---- Todos (todo-tool.tsx) ----

/** A to-do list call as one row (what changed and how far the list is), open by default to the list. */
function TodoRow({ tool, state, recovered }: { tool: ChatToolCall; state: ToolState; recovered: boolean }) {
  const todos = todosOf(tool)
  const running = state === 'running'
  const failed = state === 'error'
  const done = todos.filter((todo) => todo.status === 'completed').length
  const creating = todos.length > 0 && todos.every((todo) => todo.status === 'pending')
  const label = running
    ? creating || !todos.length ? 'Creating to-do list' : 'Updating to-dos'
    : failed
      ? 'Failed to update to-dos'
      : creating
        ? 'Created to-do list'
        : 'Updated to-dos'
  return (
    <ToolRow
      testId="tool-todo"
      icon={<ClipboardList size={18} />}
      label={label}
      detail={todos.length ? `${done} of ${todos.length} done` : undefined}
      animating={running}
      failed={failed}
      recovered={recovered}
      defaultOpen
    >
      {todos.length ? (
        <ul className="m-tl-todos__list">
          {todos.map((todo, index) => (
            <li key={index} className={`m-tl-todo m-tl-todo--${todo.status}`}>
              <span className="m-tl-todo__mark" aria-label={todo.status.replace('_', ' ')}>
                {todo.status === 'completed' ? <Check size={11} /> : todo.status === 'in_progress' ? <ChevronRight size={11} /> : null}
              </span>
              <span className="m-tl-todo__text">{todo.content}</span>
            </li>
          ))}
        </ul>
      ) : undefined}
    </ToolRow>
  )
}

/** A result shown as a plain block like a command's output: no header bar, no border (global.css an-tool-quiet-output). */
function QuietOutput({ tool }: { tool: ChatToolCall }) {
  const result = outputText(tool.output)
  if (!result.text) return null
  return <pre className="m-tl-out m-tl-mono m-tl-out__text m-tl-out--plain">{result.text}</pre>
}

interface CardProps {
  header: ReactNode
  children?: ReactNode
  error?: boolean
  animating?: boolean
  defaultOpen?: boolean
  testId?: string
  awaiting?: boolean
}

/** A bordered card with a header that toggles its body, for calls that stand on their own (quick actions). */
function ToolCard({ header, children, error = false, animating = false, defaultOpen = false, testId, awaiting = false }: CardProps) {
  const [open, setOpen] = useState(defaultOpen)
  const expandable = !!children
  return (
    <div
      className={`m-tl-chrome m-tl-card${error ? ' m-tl-card--error' : ''}`}
      data-open={open || undefined}
      data-animating={animating || undefined}
      data-awaiting={awaiting || undefined}
      data-testid={testId}
    >
      {expandable ? (
        <button type="button" className="m-tl-card__header" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
          {header}
          <ChevronRight size={14} className="m-tl-row__chevron" />
        </button>
      ) : (
        <div className="m-tl-card__header">{header}</div>
      )}
      {expandable && open && <div className="m-tl-card__body">{children}</div>}
    </div>
  )
}

function StatusMark({ state }: { state: ToolState }) {
  if (state === 'running') return <Spinner />
  if (state === 'error' || state === 'interrupted') return <X size={14} className={`m-tl-mark m-tl-mark--${state === 'error' ? 'error' : 'muted'}`} />
  return <Check size={14} className="m-tl-mark m-tl-mark--ok" />
}

// ---- Subagents (Task / Agent) ----

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active])
  return now
}

function nestedSummary(nested: ChatItem[]): string {
  let files = 0
  let searches = 0
  let commands = 0
  let other = 0
  for (const child of nested) {
    const name = child.tool?.name
    if (name === 'Read' || name === 'Edit' || name === 'Write') files++
    else if (name === 'Grep' || name === 'Glob' || name === 'WebSearch') searches++
    else if (name === 'Bash') commands++
    else other++
  }
  const parts: string[] = []
  if (files) parts.push(`${files} ${files === 1 ? 'file' : 'files'}`)
  if (searches) parts.push(`${searches} ${searches === 1 ? 'search' : 'searches'}`)
  if (commands) parts.push(`${commands} ${commands === 1 ? 'command' : 'commands'}`)
  if (other) parts.push(`${other} ${other === 1 ? 'tool' : 'tools'}`)
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0] ?? ''
}

function TaskCard({ item, tool, state, nested, live }: { item: ChatItem; tool: ChatToolCall; state: ToolState; nested: ChatItem[]; live: boolean }) {
  const base = tool.name === 'Agent' ? 'Agent' : 'Task'
  const running = state === 'running'
  const now = useNow(running)
  const input = tool.input ?? {}
  const description = typeof input.description === 'string' ? input.description : ''
  const kind = typeof input.subagent_type === 'string' ? input.subagent_type : ''
  const prompt = typeof input.prompt === 'string' ? input.prompt : ''
  const label = running ? `Running ${base.toLowerCase()}` : state === 'interrupted' ? `${base} interrupted` : state === 'error' ? `${base} failed` : `${base} completed`
  const detail = nested.length ? nestedSummary(nested) : truncate(description || kind, 60)
  const result = outputText(tool.output, 6000)
  const [visible, setVisible] = useState(nested.length)
  // While it runs, nested rows appear one by one, like the desktop's 450ms reveal.
  useEffect(() => {
    if (!running) {
      setVisible(nested.length)
      return
    }
    if (visible >= nested.length) return
    const timer = setTimeout(() => setVisible((value) => Math.min(value + 1, nested.length)), 450)
    return () => clearTimeout(timer)
  }, [running, nested.length, visible])
  const body =
    nested.length || prompt || result.text ? (
      <div className="m-tl-task">
        {kind && <div className="m-tl-task__kind">{kind}</div>}
        {prompt && (
          <details className="m-tl-task__prompt">
            <summary>Instructions</summary>
            <Markdown text={prompt} />
          </details>
        )}
        {nested.length > 0 && (
          <div className={`m-tl-task__nested${nested.length > 4 ? ' m-tl-task__nested--fade' : ''}`}>
            {nested.slice(0, visible).map((child) => (
              <ToolItem key={child.id} item={child} live={live} />
            ))}
          </div>
        )}
        {result.text && (result.json ? <CodeBlock code={result.text} language="json" /> : <Markdown text={result.text} />)}
      </div>
    ) : undefined
  return (
    <ToolCard
      testId="tool-task"
      error={state === 'error'}
      animating={running}
      header={
        <>
          <Sparkles size={16} className="m-tl-card__icon" />
          <Shimmer active={running} className="m-tl-card__label">{label}</Shimmer>
          {detail && <span className="m-tl-card__detail">{detail}</span>}
          {running && item.createdAt > 0 && <span className="m-tl-card__time">{formatElapsed(now - item.createdAt)}</span>}
        </>
      }
    >
      {body}
    </ToolCard>
  )
}

// ---- MCP ----

function McpRow({ tool, state, recovered }: { tool: ChatToolCall; state: ToolState; recovered: boolean }) {
  const result = outputText(tool.output)
  return (
    <ToolRow
      testId="tool-mcp"
      icon={<Plug size={18} />}
      label={mcpTitle(tool, state)}
      detail={[tool.server, mcpArgs(tool.input)].filter(Boolean).join('  ')}
      animating={state === 'running'}
      failed={state === 'error'}
      recovered={recovered}
    >
      {result.text ? <QuietOutput tool={tool} /> : undefined}
    </ToolRow>
  )
}

// ---- Quick actions ----

function QuickActionCard({ tool, state }: { tool: ChatToolCall; state: ToolState }) {
  const input = tool.input ?? {}
  const name = typeof input.label === 'string' && input.label.trim() ? input.label.trim() : 'Quick action'
  const payload = typeof input.payload === 'string' ? input.payload.trim() : ''
  const kind = input.kind
  const effect = kind === 'bash' ? 'is run in a new terminal tab' : kind === 'send-new-chat' ? 'is sent in new chat' : 'is sent in active chat'
  const rejected = /reject/i.test(typeof tool.output === 'string' ? tool.output : '')
  return (
    <ToolCard
      testId="tool-quick-action"
      error={state === 'error'}
      animating={state === 'running'}
      header={
        <>
          <Wrench size={16} className="m-tl-card__icon" />
          <Shimmer active={state === 'running'} className="m-tl-card__label">New quick action</Shimmer>
          <span className="m-tl-card__detail">{name}</span>
          {state === 'done' && (rejected ? <X size={14} className="m-tl-mark m-tl-mark--warn" /> : <Check size={14} className="m-tl-mark m-tl-mark--ok" />)}
          {state === 'error' && <StatusMark state="error" />}
        </>
      }
    >
      <div className="m-tl-qa">
        <div className="m-tl-qa__field"><span>Name</span> {name}</div>
        {payload && (kind === 'bash' ? <CodeBlock code={payload.slice(0, 4000)} language="bash" /> : <div className="m-tl-qa__payload">{payload.slice(0, 4000)}</div>)}
        <div className="m-tl-qa__effect">This action {effect}.</div>
      </div>
    </ToolCard>
  )
}

// ---- Question (the agent asked; answers go through the pending questions panel) ----

function QuestionRow({ tool }: { tool: ChatToolCall }) {
  const questions = Array.isArray(tool.input?.questions) ? tool.input.questions : []
  const first = questions.find((question): question is Record<string, unknown> => typeof question === 'object' && question !== null)
  const prompt = typeof first?.question === 'string' ? first.question : typeof first?.prompt === 'string' ? first.prompt : tool.summary
  return <ToolRow testId="tool-question" icon={<MessageQuestion size={18} />} label="Question" detail={truncate(prompt, 80)} />
}

// ---- Generic ----

function GenericRow({ tool, state, recovered }: { tool: ChatToolCall; state: ToolState; recovered: boolean }) {
  const { title, subtitle } = genericTitle(tool, state)
  const Icon = toolIconFor(tool.name)
  const result = tool.name === 'Read' ? { text: '' } : outputText(tool.output)
  return (
    <ToolRow
      testId="tool-generic"
      icon={<Icon size={18} />}
      label={state === 'interrupted' ? `${title} interrupted` : title}
      detail={subtitle}
      animating={state === 'running'}
      failed={state === 'error'}
      recovered={recovered}
    >
      {result.text ? <QuietOutput tool={tool} /> : undefined}
    </ToolRow>
  )
}

export interface ToolItemProps {
  item: ChatItem
  /** Whether the turn is still running, which decides running versus interrupted. */
  live: boolean
  nested?: ChatItem[]
}

/** One tool call, picked by its normalized name like the desktop's tool-renderer.tsx. */
export const ToolItem = memo(function ToolItem({ item, live, nested = [] }: ToolItemProps) {
  const recovered = useRecovered(item.id)
  if (item.kind === 'thinking') return <ThinkingRow item={item} live={live} />
  const tool = item.tool
  if (!tool) return null
  const state = toolState(item, live)
  switch (tool.name) {
    case 'Bash':
      return <BashRow tool={tool} state={state} recovered={recovered} />
    case 'Edit':
    case 'Write':
      return <EditRow tool={tool} state={state} recovered={recovered} />
    case 'Grep':
    case 'Glob':
    case 'WebSearch':
      return <SearchRow tool={tool} state={state} recovered={recovered} />
    case 'TodoWrite':
      return <TodoRow tool={tool} state={state} recovered={recovered} />
    case 'Task':
    case 'Agent':
      return <TaskCard item={item} tool={tool} state={state} nested={nested} live={live} />
    case 'Mcp':
      return <McpRow tool={tool} state={state} recovered={recovered} />
    case 'QuickAction':
      return <QuickActionCard tool={tool} state={state} />
    case 'Question':
      return <QuestionRow tool={tool} />
    case 'PlanWrite': {
      const plan = tool.input?.plan
      const markdown =
        (typeof plan === 'object' && plan !== null && typeof (plan as { summary?: unknown }).summary === 'string' ? (plan as { summary: string }).summary : '') ||
        (typeof tool.output === 'string' ? tool.output : '')
      const title = typeof plan === 'object' && plan !== null && typeof (plan as { title?: unknown }).title === 'string' ? (plan as { title: string }).title : 'Plan'
      if (markdown.trim()) return <PlanCard id={item.id} title={title} markdown={markdown} running={state === 'running'} />
      return <ToolRow icon={<Sparkles size={18} />} label={state === 'running' ? 'Creating plan' : 'Created plan'} animating={state === 'running'} />
    }
    default:
      return <GenericRow tool={tool} state={state} recovered={recovered} />
  }
})

/**
 * One still line for consecutive calls, titled with what they did ("Read 3 files and ran 2 commands"), closed until
 * tapped (tool-calls-group.tsx). Open, the rows sit in a box capped at about 18rem that scrolls on its own, with soft
 * edges where more rows are; while the turn runs it keeps its newest row in view.
 */
export function ToolGroup({ title, icon, count, failed = 0, live, children }: { title: string; icon: ReactNode; count: number; failed?: number; live: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const atEndRef = useRef(true)
  useEffect(() => {
    const box = scrollRef.current
    if (box && live && atEndRef.current) box.scrollTop = box.scrollHeight
  }, [count, live, open])
  return (
    <ToolRow
      testId="tool-group"
      icon={icon}
      plainIcon
      label={title || 'Tool calls'}
      // Only failures the agent did not get past are named on the group line.
      badge={failed > 0 ? <span className="m-tl-row__failed">· {failed} failed</span> : undefined}
      open={open}
      onToggle={() => setOpen((value) => !value)}
    >
      <div
        ref={scrollRef}
        className="m-tl-group-scroll"
        onScroll={(event) => {
          const box = event.currentTarget
          atEndRef.current = box.scrollHeight - box.scrollTop - box.clientHeight < 4
        }}
      >
        <div className="m-tl-group">{children}</div>
      </div>
    </ToolRow>
  )
}

// ---- Plans (tools/plan-tool.tsx) ----

export function PlanCard({ id, title, markdown, running = false }: { id: string; title: string; markdown: string; running?: boolean }) {
  const { approvePlan, busy, approvedPlans } = useTimelineActions()
  const [expanded, setExpanded] = useState(false)
  const [sending, setSending] = useState(false)
  const [approvedHere, setApprovedHere] = useState(false)
  const approved = approvedHere || approvedPlans.has(id)
  const awaiting = !approved && !running
  return (
    <div className="m-tl-plan" data-testid="plan-card" data-awaiting={awaiting || undefined}>
      <div className="m-tl-plan__header">
        {running ? <Spinner /> : <ClipboardList size={16} className="m-tl-card__icon" />}
        <span className="m-tl-plan__title">{title}</span>
        <span className="m-tl-plan__file">plan.md</span>
        <span className={`m-tl-plan__status${approved ? ' m-tl-plan__status--approved' : ''}`}>
          {running ? 'Writing…' : approved ? 'Approved' : 'Awaiting approval'}
        </span>
      </div>
      <div className={`m-tl-plan__body${expanded ? ' m-tl-plan__body--open' : ''}`}>
        <Markdown text={markdown} />
      </div>
      <div className="m-tl-plan__actions">
        <button type="button" className="m-tl-plan__toggle" onClick={() => setExpanded((value) => !value)}>
          {expanded ? 'Hide detailed plan' : 'Read detailed plan'}
        </button>
        {awaiting && approvePlan && (
          <button
            type="button"
            className="m-tl-plan__approve"
            disabled={busy || sending}
            onClick={() => {
              setSending(true)
              void approvePlan(markdown)
                .then(() => setApprovedHere(true))
                .finally(() => setSending(false))
            }}
          >
            {sending ? <Spinner /> : null}
            Approve
          </button>
        )}
      </div>
    </div>
  )
}
