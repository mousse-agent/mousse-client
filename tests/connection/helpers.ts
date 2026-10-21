// A scripted computer at the far end of a LeafSession, and signed thread-stream records.
import { b64url, utf8 } from '../../src/net/bytes'
import { canonicalJson, newId } from '../../src/net/canonical'
import { sha256, signBytes, type Signed } from '../../src/net/crypto'
import { StreamMux } from '../../src/net/mux'
import type { MuxMessage, WireMessage } from '../../src/net/codec'
import type { StreamEndpoint } from '../../src/net/stream'
import type { SecureChannel } from '../../src/net/tls13/client'
import type { TestComputer, TestUser } from '../net/fixtures'

export const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

export async function until(check: () => boolean, rounds = 50): Promise<void> {
  for (let i = 0; i < rounds && !check(); i++) await tick()
  if (!check()) throw new Error('Condition not reached.')
}

export function channelOf(stream: StreamEndpoint, peerSpki: Uint8Array): SecureChannel {
  return Object.assign(stream, { peerSpki, exportKeyingMaterial: () => new Uint8Array(32) }) as unknown as SecureChannel
}

export interface Record {
  seq: number
  envelope: Uint8Array
  signature: Uint8Array
}

/** The computer end: answers the handshake, then lets the test answer RPCs and stream requests. */
export function fakeComputer(stream: StreamEndpoint, user: TestUser, computer: TestComputer, signedRoster: Signed) {
  const mux = new StreamMux(stream)
  const inbox: WireMessage[] = []
  const waiters: Array<() => void> = []
  mux.onMessage((_lane, message: MuxMessage) => {
    inbox.push(message.header)
    waiters.splice(0).forEach((wake) => wake())
  })
  const send = (header: WireMessage, parts: Uint8Array[] = []) => mux.send({ header, parts })
  async function next<T extends WireMessage['t']>(t: T): Promise<Extract<WireMessage, { t: T }>> {
    for (;;) {
      const index = inbox.findIndex((message) => message.t === t)
      if (index >= 0) return inbox.splice(index, 1)[0] as Extract<WireMessage, { t: T }>
      await new Promise<void>((resolve) => waiters.push(resolve))
    }
  }
  let seq = 0
  function record(streamId: string, type: string, body: unknown): Record {
    seq++
    const envelope = canonicalJson({
      v: 1,
      minor: 0,
      id: newId('event'),
      stream: streamId,
      type,
      crit: false,
      author: { user: user.user, node: computer.node, keyEpoch: 1 },
      ts: Date.now(),
      body,
    })
    return { seq, envelope, signature: signBytes(envelope, computer.keys.signSecret) }
  }
  function batch(records: Record[]) {
    return {
      headers: records.map((entry) => ({ seq: entry.seq, epoch: 1, recvTs: entry.seq })),
      parts: records.flatMap((entry) => [entry.envelope, entry.signature]),
      lengths: records.flatMap((entry) => [entry.envelope.length, 64]),
    }
  }
  return {
    mux,
    send,
    next,
    record,
    get seq() {
      return seq
    },
    async handshake() {
      await next('hello')
      await send({
        t: 'hello',
        protoMajor: 1,
        protoMinor: 0,
        caps: ['streams.v1', 'blobs.v1', 'rpc.v1', 'presence.v1'],
        node: computer.node,
        delegation: computer.delegation,
        roster: signedRoster,
        now: Date.now(),
      })
      // The phone acknowledges what it shares with the computer; the computer echoes that set.
      const ack = await next('helloAck')
      await send({ t: 'helloAck', protoMinor: 0, caps: ack.caps, now: Date.now() })
    },
    async answer(method: string, result: unknown) {
      const request = await next('rpc.request')
      if (request.method !== method) throw new Error(`Expected ${method}, got ${request.method}`)
      await send({ t: 'rpc.result', id: request.id, result })
      return request
    },
    async snapshotChunk(streamId: string, records: Record[]) {
      const { headers, parts, lengths } = batch(records)
      await send({ t: 'snapshot.chunk', stream: streamId, epoch: 1, throughSeq: seq, records: headers, done: true, parts: lengths }, parts)
    },
    async delta(streamId: string, data: unknown) {
      await send({ t: 'ephemeral', stream: streamId, kind: 'delta', data })
    },
    async presence(streamId: string) {
      await send({ t: 'presence', stream: streamId } as WireMessage)
    },
    async events(streamId: string, records: Record[]) {
      const { headers, parts, lengths } = batch(records)
      await send({ t: 'events', stream: streamId, records: headers, replay: false, parts: lengths }, parts)
    },
  }
}

/** The desktop's snapshot records for one thread's JSON snapshot (one chunk). */
export function snapshotBodies(threadId: string, snapshot: unknown): Array<{ type: string; body: unknown }> {
  const bytes = utf8(JSON.stringify(snapshot))
  const id = crypto.randomUUID()
  const hash = b64url(sha256(bytes))
  return [
    { type: 'thread.snapshot.begin', body: { threadId, snapshot: id, totalBytes: bytes.length, chunks: 1, sha256: hash } },
    { type: 'thread.snapshot.chunk', body: { threadId, snapshot: id, index: 0, data: b64url(bytes) } },
    { type: 'thread.snapshot.end', body: { threadId, snapshot: id, sha256: hash } },
  ]
}

export function message(id: string, role: 'user' | 'assistant' | 'system', content: string, at = 1_000, extra: object = {}) {
  return { id, role, content, timestamp: new Date(at).toISOString(), ...extra }
}
