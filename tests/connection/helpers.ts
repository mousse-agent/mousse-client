// A scripted computer at the far end of a LeafSession, and signed thread-stream records.
import { appletSourceHash, validateAppletSubmission } from '../../src/connection/applets'
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
  let epoch = 1
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
      headers: records.map((entry) => ({ seq: entry.seq, epoch, recvTs: entry.seq })),
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
    get epoch() {
      return epoch
    },
    /** Moves the stream to a position: a later epoch is a new generation, as after a desktop restart. */
    position(nextEpoch: number, nextSeq: number) {
      epoch = nextEpoch
      seq = nextSeq
    },
    /** Whether the phone sent a message of this type that no test has taken yet. */
    has(t: WireMessage['t']) {
      return inbox.some((message) => message.t === t)
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
    async snapshotChunk(streamId: string, records: Record[], done = true) {
      const { headers, parts, lengths } = batch(records)
      await send({ t: 'snapshot.chunk', stream: streamId, epoch, throughSeq: seq, records: headers, done, parts: lengths }, parts)
    },
    async delta(streamId: string, data: unknown) {
      await send({ t: 'ephemeral', stream: streamId, kind: 'delta', data })
    },
    async presence(streamId: string) {
      await send({ t: 'presence', stream: streamId } as WireMessage)
    },
    async events(streamId: string, records: Record[], replay = false) {
      const { headers, parts, lengths } = batch(records)
      await send({ t: 'events', stream: streamId, records: headers, replay, parts: lengths }, parts)
    },
    async snapshotRequired(streamId: string, reason: string) {
      await send({ t: 'snapshotRequired', stream: streamId, reason, head: { epoch, seq } } as WireMessage)
    },
  }
}

/** The desktop's snapshot records for one thread's JSON snapshot, in 32 KiB chunks like the desktop's. */
export function snapshotBodies(threadId: string, snapshot: unknown): Array<{ type: string; body: unknown }> {
  const bytes = utf8(JSON.stringify(snapshot))
  const id = crypto.randomUUID()
  const hash = b64url(sha256(bytes))
  const size = 32 * 1024
  const chunks = Math.ceil(bytes.length / size)
  return [
    { type: 'thread.snapshot.begin', body: { threadId, snapshot: id, totalBytes: bytes.length, chunks, sha256: hash } },
    ...Array.from({ length: chunks }, (_, index) => ({
      type: 'thread.snapshot.chunk',
      body: { threadId, snapshot: id, index, data: b64url(bytes.subarray(index * size, (index + 1) * size)) },
    })),
    { type: 'thread.snapshot.end', body: { threadId, snapshot: id, sha256: hash } },
  ]
}

/** A reply carrying an in-response applet the way the desktop stores it: the fence in the text, plus its presentation parts. */
export function appletReply(id: string, at: number, htmlBytes = 96 * 1024) {
  const source = {
    schemaVersion: 1,
    title: 'Budget',
    description: 'Adjust monthly income.',
    html: `<main><label>Income <input id="income" type="range" min="0" max="10000" value="4000"></label><output id="total"></output></main><!-- ${'x'.repeat(htmlBytes)} -->`,
    css: 'main{max-width:100%;padding:16px}input{width:100%}',
    js: "const input=document.getElementById('income'),out=document.getElementById('total');function update(){out.textContent='$'+input.value;window.mousseApplet.saveState({income:input.value})}if(window.mousseApplet.state)input.value=window.mousseApplet.state.income;input.addEventListener('input',update);update();",
  }
  const content = `Here is a budget tool.\n\n\`\`\`mousse-applet\n${JSON.stringify(source)}\n\`\`\`\n\nMove the slider.`
  return message(id, 'assistant', content, at, {
    presentationParts: [
      { type: 'text', text: 'Here is a budget tool.\n\n' },
      { type: 'applet', reference: { appletId: 'applet_1', revisionId: 'rev_1', sourceHash: appletSourceHash(validateAppletSubmission(source)), title: source.title, description: source.description } },
      { type: 'text', text: '\n\nMove the slider.' },
    ],
  })
}

export function message(id: string, role: 'user' | 'assistant' | 'system', content: string, at = 1_000, extra: object = {}) {
  return { id, role, content, timestamp: new Date(at).toISOString(), ...extra }
}
