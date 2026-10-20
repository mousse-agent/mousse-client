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
    expect(chatItem(message('a', 'assistant', 'Hi', 5_000))).toEqual({ id: 'a', role: 'assistant', text: 'Hi', createdAt: 5_000, status: 'done' })
    expect(chatItem(message('h', 'user', 'x', 0, { hidden: true }))).toBeUndefined()
    expect(chatItem(message('t', 'assistant', '', 0, { toolCall: { title: 'Read file', summary: 'a.ts', status: 'running', toolName: 'read' } }))).toMatchObject({
      role: 'tool',
      text: 'Read file\na.ts',
      status: 'streaming',
      toolName: 'read',
    })
    expect(chatItem(message('e', 'assistant', '', 0, { error: 'Model failed' }))).toMatchObject({ text: 'Model failed', status: 'error' })
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
