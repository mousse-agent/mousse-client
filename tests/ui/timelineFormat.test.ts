// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { ChatItem, ChatToolCall } from '../../src/connection/types'
import {
  diffLines,
  diffStats,
  editDiff,
  formatWorkedFor,
  formatWorkingFor,
  groupLabel,
  hunks,
  mcpArgs,
  mcpTitle,
  searchLabels,
  searchResults,
  segmentReplies,
  thoughtHeading,
  toolState,
  turnEdits,
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
    expect(segments.map((segment) => (segment.kind === 'group' ? segment.items.map((entry) => entry.id) : segment.item.id))).toEqual([['t1', 'r1'], 'm1', 'e1', 'q1'])
    expect(groupLabel(replies.slice(0, 2))).toBe('Looking around')
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
})
