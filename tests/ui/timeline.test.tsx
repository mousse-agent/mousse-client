import { describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach } from 'vitest'
import type { ChatItem, ThreadDisplayState } from '../../src/connection/types'
import { JumpToLatest, Timeline } from '../../src/ui/timeline/Timeline'

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
    // The thought and the three tool calls collapse into a group titled by the thought.
    const group = screen.getByRole('button', { name: /Reading the relay code/ })
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
    expect(screen.getByText('Worked for 1m')).toBeInTheDocument()
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
    expect(screen.getByText('Running make')).toHaveClass('m-tl-shimmer--active')
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
})
