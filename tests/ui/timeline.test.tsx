import { describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach } from 'vitest'
import type { ChatItem, ThreadDisplayState } from '../../src/connection/types'
import { JumpToLatest, Timeline } from '../../src/ui/timeline/Timeline'
import { Markdown, keepLiteralBackslashes } from '../../src/ui/timeline/Markdown'
import { toChatItem } from '../../src/connection/timelineItems'

afterEach(() => cleanup())

const at = Date.parse('2026-10-21T10:00:00Z')
const items: ChatItem[] = [
  { id: 'u1', role: 'user', kind: 'message', text: 'Fix the relay', createdAt: at, status: 'done', files: ['log.txt'], references: [{ kind: 'file', title: 'relay.ts' }] },
  { id: 't1', role: 'assistant', kind: 'thinking', text: '**Reading** the relay code', createdAt: at + 1000, status: 'done' },
  {
    id: 'b1',
    role: 'tool',
    kind: 'tool',
    text: '',
    createdAt: at + 2000,
    status: 'done',
    tool: { name: 'Bash', title: 'Run', summary: '', details: [], input: { command: 'npm test -- relay' }, output: { stdout: '4 passed', exitCode: 0 } },
  },
  {
    id: 'e1',
    role: 'tool',
    kind: 'tool',
    text: '',
    createdAt: at + 3000,
    status: 'done',
    tool: { name: 'Edit', title: 'Edit', summary: '', details: [], input: { file_path: '/w/src/relay.ts', old_string: 'retry(1)', new_string: 'retry(3)' } },
  },
  {
    id: 'a1',
    role: 'assistant',
    kind: 'message',
    text: 'Done. See the table:\n\n| Case | Result |\n|---|---|\n| retry | ok |\n\n```ts\nconst retries = 3\n```\n\n[Docs](https://example.com) and <b>raw</b>',
    createdAt: at + 60_000,
    status: 'done',
    meta: { modelName: 'claude', tokensUsed: 1200, totalResponseTimeMs: 4200, tokensPerSecond: 41.5 },
  },
  { id: 'u2', role: 'user', kind: 'message', text: 'Make a plan for the rest', createdAt: at + 120_000, status: 'done' },
  { id: 'p1', role: 'assistant', kind: 'plan', text: '1. Step', createdAt: at + 121_000, status: 'done', plan: { title: 'Finish relay', markdown: '1. Step' } },
]
const idle: ThreadDisplayState = { questions: [] }

describe('timeline', () => {
  it('renders turns like the desktop: groups, cards, markdown, toolbar and edits', async () => {
    const { container } = render(<Timeline items={items} display={idle} active={false} />)
    // User pills and bubble.
    expect(screen.getByText('Fix the relay')).toBeInTheDocument()
    expect(screen.getByText('log.txt')).toBeInTheDocument()
    expect(screen.getByText('relay.ts')).toBeInTheDocument()
    // The finished turn folds its work behind its Worked line; the answer stays.
    expect(screen.queryByTestId('tool-group')).not.toBeInTheDocument()
    const worked = screen.getByRole('button', { name: 'Worked for 1m' })
    expect(worked).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(worked)
    // The thought and the two calls are one group that says what they did.
    const group = screen.getByRole('button', { name: /Ran 1 command and edited 1 file/ })
    expect(group).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(group)
    expect(screen.getByRole('button', { name: /npm test -- relay/ })).toBeInTheDocument()
    const edit = screen.getByRole('button', { name: /Edited relay\.ts/ })
    expect(within(edit).getByText('+1')).toBeInTheDocument()
    fireEvent.click(edit)
    expect(screen.getByRole('table', { name: 'Changes to relay.ts' })).toHaveTextContent('retry(3)')
    // Markdown: table, highlighted code, safe link, raw HTML as text.
    expect(screen.getByRole('columnheader', { name: 'Case' }).closest('table')).toHaveTextContent('retry')
    expect(screen.getByText('ts')).toBeInTheDocument()
    // The highlighter loads on first use, then colours the block.
    await waitFor(() => expect(container.querySelector('.m-code .hljs-keyword')).toHaveTextContent('const'))
    expect(screen.getByRole('link', { name: 'Docs' })).toHaveAttribute('href', 'https://example.com/')
    expect(screen.getByText(/<b>/)).toBeInTheDocument()
    // Worked-for line, turn file changes and response metadata.
    expect(screen.getByTestId('turn-edits')).toHaveTextContent('1 changed file')
    fireEvent.click(screen.getByRole('button', { name: 'Response metadata' }))
    expect(screen.getByRole('dialog', { name: 'Response metadata' })).toHaveTextContent('41.5 tok/s')
  })

  it('approves a plan and answers questions', async () => {
    const approve = vi.fn(async () => undefined)
    const answer = vi.fn(async () => undefined)
    const dismiss = vi.fn(async () => undefined)
    const display: ThreadDisplayState = {
      questions: [
        { requestId: 'q1', questions: [{ id: 'color', prompt: 'Which colour?', options: [{ id: 'red', label: 'Red' }, { id: 'blue', label: 'Blue' }] }] },
        { requestId: 'q2', questions: [{ id: 'approval', prompt: 'Create quick action "Deploy"?', options: [{ id: 'approve', label: 'Approve' }, { id: 'reject', label: 'Reject' }] }] },
      ],
    }
    render(<Timeline items={items} display={display} active={false} onApprovePlan={approve} onAnswer={answer} onDismiss={dismiss} />)
    expect(screen.getByTestId('plan-card')).toHaveTextContent('Awaiting approval')
    fireEvent.click(within(screen.getByTestId('plan-card')).getByRole('button', { name: 'Approve' }))
    expect(approve).toHaveBeenCalledWith('1. Step')
    expect(await screen.findByText('Approved')).toBeInTheDocument()

    const [question, approval] = screen.getAllByTestId('question-prompt')
    const send = within(question).getByRole('button', { name: 'Send' })
    expect(send).toBeDisabled()
    fireEvent.click(within(question).getByRole('radio', { name: /Blue/ }))
    fireEvent.click(send)
    expect(answer).toHaveBeenCalledWith('q1', { color: 'blue' })

    fireEvent.click(within(approval).getByRole('button', { name: 'Dismiss' }))
    expect(dismiss).toHaveBeenCalledWith('q2')
    fireEvent.click(within(approval).getByRole('button', { name: 'Reject' }))
    expect(answer).toHaveBeenCalledWith('q2', { approval: 'reject' })
  })

  it('shows live and end states', () => {
    const live: ChatItem[] = [
      items[0],
      { id: 'x1', role: 'tool', kind: 'tool', text: '', createdAt: at + 1000, status: 'streaming', tool: { name: 'Bash', title: '', summary: '', details: [], input: { command: 'make' } } },
    ]
    const { rerender } = render(<Timeline items={live} display={{ questions: [], phase: 'tool_running', turnStartedAt: Date.now() - 5000 }} active />)
    // A running call folds into its group; the live line under the work says what runs now.
    expect(screen.getByRole('button', { name: /Ran 1 command/ })).toBeInTheDocument()
    const progress = screen.getByTestId('turn-progress')
    expect(progress).toHaveTextContent('Running Bash…make')
    expect(progress.querySelector('.m-tl-icon')).toHaveAttribute('data-state', 'running')
    expect(screen.getByTestId('work-status')).toHaveTextContent(/Working for \d+ seconds?/)
    rerender(<Timeline items={live} display={{ questions: [], phase: 'stopped' }} active={false} />)
    expect(screen.getByTestId('run-interrupted')).toHaveTextContent('Run interrupted')
    rerender(<Timeline items={live} display={{ questions: [], phase: 'failed', turnError: 'Rate limited', connectionFailed: 'Provider unreachable.' }} active={false} />)
    expect(screen.getByText('Rate limited')).toBeInTheDocument()
    expect(screen.getByTestId('connection-failed')).toHaveTextContent('Provider unreachable.')
  })

  it('marks only the live reply so its new blocks fade in', () => {
    const reply: ChatItem = { id: 'r1', role: 'assistant', kind: 'message', text: 'First block.\n\nSecond block.', createdAt: at + 1000, status: 'streaming' }
    const { container, rerender } = render(<Timeline items={[items[0], reply]} display={{ questions: [], phase: 'streaming' }} active />)
    expect(container.querySelector('.m-tl-assistant .m-md')).toHaveAttribute('data-streaming', 'true')
    // A finished reply, or one in a thread that stopped, replays nothing when opened.
    rerender(<Timeline items={[items[0], { ...reply, status: 'done' }]} display={idle} active={false} />)
    expect(container.querySelector('.m-tl-assistant .m-md')).not.toHaveAttribute('data-streaming')
    rerender(<Timeline items={[items[0], reply]} display={idle} active={false} />)
    expect(container.querySelector('.m-tl-assistant .m-md')).not.toHaveAttribute('data-streaming')
  })

  it('fades Go to latest out and makes it inert while the view follows the end', () => {
    const onClick = vi.fn()
    const { container, rerender } = render(<JumpToLatest live={false} shown={false} onClick={onClick} />)
    const pill = container.querySelector('.m-tl-jump')!
    expect(pill).toHaveAttribute('data-hidden')
    expect(pill).toHaveAttribute('inert')
    expect(screen.queryByRole('button', { name: 'Go to latest' })).not.toBeInTheDocument()
    rerender(<JumpToLatest live shown onClick={onClick} />)
    const button = screen.getByRole('button', { name: 'Go to latest' })
    expect(button).not.toHaveAttribute('data-hidden')
    expect(button).not.toHaveAttribute('inert')
    expect(button.querySelector('.m-tl-jump__live')).toBeInTheDocument()
    fireEvent.click(button)
    expect(onClick).toHaveBeenCalled()
  })

  it('opens a reply image large on a tap and closes it', () => {
    const reply: ChatItem = { id: 'img', role: 'assistant', kind: 'message', text: 'Here:\n\n![Chart of sales](https://example.com/chart.png)', createdAt: at, status: 'done' }
    render(<Timeline items={[reply]} display={idle} active={false} />)
    const open = screen.getByRole('button', { name: 'Open image: Chart of sales' })
    open.focus()
    fireEvent.click(open)
    const viewer = screen.getByRole('dialog', { name: 'Chart of sales' })
    expect(viewer.querySelector('img')).toHaveAttribute('src', 'https://example.com/chart.png')
    expect(screen.getByRole('button', { name: 'Close image' })).toHaveFocus()
    fireEvent.click(screen.getByRole('button', { name: 'Close image' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(open).toHaveFocus()
  })

  it('turns the thinking atom only while the model thinks', () => {
    const thought: ChatItem = { id: 'th', role: 'assistant', kind: 'thinking', text: 'Weighing options', createdAt: at + 1000, status: 'streaming' }
    const { container, rerender } = render(<Timeline items={[items[0], thought]} display={{ questions: [], phase: 'streaming' }} active />)
    const icon = () => container.querySelector('.m-thinking-icon')!
    expect(icon()).toHaveAttribute('data-thinking', 'active')
    expect(icon().querySelector('.m-thinking-icon__orbit')).not.toBeNull()
    // Written so far, the thought follows the label; nothing else says Thinking.
    expect(screen.getByTestId('tool-thinking')).toHaveTextContent('ThinkingWeighing options')
    expect(screen.queryByTestId('turn-progress')).not.toBeInTheDocument()
    rerender(<Timeline items={[items[0], { ...thought, status: 'done' }]} display={idle} active={false} />)
    fireEvent.click(screen.getByRole('button', { name: /Worked for/ }))
    expect(icon()).toHaveAttribute('data-thinking', 'done')
  })

  it('shows a command as one quiet row that opens to its output and exit line', () => {
    const failing = (id: string, createdAt: number, output: unknown): ChatItem => ({
      id,
      role: 'tool',
      kind: 'tool',
      text: '',
      createdAt,
      status: 'done',
      tool: { name: 'Bash', title: 'Run', summary: '', details: [], input: { command: "bash -lc 'npm test'" }, output },
    })
    const turn: ChatItem[] = [
      items[0],
      failing('c1', at + 1000, 'Exit code 1\n × reconnects\nTests 1 failed'),
      { id: 'c2', role: 'assistant', kind: 'message', text: 'Fixed it.', createdAt: at + 5000, status: 'done' },
    ]
    render(<Timeline items={turn} display={idle} active={false} />)
    fireEvent.click(screen.getByRole('button', { name: /Worked for/ }))
    // The shell wrapper is gone from the row, and the failure the agent got past is quiet: no red label, no exit badge.
    const row = screen.getByRole('button', { name: /Failed npm test/ })
    expect(row.querySelector('.m-tl-row__label--error')).toBeNull()
    expect(row.querySelector('.m-tl-icon')).toHaveAttribute('data-state', 'recovered')
    expect(row).not.toHaveTextContent('exit 1')
    fireEvent.click(row)
    const body = screen.getByTestId('tool-bash')
    expect(body.querySelector('.m-tl-out__fail')).toHaveTextContent('× reconnects')
    expect(body.querySelector('.m-tl-out__exit')).toHaveTextContent('exit 1')
    expect(body).not.toHaveTextContent('Exit code 1')
    cleanup()
    // A failure that ended a failed turn stays loud, and in view when the work folds.
    render(<Timeline items={turn.slice(0, 2)} display={{ questions: [], phase: 'failed' }} active={false} />)
    const loud = screen.getByRole('button', { name: /Failed npm test/ })
    expect(loud.querySelector('.m-tl-row__label--error')).not.toBeNull()
    expect(loud).toHaveTextContent('exit 1')
  })

  it('keeps the answer last, and what needs the person in view, when a finished turn folds', () => {
    const tool = (id: string, name: string, input: Record<string, unknown>, createdAt: number): ChatItem => ({
      id,
      role: 'tool',
      kind: 'tool',
      text: '',
      createdAt,
      status: 'done',
      tool: { name, title: name, summary: '', details: [], input },
    })
    const turn: ChatItem[] = [
      items[0],
      { id: 'h', role: 'system', kind: 'handoff', text: '', createdAt: at + 500, status: 'done', handoff: { from: 'gpt', to: 'claude' } },
      { id: 'n1', role: 'assistant', kind: 'message', text: 'Looking at the relay first.', createdAt: at + 1000, status: 'done' },
      tool('r1', 'Read', { file_path: 'a.ts' }, at + 2000),
      tool('r2', 'Read', { file_path: 'b.ts' }, at + 3000),
      { id: 'ans', role: 'assistant', kind: 'message', text: 'All fixed.', createdAt: at + 4000, status: 'done' },
      tool('r3', 'Read', { file_path: 'a.ts' }, at + 5000),
    ]
    const { container } = render(<Timeline items={turn} display={idle} active={false} />)
    // The model switch marker and the answer stay; the narration and reads fold.
    expect(screen.getByText('gpt')).toBeInTheDocument()
    expect(screen.queryByText('Looking at the relay first.')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Worked for/ }))
    expect(screen.getByText('Looking at the relay first.')).toBeInTheDocument()
    // Work written after the answer moves above it, and reading a file twice counts once.
    const texts = [...container.querySelectorAll('.m-tl-answer > *')].map((node) => node.textContent)
    expect(texts[texts.length - 1]).toContain('All fixed.')
    expect(screen.getByRole('button', { name: /Read 2 files/ })).toBeInTheDocument()
  })

  it('shows a subagent as one compact row that opens on its whole report', () => {
    const task: ChatItem = {
      id: 'k1',
      role: 'tool',
      kind: 'tool',
      text: '',
      createdAt: at + 1000,
      status: 'done',
      tool: { name: 'Task', title: 'Task', summary: '', details: [], input: { description: 'Survey reconnect UX', subagent_type: 'researcher' }, output: '**Most** apps show a pill.\n\nSlack waits 10 s.' },
    }
    const failed: ChatItem = { ...task, id: 'k2', status: 'error', tool: { ...task.tool!, input: { description: 'Measure on Android' }, output: 'No device.' } }
    render(<Timeline items={[items[0], task, failed]} display={{ questions: [], phase: 'streaming' }} active />)
    const group = screen.getByRole('group', { name: '2 subagents · 1 failed · 1 done' })
    // Finished, the group is folded until opened.
    fireEvent.click(within(group).getByRole('button', { expanded: false }))
    const row = screen.getByRole('button', { name: 'Survey reconnect UX, Done' })
    expect(row).toHaveTextContent('Most apps show a pill. Slack waits 10 s.')
    fireEvent.click(row)
    expect(screen.getAllByTestId('tool-task')[0].querySelectorAll('.m-tl-sub__full p')).toHaveLength(2)
    expect(screen.getByRole('button', { name: 'Measure on Android, Failed' })).toHaveTextContent(/Failed\s·\sNo device\./)
  })

  it('shows backslashes and code as written, and wraps code until Wrap is turned off', () => {
    expect(keepLiteralBackslashes('a\\/b \\* `c\\` \\\\host')).toBe('a\\\\/b \\* `c\\` \\\\\\\\host')
    const { container } = render(<Markdown text={'At C:\\me\\.cache and /^a\\/b/ but \\*not italic\\*.\n\n```sh\nnpm test -- --run\n```'} />)
    expect(container.querySelector('p')).toHaveTextContent('At C:\\me\\.cache and /^a\\/b/ but *not italic*.')
    const block = container.querySelector('.m-code')!
    expect(block).not.toHaveAttribute('data-wrap')
    fireEvent.click(screen.getByRole('button', { name: "Don't wrap lines" }))
    expect(block).toHaveAttribute('data-wrap', 'off')
    expect(screen.getByRole('button', { name: 'Wrap lines' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('folds a long prompt until Show full message is tapped', () => {
    const height = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('m-tl-user__text') ? 600 : 0
    })
    try {
      const { container } = render(<Timeline items={[{ ...items[0], text: 'long\n'.repeat(40) }]} display={idle} active={false} />)
      const text = container.querySelector('.m-tl-user__text')!
      expect(text).toHaveClass('m-tl-user__text--folded')
      fireEvent.click(screen.getByRole('button', { name: 'Show full message' }))
      expect(text).not.toHaveClass('m-tl-user__text--folded')
      expect(screen.getByRole('button', { name: 'Show less' })).toHaveAttribute('aria-expanded', 'true')
    } finally {
      height.mockRestore()
    }
  })

  it('marks a turn a Stop or a restart cut off, and keeps the order it ran in', () => {
    const turn: ChatItem[] = [
      items[0],
      { id: 'w1', role: 'assistant', kind: 'message', text: 'Running the tests first.', createdAt: at + 1000, status: 'done' },
      { ...items[2], id: 'b9', createdAt: at + 2000, status: 'streaming' },
      { id: 'end', role: 'system', kind: 'message', text: 'Turn stopped.', createdAt: at + 3000, status: 'done', turnEnd: { cause: 'user' } },
      { id: 'u9', role: 'user', kind: 'message', text: 'Go on', createdAt: at + 10_000, status: 'done' },
      { id: 'end2', role: 'system', kind: 'message', text: '', createdAt: at + 12_000, status: 'done', turnEnd: { cause: 'daemon_restart' } },
    ]
    const { container } = render(<Timeline items={turn} display={idle} active={false} />)
    const [first, second] = screen.getAllByTestId('work-status')
    expect(first).toHaveTextContent('Worked for 3s · Stopped: You stopped this turn before it finished.')
    expect(second).toHaveTextContent('Worked for 2s · Interrupted')
    // The marker line itself shows nothing.
    expect(screen.queryByText('Turn stopped.')).not.toBeInTheDocument()
    // The text written before the command stays above it, and the cut-off command reads Interrupted.
    fireEvent.click(within(first).getByRole('button'))
    const rows = [...container.querySelectorAll('.m-tl-turn')[0].querySelectorAll('.m-tl-answer > *')].map((node) => node.textContent)
    expect(rows[0]).toContain('Running the tests first.')
    expect(rows[1]).toContain('Interrupted')
  })

  it('reads why a turn was cut off from the transcript line', () => {
    const stop = toChatItem({ id: 's', role: 'system', content: 'Turn stopped.', timestamp: '2026-11-13T10:00:00Z' })
    expect(stop?.turnEnd).toEqual({ cause: 'user' })
    const crash = toChatItem({ id: 'c', role: 'system', content: 'x', timestamp: '2026-11-13T10:00:00Z', turnEnd: { cause: 'crash', tools: ['Bash'] } })
    expect(crash?.turnEnd).toEqual({ cause: 'crash', tools: ['Bash'] })
    const failed = toChatItem({ id: 'e', role: 'assistant', content: '', timestamp: '2026-11-13T10:00:00Z', error: { message: 'Overloaded.', code: 'provider_overloaded', details: { supportId: 'ab-12' } } })
    expect(failed?.error).toEqual({ message: 'Overloaded. Reference: ab-12', code: 'provider_overloaded' })
  })

  it("shows a failed request with the provider's own title, message and reference", () => {
    const failed: ChatItem = { id: 'f', role: 'assistant', kind: 'message', text: '', createdAt: at + 1000, status: 'error', error: { message: '529 Overloaded: try again soon. Reference: ab-12', code: 'provider_overloaded' } }
    render(<Timeline items={[items[0], failed]} display={idle} active={false} />)
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('Provider error')
    expect(alert.querySelector('.m-tl-error__message')).toHaveTextContent(/^529 Overloaded: try again soon\.$/)
    expect(alert.querySelector('.m-tl-error__meta')).toHaveTextContent('Reference ab-12')
    cleanup()
    render(<Timeline items={[items[0], { ...failed, error: { message: 'Limit hit.', code: 'provider_usage_limit' } }]} display={idle} active={false} />)
    expect(screen.getByRole('alert')).toHaveTextContent('Usage limit reached')
  })

  it('keeps the tool name the runtime gave a row, and guesses only from a sentence', () => {
    const row = (toolCall: Record<string, unknown>, kind = 'tool_call') =>
      toChatItem({ id: 'x', role: 'assistant', content: '', kind, timestamp: '2026-11-13T10:00:00Z', toolCall: { summary: '', details: [], status: 'complete', ...toolCall } })?.tool
    expect(row({ title: 'x', toolName: 'mcp__mousse__thread_list' })).toMatchObject({ name: 'Mcp', server: 'mousse', rawName: 'thread_list' })
    expect(row({ title: 'ToolSearch', input: { query: 'select:mcp__mousse__thread_list,Read' } })).toMatchObject({ name: 'ToolSearch' })
    expect(row({ title: 'Searching the web' })?.name).toBe('Generic')
    expect(row({ title: 'Terminal' })?.name).toBe('Bash')
    expect(row({ title: 'TaskOutput', toolName: 'TaskOutput' }, 'mcp_tool_call')?.name).toBe('TaskOutput')
    expect(row({ title: 'Grep', toolName: 'Grep', summary: 'Grep' })?.input).toEqual({ pattern: '', query: '' })
    const search: ChatItem = { id: 'ts', role: 'tool', kind: 'tool', text: '', createdAt: at + 1, status: 'done', tool: row({ title: 'ToolSearch', input: { query: 'select:mcp__mousse__thread_list,Read' } })! }
    render(<Timeline items={[search]} display={idle} active={false} />)
    expect(screen.getByTestId('tool-generic')).toHaveTextContent('Loaded toolsthread_list, Read')
  })
})
