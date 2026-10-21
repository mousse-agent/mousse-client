// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { NetError } from '../../src/net/errors'
import type { ByteStream } from '../../src/net/stream'
import {
  BUFFERED_MAX_BYTES,
  CHUNK_MAX_BYTES,
  dialWebRtc,
  parseDirectEndpoints,
  stunServers,
  WEBRTC_CHANNEL_LABEL,
  WEBRTC_OFFER_METHOD,
  type DataChannelLike,
  type PeerConnectionConfig,
  type PeerConnectionLike,
  type WebRtcDialOptions,
} from '../../src/net/webrtc'

const OFFER = 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\na=candidate:1 1 udp 2122260223 192.168.1.20 50000 typ host\r\n'
const ANSWER = 'v=0\r\no=- 3 4 IN IP4 127.0.0.1\r\na=candidate:1 1 udp 2122260223 192.168.1.5 40000 typ host\r\n'

class FakeChannel implements DataChannelLike {
  binaryType = 'blob'
  readyState = 'connecting'
  bufferedAmount = 0
  sent: Uint8Array[] = []
  closed = false
  onopen: ((event: unknown) => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  onclose: ((event: unknown) => void) | null = null
  constructor(
    readonly label: string,
    readonly options: { ordered: boolean },
  ) {}
  send(data: ArrayBufferView): void {
    this.sent.push(new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice())
  }
  close(): void {
    this.closed = true
    this.readyState = 'closed'
  }
  open(): void {
    this.readyState = 'open'
    this.onopen?.({})
  }
}

class FakePeer implements PeerConnectionLike {
  connectionState = 'new'
  iceGatheringState = 'new'
  localDescription: { type: string; sdp: string } | null = null
  remote?: { type: string; sdp: string }
  channel?: FakeChannel
  closed = false
  /** Gathering finishes on its own after setLocalDescription unless false. */
  gatherCompletes = true
  remoteError?: Error
  onicecandidate: ((event: { candidate: unknown }) => void) | null = null
  onicegatheringstatechange: ((event: unknown) => void) | null = null
  onconnectionstatechange: ((event: unknown) => void) | null = null
  constructor(readonly config: PeerConnectionConfig) {}
  createDataChannel(label: string, options: { ordered: boolean }): DataChannelLike {
    this.channel = new FakeChannel(label, options)
    return this.channel
  }
  async createOffer() {
    return { type: 'offer', sdp: 'v=0\r\n' }
  }
  async setLocalDescription(description: { type: string; sdp?: string }) {
    this.localDescription = { type: description.type, sdp: description.sdp ?? '' }
    this.iceGatheringState = 'gathering'
    if (this.gatherCompletes)
      setTimeout(() => {
        // Candidates arrive and end with a null candidate, after which the description has them all.
        this.localDescription = { type: 'offer', sdp: OFFER }
        this.onicecandidate?.({ candidate: { candidate: 'a' } })
        this.iceGatheringState = 'complete'
        this.onicecandidate?.({ candidate: null })
      }, 5)
  }
  async setRemoteDescription(description: { type: 'answer'; sdp: string }) {
    if (this.remoteError) throw this.remoteError
    this.remote = description
  }
  close(): void {
    this.closed = true
    this.connectionState = 'closed'
  }
  state(next: string): void {
    this.connectionState = next
    this.onconnectionstatechange?.({})
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
const until = async (check: () => boolean, ms = 500) => {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
}

/** Dials with a fake peer connection; the computer's answer is scripted. */
function dial(options: Partial<WebRtcDialOptions> & { answer?: unknown; rpcError?: Error; setup?: (pc: FakePeer) => void } = {}) {
  const peers: FakePeer[] = []
  const calls: Array<{ method: string; params: unknown; options: unknown }> = []
  let disconnects = 0
  const result = dialWebRtc({
    stun: [],
    rpc: async (method, params, rpcOptions) => {
      calls.push({ method, params, options: rpcOptions })
      if (options.rpcError) throw options.rpcError
      return options.answer ?? { sdp: ANSWER }
    },
    onDisconnected: () => disconnects++,
    peerConnectionFactory: (config) => {
      const pc = new FakePeer(config)
      options.setup?.(pc)
      peers.push(pc)
      return pc
    },
    ...options,
  })
  result.catch(() => undefined)
  return { result, peers, calls, disconnects: () => disconnects }
}

/** A dial that has reached an open DataChannel. */
async function opened(options: Parameters<typeof dial>[0] = {}) {
  const t = dial(options)
  await until(() => !!t.peers[0]?.remote)
  const pc = t.peers[0]
  pc.state('connected')
  pc.channel!.open()
  const stream = await t.result
  const received: Uint8Array[] = []
  let closedWith: Error | undefined | null = null
  stream.listen({ data: (bytes) => received.push(bytes), close: (error) => (closedWith = error) })
  return { ...t, pc, channel: pc.channel!, stream, received, closedWith: () => closedWith }
}

describe('direct endpoints', () => {
  it('reports WebRTC only when the computer says it takes version 1 offers', () => {
    expect(parseDirectEndpoints({ endpoints: [], webrtc: { v: 1 } })).toEqual([{ kind: 'webrtc' }])
    // An older desktop omits `webrtc`; its ws endpoints are never dialed.
    expect(parseDirectEndpoints({ endpoints: [{ url: 'ws://192.168.1.5:41234/mousse-net', kind: 'lan' }] })).toEqual([])
    for (const value of [undefined, null, 'webrtc', { webrtc: true }, { webrtc: { v: 2 } }, { webrtc: null }]) expect(parseDirectEndpoints(value)).toEqual([])
  })

  it('takes STUN servers from the configuration and never TURN', () => {
    expect(stunServers(['stun:api.mousse.work:3478', 'turn:relay.test:3478', 'stuns:x.test', 'stun:a b', 7, 'stun:x?transport=tcp'])).toEqual([
      'stun:api.mousse.work:3478',
      'stuns:x.test',
    ])
    expect(stunServers(undefined)).toEqual([])
    expect(stunServers(Array.from({ length: 9 }, (_, i) => `stun:s${i}.test`))).toHaveLength(4)
  })
})

describe('webrtc opener', () => {
  it('gathers, sends the offer over the session, applies the answer and opens one ordered channel', async () => {
    const t = await opened({ stun: ['stun:api.mousse.work:3478'] })
    expect(t.pc.config.iceServers).toEqual([{ urls: ['stun:api.mousse.work:3478'] }])
    expect(t.channel.label).toBe(WEBRTC_CHANNEL_LABEL)
    expect(t.channel.options).toEqual({ ordered: true })
    expect(t.channel.binaryType).toBe('arraybuffer')
    // Non-trickle: the offer carries the candidates gathered before it was sent.
    expect(t.calls).toHaveLength(1)
    expect(t.calls[0]).toMatchObject({ method: WEBRTC_OFFER_METHOD, params: { sdp: OFFER, v: 1 } })
    expect(t.pc.remote).toEqual({ type: 'answer', sdp: ANSWER })
    expect(t.stream.closed).toBe(false)
  })

  it('uses host candidates only without STUN, and sends what it has after the gather timeout', async () => {
    const t = dial({ gatherTimeoutMs: 30, setup: (pc) => (pc.gatherCompletes = false) })
    await tick()
    expect(t.peers[0].config.iceServers).toEqual([])
    const started = Date.now()
    await until(() => t.calls.length === 1)
    expect(Date.now() - started).toBeGreaterThanOrEqual(20)
  })

  it('writes in messages of at most 64 KiB and delivers binary messages', async () => {
    const t = await opened()
    t.stream.write(new Uint8Array(CHUNK_MAX_BYTES * 2 + 10).fill(7))
    expect(t.channel.sent.map((chunk) => chunk.length)).toEqual([CHUNK_MAX_BYTES, CHUNK_MAX_BYTES, 10])
    t.channel.onmessage!({ data: new Uint8Array([1, 2, 3]).buffer })
    expect(t.received).toEqual([new Uint8Array([1, 2, 3])])
  })

  it('closes with an error instead of queueing past 8 MiB, and never drops silently', async () => {
    const t = await opened()
    t.channel.bufferedAmount = BUFFERED_MAX_BYTES - 100
    t.stream.write(new Uint8Array(100))
    expect(t.channel.sent).toHaveLength(1)
    t.stream.write(new Uint8Array(101))
    expect(t.channel.sent).toHaveLength(1)
    expect(t.closedWith()).toMatchObject({ code: 'route_unreachable' })
    expect(t.stream.closed).toBe(true)
    expect(t.pc.closed).toBe(true)
    expect(() => t.stream.write(new Uint8Array(1))).toThrow()
  })

  it('refuses text and oversized messages', async () => {
    const text = await opened()
    text.channel.onmessage!({ data: 'hello' })
    expect(text.closedWith()).toMatchObject({ code: 'bad_request' })
    expect(text.pc.closed).toBe(true)
    const large = await opened()
    large.channel.onmessage!({ data: new ArrayBuffer(CHUNK_MAX_BYTES + 1) })
    expect(large.closedWith()).toMatchObject({ code: 'too_large' })
  })

  it('ends the stream as a lost path when ICE fails or closes', async () => {
    for (const state of ['failed', 'closed']) {
      const t = await opened()
      t.pc.state(state)
      expect(t.closedWith()).toBeInstanceOf(NetError)
      expect(t.closedWith()).toMatchObject({ code: 'route_unreachable' })
      expect(t.channel.closed).toBe(true)
    }
    const channel = await opened()
    channel.channel.onclose!({})
    expect(channel.closedWith()).toMatchObject({ code: 'route_unreachable' })
  })

  it('only reports a disconnect, which is often passing, and keeps the stream open', async () => {
    const t = await opened()
    t.pc.state('disconnected')
    expect(t.disconnects()).toBe(1)
    expect(t.stream.closed).toBe(false)
    expect(t.pc.closed).toBe(false)
    t.pc.state('connected')
    t.stream.write(new Uint8Array([9]))
    expect(t.channel.sent).toHaveLength(1)
  })

  it('closes the peer connection when the race is aborted, and not once it is open', async () => {
    const controller = new AbortController()
    const t = dial({ signal: controller.signal })
    await until(() => !!t.peers[0]?.remote)
    controller.abort()
    await expect(t.result).rejects.toMatchObject({ code: 'cancelled' })
    expect(t.peers[0].closed).toBe(true)

    const before = new AbortController()
    before.abort()
    await expect(dial({ signal: before.signal }).result).rejects.toMatchObject({ code: 'cancelled' })

    const won = new AbortController()
    const open = await opened({ signal: won.signal })
    won.abort()
    expect(open.pc.closed).toBe(false)
    expect(open.stream.closed).toBe(false)
  })

  it('closes the peer connection when the stream is closed', async () => {
    const t = await opened()
    t.stream.close()
    expect(t.pc.closed).toBe(true)
    expect(t.channel.closed).toBe(true)
  })

  it('keeps SDP and addresses out of errors', async () => {
    const leaky = new Error(`Failed to set remote answer sdp: ${ANSWER}`)
    const remote = dial({ setup: (pc) => (pc.remoteError = leaky) })
    const error = (await remote.result.catch((e: unknown) => e)) as NetError
    expect(error).toBeInstanceOf(NetError)
    expect(error.code).toBe('unavailable')
    expect(error.cause).toBeUndefined()
    expect(`${error.message} ${error.stack}`).not.toMatch(/192\.168|v=0|candidate/)
    expect(remote.peers[0].closed).toBe(true)

    // The computer's refusal keeps its code; its message never carries details through.
    const refused = await dial({ rpcError: new NetError('rate_limited', `Too many offers from ${OFFER}`) }).result.catch((e: unknown) => e)
    expect(refused).toMatchObject({ code: 'rate_limited' })
    expect((refused as Error).message).not.toMatch(/192\.168/)

    for (const answer of [{}, { sdp: 5 }, { sdp: 'nope' }, { sdp: `v=0${'a'.repeat(17 * 1024)}` }])
      await expect(dial({ answer }).result).rejects.toMatchObject({ code: 'bad_request' })
  })

  it('rejects at once when the device has no WebRTC', async () => {
    const stream: Promise<ByteStream> = dialWebRtc({ stun: [], rpc: async () => ({}) })
    await expect(stream).rejects.toMatchObject({ code: 'unavailable' })
  })
})
