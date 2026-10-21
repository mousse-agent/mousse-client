// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { chatItem, ThreadProjection } from '../../src/connection/threadProjection'
import { b64url, utf8 } from '../../src/net/bytes'
import type { StreamRecord } from '../../src/net/session'
import { message, snapshotBodies } from './helpers'

let seq = 0
function rec(type: string, body: unknown): StreamRecord {
  seq++
  return {
    seq,
    epoch: 1,
    recvTs: seq,
    bytes: new Uint8Array(),
    envelope: { v: 1, minor: 0, id: `e${seq}`, stream: 's', type, crit: false, author: { user: 'u', node: 'n', keyEpoch: 1 }, ts: 0, body },
  }
}
const event = (threadId: string, type: string, data: unknown) => rec('thread.event', { threadId, type, data })
const snapshot = (threadId: string, value: unknown) => snapshotBodies(threadId, value).map((entry) => rec(entry.type, entry.body))

describe('chatItem', () => {
  it('maps text, tools, errors and hidden messages', () => {
    expect(chatItem(message('a', 'assistant', 'Hi', 5_000))).toEqual({ id: 'a', role: 'assistant', kind: 'message', text: 'Hi', createdAt: 5_000, status: 'done' })
    expect(chatItem(message('h', 'user', 'x', 0, { hidden: true }))).toBeUndefined()
    expect(chatItem(message('t', 'assistant', '', 0, { toolCall: { title: 'Read file', summary: 'a.ts', status: 'running', toolName: 'read' } }))).toMatchObject({
      role: 'tool',
      text: 'Read file\na.ts',
      status: 'streaming',
      toolName: 'Read',
    })
    expect(chatItem(message('e', 'assistant', '', 0, { error: 'Model failed' }))).toMatchObject({ error: { message: 'Model failed' }, status: 'error' })
    expect(chatItem(message('empty', 'assistant', '  '))).toBeUndefined()
  })
})

describe('ThreadProjection', () => {
  it('builds items from a snapshot and applies message events', () => {
    const projection = new ThreadProjection('t1')
    expect(projection.apply(snapshot('t1', { messages: [message('m1', 'user', 'Hi')], activeTurn: { active: true, running: true } }))).toBe(true)
    expect(projection.active).toBe(true)
    expect(projection.items().map((item) => item.text)).toEqual(['Hi'])

    projection.apply([event('t1', 'thread.message', { threadId: 't1', message: message('m2', 'assistant', 'Part', 2_000) })])
    projection.apply([event('t1', 'thread.message-updated', { threadId: 't1', message: message('m2', 'assistant', 'Whole', 2_000) })])
    projection.apply([event('t1', 'turn.completed', { threadId: 't1' })])
    expect(projection.items().map((item) => item.text)).toEqual(['Hi', 'Whole'])
    expect(projection.active).toBe(false)

    // A list without `replace` keeps messages that arrived after it.
    projection.apply([event('t1', 'thread.messages', { threadId: 't1', messages: [message('m1', 'user', 'Hi!')] })])
    expect(projection.items().map((item) => item.text)).toEqual(['Hi!', 'Whole'])
    projection.apply([event('t1', 'thread.messages', { threadId: 't1', messages: [message('m9', 'user', 'Reset')], replace: true })])
    expect(projection.items().map((item) => item.text)).toEqual(['Reset'])
  })

  it('ignores other threads, bad hashes and broken chunk sequences', () => {
    const projection = new ThreadProjection('t1')
    expect(projection.apply([event('t2', 'thread.message', { threadId: 't2', message: message('x', 'user', 'no') })])).toBe(false)

    const records = snapshot('t1', { messages: [message('m1', 'user', 'Hi')] })
    const end = records[2].envelope.body as Record<string, unknown>
    const begin = records[0].envelope.body as Record<string, unknown>
    begin.sha256 = b64url(new Uint8Array(32))
    expect(projection.apply(records)).toBe(false)
    expect(end.snapshot).toBe(begin.snapshot)

    const skipped = snapshot('t1', { messages: [message('m1', 'user', 'Hi')] })
    const chunk = skipped[1].envelope.body as Record<string, unknown>
    chunk.index = 1
    expect(projection.apply(skipped)).toBe(false)

    const oversized = snapshot('t1', { messages: [] })
    ;(oversized[1].envelope.body as Record<string, unknown>).data = b64url(utf8('{"messages":[],"extra":1}'))
    expect(projection.apply(oversized)).toBe(false)
    expect(projection.items()).toEqual([])
  })

  it('keeps local items until the next snapshot', () => {
    const projection = new ThreadProjection('t1')
    projection.apply(snapshot('t1', { messages: [message('m1', 'user', 'Hi', 1_000)] }))
    projection.addLocal({ id: 'local', role: 'system', text: 'The reply failed', createdAt: 3_000, status: 'error' })
    expect(projection.items().map((item) => item.id)).toEqual(['m1', 'local'])
    projection.apply(snapshot('t1', { messages: [message('m1', 'user', 'Hi', 1_000)] }))
    expect(projection.items().map((item) => item.id)).toEqual(['m1'])
  })
})

describe('timeline items', () => {
  it('maps every desktop row kind', () => {
    expect(chatItem(message('th', 'assistant', '', 1, { kind: 'thinking', thinking: { content: '**Plan** the work', status: 'processing' } }))).toMatchObject({
      kind: 'thinking',
      text: '**Plan** the work',
      status: 'streaming',
    })
    expect(chatItem(message('pl', 'assistant', '', 1, { kind: 'plan_card', planCard: { originalRequest: 'Add dark mode', planMarkdown: '# Steps\n1. Do it' } }))).toMatchObject({
      kind: 'plan',
      plan: { title: 'Add dark mode', markdown: '# Steps\n1. Do it' },
    })
    expect(
      chatItem(message('ed', 'assistant', '', 1, { kind: 'tool_call', toolCall: { title: 'Edit file', summary: 'ok', details: [], toolName: 'edit', status: 'complete', input: { file_path: '/r/src/a.ts', old_string: 'a', new_string: 'b' }, response: 'Edited' } })),
    ).toMatchObject({ kind: 'tool', toolName: 'Edit', status: 'done', tool: { name: 'Edit', input: { file_path: '/r/src/a.ts' }, output: 'Edited' } })
    // A running call's response is its arguments, not its output.
    expect(
      chatItem(message('b1', 'assistant', '', 1, { kind: 'tool_call', toolCall: { title: 'Run', summary: '', details: [], toolName: 'bash', status: 'processing', response: '{"command":"ls"}' } }))?.tool,
    ).toMatchObject({ name: 'Bash', input: { command: 'ls' } })
    expect(
      chatItem(message('b2', 'assistant', '', 1, { kind: 'tool_call', toolCall: { title: 'Run', summary: 'The tool returned an error.', details: ['Command: npm test'], toolName: 'bash', status: 'complete' } })),
    ).toMatchObject({ status: 'error', tool: { input: { command: 'npm test' } } })
    expect(
      chatItem(message('mc', 'assistant', '', 1, { kind: 'mcp_tool_call', toolCall: { title: 'list_issues', summary: '', details: ['Server: github', 'Tool: list_issues'], toolName: 'list_issues', status: 'complete', response: '[{"type":"text","text":"[]"}]' } }))?.tool,
    ).toMatchObject({ name: 'Mcp', server: 'github', rawName: 'list_issues' })
    expect(chatItem(message('ho', 'system', 'Switched', 1, { kind: 'context_handoff', contextHandoff: { from: { provider: 'openai', model: 'gpt' }, to: { provider: 'anthropic', model: 'claude' } } }))).toMatchObject({
      kind: 'handoff',
      handoff: { from: 'openai / gpt', to: 'anthropic / claude' },
    })
    expect(chatItem(message('cc', 'assistant', '', 1, { kind: 'context_compaction', streaming: true }))).toMatchObject({ kind: 'compaction', status: 'streaming' })
    expect(chatItem(message('wa', 'assistant', 'Careful', 1, { kind: 'warning' }))).toMatchObject({ kind: 'warning', role: 'system' })
    expect(chatItem(message('st', 'assistant', 'Done.\n\n(Stopped)', 1, { responseMetadata: { modelName: 'm', tokensUsed: 12, bogus: 1 } }))).toMatchObject({
      text: 'Done.',
      meta: { modelName: 'm', tokensUsed: 12 },
    })
    // An empty streaming placeholder shows nothing yet.
    expect(chatItem(message('ph', 'assistant', '', 1, { streaming: true }))).toBeUndefined()
  })

  it('lifts composer markers out of user text and keeps valid images', () => {
    const refs = encodeURIComponent(JSON.stringify([{ id: 'r', kind: 'file', title: 'a.ts', path: '/w/a.ts' }, { kind: 'evil', title: 'x' }]))
    const content = `Look at this\n[Mousse references data="${refs}"]\nfile a.ts\n[/Mousse references]\n[Attached files: shot.png, notes.pdf]`
    const item = chatItem(
      message('u', 'user', content, 1, {
        images: [
          { name: 'shot.png', mimeType: 'image/png', data: 'aGVsbG8=' },
          { name: 'x.svg', mimeType: 'image/svg+xml', data: 'PHN2Zz4=' },
        ],
      }),
    )
    expect(item).toMatchObject({ text: 'Look at this', files: ['notes.pdf'], references: [{ kind: 'file', title: 'a.ts', path: '/w/a.ts' }] })
    // SVG can carry script; only raster images are shown.
    expect(item?.images).toEqual([{ name: 'shot.png', mimeType: 'image/png', data: 'aGVsbG8=' }])
  })

  it('merges consecutive thoughts and folds a repeated reply', () => {
    const projection = new ThreadProjection('t1')
    projection.apply(
      snapshot('t1', {
        messages: [
          message('a', 'assistant', '', 1, { kind: 'thinking', thinking: { content: 'One', status: 'complete' } }),
          message('b', 'assistant', '', 2, { kind: 'thinking', thinking: { content: 'Two', status: 'processing' } }),
          message('c', 'assistant', 'Same', 3),
          message('d', 'assistant', 'Same', 4),
        ],
      }),
    )
    expect(projection.items().map((item) => [item.id, item.text, item.status])).toEqual([
      ['a', 'One\n\nTwo', 'streaming'],
      ['c', 'Same', 'done'],
    ])
  })
})

describe('thread display state', () => {
  it('reads pending questions, turn phases and provider failures', () => {
    const projection = new ThreadProjection('t1')
    const pending = [{ requestId: 'q1', threadId: 't1', questions: [{ id: 'approval', prompt: 'Run it?', options: [{ id: 'approve', label: 'Approve' }] }] }]
    projection.apply(snapshot('t1', { messages: [], pendingQuestions: pending, activeTurn: { active: true, running: true } }))
    expect(projection.state().questions).toEqual([{ requestId: 'q1', questions: [{ id: 'approval', prompt: 'Run it?', options: [{ id: 'approve', label: 'Approve' }] }] }])

    projection.apply([event('t1', 'turn.state', { threadId: 't1', phase: 'tool_running', startedAt: '2026-01-01T00:00:00.000Z' })])
    expect(projection.state()).toMatchObject({ phase: 'tool_running', turnStartedAt: Date.parse('2026-01-01T00:00:00.000Z') })
    expect(projection.active).toBe(true)
    projection.apply([event('t1', 'turn.state', { threadId: 't1', phase: 'failed', error: 'Rate limited' })])
    expect(projection.state()).toMatchObject({ phase: 'failed', turnError: 'Rate limited' })
    expect(projection.active).toBe(false)
    projection.apply([event('t1', 'connection.failed', { threadId: 't1', error: { message: 'Provider unreachable.' } })])
    expect(projection.state().connectionFailed).toBe('Provider unreachable.')
    projection.apply([event('t1', 'turn.started', { threadId: 't1' })])
    expect(projection.state().connectionFailed).toBeUndefined()
    projection.apply([event('t1', 'turn.interrupted', { threadId: 't1' })])
    expect(projection.state().phase).toBe('stopped')
  })

  it('applies live deltas without undoing finished messages', () => {
    const projection = new ThreadProjection('t1')
    projection.apply(snapshot('t1', { messages: [message('m1', 'user', 'Hi')] }))
    const delta = (msg: unknown) => ({ threadId: 't1', type: 'thread.message-updated', data: { threadId: 't1', message: msg } })

    expect(projection.applyDelta(delta(message('m2', 'assistant', 'Par', 2, { streaming: true })))).toBe(true)
    expect(projection.items().at(-1)).toMatchObject({ id: 'm2', text: 'Par', status: 'streaming' })
    // Settled messages arrive in the signed stream; a late streaming delta cannot regress them.
    projection.apply([event('t1', 'thread.message-updated', { threadId: 't1', message: message('m2', 'assistant', 'Partial done', 2) })])
    expect(projection.applyDelta(delta(message('m2', 'assistant', 'Par', 2, { streaming: true })))).toBe(false)
    expect(projection.items().at(-1)).toMatchObject({ text: 'Partial done', status: 'done' })
    // Only streaming rows, only this thread.
    expect(projection.applyDelta(delta(message('m3', 'assistant', 'x', 3)))).toBe(false)
    expect(projection.applyDelta({ threadId: 't2', type: 'thread.message', data: { threadId: 't2', message: message('m4', 'assistant', 'x', 4, { streaming: true }) } })).toBe(false)

    expect(projection.applyDelta({ threadId: 't1', type: 'questions.updated', data: { threadId: 't1', pending: [{ requestId: 'q', threadId: 't1', questions: [{ id: 'a', prompt: 'Which?', options: [] }] }] } })).toBe(true)
    expect(projection.state().questions.map((entry) => entry.requestId)).toEqual(['q'])
    expect(projection.applyDelta({ threadId: 't1', type: 'questions.updated', data: { threadId: 't1', pending: [] } })).toBe(true)
    expect(projection.state().questions).toEqual([])
  })
})
