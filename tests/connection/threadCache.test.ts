// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { RealComputerSession } from '../../src/connection/computerSession'
import { memoryThreadCacheBackend, ThreadCache, THREAD_CACHE_FORMAT, type CachedThread, type ThreadCacheScope } from '../../src/connection/threadCache'
import type { ChatItem, ThreadDisplayState } from '../../src/connection/types'
import { newId } from '../../src/net/canonical'
import { utf8 } from '../../src/net/bytes'
import { NetError } from '../../src/net/errors'
import { generateNodeKeys } from '../../src/net/keys'
import { LeafSession, type SessionLink, type StreamRecord, type SubscriptionHandlers } from '../../src/net/session'
import { streamPair } from '../../src/net/stream'
import { delegate, roster, testComputer, testUser } from '../net/fixtures'
import { channelOf, fakeComputer, message, snapshotBodies, until } from './helpers'

function entry(texts: string[], head = { epoch: 1, seq: 3 }, extra: Partial<CachedThread> = {}): CachedThread {
  return {
    stream: 'str_t1',
    head,
    state: { messages: texts.map((text, index) => message(`m${index + 1}`, index % 2 ? 'assistant' : 'user', text, 1_000 + index)), active: false },
    savedAt: 1,
    ...extra,
  }
}

function clock() {
  let now = 1_000
  return () => ++now
}

describe('thread cache', () => {
  it('keeps the most recently used threads and evicts whole threads beyond the count', async () => {
    const backend = memoryThreadCacheBackend()
    const cache = new ThreadCache(backend, { maxThreads: 3, now: clock() })
    const scope = cache.scope('acct', 'node')
    for (const id of ['t1', 't2', 't3']) scope.write(id, entry([id]))
    await cache.settle()
    // Opening t1 makes it recent, so t2 is the least recently used when t4 arrives.
    expect(scope.peek('t1')).toBeDefined()
    scope.write('t4', entry(['t4']))
    await cache.settle()
    const threads = [...backend.index.values()].map((row) => row.threadId).sort()
    expect(threads).toEqual(['t1', 't3', 't4'])
    expect(backend.data.size).toBe(3)
    expect(scope.peek('t2')).toBeUndefined()
  })

  it('stays under the size cap and keeps oversized threads in memory only', async () => {
    const backend = memoryThreadCacheBackend()
    const big = 'x'.repeat(4_000)
    const cache = new ThreadCache(backend, { maxBytes: 10_000, maxThreadBytes: 6_000, now: clock() })
    const scope = cache.scope('acct', 'node')
    scope.write('t1', entry([big]))
    scope.write('t2', entry([big]))
    scope.write('t3', entry([big]))
    await cache.settle()
    expect([...backend.index.values()].map((row) => row.threadId).sort()).toEqual(['t2', 't3'])
    expect((await cache.usage()).bytes).toBeLessThanOrEqual(10_000)

    // Too large for the phone's storage: it stays in memory, and the older saved copy goes.
    scope.write('t3', entry([big, big]))
    await cache.settle()
    expect(backend.index.has(JSON.stringify(['acct', 'node', 't3']))).toBe(false)
    expect(scope.peek('t3')?.state.messages).toHaveLength(2)
  })

  it('reads saved threads after a restart and drops other formats', async () => {
    const backend = memoryThreadCacheBackend()
    const first = new ThreadCache(backend)
    first.scope('acct', 'node').write('t1', entry(['Hi', 'Hello']))
    await first.settle()

    const second = new ThreadCache(backend)
    const scope = second.scope('acct', 'node')
    expect(scope.peek('t1')).toBeUndefined()
    expect((await scope.read('t1'))?.state.messages.map((entry) => entry.content)).toEqual(['Hi', 'Hello'])
    expect(scope.peek('t1')).toBeDefined()

    const key = JSON.stringify(['acct', 'node', 't2'])
    backend.index.set(key, { key, format: THREAD_CACHE_FORMAT + 1, accountId: 'acct', nodeId: 'node', threadId: 't2', bytes: 2, usedAt: 1, savedAt: 1 })
    backend.data.set(key, '{}')
    const third = new ThreadCache(backend)
    expect(await third.scope('acct', 'node').read('t2')).toBeUndefined()
    await third.settle()
    expect(backend.index.has(key)).toBe(false)
  })

  it('clears an account on sign-out and one computer on removal, and ignores later writes from old sessions', async () => {
    const backend = memoryThreadCacheBackend()
    const cache = new ThreadCache(backend)
    const studio = cache.scope('acct', 'studio')
    const laptop = cache.scope('acct', 'laptop')
    const other = cache.scope('other', 'studio')
    studio.write('t1', entry(['a']))
    laptop.write('t1', entry(['b']))
    other.write('t1', entry(['c']))
    await cache.settle()
    expect(backend.data.size).toBe(3)

    await cache.clearComputer('acct', 'studio')
    expect(studio.peek('t1')).toBeUndefined()
    expect(laptop.peek('t1')).toBeDefined()
    expect([...backend.index.values()].map((row) => `${row.accountId}/${row.nodeId}`).sort()).toEqual(['acct/laptop', 'other/studio'])
    // A session that was open before the removal saves as it closes: nothing lands.
    studio.write('t1', entry(['late']))
    await cache.settle()
    expect(backend.data.size).toBe(2)
    expect(cache.scope('acct', 'studio').peek('t1')).toBeUndefined()

    await cache.clearAccount('acct')
    laptop.write('t2', entry(['late']))
    await cache.settle()
    expect([...backend.index.values()].map((row) => row.accountId)).toEqual(['other'])
    expect(await cache.scope('acct', 'laptop').read('t1')).toBeUndefined()
    expect(other.peek('t1')).toBeDefined()
  })
})

async function connect(cache: ThreadCacheScope) {
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
  const session = new RealComputerSession({ nodeId: computer.node, leaf, threadCache: cache })
  return { session, remote, leaf }
}

type Seen = Array<{ items: ChatItem[]; state?: ThreadDisplayState }>
const texts = (seen: Seen) => seen.at(-1)?.items.map((item) => item.text)
const event = (threadId: string, msg: unknown) => ({ threadId, type: 'thread.message', data: { threadId, message: msg } })
/** No update ever showed an item twice or an empty thread. */
function steady(seen: Seen) {
  for (const { items } of seen) {
    expect(items.length).toBeGreaterThan(0)
    expect(new Set(items.map((item) => item.id)).size).toBe(items.length)
  }
}

describe('opening threads from the cache', () => {
  it('shows the saved thread at once, then follows the stream after the saved record without duplicates', async () => {
    const cache = new ThreadCache(memoryThreadCacheBackend())
    const scope = cache.scope('acct', 'studio')

    // First visit: the thread comes from the computer's snapshot and is saved when it closes.
    const first = await connect(scope)
    const firstSeen: Seen = []
    const opening = first.session.openThread('t1', (items) => firstSeen.push({ items }))
    await first.remote.answer('bridge.thread.open', { descriptor: { id: 'str_t1' }, head: { epoch: 1, seq: 3 } })
    await first.remote.next('snapshot.get')
    await first.remote.snapshotChunk('str_t1', snapshotBodies('t1', { messages: [message('m1', 'user', 'Hi')] }).map((body) => first.remote.record('str_t1', body.type, body.body)))
    const close = await opening
    await first.remote.next('subscribe')
    await first.remote.events('str_t1', [first.remote.record('str_t1', 'thread.event', event('t1', message('m2', 'assistant', 'Hello', 2_000)))])
    await until(() => firstSeen.at(-1)?.items.length === 2)
    close()
    expect(scope.peek('t1')).toMatchObject({ stream: 'str_t1', head: { epoch: 1, seq: 4 } })
    first.session.close()

    // Second visit, on a new session: the saved thread draws before the computer answers.
    const second = await connect(scope)
    second.remote.position(1, 4)
    const seen: Seen = []
    const reopening = second.session.openThread('t1', (items, state) => seen.push({ items, state }))
    expect(texts(seen)).toEqual(['Hi', 'Hello'])
    const unsubscribe = await reopening
    await second.remote.answer('bridge.thread.open', { descriptor: { id: 'str_t1' }, head: { epoch: 1, seq: 5 } })
    expect(await second.remote.next('subscribe')).toEqual({ t: 'subscribe', stream: 'str_t1', after: { epoch: 1, seq: 4 } })
    // The snapshot carried pending questions; a resumed thread asks for them.
    const ask = await second.remote.next('rpc.request')
    expect(ask).toMatchObject({ method: 'orchestrator.pendingQuestions', params: { threadId: 't1' } })
    await second.remote.send({ t: 'rpc.result', id: ask.id, result: { pending: [{ requestId: 'q1', threadId: 't1', questions: [{ id: 'a', prompt: 'Go?', options: [{ id: 'y', label: 'Yes' }] }] }] } })
    await until(() => seen.at(-1)?.state?.questions.length === 1)

    // A replayed record at or before the saved position is never applied twice.
    second.remote.position(1, 3)
    const replayed = second.remote.record('str_t1', 'thread.event', event('t1', message('dup', 'assistant', 'Again', 2_500)))
    const next = second.remote.record('str_t1', 'thread.event', event('t1', message('m3', 'user', 'Thanks', 3_000)))
    await second.remote.events('str_t1', [replayed, next], true)
    await until(() => seen.at(-1)?.items.length === 3)
    expect(texts(seen)).toEqual(['Hi', 'Hello', 'Thanks'])
    expect(second.remote.has('snapshot.get')).toBe(false)
    steady(seen)

    unsubscribe()
    expect(scope.peek('t1')?.head).toEqual({ epoch: 1, seq: 5 })
    second.session.close()
  })

  it('replaces the saved thread with a fresh snapshot when the computer started a new stream generation', async () => {
    const cache = new ThreadCache(memoryThreadCacheBackend())
    const scope = cache.scope('acct', 'studio')
    scope.write('t1', entry(['Hi', 'Old reply'], { epoch: 1, seq: 9 }))
    const { session, remote } = await connect(scope)
    const seen: Seen = []
    const opening = session.openThread('t1', (items, state) => seen.push({ items, state }))
    expect(texts(seen)).toEqual(['Hi', 'Old reply'])
    await opening
    // The desktop restarted: its thread stream is in epoch 2 now.
    await remote.answer('bridge.thread.open', { descriptor: { id: 'str_t1' }, head: { epoch: 2, seq: 3 } })
    await remote.next('snapshot.get')
    remote.position(2, 0)
    const fresh = { messages: [message('m1', 'user', 'Hi', 1_000), message('m2', 'assistant', 'New reply', 1_001)] }
    await remote.snapshotChunk('str_t1', snapshotBodies('t1', fresh).map((body) => remote.record('str_t1', body.type, body.body)))
    await until(() => texts(seen)?.[1] === 'New reply')
    expect(await remote.next('subscribe')).toEqual({ t: 'subscribe', stream: 'str_t1', after: { epoch: 2, seq: 3 } })
    expect(texts(seen)).toEqual(['Hi', 'New reply'])
    // The saved copy stayed on screen until the snapshot replaced it in one step.
    expect(seen.map((entry) => entry.items.length)).toEqual(seen.map(() => 2))
    steady(seen)
    session.close()
    expect(scope.peek('t1')).toMatchObject({ head: { epoch: 2, seq: 3 }, state: { messages: [{ content: 'Hi' }, { content: 'New reply' }] } })
  })

  it('reads a fresh snapshot when the saved position is no longer kept', async () => {
    const cache = new ThreadCache(memoryThreadCacheBackend())
    const scope = cache.scope('acct', 'studio')
    scope.write('t1', entry(['Hi', 'Old reply'], { epoch: 1, seq: 2 }))
    const { session, remote } = await connect(scope)
    const seen: Seen = []
    await session.openThread('t1', (items, state) => seen.push({ items, state }))
    await remote.answer('bridge.thread.open', { descriptor: { id: 'str_t1' }, head: { epoch: 1, seq: 40 } })
    expect(await remote.next('subscribe')).toMatchObject({ after: { epoch: 1, seq: 2 } })
    remote.position(1, 40)
    await remote.snapshotRequired('str_t1', 'cursorTooOld')
    await remote.next('snapshot.get')
    remote.position(1, 37)
    const fresh = { messages: [message('m1', 'user', 'Hi'), message('m2', 'assistant', 'Old reply'), message('m3', 'user', 'More')] }
    await remote.snapshotChunk('str_t1', snapshotBodies('t1', fresh).map((body) => remote.record('str_t1', body.type, body.body)))
    await until(() => seen.at(-1)?.items.length === 3)
    expect(texts(seen)).toEqual(['Hi', 'Old reply', 'More'])
    expect(await remote.next('subscribe')).toMatchObject({ after: { epoch: 1, seq: 40 } })
    steady(seen)
    session.close()
  })

  it('never saves live reply text or pending questions', async () => {
    const cache = new ThreadCache(memoryThreadCacheBackend())
    const scope = cache.scope('acct', 'studio')
    const { session, remote } = await connect(scope)
    const seen: Seen = []
    const opening = session.openThread('t1', (items, state) => seen.push({ items, state }))
    await remote.answer('bridge.thread.open', { descriptor: { id: 'str_t1' }, head: { epoch: 1, seq: 3 } })
    await remote.next('snapshot.get')
    const pending = [{ requestId: 'q1', threadId: 't1', questions: [{ id: 'a', prompt: 'Go?', options: [{ id: 'y', label: 'Yes' }] }] }]
    const snapshot = { messages: [message('m1', 'user', 'Hi'), message('m2', 'assistant', 'Wor', 2_000, { streaming: true })], pendingQuestions: pending }
    await remote.snapshotChunk('str_t1', snapshotBodies('t1', snapshot).map((body) => remote.record('str_t1', body.type, body.body)))
    const close = await opening
    await remote.next('subscribe')
    await remote.delta('str_t1', event('t1', message('m2', 'assistant', 'World, still writing', 2_000, { streaming: true })))
    await remote.delta('str_t1', event('t1', message('m3', 'assistant', 'A second live reply', 3_000, { streaming: true })))
    await until(() => seen.at(-1)?.items.length === 3)
    expect(texts(seen)).toEqual(['Hi', 'World, still writing', 'A second live reply'])
    expect(seen.at(-1)?.state?.questions).toHaveLength(1)
    // A settled record arrives after the deltas, then the view closes.
    await remote.events('str_t1', [remote.record('str_t1', 'thread.event', event('t1', message('m4', 'user', 'Next', 4_000)))])
    await until(() => seen.at(-1)?.items.length === 4)
    close()

    const saved = scope.peek('t1')!
    expect(saved.state.messages.map((entry) => [entry.id, entry.content])).toEqual([
      ['m1', 'Hi'],
      ['m2', 'Wor'],
      ['m4', 'Next'],
    ])
    expect(saved.state).not.toHaveProperty('questions')
    expect(JSON.stringify(saved)).not.toContain('still writing')
    expect(JSON.stringify(saved)).not.toContain('Go?')
    session.close()
  })

  it('keeps the saved thread on screen when the computer cannot be asked, and forgets a deleted thread', async () => {
    const cache = new ThreadCache(memoryThreadCacheBackend())
    const scope = cache.scope('acct', 'studio')
    scope.write('t1', entry(['Hi', 'Hello']))
    const { session, remote } = await connect(scope)
    const seen: Seen = []
    await session.openThread('t1', (items, state) => seen.push({ items, state }))
    const request = await remote.next('rpc.request')
    await remote.send({ t: 'rpc.result', id: request.id, error: { code: 'not_found', message: 'No such thread.', retryable: false } })
    await until(() => seen.at(-1)?.items.length === 3)
    expect(texts(seen)?.slice(0, 2)).toEqual(['Hi', 'Hello'])
    expect(seen.at(-1)?.items[2]).toMatchObject({ role: 'system', status: 'error' })
    expect(scope.peek('t1')).toBeUndefined()
    session.close()
  })
})

/** A computer link with no wire: lists from the old polling methods, and one snapshot per thread. */
function scriptedLink(path: 'relay' | 'direct', threads: Array<{ id: string; updatedAt: number }>) {
  const snapshots: string[] = []
  const record = (stream: string, seq: number, type: string, body: unknown): StreamRecord => {
    const envelope = { v: 1, minor: 0, id: `e${seq}`, stream, type, crit: false, author: { user: 'u', node: 'n', keyEpoch: 1 }, ts: 0, body }
    return { seq, epoch: 1, recvTs: 0, bytes: utf8(JSON.stringify(envelope)), envelope }
  }
  const link = {
    path,
    state: 'open',
    closeReason: undefined,
    onStateChange: () => () => undefined,
    onClose: () => () => undefined,
    close: () => undefined,
    async rpc(method: string, params: { threadId?: string }) {
      if (method === 'bridge.lists.open') throw new NetError('forbidden', 'Old desktop.')
      if (method === 'projects.list') return { projects: [] }
      if (method === 'threads.list') return { threads: threads.map((thread) => ({ id: thread.id, name: `Thread ${thread.id}`, updatedAt: new Date(thread.updatedAt).toISOString() })) }
      if (method === 'bridge.thread.open') return { descriptor: { id: `str_${params.threadId}` }, head: { epoch: 1, seq: 3 } }
      return {}
    },
    async snapshot(stream: string) {
      snapshots.push(stream)
      const threadId = stream.slice(4)
      const bodies = snapshotBodies(threadId, { messages: [message('m1', 'user', `Hi from ${threadId}`)] })
      return { target: { epoch: 1, seq: 3 }, records: bodies.map((body, index) => record(stream, index + 1, body.type, body.body)) }
    },
    subscribe(_stream: string, _after: unknown, handlers: SubscriptionHandlers) {
      setTimeout(() => handlers.caughtUp?.(), 0)
      return () => undefined
    },
  }
  return { link: link as unknown as SessionLink, snapshots }
}

describe('prefetching recent threads', () => {
  const threads = [1, 5, 3, 4, 2].map((n) => ({ id: `t${n}`, updatedAt: Date.now() - (10 - n) * 60_000 }))

  it('brings the three most recent threads up to date on a direct path', async () => {
    const cache = new ThreadCache(memoryThreadCacheBackend())
    const scope = cache.scope('acct', 'studio')
    const { link, snapshots } = scriptedLink('direct', threads)
    const session = new RealComputerSession({ nodeId: 'studio', leaf: link, threadCache: scope })
    const stop = session.watchLists({ lists: () => undefined })
    await until(() => snapshots.length === 3 && !!scope.peek('t3'), 200)
    expect(snapshots).toEqual(['str_t5', 'str_t4', 'str_t3'])
    expect(scope.peek('t5')?.state.messages[0].content).toBe('Hi from t5')
    expect(scope.peek('t1')).toBeUndefined()
    // Opening a prefetched thread draws it at once.
    const seen: Seen = []
    void session.openThread('t4', (items) => seen.push({ items }))
    expect(texts(seen)).toEqual(['Hi from t4'])
    stop()
    session.close()
  })

  it('leaves threads alone on the relay', async () => {
    const cache = new ThreadCache(memoryThreadCacheBackend())
    const { link, snapshots } = scriptedLink('relay', threads)
    const session = new RealComputerSession({ nodeId: 'studio', leaf: link, threadCache: cache.scope('acct', 'studio') })
    const stop = session.watchLists({ lists: () => undefined })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(snapshots).toEqual([])
    stop()
    session.close()
  })
})
