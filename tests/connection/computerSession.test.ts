// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { RealComputerSession } from '../../src/connection/computerSession'
import type { ChatItem } from '../../src/connection/types'
import { newId } from '../../src/net/canonical'
import { NetError } from '../../src/net/errors'
import { generateNodeKeys } from '../../src/net/keys'
import { LeafSession } from '../../src/net/session'
import { streamPair } from '../../src/net/stream'
import { delegate, roster, testComputer, testUser } from '../net/fixtures'
import { channelOf, fakeComputer, message, snapshotBodies, until } from './helpers'

async function setup() {
  const user = testUser()
  const computer = testComputer(user)
  const phone = newId('node')
  const phoneDelegation = delegate(user, phone, generateNodeKeys(), { name: 'Phone' })
  const signedRoster = roster(user, computer.node)
  const [a, b] = streamPair()
  const leaf = new LeafSession(channelOf(a, computer.keys.transport.spki), {
    identity: { user: user.user, rootKey: user.rootKey, node: phone, roster: signedRoster, delegation: phoneDelegation },
    peerNode: computer.node,
  })
  const remote = fakeComputer(b, user, computer, signedRoster)
  await remote.handshake()
  await leaf.opened
  let closed = 0
  const session = new RealComputerSession({ nodeId: computer.node, leaf, onClose: () => closed++ })
  return { session, remote, leaf, closed: () => closed }
}

describe('leaf session snapshots', () => {
  it('collects a verified snapshot and shares one transfer between callers', async () => {
    const { leaf, remote } = await setup()
    const first = leaf.snapshot('str_a')
    const second = leaf.snapshot('str_a')
    expect(await remote.next('snapshot.get')).toEqual({ t: 'snapshot.get', stream: 'str_a' })
    const records = [remote.record('str_a', 'thread.event', { n: 1 }), remote.record('str_a', 'thread.event', { n: 2 })]
    await remote.snapshotChunk('str_a', records)
    const snapshot = await first
    expect(await second).toBe(snapshot)
    expect(snapshot.target).toEqual({ epoch: 1, seq: 2 })
    expect(snapshot.records.map((record) => record.envelope.body)).toEqual([{ n: 1 }, { n: 2 }])
    leaf.close()
  })

  it('fails the session on a forged snapshot record', async () => {
    const { leaf, remote } = await setup()
    const pending = leaf.snapshot('str_b')
    await remote.next('snapshot.get')
    const record = remote.record('str_b', 'thread.event', {})
    record.signature = new Uint8Array(64)
    await remote.snapshotChunk('str_b', [record])
    await expect(pending).rejects.toMatchObject({ code: 'bad_signature' })
    expect(leaf.state).toBe('closed')
  })
})

describe('computer session', () => {
  it('maps projects and threads to the desktop RPCs', async () => {
    const { session, remote } = await setup()
    const projects = session.listProjects()
    const projectsCall = await remote.answer('projects.list', { projects: [{ id: 'p1', name: 'Site', path: '/w/site', order: 0 }, { bad: true }] })
    expect(projectsCall.params).toEqual({})
    expect(await projects).toEqual([{ id: 'p1', name: 'Site', path: '/w/site' }])

    const threads = session.listThreads({ projectId: 'p1' })
    const listCall = await remote.answer('threads.list', {
      threads: [
        { id: 't1', name: 'Old', projectId: 'p1', updatedAt: '2026-01-01T00:00:00Z' },
        { id: 't2', name: 'New', projectId: 'p1', updatedAt: '2026-02-01T00:00:00Z', pinnedAt: '2026-02-01T00:00:00Z' },
      ],
    })
    expect(listCall.params).toEqual({ projectId: 'p1' })
    expect((await threads).map((thread) => [thread.id, thread.pinned])).toEqual([
      ['t2', true],
      ['t1', false],
    ])

    const search = session.listThreads({ query: ' fix ' })
    const searchCall = await remote.answer('threads.search', { results: [{ threadId: 't1', threadName: 'Old' }, { threadId: 'gone' }] })
    expect(searchCall.params).toEqual({ query: 'fix', limit: 50 })
    await remote.answer('threads.list', { threads: [{ id: 't1', name: 'Old', updatedAt: '2026-01-01T00:00:00Z' }] })
    expect((await search).map((thread) => thread.id)).toEqual(['t1'])

    const created = session.createThread({ projectId: 'p1', title: '' })
    const createCall = await remote.answer('threads.create', { thread: { id: 't3', name: 'New thread', projectId: 'p1', updatedAt: '2026-03-01T00:00:00Z' }, threads: [] })
    expect(createCall.params).toEqual({ name: 'New thread', projectId: 'p1' })
    expect(createCall.idem).toBeTruthy()
    expect(await created).toMatchObject({ id: 't3', title: 'New thread', projectId: 'p1' })
    session.close()
  })

  it('opens a thread from its snapshot and follows live events', async () => {
    const { session, remote } = await setup()
    const seen: ChatItem[][] = []
    const opening = session.openThread('t1', (items) => seen.push(items))
    const open = await remote.answer('bridge.thread.open', { descriptor: { id: 'str_t1' }, head: { epoch: 1, seq: 3 } })
    expect(open.params).toEqual({ threadId: 't1' })
    await remote.next('snapshot.get')
    const snapshot = { messages: [message('m1', 'user', 'Hi'), message('m0', 'system', 'hidden', 500, { hidden: true })], activeTurn: { active: false, running: false } }
    await remote.snapshotChunk(
      'str_t1',
      snapshotBodies('t1', snapshot).map((entry) => remote.record('str_t1', entry.type, entry.body)),
    )
    const unsubscribe = await opening
    expect(await remote.next('subscribe')).toEqual({ t: 'subscribe', stream: 'str_t1', after: { epoch: 1, seq: 3 } })
    expect(seen.at(-1)?.map((item) => item.text)).toEqual(['Hi'])

    await remote.events('str_t1', [
      remote.record('str_t1', 'thread.event', { threadId: 't1', type: 'thread.message', data: { threadId: 't1', message: message('m2', 'assistant', 'Hello', 2_000) } }),
    ])
    await until(() => seen.at(-1)?.length === 2)
    expect(seen.at(-1)?.[1]).toMatchObject({ id: 'm2', role: 'assistant', text: 'Hello', status: 'done' })

    unsubscribe()
    expect(await remote.next('unsubscribe')).toEqual({ t: 'unsubscribe', stream: 'str_t1' })
    session.close()
  })

  it('sends, stops its own run and refuses runs from elsewhere', async () => {
    const { session, remote, closed } = await setup()
    await expect(session.abort('t1')).rejects.toThrow(/another device/)

    const sending = session.send('t1', 'Do it')
    const request = await remote.next('rpc.request')
    expect(request).toMatchObject({ method: 'orchestrator.send', params: { threadId: 't1', content: 'Do it' } })
    expect(request.idem).toBeTruthy()
    expect(request.deadlineMs).toBe(6 * 60 * 60 * 1000)
    await sending
    await expect(session.send('t1', 'again')).rejects.toThrow(/already running/)

    const stopping = session.abort('t1')
    const abort = await remote.next('rpc.request')
    expect(abort).toMatchObject({ method: 'orchestrator.abort', params: { threadId: 't1', run: request.id } })
    await remote.send({ t: 'rpc.result', id: abort.id, result: { ok: true } })
    await stopping
    await remote.send({ t: 'rpc.result', id: request.id, result: { ok: true } })

    const active = session.isTurnActive('t1')
    const check = await remote.answer('orchestrator.isTurnActive', { active: true, running: true })
    expect(check.params).toEqual({ threadId: 't1' })
    expect(await active).toBe(true)

    session.close()
    await until(() => closed() === 1)
    expect(session.state()).toBe('closed')
  })

  it('keeps the close error message as one short line', async () => {
    const { session, leaf } = await setup()
    expect(session.endMessage()).toBeUndefined()
    leaf.close(new NetError('route_unreachable', `The relay closed\n the connection ${'x'.repeat(300)}`))
    expect(session.endReason()).toBe('ended')
    const message = session.endMessage()!
    expect(message.startsWith('The relay closed the connection x')).toBe(true)
    expect(message).toHaveLength(160)
    expect(message.endsWith('…')).toBe(true)
  })

  it('throws a send that fails at once', async () => {
    const { session, remote } = await setup()
    const sending = session.send('t1', 'Hi')
    const request = await remote.next('rpc.request')
    await remote.send({ t: 'rpc.result', id: request.id, error: { code: 'forbidden', message: 'forbidden', retryable: false } })
    await expect(sending).rejects.toMatchObject({ code: 'forbidden' })
    session.close()
  })
})
