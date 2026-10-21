// Tool call rows and cards, after the desktop's agent-elements tools: a quiet row for most tools
// (tool-row-base.tsx) and bordered cards for commands, edits, plans and subagents. Running rows
// shimmer; finished rows dim until touched, like `.an-tool-chrome`.
import { memo, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { ChatItem, ChatToolCall } from '../../connection/types'
import {
  baseName,
  bashCommand,
  bashOutput,
  commandSummary,
  diffStats,
  displayPath,
  editDiff,
  filePathOf,
  formatElapsed,
  genericTitle,
  hunks,
  mcpArgs,
  mcpTitle,
  outputText,
  searchLabels,
  searchResults,
  thoughtHeading,
  todosOf,
  toolState,
  truncate,
  type DiffLine,
  type ToolState,
} from './format'
import { highlightCode, languageForPath } from './highlight'
import {
  Brain,
  Check,
  ChevronRight,
  ClipboardList,
  Eye,
  FileCode,
  FilePlus,
  FolderSearch,
  GitBranch,
  Globe,
  Logout,
  MessageQuestion,
  Plug,
  Search,
  Sparkles,
  Terminal,
  Wrench,
  X,
  type TimelineIcon,
} from './icons'
import { CodeBlock, Markdown } from './Markdown'
import { useTimelineActions } from './context'

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

interface RowProps {
  icon?: ReactNode
  label: string
  detail?: string
  animating?: boolean
  error?: boolean
  /** Children make the row expandable. */
  children?: ReactNode
  defaultOpen?: boolean
  testId?: string
}

/** The desktop's ToolRowBase: icon, label, muted detail and an optional chevron. */
export function ToolRow({ icon, label, detail, animating = false, error = false, children, defaultOpen = false, testId }: RowProps) {
  const [open, setOpen] = useState(defaultOpen)
  const expandable = !!children
  const header = (
    <>
      {icon && <span className={`m-tl-row__icon${error ? ' m-tl-row__icon--error' : ''}`}>{icon}</span>}
      <Shimmer active={animating} className="m-tl-row__label">{label}</Shimmer>
      {detail && <span className="m-tl-row__detail">{detail}</span>}
      {expandable && <ChevronRight size={14} className="m-tl-row__chevron" />}
    </>
  )
  return (
    <div className="m-tl-chrome m-tl-row" data-open={open || undefined} data-animating={animating || undefined} data-testid={testId}>
      {expandable ? (
        <button type="button" className="m-tl-row__header" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
          {header}
        </button>
      ) : (
        <div className="m-tl-row__header">{header}</div>
      )}
      {expandable && open && <div className="m-tl-row__body">{children}</div>}
    </div>
  )
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

/** A bordered tool card with a 28px header that toggles its body. */
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
  if (state === 'error') return <X size={14} className="m-tl-mark m-tl-mark--error" />
  if (state === 'interrupted') return <X size={14} className="m-tl-mark m-tl-mark--muted" />
  return <Check size={14} className="m-tl-mark m-tl-mark--ok" />
}

// ---- Thinking ----

export function ThinkingRow({ item, live }: { item: ChatItem; live: boolean }) {
  const running = item.status === 'streaming' && live
  const heading = thoughtHeading(item.text)
  return (
    <ToolRow icon={<Brain size={18} />} label={running || !heading ? 'Thinking' : heading} animating={running} testId="tool-thinking">
      {item.text.trim() ? (
        <div className="m-tl-thought">
          <Markdown text={item.text} />
        </div>
      ) : undefined}
    </ToolRow>
  )
}

// ---- Bash ----

function BashCard({ tool, state }: { tool: ChatToolCall; state: ToolState }) {
  const command = bashCommand(tool)
  const summary = commandSummary(command)
  const { text, ok } = bashOutput(tool)
  const failed = state === 'error' || (state === 'done' && !ok)
  const running = state === 'running'
  const label = running
    ? summary ? `Running ${summary}` : 'Running command'
    : failed
      ? summary ? `Failed ${summary}` : 'Failed command'
      : summary || 'Ran command'
  return (
    <ToolCard
      testId="tool-bash"
      error={failed}
      animating={running}
      header={
        <>
          {running ? <Spinner /> : <Terminal size={16} className="m-tl-card__icon" />}
          {!running && <StatusMark state={failed ? 'error' : state} />}
          <Shimmer active={running} className={`m-tl-card__label m-tl-mono${failed ? ' m-tl-card__label--error' : ''}`}>{label}</Shimmer>
        </>
      }
    >
      {command || text ? (
        <div className="m-tl-term">
          {command && (
            <div className="m-tl-term__cmd">
              <span className="m-tl-term__prompt">$</span> {command}
            </div>
          )}
          {text && <pre className="m-tl-term__out">{text.length > 20_000 ? `${text.slice(0, 20_000)}…` : text}</pre>}
        </div>
      ) : undefined}
    </ToolCard>
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
  const html = useMemo(() => (language ? highlightCode(text, language) : undefined), [text, language])
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

function EditCard({ tool, state }: { tool: ChatToolCall; state: ToolState }) {
  const path = filePathOf(tool.input)
  const file = path ? baseName(path) : ''
  const lines = useMemo(() => editDiff(tool), [tool])
  const stats = diffStats(lines)
  const writing = tool.name === 'Write'
  const running = state === 'running'
  const verb = running ? (writing ? 'Creating' : 'Editing') : writing ? 'Created' : 'Edited'
  const Icon = writing ? FilePlus : FileCode
  return (
    <ToolCard
      testId="tool-edit"
      error={state === 'error'}
      animating={running}
      header={
        <>
          <Icon size={16} className="m-tl-card__icon" />
          <Shimmer active={running} className="m-tl-card__label">
            {verb}
            {file && <span className="m-tl-card__file"> {file}</span>}
          </Shimmer>
          {!running && (stats.added > 0 || stats.removed > 0) && <DiffStat {...stats} />}
          {state === 'error' && <StatusMark state="error" />}
        </>
      }
    >
      {lines.length ? (
        <>
          {path && <div className="m-tl-diff__path">{displayPath(path)}</div>}
          <DiffView lines={lines} path={path} />
        </>
      ) : undefined}
    </ToolCard>
  )
}

// ---- Search ----

function SearchRow({ tool, state }: { tool: ChatToolCall; state: ToolState }) {
  const running = state === 'running'
  const { count, lines } = searchResults(tool)
  const { done, detail } = searchLabels(tool, count)
  const Icon: TimelineIcon = tool.name === 'Glob' ? FolderSearch : tool.name === 'WebSearch' ? Globe : Search
  return (
    <ToolRow
      testId="tool-search"
      icon={<Icon size={18} />}
      label={running ? 'Searching...' : state === 'interrupted' ? 'Search interrupted' : done}
      detail={detail}
      animating={running}
      error={state === 'error'}
    >
      {lines.length ? (
        <ul className="m-tl-results">
          {lines.slice(0, 200).map((line, index) => (
            <li key={index} className="m-tl-results__item">{displayPath(line)}</li>
          ))}
        </ul>
      ) : undefined}
    </ToolRow>
  )
}

// ---- Todos ----

function TodoCard({ tool, state }: { tool: ChatToolCall; state: ToolState }) {
  const todos = todosOf(tool)
  if (!todos.length) {
    const running = state === 'running'
    return <ToolRow icon={<ClipboardList size={18} />} label={running ? 'Updating todos' : 'Updated todos'} animating={running} testId="tool-todo" />
  }
  const doneCount = todos.filter((todo) => todo.status === 'completed').length
  return (
    <div className="m-tl-chrome m-tl-card m-tl-todos" data-testid="tool-todo">
      <div className="m-tl-card__header">
        <ClipboardList size={16} className="m-tl-card__icon" />
        <Shimmer active={state === 'running'} className="m-tl-card__label">{state === 'running' ? 'Creating to-do list...' : 'To-dos'}</Shimmer>
        <span className="m-tl-card__count">{doneCount}/{todos.length}</span>
      </div>
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
    </div>
  )
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

function McpRow({ tool, state }: { tool: ChatToolCall; state: ToolState }) {
  const result = outputText(tool.output)
  return (
    <ToolRow
      testId="tool-mcp"
      icon={<Plug size={18} />}
      label={mcpTitle(tool, state)}
      detail={[tool.server, mcpArgs(tool.input)].filter(Boolean).join('  ')}
      animating={state === 'running'}
      error={state === 'error'}
    >
      {result.text ? <CodeBlock code={result.text} language={result.json ? 'json' : undefined} /> : undefined}
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

const GENERIC_ICONS: Record<string, TimelineIcon> = {
  Read: Eye,
  WebFetch: Globe,
  Skill: Sparkles,
  ExitPlanMode: Logout,
  NotebookEdit: FileCode,
  KillShell: X,
  cloning: GitBranch,
}

function GenericRow({ tool, state }: { tool: ChatToolCall; state: ToolState }) {
  const { title, subtitle } = genericTitle(tool, state)
  const Icon = GENERIC_ICONS[tool.name] ?? Wrench
  const result = tool.name === 'Read' ? { text: '', json: false } : outputText(tool.output)
  return (
    <ToolRow
      testId="tool-generic"
      icon={<Icon size={18} />}
      label={state === 'interrupted' ? `${title} interrupted` : title}
      detail={subtitle}
      animating={state === 'running'}
      error={state === 'error'}
    >
      {result.text ? <CodeBlock code={result.text} language={result.json ? 'json' : undefined} /> : undefined}
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
  if (item.kind === 'thinking') return <ThinkingRow item={item} live={live} />
  const tool = item.tool
  if (!tool) return null
  const state = toolState(item, live)
  switch (tool.name) {
    case 'Bash':
      return <BashCard tool={tool} state={state} />
    case 'Edit':
    case 'Write':
      return <EditCard tool={tool} state={state} />
    case 'Grep':
    case 'Glob':
    case 'WebSearch':
      return <SearchRow tool={tool} state={state} />
    case 'TodoWrite':
      return <TodoCard tool={tool} state={state} />
    case 'Task':
    case 'Agent':
      return <TaskCard item={item} tool={tool} state={state} nested={nested} live={live} />
    case 'Mcp':
      return <McpRow tool={tool} state={state} />
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
      return <GenericRow tool={tool} state={state} />
  }
})

/** The group of consecutive activity rows: collapsed by default, titled by the latest thought. */
export function ToolGroup({ label, count, running, children }: { label: string; count: number; running: boolean; children: ReactNode }) {
  const title = label || 'Tool calls'
  return (
    <ToolRow
      testId="tool-group"
      icon={label ? <Brain size={18} /> : <Wrench size={18} />}
      label={title}
      detail={label ? undefined : `${count}`}
      animating={running}
    >
      <div className="m-tl-group">{children}</div>
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
