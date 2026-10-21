// The phone's side of a Net session with one of the user's computers, over an established TLS
// channel. Mirrors the desktop `sync/session.ts` handshake (hello, helloAck), liveness (ping),
// roster updates, RPC and stream subscriptions. The phone never serves streams or RPC.
import { fromB64url, fromUtf8 } from './bytes'
import type { MuxMessage, RecordHeader, StreamHead, WireMessage } from './codec'
export type { StreamHead } from './codec'
import { verifyBytes, type Signed } from './crypto'
import { fromWireError, NetError } from './errors'
import {
  currentNode,
  NET_PROTO_MAJOR,
  NET_PROTO_MINOR,
  rosterPosition,
  sameKeys,
  verifyDelegation,
  verifyRoster,
  verifyRoutes,
  type NodeDelegation,
  type Roster,
} from './identity'
import { StreamMux } from './mux'
import { newId } from './canonical'
import type { SecureChannel } from './tls13/client'
import { b64url } from './bytes'

// presence.v1 lets the computer send ephemeral messages: live reply deltas and pending questions.
export const SESSION_CAPS = ['streams.v1', 'rpc.v1', 'presence.v1'] as const
export const SESSION_PING_INTERVAL_MS = 20_000
export const PREAUTH_DEADLINE_MS = 10_000
export const PREAUTH_MAX_BYTES = 16 * 1024
export const MAX_INFLIGHT_RPCS = 64
export const MAX_SUBSCRIPTIONS = 256

export interface LeafIdentity {
  user: string
  rootKey: string
  node: string
  /** Latest roster held for the user. */
  roster: Signed
  /** This phone's delegation (the newest one held). */
  delegation: Signed
}

export interface SessionOptions {
  identity: LeafIdentity
  /** The computer this session must reach. */
  peerNode: string
  /** Persist a newer roster; the session already adopted it. */
  onRoster?: (roster: Signed) => void
  now?: () => number
  pingIntervalMs?: number
  preauthDeadlineMs?: number
}

/** A verified stream record: the exact signed envelope bytes and their parsed form. */
export interface StreamRecord {
  seq: number
  epoch: number
  recvTs: number
  bytes: Uint8Array
  envelope: Envelope
}

export interface Envelope {
  v: number
  minor: number
  id: string
  stream: string
  type: string
  crit: boolean
  author: { user: string; node: string; keyEpoch: number }
  ts: number
  body: unknown
}

export interface SubscriptionHandlers {
  subscribed?(head: StreamHead): void
  records(records: StreamRecord[], replay: boolean): void
  caughtUp?(): void
  snapshotRequired?(reason: string, head: StreamHead): void
  /** The subscription ended: an error from the computer, or the session closed. */
  ended?(error: Error): void
  /** An unsigned, never-stored `delta` the computer sent over this authenticated session for the stream. */
  delta?(data: unknown): void
}

export interface RpcOptions {
  idem?: string
  deadlineMs?: number
  signal?: AbortSignal
  onProgress?: (data: unknown) => void
  /** Reuse an id, for example to collect a result after reconnecting. */
  id?: string
}

/** A complete stream snapshot: every retained record through `target`. */
export interface StreamSnapshot {
  target: StreamHead
  records: StreamRecord[]
}

type PendingSnapshot = {
  promise: Promise<StreamSnapshot>
  resolve(value: StreamSnapshot): void
  reject(error: Error): void
  target?: StreamHead
  records: StreamRecord[]
  timer: ReturnType<typeof setTimeout>
}

export const SNAPSHOT_DEADLINE_MS = 60_000
const SNAPSHOT_MAX_RECORDS = 4096

type Pending = {
  resolve(value: unknown): void
  reject(error: Error): void
  progress?(data: unknown): void
  timer: ReturnType<typeof setTimeout>
}

export type LeafSessionState = 'connecting' | 'open' | 'closed'

export class LeafSession {
  private readonly mux: StreamMux
  private readonly now: () => number
  private stateValue: LeafSessionState = 'connecting'
  private helloReceived = false
  private ackSent = false
  private ackReceived = false
  private negotiatedCaps: string[] = []
  private negotiatedMinor = NET_PROTO_MINOR
  private preauthBytes = 0
  private roster: Roster
  private rosterSigned: Signed
  private peerDelegation?: NodeDelegation
  private readonly pending = new Map<string, Pending>()
  private readonly subscriptions = new Map<string, SubscriptionHandlers>()
  private readonly snapshots = new Map<string, PendingSnapshot>()
  private readonly closeListeners = new Set<(error?: Error) => void>()
  private readonly stateListeners = new Set<(state: LeafSessionState) => void>()
  private handshakeTimer?: ReturnType<typeof setTimeout>
  private pingTimer?: ReturnType<typeof setTimeout>
  private expiryTimer?: ReturnType<typeof setTimeout>
  private unanswered = 0
  private pingNumber = 0
  private closeError?: Error
  readonly opened: Promise<void>
  private openResolve!: () => void
  private openReject!: (error: Error) => void

  constructor(
    private readonly channel: SecureChannel,
    private readonly options: SessionOptions,
  ) {
    this.now = options.now ?? Date.now
    this.rosterSigned = options.identity.roster
    this.roster = verifyRoster(options.identity.roster, options.identity.rootKey)
    if (this.roster.owner !== options.identity.user) throw new NetError('bad_delegation', 'Roster owner differs.')
    this.opened = new Promise((resolve, reject) => {
      this.openResolve = resolve
      this.openReject = reject
    })
    this.opened.catch(() => {})
    this.mux = new StreamMux(channel, {
      onBytesReceived: (count) => {
        if (this.stateValue !== 'connecting') return
        this.preauthBytes += count
        if (this.preauthBytes > PREAUTH_MAX_BYTES) throw new NetError('too_large', 'Handshake exceeds 16 KiB.')
      },
    })
    this.mux.onMessage((_lane, message) => {
      try {
        this.receive(message)
      } catch (error) {
        this.fail(error instanceof Error ? error : new NetError('bad_request'))
      }
    })
    this.mux.onClose((error) => this.fail(error ?? new NetError('route_unreachable', 'The computer closed the session.')))
    this.handshakeTimer = setTimeout(
      () => this.fail(new NetError('deadline_exceeded', 'The computer did not finish the handshake.')),
      options.preauthDeadlineMs ?? PREAUTH_DEADLINE_MS,
    )
    void this.send({
      t: 'hello',
      protoMajor: NET_PROTO_MAJOR,
      protoMinor: NET_PROTO_MINOR,
      caps: [...SESSION_CAPS],
      node: options.identity.node,
      delegation: this.ownDelegation(),
      roster: this.rosterSigned,
      now: this.now(),
    }).catch((error) => this.fail(error))
  }

  get state(): LeafSessionState {
    return this.stateValue
  }

  /** The error the session closed with, once it is closed. */
  get closeReason(): Error | undefined {
    return this.stateValue === 'closed' ? this.closeError : undefined
  }

  /** The computer's current delegation from the roster (name, caps). */
  get peer(): NodeDelegation | undefined {
    return this.peerDelegation
  }

  get caps(): readonly string[] {
    return this.negotiatedCaps
  }

  onStateChange(listener: (state: LeafSessionState) => void): () => void {
    this.stateListeners.add(listener)
    return () => this.stateListeners.delete(listener)
  }

  onClose(listener: (error?: Error) => void): () => void {
    this.closeListeners.add(listener)
    if (this.stateValue === 'closed') queueMicrotask(() => listener(this.closeError))
    return () => this.closeListeners.delete(listener)
  }

  rpc(method: string, params: unknown, options: RpcOptions = {}): Promise<unknown> {
    if (this.stateValue !== 'open') return Promise.reject(this.closedError())
    if (!this.negotiatedCaps.includes('rpc.v1')) return Promise.reject(new NetError('forbidden', 'RPC was not negotiated.'))
    if (this.pending.size >= MAX_INFLIGHT_RPCS) return Promise.reject(new NetError('rate_limited', 'Too many requests in flight.'))
    const id = options.id ?? newId('rpc')
    const deadlineMs = options.deadlineMs ?? 30_000
    if (this.pending.has(id)) return Promise.reject(new NetError('conflict', 'Request id in use.'))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new NetError('deadline_exceeded', `${method} timed out.`))
      }, deadlineMs + 2_000)
      this.pending.set(id, { resolve, reject, progress: options.onProgress, timer })
      const abort = () => {
        if (!this.pending.has(id)) return
        clearTimeout(timer)
        this.pending.delete(id)
        void this.send({ t: 'rpc.cancel', id }).catch(() => {})
        reject(new NetError('cancelled'))
      }
      options.signal?.addEventListener('abort', abort, { once: true })
      void this.send({
        t: 'rpc.request',
        id,
        method,
        params,
        ...(options.idem === undefined ? {} : { idem: options.idem }),
        deadlineMs,
      }).catch((error) => {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error)
      })
    })
  }

  /** Subscribes to a stream after `after`; returns an unsubscribe. */
  subscribe(stream: string, after: StreamHead, handlers: SubscriptionHandlers): () => void {
    if (this.stateValue !== 'open') throw this.closedError()
    if (!this.negotiatedCaps.includes('streams.v1')) throw new NetError('forbidden', 'Streams were not negotiated.')
    if (this.subscriptions.has(stream)) throw new NetError('conflict', 'Already subscribed.')
    if (this.subscriptions.size >= MAX_SUBSCRIPTIONS) throw new NetError('rate_limited', 'Too many subscriptions.')
    this.subscriptions.set(stream, handlers)
    void this.send({ t: 'subscribe', stream, after }).catch((error) => this.fail(error))
    return () => {
      if (this.subscriptions.get(stream) !== handlers) return
      this.subscriptions.delete(stream)
      if (this.stateValue === 'open') void this.send({ t: 'unsubscribe', stream }).catch(() => {})
    }
  }

  /**
   * Reads a stream's current snapshot (`snapshot.get`). The records are verified like live ones;
   * subscribe after `target` to follow the stream from there. Concurrent calls share one transfer.
   */
  snapshot(stream: string): Promise<StreamSnapshot> {
    if (this.stateValue !== 'open') return Promise.reject(this.closedError())
    if (!this.negotiatedCaps.includes('streams.v1')) return Promise.reject(new NetError('forbidden', 'Streams were not negotiated.'))
    const existing = this.snapshots.get(stream)
    if (existing) return existing.promise
    let resolve!: (value: StreamSnapshot) => void
    let reject!: (error: Error) => void
    const promise = new Promise<StreamSnapshot>((res, rej) => {
      resolve = res
      reject = rej
    })
    const timer = setTimeout(() => {
      this.settleSnapshot(stream, undefined, new NetError('deadline_exceeded', 'The computer did not send the thread in time.'))
    }, SNAPSHOT_DEADLINE_MS)
    this.snapshots.set(stream, { promise, resolve, reject, records: [], timer })
    void this.send({ t: 'snapshot.get', stream }).catch((error) => this.settleSnapshot(stream, undefined, error))
    return promise
  }

  close(error?: Error): void {
    this.fail(error ?? new NetError('cancelled', 'Session closed.'))
  }

  private closedError(): Error {
    return this.closeError ?? new NetError('route_unreachable', 'The session is not open.')
  }

  private send(header: WireMessage, parts: Uint8Array[] = []): Promise<void> {
    return this.mux.send({ header, parts })
  }

  private ownDelegation(): Signed {
    const { identity } = this.options
    try {
      const current = currentNode(this.roster, identity.node, this.now())
      return current.signed
    } catch {
      return identity.delegation
    }
  }

  private receive(message: MuxMessage): void {
    const h = message.header
    if (this.stateValue === 'closed') return
    if (this.stateValue === 'connecting') {
      if (h.t === 'hello') return this.hello(h)
      if (h.t === 'helloAck') return this.helloAck(h)
      if (h.t === 'goAway') throw fromWireError(h.error)
      throw new NetError('forbidden', 'Traffic before authentication.')
    }
    switch (h.t) {
      case 'hello':
      case 'helloAck':
        throw new NetError('bad_request', 'Repeated handshake.')
      case 'goAway':
        throw fromWireError(h.error)
      case 'error': {
        if (!h.re) return
        const sub = this.subscriptions.get(h.re)
        if (sub) {
          this.subscriptions.delete(h.re)
          sub.ended?.(fromWireError(h.error))
        }
        this.settleSnapshot(h.re, undefined, fromWireError(h.error))
        this.finish(h.re, undefined, fromWireError(h.error))
        return
      }
      case 'ping':
        void this.send({ t: 'pong', n: h.n, now: this.now() }).catch((error) => this.fail(error))
        return
      case 'pong':
        if (h.n === this.pingNumber) this.unanswered = 0
        return
      case 'rosterUpdate':
        this.adoptRoster(h.roster)
        this.revalidate()
        return
      case 'revoked':
        return
      case 'subscribed': {
        const sub = this.subscriptions.get(h.stream)
        sub?.subscribed?.(h.head)
        return
      }
      case 'events': {
        const sub = this.subscriptions.get(h.stream)
        if (!sub) return
        sub.records(this.records(h.stream, h.records, message.parts), h.replay)
        return
      }
      case 'caughtUp':
        this.subscriptions.get(h.stream)?.caughtUp?.()
        return
      case 'snapshotRequired': {
        const sub = this.subscriptions.get(h.stream)
        if (!sub) return
        this.subscriptions.delete(h.stream)
        sub.snapshotRequired?.(h.reason, h.head)
        return
      }
      case 'rpc.progress':
        this.pending.get(h.id)?.progress?.(h.data)
        return
      case 'rpc.result':
        if (h.error) this.finish(h.id, undefined, fromWireError(h.error))
        else this.finish(h.id, h.result)
        return
      case 'snapshot.chunk':
        return this.snapshotChunk(h, message.parts)
      case 'ephemeral':
        if (h.kind === 'delta') this.subscriptions.get(h.stream)?.delta?.(h.data)
        return
      case 'presence':
        return
      default:
        throw new NetError('forbidden', `Unexpected ${h.t} from the computer.`)
    }
  }

  private snapshotChunk(h: Extract<WireMessage, { t: 'snapshot.chunk' }>, parts: Uint8Array[]): void {
    const pending = this.snapshots.get(h.stream)
    if (!pending) return
    const target = { epoch: h.epoch, seq: h.throughSeq }
    if (pending.target && (pending.target.epoch !== target.epoch || pending.target.seq !== target.seq))
      throw new NetError('bad_request', 'Snapshot target changed mid-transfer.')
    pending.target = target
    const records = this.records(h.stream, h.records, parts)
    for (const record of records)
      if (record.epoch > target.epoch || (record.epoch === target.epoch && record.seq > target.seq))
        throw new NetError('bad_request', 'Snapshot record exceeds its declared position.')
    const last = pending.records.at(-1)
    if (last && records[0] && (records[0].epoch !== last.epoch || records[0].seq !== last.seq + 1))
      throw new NetError('bad_request', 'Snapshot chunks are not contiguous.')
    pending.records.push(...records)
    if (pending.records.length > SNAPSHOT_MAX_RECORDS) throw new NetError('too_large', 'Snapshot is too large.')
    if (h.done) this.settleSnapshot(h.stream, { target, records: pending.records })
  }

  private settleSnapshot(stream: string, value?: StreamSnapshot, error?: Error): void {
    const pending = this.snapshots.get(stream)
    if (!pending) return
    this.snapshots.delete(stream)
    clearTimeout(pending.timer)
    if (value) pending.resolve(value)
    else pending.reject(error ?? new NetError('cancelled'))
  }

  private finish(id: string, value: unknown, error?: Error): void {
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    clearTimeout(pending.timer)
    if (error) pending.reject(error)
    else pending.resolve(value)
  }

  /** Verifies each record's Ed25519 signature with its author's delegated node key. */
  private records(stream: string, headers: RecordHeader[], parts: Uint8Array[]): StreamRecord[] {
    return headers.map((header, index) => {
      const bytes = parts[index * 2]
      const sig = parts[index * 2 + 1]
      let envelope: Envelope
      try {
        envelope = JSON.parse(fromUtf8(bytes)) as Envelope
      } catch {
        throw new NetError('bad_request', 'Unreadable stream envelope.')
      }
      if (!envelope || envelope.stream !== stream || !envelope.author || envelope.author.user !== this.options.identity.user)
        throw new NetError('bad_signature', 'Envelope does not belong to this stream.')
      const key = this.authorKey(envelope.author.node, envelope.author.keyEpoch)
      if (!verifyBytes(bytes, sig, fromB64url(key, 32))) throw new NetError('bad_signature', 'Invalid envelope signature.')
      return { seq: header.seq, epoch: header.epoch, recvTs: header.recvTs, bytes, envelope }
    })
  }

  private authorKey(node: string, keyEpoch: number): string {
    if (this.peerDelegation?.subject === node && this.peerDelegation.keyEpoch === keyEpoch) return this.peerDelegation.keys.sign
    for (const signed of this.roster.nodes) {
      const delegation = verifyDelegation(signed, this.roster.rootKey)
      if (delegation.subject === node && delegation.keyEpoch === keyEpoch && delegation.owner === this.roster.owner)
        return delegation.keys.sign
    }
    throw new NetError('bad_delegation', 'Unknown event author.')
  }

  /** Adopts a newer roster of the user; older or equal ones are ignored. */
  private adoptRoster(signed: Signed): void {
    const { identity } = this.options
    const incoming = verifyRoster(signed, identity.rootKey)
    if (incoming.owner !== identity.user) throw new NetError('bad_delegation', 'Roster of another user.')
    if (incoming.recoveryEpoch === this.roster.recoveryEpoch && incoming.lineage !== this.roster.lineage)
      throw new NetError('roster_conflict', 'Conflicting roster lineage.')
    if (rosterPosition(incoming, this.roster) <= 0) return
    this.roster = incoming
    this.rosterSigned = signed
    this.options.onRoster?.(signed)
  }

  private hello(h: Extract<WireMessage, { t: 'hello' }>): void {
    if (this.helloReceived) throw new NetError('bad_request', 'Repeated hello.')
    if (h.protoMajor !== NET_PROTO_MAJOR) throw new NetError('incompatible_peer', 'Unsupported protocol version.')
    if (!h.roster || !h.delegation) throw new NetError('not_enrolled', 'The computer is not enrolled.')
    if (h.node !== this.options.peerNode) throw new NetError('peer_key_mismatch', 'Reached a different computer.')
    const { identity } = this.options
    const delegation = verifyDelegation(h.delegation, identity.rootKey)
    if (delegation.owner !== identity.user) throw new NetError('bad_delegation', 'The computer belongs to another user.')
    if (delegation.subject !== h.node || delegation.keys.transport !== b64url(this.channel.peerSpki))
      throw new NetError('peer_key_mismatch', 'Transport key does not match the delegation.')
    const now = this.now()
    if (delegation.issuedAt > now || delegation.expiresAt <= now) throw new NetError('bad_delegation', 'Expired delegation.')
    this.adoptRoster(h.roster)
    const current = currentNode(this.roster, delegation.subject, now).delegation
    if (current.keyEpoch !== delegation.keyEpoch || !sameKeys(current.keys, delegation.keys))
      throw new NetError('bad_delegation', 'Stale delegation.')
    if (h.routes) verifyRoutes(h.routes, delegation.keys.sign, h.node)
    this.peerDelegation = current
    this.negotiatedCaps = SESSION_CAPS.filter((cap) => h.caps.includes(cap))
    if (!this.negotiatedCaps.includes('streams.v1')) throw new NetError('incompatible_peer', 'Streams are not supported.')
    this.negotiatedMinor = Math.min(NET_PROTO_MINOR, h.protoMinor)
    this.helloReceived = true
    void this.send({ t: 'helloAck', protoMinor: this.negotiatedMinor, caps: this.negotiatedCaps, now: this.now() })
      .then(() => {
        this.ackSent = true
        this.tryOpen()
      })
      .catch((error) => this.fail(error))
  }

  private helloAck(h: Extract<WireMessage, { t: 'helloAck' }>): void {
    if (
      !this.helloReceived ||
      this.ackReceived ||
      h.protoMinor !== this.negotiatedMinor ||
      h.caps.length !== this.negotiatedCaps.length ||
      h.caps.some((cap) => !this.negotiatedCaps.includes(cap))
    )
      throw new NetError('incompatible_peer', 'Handshake acknowledgement differs.')
    this.ackReceived = true
    this.tryOpen()
  }

  private tryOpen(): void {
    if (!this.helloReceived || !this.ackReceived || !this.ackSent || this.stateValue !== 'connecting') return
    clearTimeout(this.handshakeTimer)
    this.setState('open')
    this.revalidate()
    this.schedulePing()
    this.openResolve()
  }

  /** Re-checks both delegations against the held roster and arms the expiry timer. */
  private revalidate(): void {
    if (this.stateValue !== 'open') return
    const now = this.now()
    const peer = currentNode(this.roster, this.options.peerNode, now).delegation
    if (this.peerDelegation && (peer.keyEpoch !== this.peerDelegation.keyEpoch || !sameKeys(peer.keys, this.peerDelegation.keys)))
      throw new NetError('bad_delegation', 'The computer was re-keyed.')
    const own = currentNode(this.roster, this.options.identity.node, now).delegation
    this.peerDelegation = peer
    clearTimeout(this.expiryTimer)
    this.expiryTimer = setTimeout(
      () => this.fail(new NetError('bad_delegation', 'The delegation expired.')),
      Math.max(0, Math.min(peer.expiresAt, own.expiresAt) - now),
    )
  }

  private schedulePing(): void {
    this.pingTimer = setTimeout(() => {
      if (this.stateValue !== 'open') return
      if (this.unanswered >= 3) {
        this.fail(new NetError('peer_offline', 'The computer stopped answering.'))
        return
      }
      this.unanswered++
      this.pingNumber++
      void this.send({ t: 'ping', n: this.pingNumber, now: this.now() }).catch((error) => this.fail(error))
      this.schedulePing()
    }, this.options.pingIntervalMs ?? SESSION_PING_INTERVAL_MS)
  }

  private setState(state: LeafSessionState): void {
    this.stateValue = state
    for (const listener of this.stateListeners) listener(state)
  }

  private fail(error: Error): void {
    if (this.stateValue === 'closed') return
    this.closeError = error
    clearTimeout(this.handshakeTimer)
    clearTimeout(this.pingTimer)
    clearTimeout(this.expiryTimer)
    this.setState('closed')
    this.openReject(error)
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(error)
      this.pending.delete(id)
    }
    for (const [stream, sub] of this.subscriptions) {
      this.subscriptions.delete(stream)
      sub.ended?.(error)
    }
    for (const stream of [...this.snapshots.keys()]) this.settleSnapshot(stream, undefined, error)
    this.mux.close(error)
    for (const listener of this.closeListeners) listener(error)
  }
}
