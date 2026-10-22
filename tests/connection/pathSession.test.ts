// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { manualNetworkSignals } from '../../src/connection/networkSignals'
import { DIRECT_OPEN_TIMEOUT_MS, ENDPOINTS_METHOD, PathSession, type DirectLink, type PathOpeners } from '../../src/connection/pathSession'
import { MousseIdError } from '../../src/mousseId/http'
import { newId } from '../../src/net/canonical'
import { NetError } from '../../src/net/errors'
import { generateNodeKeys } from '../../src/net/keys'
import { LeafSession, type StreamRecord } from '../../src/net/session'
import { streamPair, type StreamEndpoint } from '../../src/net/stream'
import { WEBRTC_OFFER_METHOD } from '../../src/net/webrtc'
import { delegate, roster, testComputer, testUser } from '../net/fixtures'
import { channelOf, fakeComputer, until, type Record } from './helpers'

/** What a computer that takes WebRTC offers answers to the endpoints request. */
const WEBRTC = { endpoints: [], webrtc: { v: 1 } }

type Remote = ReturnType<typeof fakeComputer>

/** The user's computer, reachable over any number of separate sessions (paths). */
function world() {
  const user = testUser()
  const computer = testComputer(user)
  const phone = newId('node')
  const phoneDelegation = delegate(user, phone, generateNodeKeys(), { name: 'Phone' })
  const signedRoster = roster(user, computer.node)
  /** Signed records that every path of the computer serves with the same positions. */
  const records: Record[] = []
  const author = fakeComputer(streamPair()[1], user, computer, signedRoster)
  const record = (stream: string, n: number) => {
    const made = author.record(stream, 'thread.event', { n })
    records.push(made)
    return made
  }
  async function path(options: { pong?: number | false; pingIntervalMs?: number } = {}) {
    const [a, b] = streamPair()
    const leaf = new LeafSession(channelOf(a, computer.keys.transport.spki), {
      identity: { user: user.user, rootKey: user.rootKey, node: phone, roster: signedRoster, delegation: phoneDelegation },
      peerNode: computer.node,
      ...(options.pingIntervalMs ? { pingIntervalMs: options.pingIntervalMs } : {}),
    })
    const remote = fakeComputer(b, user, computer, signedRoster)
    await remote.handshake()
    await leaf.opened
    if (options.pong !== false) answerPings(remote, options.pong ?? 0)
    return { leaf, remote, end: b as StreamEndpoint }
  }
  return { path, record }
}

/** The computer answers pings after `delayMs`. */
function answerPings(remote: Remote, delayMs: number): void {
  void (async () => {
    for (;;) {
      const ping = await remote.next('ping')
      setTimeout(() => void remote.send({ t: 'pong', n: ping.n, now: Date.now() }).catch(() => undefined), delayMs)
    }
  })()
}

async function events(remote: Remote, stream: string, records: Record[]) {
  const headers = records.map((entry) => ({ seq: entry.seq, epoch: 1, recvTs: entry.seq }))
  const parts = records.flatMap((entry) => [entry.envelope, entry.signature])
  await remote.send({ t: 'events', stream, records: headers, replay: false, parts: records.flatMap((entry) => [entry.envelope.length, 64]) }, parts)
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** A session on the relay whose direct path opens on demand. */
async function setup(
  options: { relayPong?: number; directPong?: number | false; allowed?: boolean; timeoutMs?: number; hang?: boolean; signal?: boolean } = {},
) {
  const w = world()
  const relay = await w.path({ pong: options.relayPong ?? 30 })
  const relays = [relay]
  const directs: Array<Awaited<ReturnType<typeof w.path>>> = []
  const network = manualNetworkSignals()
  const opened: string[] = []
  let relayFailure: Error | undefined
  let directFailure: Error | undefined
  const links: DirectLink[] = []
  const signals: AbortSignal[] = []
  const open: PathOpeners = {
    relay: async () => {
      opened.push('relay')
      if (relayFailure) throw relayFailure
      const next = await w.path({ pong: options.relayPong ?? 30 })
      relays.push(next)
      return next.leaf
    },
    direct: async (endpoint, signal, link) => {
      opened.push(endpoint.kind)
      links.push(link)
      signals.push(signal)
      if (directFailure) throw directFailure
      if (options.hang)
        return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new NetError('cancelled')), { once: true }))
      if (options.signal) await link.rpc(WEBRTC_OFFER_METHOD, { sdp: 'v=0 offer', v: 1 })
      const next = await w.path({ pong: options.directPong ?? 0, pingIntervalMs: 60_000 })
      directs.push(next)
      return next.leaf
    },
    ...(options.allowed === undefined ? {} : { directAllowed: async () => options.allowed! }),
    ...(options.timeoutMs === undefined ? {} : { directTimeoutMs: () => options.timeoutMs! }),
  }
  const session = new PathSession({ first: relay.leaf, open, network, autoProbe: false, livenessTimeoutMs: 200, settleMs: 5, recoveryDelaysMs: [0, 20, 20], recoveryWindowMs: 1_000 })
  const states: string[] = []
  session.onStateChange((state) => states.push(state))
  return {
    w,
    session,
    relay,
    relays,
    directs,
    network,
    opened,
    links,
    signals,
    states,
    failRelay: (error?: Error) => (relayFailure = error),
    failDirect: (error: Error) => (directFailure = error),
  }
}

/** Runs a probe and answers the endpoints request on the relay. */
async function upgrade(t: Awaited<ReturnType<typeof setup>>, answer: unknown = WEBRTC) {
  const probing = t.session.probe()
  const relay = t.relays.at(-1)!
  await relay.remote.answer(ENDPOINTS_METHOD, answer)
  await probing
}

describe('path session', () => {
  it('learns over the relay that the computer takes WebRTC and moves to a direct path that answers faster', async () => {
    const t = await setup({ signal: true })
    expect(t.session.path).toBe('relay')
    const probing = t.session.probe()
    await t.relay.remote.answer(ENDPOINTS_METHOD, WEBRTC)
    // The offer travels inside the relay session.
    const offer = await t.relay.remote.answer(WEBRTC_OFFER_METHOD, { sdp: 'v=0 answer' })
    expect(offer.params).toEqual({ sdp: 'v=0 offer', v: 1 })
    await probing
    expect(t.opened).toEqual(['webrtc'])
    expect(t.session.path).toBe('direct')
    const carrier = t.directs[0]
    const listing = t.session.rpc('projects.list', {})
    const request = await carrier.remote.answer('projects.list', { projects: [] })
    expect(await listing).toEqual({ projects: [] })
    expect(request.method).toBe('projects.list')
    // The idle relay session closed; the caller saw no state change.
    await until(() => t.relay.leaf.state === 'closed')
    expect(t.session.state).toBe('open')
    expect(t.states).toEqual([])
  })

  it('stays on the relay when the direct path is slower, and when the computer offers no endpoints', async () => {
    const slow = await setup({ relayPong: 0, directPong: 40 })
    await upgrade(slow)
    expect(slow.session.path).toBe('relay')
    await until(() => slow.directs[0]?.leaf.state === 'closed')

    // An older desktop answers without `webrtc` (its ws endpoints are ignored); the phone never dials.
    for (const answer of [{ endpoints: [] }, { endpoints: [{ url: 'ws://192.168.1.5:41234/mousse-net', kind: 'lan' }] }, { webrtc: { v: 2 } }]) {
      const none = await setup()
      await upgrade(none, answer)
      expect(none.session.path).toBe('relay')
      expect(none.opened).toEqual([])
    }
  })

  it('does not ask the computer when direct paths are switched off', async () => {
    const t = await setup({ allowed: false })
    let asked = false
    void t.relay.remote.next('rpc.request').then(() => (asked = true))
    await t.session.probe()
    await sleep(20)
    expect(asked).toBe(false)
    expect(t.opened).toEqual([])
  })

  it('gives each attempt the timeout of its kind and closes it when the time is up', async () => {
    expect(DIRECT_OPEN_TIMEOUT_MS.webrtc).toEqual({ sameNetwork: 8_000, stun: 10_000 })
    const t = await setup({ hang: true, timeoutMs: 40 })
    const started = Date.now()
    await upgrade(t)
    expect(t.signals[0].aborted).toBe(true)
    expect(Date.now() - started).toBeGreaterThanOrEqual(35)
    expect(t.session.path).toBe('relay')
  })

  it('only checks the path when ICE reports a disconnect, and stays when it still answers', async () => {
    const t = await setup()
    await upgrade(t)
    const direct = t.directs[0]
    let probes = 0
    const probe = direct.leaf.probe.bind(direct.leaf)
    direct.leaf.probe = (timeoutMs) => {
      probes++
      return probe(timeoutMs)
    }
    t.links[0].checkPath()
    await until(() => probes === 1)
    await sleep(20)
    expect(t.session.path).toBe('direct')
    expect(direct.leaf.state).toBe('open')
    expect(t.relays).toHaveLength(1)
  })

  it('stops looking for a direct path on a computer without the endpoints method', async () => {
    const t = await setup()
    const probing = t.session.probe()
    const request = await t.relay.remote.next('rpc.request')
    expect(request.method).toBe(ENDPOINTS_METHOD)
    await t.relay.remote.send({ t: 'rpc.result', id: request.id, error: { code: 'forbidden', message: 'Forbidden.', retryable: false } })
    await probing
    await t.session.probe()
    expect(t.opened).toEqual([])
  })

  it('moves streams onto the new path from where they were, without losing or repeating records', async () => {
    const t = await setup()
    const stream = 'str_thread'
    const r = [1, 2, 3, 4, 5, 6].map((n) => t.w.record(stream, n))
    const seen: number[] = []
    t.session.subscribe(stream, { epoch: 1, seq: 0 }, {
      records: (records: StreamRecord[]) => seen.push(...records.map((record) => record.seq)),
    })
    expect(await t.relay.remote.next('subscribe')).toMatchObject({ stream, after: { epoch: 1, seq: 0 } })
    await events(t.relay.remote, stream, [r[0], r[1]])
    await until(() => seen.length === 2)
    await upgrade(t)
    expect(t.session.path).toBe('direct')
    const direct = t.directs[0]
    // The direct path resumes after the last record the caller has.
    expect(await direct.remote.next('subscribe')).toMatchObject({ stream, after: { epoch: 1, seq: 2 } })
    // The idle relay session closes; the direct path's overlap is dropped.
    await until(() => t.relay.leaf.state === 'closed')
    await events(direct.remote, stream, [r[1], r[2], r[3]])
    await events(direct.remote, stream, [r[3], r[4], r[5]])
    await until(() => seen.length >= 6)
    expect(seen).toEqual([1, 2, 3, 4, 5, 6])
  })

  it('passes on replayed records that a live record overtook, once each', async () => {
    const t = await setup()
    const stream = 'str_thread'
    const r = [1, 2, 3, 4].map((n) => t.w.record(stream, n))
    const seen: number[] = []
    t.session.subscribe(stream, { epoch: 1, seq: 0 }, {
      records: (records: StreamRecord[]) => seen.push(...records.map((record) => record.seq)),
    })
    await t.relay.remote.next('subscribe')
    // Live 4 arrives on the control lane before the replay of 1 to 3 on the bulk lane.
    await events(t.relay.remote, stream, [r[3]])
    await events(t.relay.remote, stream, [r[0], r[1], r[2]])
    await events(t.relay.remote, stream, [r[3]])
    await until(() => seen.length >= 4)
    expect(seen).toEqual([4, 1, 2, 3])
  })

  it('finishes requests in flight on the old path and sends new ones on the new path', async () => {
    const t = await setup()
    const send = t.session.rpc('orchestrator.send', { threadId: 't1', content: 'hi' }, { idem: 'idem-1', deadlineMs: 60_000 })
    const sent = await t.relay.remote.next('rpc.request')
    expect(sent.method).toBe('orchestrator.send')
    await upgrade(t)
    expect(t.session.path).toBe('direct')
    const abort = t.session.rpc('orchestrator.abort', { threadId: 't1', run: sent.id }, { idem: 'idem-2' })
    await t.directs[0].remote.answer('orchestrator.abort', { ok: true })
    expect(await abort).toEqual({ ok: true })
    // The relay stays open for the reply, which arrives once and closes it after.
    expect(t.relay.leaf.state).toBe('open')
    await t.relay.remote.send({ t: 'rpc.result', id: sent.id, result: { ok: true } })
    expect(await send).toEqual({ ok: true })
    await until(() => t.relay.leaf.state === 'closed')
    expect(t.states).toEqual([])
  })

  it('falls back to the relay when the direct path drops, resending requests and streams there', async () => {
    const t = await setup()
    await upgrade(t)
    const direct = t.directs[0]
    const stream = 'str_lists'
    const r = [1, 2, 3].map((n) => t.w.record(stream, n))
    const seen: number[] = []
    t.session.subscribe(stream, { epoch: 1, seq: 0 }, { records: (records) => seen.push(...records.map((record) => record.seq)) })
    await direct.remote.next('subscribe')
    await events(direct.remote, stream, [r[0]])
    await until(() => seen.length === 1)
    const write = t.session.rpc('threads.create', { name: 'x' }, { idem: 'idem-create' })
    const read = t.session.rpc('projects.list', {})
    const firstWrite = await direct.remote.next('rpc.request')
    const firstRead = await direct.remote.next('rpc.request')
    // The Wi-Fi goes away.
    direct.end.close(new NetError('route_unreachable', 'gone'))
    await until(() => t.relays.length === 2)
    const relay = t.relays[1]
    expect(t.session.path).toBe('relay')
    expect(await relay.remote.next('subscribe')).toMatchObject({ stream, after: { epoch: 1, seq: 1 } })
    const again = [await relay.remote.next('rpc.request'), await relay.remote.next('rpc.request')]
    const writeAgain = again.find((request) => request.method === 'threads.create')!
    const readAgain = again.find((request) => request.method === 'projects.list')!
    // The mutation keeps its id and key, so the computer runs it once; the read starts fresh.
    expect(writeAgain).toMatchObject({ id: firstWrite.id, idem: 'idem-create' })
    expect(readAgain.id).not.toBe(firstRead.id)
    await relay.remote.send({ t: 'rpc.result', id: writeAgain.id, result: { thread: { id: 't9' } } })
    await relay.remote.send({ t: 'rpc.result', id: readAgain.id, result: { projects: [] } })
    expect(await write).toEqual({ thread: { id: 't9' } })
    expect(await read).toEqual({ projects: [] })
    await events(relay.remote, stream, [r[0], r[1], r[2]])
    await until(() => seen.length === 3)
    expect(seen).toEqual([1, 2, 3])
    expect(t.session.state).toBe('open')
    expect(t.states).toEqual([])
  })

  it('notices a silent direct path when the network changes and falls back at once', async () => {
    const t = await setup({ directPong: 0 })
    await upgrade(t)
    expect(t.session.path).toBe('direct')
    // The computer stops answering on this path, as when the phone leaves the Wi-Fi without an error.
    const silent = t.directs[0]
    const pings: number[] = []
    void (async () => {
      for (;;) pings.push((await silent.remote.next('ping')).n)
    })()
    silent.leaf.probe = (timeoutMs) => new Promise((_resolve, reject) => setTimeout(() => reject(new NetError('deadline_exceeded')), timeoutMs))
    t.network.fire()
    await until(() => t.relays.length === 2, 400)
    expect(silent.leaf.state).toBe('closed')
    expect(t.session.path).toBe('relay')
    expect(t.session.state).toBe('open')
  })

  it('tries the direct path again after the network changes while on the relay', async () => {
    const t = await setup()
    t.network.fire()
    const request = await t.relay.remote.next('rpc.request')
    expect(request.method).toBe(ENDPOINTS_METHOD)
    await t.relay.remote.send({ t: 'rpc.result', id: request.id, result: WEBRTC })
    await until(() => t.session.path === 'direct', 400)
  })

  it('keeps the session open while the relay restarts, and sends waiting requests once it is back', async () => {
    const t = await setup()
    const pending = t.session.rpc('projects.list', {})
    await t.relay.remote.next('rpc.request')
    // Mousse ID deploys: the relay is gone for a moment and the computer registers again.
    t.failRelay(new NetError('route_unreachable', 'Relay connection failed.'))
    t.relay.end.close(new NetError('route_unreachable', 'The relay closed the connection (code 1006).'))
    await until(() => t.opened.filter((kind) => kind === 'relay').length === 2)
    t.failRelay(undefined)
    await until(() => t.relays.length === 2)
    const again = await t.relays[1].remote.next('rpc.request')
    await t.relays[1].remote.send({ t: 'rpc.result', id: again.id, result: { projects: [] } })
    expect(await pending).toEqual({ projects: [] })
    expect(t.session.state).toBe('open')
    expect(t.states).toEqual([])
  })

  it('keeps the session open while Mousse ID cannot renew the registration for a moment', async () => {
    const t = await setup()
    // Mousse ID itself redeploys, or the phone's network is not back yet after the app returns.
    t.failRelay(new MousseIdError('unavailable'))
    t.relay.end.close(new NetError('route_unreachable', 'The relay closed the connection (code 1006).'))
    await until(() => t.opened.length === 1)
    t.failRelay(new MousseIdError('offline'))
    await until(() => t.opened.length === 2)
    t.failRelay(undefined)
    await until(() => t.relays.length === 2)
    expect(t.session.state).toBe('open')
    expect(t.states).toEqual([])
  })

  it('closes as before when both paths fail, with the reason the session had', async () => {
    const t = await setup()
    await upgrade(t)
    t.failRelay(new NetError('peer_offline', 'Relay down.'))
    const pending = t.session.rpc('projects.list', {})
    await t.directs[0].remote.next('rpc.request')
    t.directs[0].end.close(new NetError('route_unreachable', 'Wi-Fi gone.'))
    await expect(pending).rejects.toMatchObject({ code: 'route_unreachable' })
    expect(t.session.state).toBe('closed')
    expect(t.session.closeReason).toMatchObject({ code: 'route_unreachable' })
    expect(t.states).toEqual(['closed'])
  })

  it('closes with the refusal when the computer revoked the phone, and never hides a revocation', async () => {
    const t = await setup()
    await upgrade(t)
    t.failRelay(new NetError('revoked', 'Removed.'))
    t.directs[0].end.close(new NetError('route_unreachable', 'Wi-Fi gone.'))
    await until(() => t.session.state === 'closed')
    expect(t.session.closeReason).toMatchObject({ code: 'revoked' })

    const direct = await setup()
    await upgrade(direct)
    await direct.directs[0].remote.send({ t: 'goAway', error: { code: 'revoked', message: 'Removed.', retryable: false } })
    await until(() => direct.session.state === 'closed')
    expect(direct.session.closeReason).toMatchObject({ code: 'revoked' })
    expect(direct.relays).toHaveLength(1)
  })

  it('closes every path when the caller closes it', async () => {
    const t = await setup()
    const send = t.session.rpc('orchestrator.send', { threadId: 't1', content: 'hi' }, { idem: 'idem-1' })
    await t.relay.remote.next('rpc.request')
    await upgrade(t)
    t.session.close()
    await expect(send).rejects.toMatchObject({ code: 'cancelled' })
    expect(t.relay.leaf.state).toBe('closed')
    expect(t.directs[0].leaf.state).toBe('closed')
    await sleep(5)
    expect(t.relays).toHaveLength(1)
  })
})
