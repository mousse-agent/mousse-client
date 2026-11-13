// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { RealComputerSession } from '../../src/connection/computerSession'
import type { ChatItem, ThreadDisplayState } from '../../src/connection/types'
import { newId } from '../../src/net/canonical'
import { NetError } from '../../src/net/errors'
import { generateNodeKeys } from '../../src/net/keys'
import { LeafSession } from '../../src/net/session'
import { streamPair } from '../../src/net/stream'
import { delegate, roster, testComputer, testUser } from '../net/fixtures'
import { appletReply, channelOf, fakeComputer, message, snapshotBodies, until } from './helpers'

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
    expect(createCall.params).toEqual({ name: 'New Thread', projectId: 'p1' })
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

  it('reads the thread again when the computer skips a live record of a large applet reply', async () => {
    const { session, remote } = await setup()
    const seen: ChatItem[][] = []
    const opening = session.openThread('t1', (items) => seen.push(items))
    await remote.answer('bridge.thread.open', { descriptor: { id: 'str_t1' }, head: { epoch: 1, seq: 3 } })
    await remote.next('snapshot.get')
    await remote.snapshotChunk(
      'str_t1',
      snapshotBodies('t1', { messages: [message('m1', 'user', 'Make a budget tool')] }).map((entry) => remote.record('str_t1', entry.type, entry.body)),
    )
    await opening
    await remote.next('subscribe')
    await remote.send({ t: 'caughtUp', stream: 'str_t1' })

    // The finished reply is over 48 KiB, so the computer republishes the whole thread as a fresh
    // snapshot: begin, 32 KiB chunks and end. An older computer dropped some of those records.
    const reply = appletReply('m2', 2_000)
    const refreshed = { messages: [message('m1', 'user', 'Make a budget tool'), reply] }
    const records = snapshotBodies('t1', refreshed).map((entry) => remote.record('str_t1', entry.type, entry.body))
    expect(records.length).toBeGreaterThan(4)
    for (const [index, record] of records.entries()) if (index !== 2) await remote.events('str_t1', [record])

    // The phone notices the gap and reads the thread again instead of staying behind for good.
    expect(await remote.next('unsubscribe')).toEqual({ t: 'unsubscribe', stream: 'str_t1' })
    await remote.next('snapshot.get')
    await remote.snapshotChunk('str_t1', snapshotBodies('t1', refreshed).map((entry) => remote.record('str_t1', entry.type, entry.body)))
    expect(await remote.next('subscribe')).toEqual({ t: 'subscribe', stream: 'str_t1', after: { epoch: 1, seq: remote.seq } })
    await until(() => seen.at(-1)?.length === 2)
    expect(seen.at(-1)?.[1]).toMatchObject({ id: 'm2', role: 'assistant', status: 'done', text: 'Here is a budget tool.\n\nMove the slider.' })
    expect(seen.at(-1)?.[1].parts?.[1]).toMatchObject({ type: 'applet', applet: { title: 'Budget', source: { title: 'Budget' } } })
    expect(session.state()).toBe('open')
    session.close()
  })

  it('holds live records that overtake the replay until the replay fills the gap', async () => {
    const { session, remote } = await setup()
    const seen: ChatItem[][] = []
    const opening = session.openThread('t1', (items) => seen.push(items))
    await remote.answer('bridge.thread.open', { descriptor: { id: 'str_t1' }, head: { epoch: 1, seq: 3 } })
    await remote.next('snapshot.get')
    await remote.snapshotChunk(
      'str_t1',
      snapshotBodies('t1', { messages: [message('m1', 'user', 'Hi')] }).map((entry) => remote.record('str_t1', entry.type, entry.body)),
    )
    await opening
    await remote.next('subscribe')
    const event = (id: string, at: number) =>
      remote.record('str_t1', 'thread.event', { threadId: 't1', type: 'thread.message', data: { threadId: 't1', message: message(id, 'assistant', id, at) } })
    const replayed = event('m2', 2_000)
    const live = event('m3', 3_000)
    // Live records travel on the control lane and can arrive before replayed ones on the bulk lane.
    await remote.events('str_t1', [live])
    await remote.events('str_t1', [replayed], true)
    await remote.send({ t: 'caughtUp', stream: 'str_t1' })
    await until(() => seen.at(-1)?.length === 3)
    expect(seen.at(-1)?.map((item) => item.id)).toEqual(['m1', 'm2', 'm3'])
    expect(remote.has('snapshot.get')).toBe(false)
    session.close()
  })

  it('streams live deltas and answers pending questions', async () => {
    const { session, remote, leaf } = await setup()
    expect(leaf.caps).toBeDefined()
    const seen: Array<{ items: ChatItem[]; state?: ThreadDisplayState }> = []
    const opening = session.openThread('t1', (items, state) => seen.push({ items, state }))
    await remote.answer('bridge.thread.open', { descriptor: { id: 'str_t1' }, head: { epoch: 1, seq: 3 } })
    await remote.next('snapshot.get')
    const pending = [{ requestId: 'q1', threadId: 't1', questions: [{ id: 'pick', prompt: 'Which?', options: [{ id: 'a', label: 'A' }] }] }]
    await remote.snapshotChunk(
      'str_t1',
      snapshotBodies('t1', { messages: [message('m1', 'user', 'Hi')], pendingQuestions: pending }).map((entry) => remote.record('str_t1', entry.type, entry.body)),
    )
    await opening
    await remote.next('subscribe')
    expect(seen.at(-1)?.state?.questions.map((entry) => entry.requestId)).toEqual(['q1'])

    // Presence is ignored; a delta for the subscribed stream shows the reply as it is written.
    await remote.presence('str_t1')
    await remote.delta('str_t1', { threadId: 't1', type: 'thread.message', data: { threadId: 't1', message: message('m2', 'assistant', 'Wor', 2_000, { streaming: true }) } })
    await until(() => seen.at(-1)?.items.length === 2)
    expect(seen.at(-1)?.items[1]).toMatchObject({ id: 'm2', text: 'Wor', status: 'streaming' })
    expect(session.state()).toBe('open')

    const answering = session.answerQuestions('t1', 'q1', { pick: 'a' })
    const call = await remote.answer('orchestrator.answerQuestions', { ok: true })
    expect(call.params).toEqual({ threadId: 't1', requestId: 'q1', answers: { pick: 'a' } })
    expect(call.idem).toBeTruthy()
    await remote.answer('orchestrator.pendingQuestions', { pending: [] })
    expect(await answering).toBe(true)
    expect(seen.at(-1)?.state?.questions).toEqual([])

    const dismissing = session.dismissQuestions('t1', 'q2')
    const dismiss = await remote.answer('orchestrator.dismissQuestions', { ok: false })
    expect(dismiss.params).toEqual({ threadId: 't1', requestId: 'q2' })
    await remote.answer('orchestrator.pendingQuestions', { pending: [] })
    expect(await dismissing).toBe(false)
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

describe('composer controls', () => {
  it('reads the computer options and the thread model, and stores a new model on the thread', async () => {
    const { session, remote } = await setup()
    const options = session.composerOptions('t1')
    const optionsCall = await remote.answer('composer.options', {
      providers: [
        { id: 'anthropic', instanceId: 'pi:anthropic', label: 'Anthropic', models: [{ id: 'claude-opus-4-8', label: 'Claude Opus 4.8', efforts: ['low', 'high'], speed: 'weird' }, { bad: 1 }] },
        { nope: true },
      ],
      defaultModel: { instanceId: 'pi:anthropic', llmProvider: 'anthropic', model: 'claude-opus-4-8:high' },
      modes: ['plan', 'agent', 'build'],
      skills: [{ id: 's1', name: 'Review', description: 'Look', skillPath: '/secret' }],
      commands: [{ name: 'new', description: 'New', aliases: ['reset'], argsHint: '[title]' }],
    })
    expect(optionsCall.params).toEqual({ threadId: 't1' })
    expect(await options).toEqual({
      providers: [{ id: 'anthropic', instanceId: 'pi:anthropic', label: 'Anthropic', models: [{ id: 'claude-opus-4-8', label: 'Claude Opus 4.8', efforts: ['low', 'high'] }] }],
      defaultModel: { instanceId: 'pi:anthropic', llmProvider: 'anthropic', model: 'claude-opus-4-8:high' },
      modes: ['plan', 'agent', 'build'],
      skills: [{ id: 's1', name: 'Review', description: 'Look' }],
      commands: [{ name: 'new', description: 'New', aliases: ['reset'], argsHint: '[title]' }],
    })

    const details = session.getThread('t1')
    await remote.answer('threads.get', { thread: { id: 't1', projectId: 'p1', modelOverride: { instanceId: 'pi:openai', llmProvider: 'openai', model: 'gpt-5.5:xhigh' } } })
    expect(await details).toEqual({ id: 't1', projectId: 'p1', model: { instanceId: 'pi:openai', llmProvider: 'openai', model: 'gpt-5.5:xhigh' } })

    const setting = session.setThreadModel('t1', { instanceId: 'pi:openai', llmProvider: 'openai', model: 'gpt-5.5:low' })
    const setCall = await remote.answer('threads.setModel', { ok: true })
    expect(setCall.params).toEqual({ threadId: 't1', model: { instanceId: 'pi:openai', llmProvider: 'openai', model: 'gpt-5.5:low' } })
    expect(setCall.idem).toBeTruthy()
    await setting

    const refused = session.setThreadModel('t1', { llmProvider: 'gone', model: 'x' })
    await remote.answer('threads.setModel', { ok: false, error: 'Unknown provider instance' })
    await expect(refused).rejects.toThrow('Unknown provider instance')
    session.close()
  })

  it('stages images in chunks, then sends them with the mode', async () => {
    const { session, remote } = await setup()
    const data = 'A'.repeat(48 * 1024 + 8)
    const sending = session.send('t1', 'Look', { mode: 'plan', images: [{ name: 'shot.png', mimeType: 'image/png', data }] })
    const first = await remote.answer('attachments.stage', { ok: true, received: 1, total: 2 })
    const upload = (first.params as { upload: string }).upload
    expect(first.params).toMatchObject({ index: 0, total: 2, name: 'shot.png', mimeType: 'image/png', data: 'A'.repeat(48 * 1024) })
    const second = await remote.answer('attachments.stage', { ok: true, received: 2, total: 2 })
    expect(second.params).toMatchObject({ upload, index: 1, data: 'AAAAAAAA' })
    const request = await remote.next('rpc.request')
    expect(request).toMatchObject({ method: 'orchestrator.send', params: { threadId: 't1', content: 'Look', mode: 'plan', attachments: [upload] } })
    await sending
    session.close()
  })

  it('surfaces a turn the computer refused', async () => {
    const { session, remote } = await setup()
    const sending = session.send('t1', 'Hi')
    const request = await remote.next('rpc.request')
    await remote.send({ t: 'rpc.result', id: request.id, result: { text: '', silent: false, error: 'Thread already has a running turn: t1' } })
    await expect(sending).rejects.toThrow(/already has a running turn/)
    session.close()
  })

  it('queues, lists, reorders, removes and steers queued messages', async () => {
    const { session, remote } = await setup()
    const queueing = session.enqueue('t1', 'Next', { mode: { type: 'skill', skillId: 's1' } })
    const enqueue = await remote.answer('queue.enqueue', { ok: true, item: { id: 'q1' }, items: [] })
    expect(enqueue.params).toEqual({ threadId: 't1', content: 'Next', mode: { type: 'skill', skillId: 's1' } })
    await queueing

    const listing = session.listQueue('t1')
    await remote.answer('queue.list', { items: [{ id: 'q1', content: 'Next', images: [{ name: 'a.png' }], enqueuedAt: '2026-01-01T00:00:00Z', intent: 'normal', state: 'pending' }, { bad: true }] })
    expect(await listing).toEqual([{ id: 'q1', content: 'Next', imageCount: 1, enqueuedAt: Date.parse('2026-01-01T00:00:00Z'), intent: 'normal', state: 'pending' }])

    const reordering = session.reorderQueue('t1', ['q2', 'q1'])
    expect((await remote.answer('queue.reorder', { ok: true, items: [] })).params).toEqual({ threadId: 't1', orderedIds: ['q2', 'q1'] })
    await reordering

    const removing = session.removeQueued('t1', 'q1')
    await remote.answer('queue.remove', { ok: false, error: 'This message already started or is no longer queued.' })
    await expect(removing).rejects.toThrow(/already started/)

    // Steering a turn this phone did not start: queue the text, then move it into the turn.
    const steering = session.steer('t1', 'Use the other API')
    const steerQueue = await remote.answer('queue.enqueue', { ok: true, item: { id: 'q9' } })
    expect(steerQueue.params).toEqual({ threadId: 't1', content: 'Use the other API' })
    expect((await remote.answer('queue.promoteToSteer', { ok: true, items: [] })).params).toEqual({ threadId: 't1', itemId: 'q9' })
    await steering
    session.close()
  })

  it('edits a queued message in place and keeps newer text', async () => {
    const { session, remote } = await setup()
    const pending = (id: string, content: string) => ({ id, content, enqueuedAt: '2026-01-01T00:00:00Z', intent: 'normal', state: 'pending' })
    const editing = session.editQueued('t1', 'q1', ' Better ', 'Old')
    await remote.answer('queue.list', { items: [pending('q1', 'Old')], revision: 'r7' })
    const edit = await remote.answer('queue.edit', { item: pending('q1', 'Better'), items: [] })
    expect(edit.params).toEqual({ threadId: 't1', itemId: 'q1', content: 'Better', expectedRevision: 'r7' })
    expect((await editing).item.content).toBe('Better')

    // Changed elsewhere since the edit started: nothing is saved.
    const stale = session.editQueued('t1', 'q1', 'Mine', 'Old')
    await remote.answer('queue.list', { items: [pending('q1', 'Theirs')] })
    expect(await stale).toEqual({ item: expect.objectContaining({ content: 'Theirs' }), changed: true })
    session.close()
  })

  it('edits by replacing the message where the computer refuses queue.edit', async () => {
    const { session, remote } = await setup()
    const pending = (id: string, content: string) => ({ id, content, enqueuedAt: '2026-01-01T00:00:00Z', intent: 'normal', state: 'pending' })
    const editing = session.editQueued('t1', 'q1', 'New', 'Old')
    await remote.answer('queue.list', { items: [pending('q1', 'Old'), pending('q2', 'Later')] })
    const refused = await remote.next('rpc.request')
    expect(refused.method).toBe('queue.edit')
    await remote.send({ t: 'rpc.result', id: refused.id, error: { code: 'forbidden', message: 'forbidden', retryable: false } })
    expect((await remote.answer('queue.enqueue', { ok: true, item: { id: 'q3' } })).params).toEqual({ threadId: 't1', content: 'New' })
    expect((await remote.answer('queue.remove', { outcome: 'removed' })).params).toEqual({ threadId: 't1', itemId: 'q1' })
    await remote.answer('queue.list', { items: [pending('q2', 'Later'), pending('q3', 'New')] })
    expect((await remote.answer('queue.reorder', { items: [] })).params).toEqual({ threadId: 't1', orderedIds: ['q3', 'q2'] })
    expect(await editing).toEqual({ item: expect.objectContaining({ id: 'q3', content: 'New' }) })

    // The refusal is remembered: the next edit replaces at once, and a failed removal takes the copy back.
    const again = session.editQueued('t1', 'q2', 'Sooner')
    await remote.answer('queue.list', { items: [pending('q3', 'New'), pending('q2', 'Later')] })
    await remote.answer('queue.enqueue', { ok: true, item: { id: 'q4' } })
    await remote.answer('queue.remove', { ok: false, error: 'Queued message already started.' })
    expect((await remote.answer('queue.remove', { outcome: 'removed' })).params).toEqual({ threadId: 't1', itemId: 'q4' })
    await expect(again).rejects.toThrow(/already started/)
    session.close()
  })

  it('steers its own run directly', async () => {
    const { session, remote } = await setup()
    const sending = session.send('t1', 'Do it')
    const run = await remote.next('rpc.request')
    await sending
    const steering = session.steer('t1', 'Faster')
    const steer = await remote.answer('orchestrator.steer', { ok: true })
    expect(steer.params).toEqual({ threadId: 't1', run: run.id, text: 'Faster' })
    await steering
    session.close()
  })
})
