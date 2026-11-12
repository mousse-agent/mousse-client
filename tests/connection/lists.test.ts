// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { RealComputerSession } from '../../src/connection/computerSession'
import { ComputerStore, memoryListsCache } from '../../src/connection/computerStore'
import { LISTS_THREAD_ID, parseLists } from '../../src/connection/lists'
import { manualNetworkSignals } from '../../src/connection/networkSignals'
import type { ComputerLists, ComputerSession, ListsHandlers, SessionEndReason, SessionState } from '../../src/connection/types'
import { isUnreachable, unreachable } from '../../src/connection/types'
import { NetError } from '../../src/net/errors'
import { newId } from '../../src/net/canonical'
import { generateNodeKeys } from '../../src/net/keys'
import { LeafSession } from '../../src/net/session'
import { streamPair } from '../../src/net/stream'
import { delegate, roster, testComputer, testUser } from '../net/fixtures'
import { channelOf, fakeComputer, snapshotBodies, until } from './helpers'

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
  return { session: new RealComputerSession({ nodeId: computer.node, leaf }), remote, leaf }
}

const at = '2026-10-21T10:00:00.000Z'
function desktopLists(extra: Partial<Record<string, unknown>> = {}) {
  return {
    kind: 'mousse.lists',
    version: 1,
    projects: [{ id: 'p1', name: 'Mousse', path: '/src/mousse', order: 0 }],
    threads: [
      { id: 't1', name: 'Relay backoff', projectId: 'p1', createdAt: at, updatedAt: at, order: 1, startedAt: at, pinnedAt: at },
      { id: 'ct', name: 'Reviewer', createdAt: at, updatedAt: at, order: 0, startedAt: at },
    ],
    status: { t1: { state: 'processing', since: at }, gone: { state: 'nonsense' } },
    chats: [{ id: 'c1', kind: 'direct', name: 'Reviewer', threadId: 'ct', agents: ['Reviewer'], updatedAt: at, preview: 'Hi' }],
    ...extra,
  }
}

function records(remote: ReturnType<typeof fakeComputer>, stream: string, value: unknown) {
  return snapshotBodies(LISTS_THREAD_ID, value).map(({ type, body }) => remote.record(stream, type, body))
}

describe('lists from the desktop', () => {
  it('reads the desktop lists and drops what it does not understand', () => {
    const lists = parseLists(desktopLists(), 5)!
    expect(lists.receivedAt).toBe(5)
    expect(lists.projects).toEqual([{ id: 'p1', name: 'Mousse', path: '/src/mousse', order: 0, pinned: false }])
    expect(lists.threads[0]).toMatchObject({ id: 't1', title: 'Relay backoff', projectId: 'p1', pinned: true, settled: false, started: true, order: 1 })
    expect(lists.status).toEqual({ t1: { state: 'processing', since: Date.parse(at) } })
    expect(lists.chats).toEqual([{ id: 'c1', kind: 'direct', name: 'Reviewer', threadId: 'ct', network: false, agents: ['Reviewer'], updatedAt: Date.parse(at), preview: 'Hi' }])
    expect(parseLists({ ...desktopLists(), version: 2 })).toBeUndefined()
    expect(parseLists({ kind: 'thread' })).toBeUndefined()
  })

  it('follows the live lists stream: snapshot, live replacements, and a full read when asked', async () => {
    const { session, remote, leaf } = await setup()
    const seen: ComputerLists[] = []
    const states: string[] = []
    const stop = session.watchLists({ lists: (lists) => seen.push(lists), state: (state) => states.push(state) })
    const open = await remote.next('rpc.request')
    expect(open).toMatchObject({ method: 'bridge.lists.open', params: {} })
    await remote.send({ t: 'rpc.result', id: open.id, result: { descriptor: { id: 'str_lists' }, head: { epoch: 1, seq: 0 } } })
    expect(await remote.next('snapshot.get')).toEqual({ t: 'snapshot.get', stream: 'str_lists' })
    await remote.snapshotChunk('str_lists', records(remote, 'str_lists', desktopLists()))
    expect(await remote.next('subscribe')).toMatchObject({ stream: 'str_lists', after: { epoch: 1, seq: 3 } })
    await until(() => seen.length === 1)
    expect(states.at(-1)).toBe('live')
    expect(seen[0].status.t1?.state).toBe('processing')

    // The run finishes on the computer: a new snapshot arrives on the stream.
    await remote.events('str_lists', records(remote, 'str_lists', desktopLists({ status: { t1: { state: 'completed' } } })))
    await until(() => seen.length === 2)
    expect(seen[1].status).toEqual({ t1: { state: 'completed' } })

    // A second watcher gets the current lists at once and shares the subscription.
    const late = vi.fn()
    session.watchLists({ lists: late })
    expect(late).toHaveBeenCalledWith(seen[1])

    // After a gap the computer asks for a snapshot: the phone reads everything again.
    await remote.send({ t: 'snapshotRequired', stream: 'str_lists', reason: 'cursorTooOld', head: { epoch: 2, seq: 9 } })
    expect(await remote.next('snapshot.get')).toEqual({ t: 'snapshot.get', stream: 'str_lists' })
    await remote.snapshotChunk('str_lists', records(remote, 'str_lists', desktopLists({ status: {} })))
    await until(() => seen.length === 3)
    expect(seen[2].status).toEqual({})
    stop()
    leaf.close()
  })

  it('polls an older desktop that has no lists stream', async () => {
    const { session, remote, leaf } = await setup()
    const seen: ComputerLists[] = []
    const states: string[] = []
    session.watchLists({ lists: (lists) => seen.push(lists), state: (state) => states.push(state) })
    const open = await remote.next('rpc.request')
    await remote.send({ t: 'rpc.result', id: open.id, error: { code: 'forbidden', message: 'forbidden', retryable: false } })
    await remote.answer('projects.list', { projects: [{ id: 'p1', name: 'Mousse', order: 0 }] })
    await remote.answer('threads.list', { threads: [{ id: 't1', name: 'Old', updatedAt: at, startedAt: at, order: 0 }] })
    await until(() => seen.length === 1)
    expect(states.at(-1)).toBe('polling')
    expect(seen[0]).toMatchObject({ chats: [], status: {}, threads: [{ id: 't1', title: 'Old' }] })
    leaf.close()
  })

  it('sends to and stops an agent chat through the chat, not the thread', async () => {
    const { session, remote, leaf } = await setup()
    let lists: ComputerLists | undefined
    session.watchLists({ lists: (next) => (lists = next) })
    const open = await remote.next('rpc.request')
    await remote.send({ t: 'rpc.result', id: open.id, result: { descriptor: { id: 'str_lists' } } })
    await remote.next('snapshot.get')
    await remote.snapshotChunk('str_lists', records(remote, 'str_lists', desktopLists()))
    await until(() => !!lists)

    const sent = session.send('ct', ' Review this ')
    const request = await remote.next('rpc.request')
    expect(request).toMatchObject({ method: 'chats.send', params: { chatId: 'c1', text: 'Review this' } })
    expect(request.idem).toEqual(expect.any(String))
    await remote.send({ t: 'rpc.result', id: request.id, result: { chatId: 'c1', run: { id: 'r1', state: 'running' } } })
    await sent

    const running = desktopLists({ chats: [{ ...desktopLists().chats[0], run: { id: 'r1', state: 'running', startedAt: at } }] })
    await remote.next('subscribe')
    await remote.events('str_lists', records(remote, 'str_lists', running))
    await until(() => lists?.chats[0].run?.state === 'running')
    expect(await session.isTurnActive('ct')).toBe(true)
    await expect(session.send('ct', 'more')).rejects.toThrow(/Wait for this reply/)

    const stopped = session.abort('ct')
    const cancel = await remote.next('rpc.request')
    expect(cancel).toMatchObject({ method: 'chats.cancel', params: { chatId: 'c1', runId: 'r1' } })
    await remote.send({ t: 'rpc.result', id: cancel.id, result: { chatId: 'c1' } })
    await stopped
    leaf.close()
  })
})

class StubSession implements ComputerSession {
  readonly nodeId = 'node'
  current: SessionState = 'open'
  handlers = new Set<ListsHandlers>()
  private listeners = new Set<(state: SessionState) => void>()
  reason: SessionEndReason = 'ended'
  message?: string
  state() { return this.current }
  onStateChange(listener: (state: SessionState) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  endReason() { return this.current === 'closed' ? this.reason : undefined }
  endMessage() { return this.current === 'closed' ? this.message : undefined }
  listProjects = vi.fn()
  listThreads = vi.fn()
  createThread = vi.fn()
  openThread = vi.fn()
  send = vi.fn()
  abort = vi.fn()
  isTurnActive = vi.fn()
  composerOptions = vi.fn()
  getThread = vi.fn()
  setThreadModel = vi.fn()
  steer = vi.fn()
  enqueue = vi.fn()
  listQueue = vi.fn()
  removeQueued = vi.fn()
  reorderQueue = vi.fn()
  editQueued = vi.fn()
  steerQueued = vi.fn()
  contextUsage = vi.fn()
  watchLists(handlers: ListsHandlers) { this.handlers.add(handlers); return () => { this.handlers.delete(handlers) } }
  push(lists: ComputerLists) { for (const handler of this.handlers) { handler.lists(lists); handler.state?.('live') } }
  close(reason: SessionEndReason = 'ended', message?: string) { this.reason = reason; this.message = message; this.current = 'closed'; for (const listener of this.listeners) listener('closed') }
}

describe('computer store', () => {
  const lists = (title: string): ComputerLists => ({ ...parseLists(desktopLists())!, threads: [{ id: 't', title, createdAt: 0, updatedAt: 0, order: 0, pinned: false, settled: false, started: true }] })

  it('shows saved lists at once, follows the computer, and saves what it shows', async () => {
    vi.useFakeTimers()
    try {
      const cache = memoryListsCache()
      cache.write('acct', 'node', lists('Saved'))
      const sessions: StubSession[] = []
      const store = new ComputerStore({ nodeId: 'node', accountId: 'acct', cache, open: async () => { sessions.push(new StubSession()); return sessions.at(-1)! }, drop: () => undefined })
      expect(store.view()).toMatchObject({ link: 'idle', listsState: 'saved', lists: { threads: [{ title: 'Saved' }] } })
      const notify = vi.fn()
      store.subscribe(notify)
      expect(store.view().link).toBe('connecting')
      await vi.advanceTimersByTimeAsync(0)
      expect(store.view()).toMatchObject({ link: 'open', listsState: 'saved' })
      sessions[0].push(lists('Live'))
      expect(store.view()).toMatchObject({ listsState: 'live', lists: { threads: [{ title: 'Live' }] } })
      // A second screen subscribing neither reconnects nor reloads.
      const view = store.view()
      store.subscribe(vi.fn())
      expect(store.view()).toBe(view)
      expect(sessions).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(600)
      expect(cache.read('acct', 'node')?.threads[0].title).toBe('Live')
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the lists through a dropped link and reconnects with a fresh read', async () => {
    vi.useFakeTimers()
    try {
      const sessions: StubSession[] = []
      const store = new ComputerStore({ nodeId: 'node', accountId: 'acct', cache: memoryListsCache(), open: async () => { sessions.push(new StubSession()); return sessions.at(-1)! }, drop: () => undefined, reconnectDelaysMs: [100] })
      store.subscribe(vi.fn())
      await vi.advanceTimersByTimeAsync(0)
      sessions[0].push(lists('First'))
      sessions[0].close()
      expect(store.view()).toMatchObject({ link: 'closed', listsState: 'saved', lists: { threads: [{ title: 'First' }] } })
      await vi.advanceTimersByTimeAsync(100)
      expect(store.view().link).toBe('open')
      expect(sessions).toHaveLength(2)
      sessions[1].push(lists('Second'))
      expect(store.view()).toMatchObject({ listsState: 'live', lists: { threads: [{ title: 'Second' }] } })
      // A computer that removed the phone takes its saved lists with it and is not retried.
      sessions[1].close('removed')
      expect(store.view()).toMatchObject({ link: 'removed', listsState: 'none' })
      expect(store.view().lists).toBeUndefined()
      await vi.advanceTimersByTimeAsync(1000)
      expect(sessions).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('reconnects without a banner when the relay drops an open link, and says so only when it stays down', async () => {
    vi.useFakeTimers()
    try {
      let down = false
      const sessions: StubSession[] = []
      const states: string[] = []
      const store = new ComputerStore({
        nodeId: 'node',
        accountId: 'acct',
        cache: memoryListsCache(),
        reconnectDelaysMs: [1_000, 2_000, 5_000, 10_000, 30_000],
        drop: () => undefined,
        open: async () => {
          if (down) throw unreachable(new Error('Studio Mac is offline. Open Mousse on it and try again.'))
          sessions.push(new StubSession())
          return sessions.at(-1)!
        },
      })
      store.subscribe(() => states.push(`${store.view().link}:${store.view().error ?? ''}`))
      await vi.advanceTimersByTimeAsync(0)
      sessions[0].push(lists('First'))
      // Mousse ID deploys and its relay restarts: the socket closes with 1006.
      down = true
      sessions[0].close('lost', 'The relay closed the connection (code 1006).')
      expect(store.view()).toMatchObject({ link: 'connecting', listsState: 'saved', lists: { threads: [{ title: 'First' }] } })
      expect(store.view().error).toBeUndefined()
      await vi.advanceTimersByTimeAsync(3_000)
      expect(store.view()).toMatchObject({ link: 'connecting' })
      down = false
      await vi.advanceTimersByTimeAsync(5_000)
      expect(store.view().link).toBe('open')
      expect(sessions).toHaveLength(2)
      expect(states.filter((state) => state.startsWith('closed') || state.startsWith('error'))).toEqual([])

      // A relay that stays down is reported once the quiet window is over.
      down = true
      sessions[1].close('lost', 'The relay closed the connection (code 1006).')
      await vi.advanceTimersByTimeAsync(20_000)
      expect(store.view()).toMatchObject({ link: 'error', error: 'Studio Mac is offline. Open Mousse on it and try again.' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('waits at least a minute after Mousse ID refuses a connection for the account\'s budget', async () => {
    vi.useFakeTimers()
    try {
      let attempts = 0
      const store = new ComputerStore({
        nodeId: 'node',
        accountId: 'acct',
        cache: memoryListsCache(),
        reconnectDelaysMs: [1_000, 2_000, 5_000, 10_000, 30_000],
        drop: () => undefined,
        open: async () => {
          attempts++
          throw Object.assign(new Error('Relay refused the connection (quota_exceeded).'), { code: 'quota_exceeded' })
        },
      })
      store.subscribe(() => undefined)
      await vi.advanceTimersByTimeAsync(0)
      expect(attempts).toBe(1)
      await vi.advanceTimersByTimeAsync(59_000)
      expect(attempts).toBe(1)
      await vi.advanceTimersByTimeAsync(2_000)
      expect(attempts).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('never stops reconnecting a dropped link, and tries at once when the network changes', async () => {
    vi.useFakeTimers()
    try {
      let down = false
      let attempts = 0
      const sessions: StubSession[] = []
      const network = manualNetworkSignals()
      const store = new ComputerStore({
        nodeId: 'node',
        accountId: 'acct',
        cache: memoryListsCache(),
        reconnectDelaysMs: [1_000, 30_000],
        network,
        drop: () => undefined,
        open: async () => {
          attempts++
          if (down) throw unreachable(new Error('Studio Mac is offline. Open Mousse on it and try again.'))
          sessions.push(new StubSession())
          return sessions.at(-1)!
        },
      })
      store.subscribe(vi.fn())
      await vi.advanceTimersByTimeAsync(0)
      down = true
      sessions[0].close('lost', 'The relay closed the connection (code 1006).')
      // The computer stays away for ten minutes; the phone keeps trying at the longest wait.
      await vi.advanceTimersByTimeAsync(10 * 60_000)
      expect(attempts).toBeGreaterThanOrEqual(20)
      expect(store.view()).toMatchObject({ link: 'error' })
      down = false
      await vi.advanceTimersByTimeAsync(30_000)
      expect(store.view().link).toBe('open')

      // Wi-Fi comes back while a retry is still far off: the phone tries again at once.
      down = true
      sessions[1].close('lost', 'The relay closed the connection (code 1006).')
      await vi.advanceTimersByTimeAsync(2_000)
      down = false
      const before = attempts
      network.fire()
      await vi.advanceTimersByTimeAsync(0)
      expect(attempts).toBe(before + 1)
      expect(store.view().link).toBe('open')
      store.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('still shows a session that ended for another reason, and a refusal while reconnecting', async () => {
    vi.useFakeTimers()
    try {
      let refuse = false
      const sessions: StubSession[] = []
      const store = new ComputerStore({
        nodeId: 'node',
        accountId: 'acct',
        cache: memoryListsCache(),
        reconnectDelaysMs: [100, 100],
        drop: () => undefined,
        open: async () => {
          if (refuse) throw new Error('Studio Mac no longer accepts this phone. Add it again.')
          sessions.push(new StubSession())
          return sessions.at(-1)!
        },
      })
      store.subscribe(vi.fn())
      await vi.advanceTimersByTimeAsync(0)
      sessions[0].close('ended', 'Handshake exceeds 16 KiB.')
      expect(store.view()).toMatchObject({ link: 'closed', error: 'Handshake exceeds 16 KiB.' })
      await vi.advanceTimersByTimeAsync(100)
      expect(store.view().link).toBe('open')
      refuse = true
      sessions[1].close('lost', 'The relay closed the connection (code 1006).')
      expect(store.view()).toMatchObject({ link: 'connecting' })
      await vi.advanceTimersByTimeAsync(100)
      expect(store.view()).toMatchObject({ link: 'error', error: 'Studio Mac no longer accepts this phone. Add it again.' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('tells a path that is only unreachable from a refusal or a broken handshake', () => {
    expect(isUnreachable(new NetError('route_unreachable', 'The relay closed the connection (code 1006).'))).toBe(true)
    expect(isUnreachable(new NetError('peer_offline'))).toBe(true)
    expect(isUnreachable(unreachable(new Error('Studio Mac is offline.')))).toBe(true)
    expect(isUnreachable(new NetError('revoked'))).toBe(false)
    expect(isUnreachable(new NetError('too_large', 'Handshake exceeds 16 KiB.'))).toBe(false)
    expect(isUnreachable(new Error('Studio Mac no longer accepts this phone.'))).toBe(false)
    expect(isUnreachable(undefined)).toBe(false)
  })

  it('reports a failed connection and tries again on request', async () => {
    let fail = true
    const drop = vi.fn()
    const store = new ComputerStore({ nodeId: 'node', accountId: 'acct', cache: memoryListsCache(), drop, reconnectDelaysMs: [], open: async () => { if (fail) throw new Error('Studio Mac is offline.'); return new StubSession() } })
    store.subscribe(vi.fn())
    await until(() => store.view().link === 'error')
    expect(store.view().error).toBe('Studio Mac is offline.')
    fail = false
    store.retry()
    expect(drop).toHaveBeenCalled()
    await until(() => store.view().link === 'open')
  })
})
