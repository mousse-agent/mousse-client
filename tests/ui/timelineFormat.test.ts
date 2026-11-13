// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { ChatItem, ChatToolCall } from '../../src/connection/types'
import {
  describeTurnProgress,
  diffLines,
  diffStats,
  editDiff,
  foldTurnWork,
  formatWorkedFor,
  formatWorkingFor,
  groupLabel,
  hunks,
  liveThoughtLine,
  mcpArgs,
  mcpTitle,
  plainResultText,
  searchLabels,
  searchResults,
  segmentReplies,
  settleFinishedTurn,
  subagentReport,
  subagentStarted,
  subagentState,
  thoughtHeading,
  toolState,
  turnEdits,
  workGroupIcon,
  workGroupTitle,
} from '../../src/ui/timeline/format'

const tool = (name: string, extra: Partial<ChatToolCall> = {}): ChatToolCall => ({ name, title: name, summary: '', details: [], input: {}, ...extra })
const item = (id: string, extra: Partial<ChatItem>): ChatItem => ({ id, role: 'assistant', text: '', createdAt: 0, status: 'done', ...extra })

describe('timeline format', () => {
  it('diffs lines and keeps context around changes', () => {
    const lines = diffLines('a\nb\nc\nd', 'a\nB\nc\nd\ne')
    expect(lines).toEqual([
      { type: 'context', text: 'a' },
      { type: 'remove', text: 'b' },
      { type: 'add', text: 'B' },
      { type: 'context', text: 'c' },
      { type: 'context', text: 'd' },
      { type: 'add', text: 'e' },
    ])
    expect(diffStats(lines)).toEqual({ added: 2, removed: 1 })
    const long = diffLines(Array.from({ length: 20 }, (_, i) => `l${i}`).join('\n'), Array.from({ length: 20 }, (_, i) => (i === 10 ? 'X' : `l${i}`)).join('\n'))
    const shown = hunks(long, 2)
    expect(shown[0]).toBeNull()
    expect(shown.filter(Boolean)).toHaveLength(6)
  })

  it('reads edits from every provider shape', () => {
    expect(diffStats(editDiff(tool('Edit', { input: { file_path: 'a', old_string: 'x\ny', new_string: 'x\nz\nw' } })))).toEqual({ added: 2, removed: 1 })
    expect(diffStats(editDiff(tool('Edit', { input: { path: 'a', edits: [{ oldText: 'p', newText: 'q' }] } })))).toEqual({ added: 1, removed: 1 })
    expect(diffStats(editDiff(tool('Write', { input: { file_path: 'a', content: 'one\ntwo\n' } })))).toEqual({ added: 2, removed: 0 })
    expect(diffStats(editDiff(tool('Edit', { output: { structuredPatch: [{ lines: [' a', '-b', '+c', '+d'] }] } })))).toEqual({ added: 2, removed: 1 })
  })

  it('labels searches, MCP calls and thoughts like the desktop', () => {
    const grep = tool('Grep', { input: { pattern: 'TODO' }, output: 'a.ts\nb.ts' })
    expect(searchResults(grep).count).toBe(2)
    expect(searchLabels(grep, 2)).toEqual({ done: 'Found 2 results', detail: 'Grep “TODO”' })
    expect(searchLabels(tool('Glob'), 0).done).toBe('No matches')
    const mcp = tool('Mcp', { rawName: 'list_issues', input: { repo: 'r', query: 'bug', extra: 1 } })
    expect(mcpTitle(mcp, 'running')).toBe('Listing issues')
    expect(mcpTitle(mcp, 'done')).toBe('Listed issues')
    expect(mcpTitle(mcp, 'interrupted')).toBe('List issues interrupted')
    expect(mcpArgs(mcp.input)).toBe('query: bug  repo: r')
    expect(thoughtHeading('## **Checking** the `relay`\nmore')).toBe('Checking the relay')
  })

  it('groups activity runs and counts the turn edits', () => {
    const replies = [
      item('t1', { kind: 'thinking', text: 'Looking around' }),
      item('r1', { kind: 'tool', role: 'tool', tool: tool('Read') }),
      item('m1', { kind: 'message', text: 'Found it' }),
      item('e1', { kind: 'tool', role: 'tool', tool: tool('Edit', { input: { file_path: '/w/src/a.ts', old_string: 'a', new_string: 'b' } }) }),
      item('q1', { kind: 'tool', role: 'tool', tool: tool('Question') }),
    ]
    const segments = segmentReplies(replies)
    expect(segments.map((segment) => (segment.kind === 'item' ? segment.item.id : segment.items.map((entry) => entry.id)))).toEqual([['t1', 'r1'], 'm1', 'e1', 'q1'])
    expect(groupLabel(replies.slice(0, 2))).toBe('Looking around')
    // While the turn runs, a running call folds into a group even alone.
    const running = item('e2', { kind: 'tool', role: 'tool', status: 'streaming', tool: tool('Bash', { input: { command: 'make' } }) })
    expect(segmentReplies([running], true)[0].kind).toBe('group')
    expect(segmentReplies([running], false)[0].kind).toBe('item')
    expect(turnEdits(replies)).toEqual({ files: [{ path: 'src/a.ts', added: 1, removed: 1 }], added: 1, removed: 1 })
  })

  it('formats work time and tool states', () => {
    expect(formatWorkingFor(65_000)).toBe('Working for 1 minute and 5 seconds')
    expect(formatWorkedFor(126_000)).toBe('Worked for 2m 6s')
    expect(formatWorkedFor(3_600_000)).toBe('Worked for 1h')
    const running = item('x', { status: 'streaming', tool: tool('Bash') })
    expect(toolState(running, true)).toBe('running')
    expect(toolState(running, false)).toBe('interrupted')
    expect(toolState(item('y', { tool: tool('Bash', { output: { success: false } }) }), false)).toBe('error')
  })

  it('titles work groups by what they did and folds a finished turn', () => {
    const call = (id: string, name: string, input: Record<string, unknown> = {}) => item(id, { kind: 'tool', role: 'tool', tool: tool(name, { input }) })
    expect(workGroupTitle([item('t', { kind: 'thinking', text: 'Hmm' }), call('a', 'Read', { file_path: 'x' }), call('b', 'Read', { file_path: 'x' }), call('c', 'Bash')])).toBe(
      'Read 1 file and ran 1 command',
    )
    expect(workGroupTitle([call('a', 'Edit'), call('b', 'Bash'), call('c', 'Read'), call('d', 'Grep'), call('e', 'Grep')])).toBe(
      'Edited 1 file, ran 1 command and 3 other actions',
    )
    expect(workGroupTitle([call('a', 'Grep'), call('b', 'Glob'), call('c', 'WebSearch')])).toBe('Searched code twice and searched the web once')
    expect(workGroupTitle([item('t', { kind: 'thinking', text: '**Plan** it' })])).toBe('Plan it')
    expect(workGroupIcon([call('a', 'Bash'), call('b', 'Bash')])).toBe('Bash')
    expect(workGroupIcon([call('a', 'Bash'), call('b', 'Read')])).toBeUndefined()
    // The answer and what must stay stay; the work and narration fold.
    expect(
      foldTurnWork([{ kind: 'message', text: true }, { kind: 'tools' }, { kind: 'tools', keep: true }, { kind: 'cards', running: true }, { kind: 'message', keep: true }, { kind: 'message', text: true }]),
    ).toEqual([true, true, false, false, false, false])
    // A turn cut off before its answer folds all its work.
    expect(foldTurnWork([{ kind: 'message', text: true }, { kind: 'message', toolsOnly: true }])).toEqual([true, true])
    // Settling moves work after the answer above it, unless the turn was cut off.
    const answer = item('ans', { kind: 'message', text: 'Done' })
    const after = call('z', 'Read')
    expect(settleFinishedTurn([answer, after]).map((entry) => entry.id)).toEqual(['z', 'ans'])
    expect(settleFinishedTurn([answer, after], true).map((entry) => entry.id)).toEqual(['ans', 'z'])
  })

  it('says what a running turn does now', () => {
    const bash = item('b', { kind: 'tool', role: 'tool', status: 'streaming', tool: tool('Bash', { input: { command: 'npm test\nmore' } }) })
    expect(describeTurnProgress([bash], 'tool_running', false)).toEqual({ kind: 'running-tool', label: 'Running Bash…', detail: 'npm test', tool: 'Bash' })
    const empty = item('e', { kind: 'tool', role: 'tool', status: 'streaming', tool: tool('Read', { input: {} }) })
    expect(describeTurnProgress([empty], 'tool_running', false)?.label).toBe('Preparing Read…')
    const spawning = item('s', { kind: 'tool', role: 'tool', status: 'streaming', tool: tool('Task', { input: {} }) })
    expect(describeTurnProgress([spawning], 'tool_running', false)?.label).toBe('Starting subagent…')
    expect(describeTurnProgress([spawning, { ...spawning, id: 's2' }, bash], 'tool_running', false)?.label).toBe('Starting 2 subagents…')
    expect(describeTurnProgress([item('t', { kind: 'thinking', status: 'streaming', text: 'x' })], 'thinking', false)).toBeNull()
    expect(describeTurnProgress([], 'queued', false)?.label).toBe('Thinking…')
    expect(describeTurnProgress([bash], 'tool_running', true)).toBeNull()
    expect(liveThoughtLine('First.\n\n**Now** checking the `relay`')).toBe('Now checking the relay')
  })

  it('reads a subagent report with its line breaks and as one plain line', () => {
    const task = tool('Task', { input: { description: 'Survey' }, output: [{ type: 'text', text: '## Found\n\n- one\n- two' }, { type: 'text', text: 'agentId: ab12 (for resuming to continue)' }] })
    expect(subagentReport(task)).toBe('## Found\n\n- one\n- two')
    expect(plainResultText(subagentReport(task))).toBe('Found one two')
    const running = item('t', { kind: 'tool', role: 'tool', status: 'streaming', tool: task })
    expect(subagentState(running, true)).toBe('working')
    expect(subagentState(running, false)).toBe('interrupted')
    expect(subagentState({ ...running, tool: tool('Task', { input: { description: 'x', run_in_background: true } }) }, false)).toBe('working')
    expect(subagentStarted({ ...running, tool: tool('Task') })).toBe(false)
  })
})
