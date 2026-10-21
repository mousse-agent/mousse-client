// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { b64url, fromB64url, utf8 } from '../../src/net/bytes'
import { canonicalJson, newId } from '../../src/net/canonical'
import { decodeMessage, encodeMessage, type MuxMessage, type WireMessage } from '../../src/net/codec'
import { signBytes, verifyBytes, generateSigningKey, type Signed } from '../../src/net/crypto'
import { NetError } from '../../src/net/errors'
import { generateNodeKeys } from '../../src/net/keys'
import { StreamMux } from '../../src/net/mux'
import { dialRelay, rendezvousRegistration, RELAY_AUTH_DOMAIN, type RelaySocket } from '../../src/net/relay'
import { LeafSession } from '../../src/net/session'
import { streamPair, type StreamEndpoint } from '../../src/net/stream'
import type { SecureChannel } from '../../src/net/tls13/client'
import { delegate, roster, testComputer, testUser } from './fixtures'

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('codec', () => {
  it('round-trips headers with parts and enforces lanes', () => {
    const header: WireMessage = { t: 'events', stream: 'str_x', records: [{ seq: 1, epoch: 1, recvTs: 5 }], replay: true, parts: [3, 64] }
    const bytes = encodeMessage(header, [utf8('abc'), new Uint8Array(64)])
    const decoded = decodeMessage(bytes, 'bulk')
    expect(decoded.header).toEqual(header)
    expect(decoded.parts.map((part) => part.length)).toEqual([3, 64])
    expect(() => decodeMessage(bytes, 'control')).toThrow(/wrong lane/)
  })

  it('rejects non-dense batches, bad parts and trailing bytes, and flags unknown types', () => {
    expect(() =>
      encodeMessage(
        { t: 'events', stream: 's', records: [{ seq: 1, epoch: 1, recvTs: 0 }, { seq: 3, epoch: 1, recvTs: 0 }], replay: false, parts: [1, 64, 1, 64] },
        [new Uint8Array(1), new Uint8Array(64), new Uint8Array(1), new Uint8Array(64)],
      ),
    ).toThrow(/dense/)
    const ping = encodeMessage({ t: 'ping', n: 1, now: 1 })
    const padded = new Uint8Array(ping.length + 1)
    padded.set(ping)
    expect(() => decodeMessage(padded)).toThrow(/trailing/)
    const unknown = canonicalJson({ t: 'future.thing' })
    const frame = new Uint8Array(4 + unknown.length)
    new DataView(frame.buffer).setUint32(0, unknown.length)
    frame.set(unknown, 4)
    expect(() => decodeMessage(frame)).toThrow(expect.objectContaining({ code: 'unsupported_version' }))
  })
})

describe('mux', () => {
  it('fragments large messages under credit and keeps order on both lanes', async () => {
    const [a, b] = streamPair()
    const left = new StreamMux(a)
    const right = new StreamMux(b)
    const received: MuxMessage[] = []
    right.onMessage((_lane, message) => received.push(message))
    const big = new Uint8Array(900_000).map((_, i) => i % 251)
    const sends = [
      left.send({ header: { t: 'ping', n: 1, now: 0 }, parts: [] }),
      left.send({
        header: { t: 'events', stream: 's', records: [{ seq: 1, epoch: 1, recvTs: 0 }], replay: true, parts: [big.length, 64] },
        parts: [big, new Uint8Array(64)],
      }),
      left.send({ header: { t: 'ping', n: 2, now: 0 }, parts: [] }),
      left.send({ header: { t: 'ping', n: 3, now: 0 }, parts: [] }),
    ]
    await Promise.all(sends)
    for (let i = 0; i < 20 && received.length < 4; i++) await tick()
    expect(received.map((message) => message.header.t)).toEqual(['ping', 'ping', 'ping', 'events'])
    expect(received.filter((m) => m.header.t === 'ping').map((m) => (m.header as { n: number }).n)).toEqual([1, 2, 3])
    expect(Buffer.compare(Buffer.from(received[3].parts[0]), Buffer.from(big))).toBe(0)
    // A second large message proves credit was returned.
    await left.send({
      header: { t: 'events', stream: 's', records: [{ seq: 2, epoch: 1, recvTs: 0 }], replay: true, parts: [big.length, 64] },
      parts: [big, new Uint8Array(64)],
    })
    left.close()
  })

  it('closes on an invalid frame', async () => {
    const [a, b] = streamPair()
    const mux = new StreamMux(a)
    const closed = new Promise<Error | undefined>((resolve) => mux.onClose(resolve))
    b.write(new Uint8Array(16).fill(9))
    expect(await closed).toMatchObject({ code: 'bad_request' })
  })
})

class FakeSocket implements RelaySocket {
  binaryType = 'blob'
  readyState = 1
  sent: Array<string | Uint8Array> = []
  closed = false
  onopen: RelaySocket['onopen'] = null
  onmessage: RelaySocket['onmessage'] = null
  onerror: RelaySocket['onerror'] = null
  onclose: RelaySocket['onclose'] = null
  constructor(readonly url: string) {}
  send(data: string | ArrayBufferLike | ArrayBufferView) {
    this.sent.push(typeof data === 'string' ? data : new Uint8Array(data as ArrayBuffer))
  }
  close() {
    this.closed = true
  }
  server(value: unknown) {
    this.onmessage?.({ data: typeof value === 'string' ? value : JSON.stringify(value) })
  }
}

describe('relay dial', () => {
  const audience = 'wss://id.test/v1/net/relay'
  const target = newId('node')
  const node = newId('node')
  const key = generateSigningKey()
  const identity = { node, signKey: b64url(key.publicKey), signSecret: key.secretKey }

  it('authenticates, pairs and carries binary frames', async () => {
    let socket!: FakeSocket
    const ticket = b64url(new Uint8Array(32).fill(7))
    const dialing = dialRelay({
      route: `${audience}?node=${target}`,
      identity,
      registration: rendezvousRegistration(ticket),
      ticket,
      socketFactory: (url) => (socket = new FakeSocket(url)),
    })
    expect(socket.url).toBe(audience)
    const nonce = b64url(new Uint8Array(32).fill(1))
    socket.server({ v: 1, t: 'challenge', audience, nonce })
    const auth = JSON.parse(socket.sent[0] as string)
    const { sig, ...claims } = auth
    expect(claims).toMatchObject({ t: 'auth', v: 1, role: 'dial', target, node, generation: 1, rendezvous: { ticket } })
    expect(claims.registrationId).toMatch(/^rendezvous_[A-Za-z0-9_-]{43}$/)
    expect(verifyBytes(canonicalJson({ domain: RELAY_AUTH_DOMAIN, ...claims }), fromB64url(sig, 64), key.publicKey)).toBe(true)
    socket.server({ v: 1, t: 'ready' })
    socket.server({ v: 1, t: 'paired', peer: target, circuitId: 'c1' })
    const stream = await dialing
    const got: Uint8Array[] = []
    stream.listen({ data: (bytes) => got.push(bytes), close: () => {} })
    socket.onmessage?.({ data: Uint8Array.of(1, 2, 3).buffer })
    expect([...got[0]]).toEqual([1, 2, 3])
    stream.write(new Uint8Array(70_000))
    expect(socket.sent.slice(1).map((frame) => frame.length)).toEqual([65536, 70_000 - 65536])
    const ended = new Promise<Error | undefined>((resolve) => stream.listen({ data: () => {}, close: resolve }))
    socket.server('{"v":1,"t":"ready"}')
    expect(await ended).toMatchObject({ code: 'bad_request' })
  })

  it('ends a paired circuit with the relay close code when the relay closes it', async () => {
    let socket!: FakeSocket
    const ticket = b64url(new Uint8Array(32).fill(7))
    const dialing = dialRelay({
      route: `${audience}?node=${target}`,
      identity,
      registration: rendezvousRegistration(ticket),
      ticket,
      socketFactory: (url) => (socket = new FakeSocket(url)),
    })
    socket.server({ v: 1, t: 'challenge', audience, nonce: b64url(new Uint8Array(32).fill(1)) })
    socket.server({ v: 1, t: 'ready' })
    socket.server({ v: 1, t: 'paired', peer: target, circuitId: 'c1' })
    const stream = await dialing
    const ended = new Promise<Error | undefined>((resolve) => stream.listen({ data: () => {}, close: resolve }))
    socket.onclose?.({ code: 1008, reason: '' })
    expect(await ended).toMatchObject({ code: 'route_unreachable', message: 'The relay closed the connection (code 1008).' })
  })

  it('refuses a challenge for another service and maps relay errors', async () => {
    let socket!: FakeSocket
    const options = { route: `${audience}?node=${target}`, identity, registration: { registrationId: 'reg_1', generation: 2 } }
    const first = dialRelay({ ...options, socketFactory: (url) => (socket = new FakeSocket(url)) })
    socket.server({ v: 1, t: 'challenge', audience: 'wss://other.test/v1/net/relay', nonce: b64url(new Uint8Array(32)) })
    await expect(first).rejects.toMatchObject({ code: 'forbidden' })
    expect(socket.sent).toHaveLength(0)
    const second = dialRelay({ ...options, socketFactory: (url) => (socket = new FakeSocket(url)) })
    socket.server({ v: 1, t: 'error', code: 'peer_offline' })
    await expect(second).rejects.toMatchObject({ code: 'peer_offline' })
    expect(() => dialRelay({ ...options, route: 'ws://public.test/v1/net/relay?node=' + target })).toThrow(NetError)
  })
})

/** The computer end of a session, driven by the test. */
function fakeComputer(stream: StreamEndpoint) {
  const mux = new StreamMux(stream)
  const inbox: WireMessage[] = []
  const waiters: Array<() => void> = []
  mux.onMessage((_lane, message) => {
    inbox.push(message.header)
    waiters.splice(0).forEach((wake) => wake())
  })
  return {
    mux,
    send: (header: WireMessage, parts: Uint8Array[] = []) => mux.send({ header, parts }),
    async next<T extends WireMessage['t']>(t: T): Promise<Extract<WireMessage, { t: T }>> {
      for (;;) {
        const index = inbox.findIndex((message) => message.t === t)
        if (index >= 0) return inbox.splice(index, 1)[0] as Extract<WireMessage, { t: T }>
        await new Promise<void>((resolve) => waiters.push(resolve))
      }
    },
  }
}

function channelOf(stream: StreamEndpoint, peerSpki: Uint8Array): SecureChannel {
  return Object.assign(stream, { peerSpki, exportKeyingMaterial: () => new Uint8Array(32) }) as unknown as SecureChannel
}

describe('leaf session', () => {
  function setup() {
    const user = testUser()
    const computer = testComputer(user)
    const phoneKeys = generateNodeKeys()
    const phone = newId('node')
    const phoneDelegation = delegate(user, phone, phoneKeys, { name: 'Phone' })
    const signedRoster = roster(user, computer.node)
    const [a, b] = streamPair()
    const rosters: Signed[] = []
    const session = new LeafSession(channelOf(a, computer.keys.transport.spki), {
      identity: { user: user.user, rootKey: user.rootKey, node: phone, roster: signedRoster, delegation: phoneDelegation },
      peerNode: computer.node,
      onRoster: (signed) => rosters.push(signed),
    })
    const remote = fakeComputer(b)
    return { user, computer, phone, phoneKeys, signedRoster, session, remote, rosters }
  }

  async function open(ctx: ReturnType<typeof setup>) {
    const hello = await ctx.remote.next('hello')
    expect(hello).toMatchObject({ node: ctx.phone, caps: ['streams.v1', 'rpc.v1', 'presence.v1'], protoMajor: 1 })
    await ctx.remote.send({
      t: 'hello',
      protoMajor: 1,
      protoMinor: 0,
      caps: ['streams.v1', 'blobs.v1', 'rpc.v1', 'presence.v1'],
      node: ctx.computer.node,
      delegation: ctx.computer.delegation,
      roster: ctx.signedRoster,
      now: Date.now(),
    })
    const ack = await ctx.remote.next('helloAck')
    expect(ack.caps).toEqual(['streams.v1', 'rpc.v1', 'presence.v1'])
    await ctx.remote.send({ t: 'helloAck', protoMinor: 0, caps: ['streams.v1', 'rpc.v1', 'presence.v1'], now: Date.now() })
    await ctx.session.opened
  }

  it('opens, answers pings, runs RPC and adopts newer rosters', async () => {
    const ctx = setup()
    await open(ctx)
    expect(ctx.session.state).toBe('open')
    await ctx.remote.send({ t: 'ping', n: 7, now: 1 })
    expect((await ctx.remote.next('pong')).n).toBe(7)

    const call = ctx.session.rpc('projects.list', {}, { idem: 'k1' })
    const request = await ctx.remote.next('rpc.request')
    expect(request).toMatchObject({ method: 'projects.list', idem: 'k1' })
    await ctx.remote.send({ t: 'rpc.progress', id: request.id, data: 1 })
    await ctx.remote.send({ t: 'rpc.result', id: request.id, result: [{ id: 'p' }] })
    expect(await call).toEqual([{ id: 'p' }])

    const failing = ctx.session.rpc('threads.get', { threadId: 'x' })
    const second = await ctx.remote.next('rpc.request')
    await ctx.remote.send({ t: 'rpc.result', id: second.id, error: { code: 'forbidden', message: 'forbidden', retryable: false } })
    await expect(failing).rejects.toMatchObject({ code: 'forbidden' })

    const newer = roster(ctx.user, ctx.computer.node)
    await ctx.remote.send({ t: 'rosterUpdate', roster: newer })
    for (let i = 0; i < 5 && !ctx.rosters.length; i++) await tick()
    expect(ctx.rosters).toEqual([newer])
    ctx.session.close()
  })

  it('delivers verified stream records and closes on a forged signature', async () => {
    const ctx = setup()
    await open(ctx)
    const got: string[] = []
    let caughtUp = false
    ctx.session.subscribe('str_t', { epoch: 0, seq: 0 }, {
      records: (records) => got.push(...records.map((record) => record.envelope.type)),
      caughtUp: () => (caughtUp = true),
    })
    const subscribe = await ctx.remote.next('subscribe')
    expect(subscribe).toEqual({ t: 'subscribe', stream: 'str_t', after: { epoch: 0, seq: 0 } })
    const envelope = (type: string) =>
      canonicalJson({
        v: 1,
        minor: 0,
        id: newId('event'),
        stream: 'str_t',
        type,
        crit: false,
        author: { user: ctx.user.user, node: ctx.computer.node, keyEpoch: 1 },
        ts: Date.now(),
        body: {},
      })
    const one = envelope('thread.event')
    await ctx.remote.send({ t: 'subscribed', stream: 'str_t', head: { epoch: 1, seq: 1 }, replayThrough: 1 })
    await ctx.remote.send(
      { t: 'events', stream: 'str_t', records: [{ seq: 1, epoch: 1, recvTs: 1 }], replay: true, parts: [one.length, 64] },
      [one, signBytes(one, ctx.computer.keys.signSecret)],
    )
    await ctx.remote.send({ t: 'caughtUp', stream: 'str_t' })
    for (let i = 0; i < 5 && !caughtUp; i++) await tick()
    expect(got).toEqual(['thread.event'])
    expect(caughtUp).toBe(true)

    const closed = new Promise<Error | undefined>((resolve) => ctx.session.onClose(resolve))
    const two = envelope('thread.event')
    await ctx.remote.send(
      { t: 'events', stream: 'str_t', records: [{ seq: 2, epoch: 1, recvTs: 2 }], replay: false, parts: [two.length, 64] },
      [two, new Uint8Array(64)],
    )
    expect(await closed).toMatchObject({ code: 'bad_signature' })
  })

  it('rejects a computer whose transport key differs from its delegation', async () => {
    const ctx = setup()
    const other = testComputer(ctx.user)
    await ctx.remote.next('hello')
    await ctx.remote.send({
      t: 'hello',
      protoMajor: 1,
      protoMinor: 0,
      caps: ['streams.v1', 'rpc.v1'],
      node: ctx.computer.node,
      delegation: other.delegation,
      roster: roster(ctx.user, ctx.computer.node),
      now: Date.now(),
    })
    await expect(ctx.session.opened).rejects.toMatchObject({ code: 'peer_key_mismatch' })
  })
})
