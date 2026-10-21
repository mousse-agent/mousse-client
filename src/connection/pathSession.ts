// One computer session that moves between network paths without the screens noticing. It starts on
// the Mousse ID relay. When the computer reports direct endpoints (its private LAN or Tailscale
// addresses) and one of them answers faster than the relay, a full second session opens there and
// streams and new requests move onto it; the relay session closes once its requests in flight
// finish. When the direct path stops answering, the session falls back to the relay. Callers see
// one open session the whole time and never learn which path carries it.
import { newId } from '../net/canonical'
import { parseDirectEndpoints, type DirectEndpoint } from '../net/direct'
import { NetError } from '../net/errors'
import type {
  LeafSession,
  LeafSessionState,
  RpcOptions,
  SessionLink,
  StreamHead,
  StreamRecord,
  StreamSnapshot,
  SubscriptionHandlers,
} from '../net/session'
import { deviceNetworkSignals, type NetworkSignals } from './networkSignals'

/** The computer's RPC that lists its direct endpoints for a phone that came through Mousse ID. */
export const ENDPOINTS_METHOD = 'net.direct.endpoints'
/** How often a session on the relay tries the direct path again. */
export const PROBE_INTERVAL_MS = 30_000
/** How long one attempt to open a direct session may take. */
export const DIRECT_OPEN_TIMEOUT_MS = 3_000
/** How long a direct path may take to answer a ping after the network changed. */
export const LIVENESS_TIMEOUT_MS = 2_500
/** The relay crosses the internet and may sit on a slow mobile network; it gets longer. */
export const RELAY_LIVENESS_TIMEOUT_MS = 6_000
/** Ping interval on a direct path, so a silent drop is noticed within a few seconds. */
export const DIRECT_PING_INTERVAL_MS = 5_000
const NETWORK_SETTLE_MS = 300
const MAX_ATTEMPTS = 3

export type PathKind = 'relay' | 'direct'

export interface PathOpeners {
  /** Opens a session over the Mousse ID relay; resolves once it is open. */
  relay(): Promise<LeafSession>
  /** Opens a session on one direct endpoint; resolves once it is open. */
  direct(endpoint: DirectEndpoint, signal: AbortSignal): Promise<LeafSession>
}

export interface PathSessionOptions {
  /** The session that is already open, on the relay. */
  first: LeafSession
  open: PathOpeners
  network?: NetworkSignals
  probeIntervalMs?: number
  directTimeoutMs?: number
  livenessTimeoutMs?: number
  /** How long to let the network settle after a change before checking the path. */
  settleMs?: number
  /** Tests start probing by hand. */
  autoProbe?: boolean
}

interface Path {
  kind: PathKind
  leaf: LeafSession
  /** RPCs and snapshot transfers still running on this path. */
  busy: number
  /** Closed on purpose (drained or replaced); its close is not a loss. */
  retired: boolean
}

interface Subscription {
  stream: string
  handlers: SubscriptionHandlers
  /** The last record position delivered to the caller. */
  head: StreamHead
  attached: Map<Path, () => void>
  subscribedSent: boolean
}

/** Codes that only say the path is gone, not that the computer refused this phone. */
const PATH_LOST = new Set(['route_unreachable', 'peer_offline', 'deadline_exceeded', 'unavailable', 'too_large', 'bad_request'])

const after = (record: StreamRecord, head: StreamHead) => record.epoch > head.epoch || (record.epoch === head.epoch && record.seq > head.seq)

const codeOf = (error: unknown) => (error instanceof NetError ? error.code : undefined)

export class PathSession implements SessionLink {
  private active: Path
  private readonly draining = new Set<Path>()
  private readonly subscriptions = new Map<string, Subscription>()
  private readonly stateListeners = new Set<(state: LeafSessionState) => void>()
  private readonly closeListeners = new Set<(error?: Error) => void>()
  private stateValue: LeafSessionState = 'open'
  private closeError?: Error
  private recovering?: Promise<void>
  private upgrading = false
  private endpoints: DirectEndpoint[] = []
  /** False once the computer says it has no endpoints method (an older desktop). */
  private directSupported = true
  private probeTimer?: ReturnType<typeof setTimeout>
  private settleTimer?: ReturnType<typeof setTimeout>
  private readonly offNetwork: () => void

  constructor(private readonly options: PathSessionOptions) {
    this.active = this.track('relay', options.first)
    this.offNetwork = (options.network ?? deviceNetworkSignals).onChange(() => this.networkChanged())
    if (options.autoProbe !== false) this.probeSoon(0)
  }

  /** Which path carries the session now; for tests and diagnostics only, never shown. */
  get path(): PathKind {
    return this.active.kind
  }

  get state(): LeafSessionState {
    return this.stateValue
  }

  get closeReason(): Error | undefined {
    return this.stateValue === 'closed' ? this.closeError : undefined
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

  /**
   * Sends on the current path. When that path is lost mid-request the request is sent again on
   * the next one: mutations with their idempotency key and id, so the computer runs them once and
   * returns the first result; reads with a fresh id.
   */
  async rpc(method: string, params: unknown, options: RpcOptions = {}): Promise<unknown> {
    let id = options.id ?? newId('rpc')
    let lost: Error | undefined
    for (let attempt = 1; ; attempt++) {
      const path = await this.current()
      path.busy++
      try {
        return await path.leaf.rpc(method, params, { ...options, id })
      } catch (error) {
        if (!this.lostWith(path, error) || attempt >= MAX_ATTEMPTS || options.signal?.aborted) {
          // A retried mutation the computer could not confirm keeps the error the path ended with.
          if (lost && codeOf(error) === 'outcome_uncertain') throw lost
          throw error
        }
        lost ??= error as Error
        if (options.idem === undefined) id = newId('rpc')
      } finally {
        path.busy--
        this.retireIfIdle(path)
      }
    }
  }

  async snapshot(stream: string): Promise<StreamSnapshot> {
    for (let attempt = 1; ; attempt++) {
      const path = await this.current()
      path.busy++
      try {
        return await path.leaf.snapshot(stream)
      } catch (error) {
        if (!this.lostWith(path, error) || attempt >= MAX_ATTEMPTS) throw error
      } finally {
        path.busy--
        this.retireIfIdle(path)
      }
    }
  }

  subscribe(stream: string, from: StreamHead, handlers: SubscriptionHandlers): () => void {
    if (this.stateValue !== 'open') throw this.closedError()
    if (this.subscriptions.has(stream)) throw new NetError('conflict', 'Already subscribed.')
    const sub: Subscription = { stream, handlers, head: { epoch: from.epoch, seq: from.seq }, attached: new Map(), subscribedSent: false }
    this.subscriptions.set(stream, sub)
    if (!this.recovering) this.attach(sub, this.active, true)
    return () => {
      if (this.subscriptions.get(stream) !== sub) return
      this.subscriptions.delete(stream)
      this.detachAll(sub)
    }
  }

  close(error?: Error): void {
    this.fail(error ?? new NetError('cancelled', 'Session closed.'))
  }

  /** Looks for a direct path now; resolves when the attempt is over. */
  async probe(): Promise<void> {
    if (this.stateValue !== 'open' || this.recovering || this.upgrading || this.active.kind === 'direct' || !this.directSupported) return
    this.upgrading = true
    clearTimeout(this.probeTimer)
    try {
      const relay = this.active
      await this.discover(relay)
      if (!this.endpoints.length) return
      const next = await this.openDirect()
      if (!next) return
      if (this.stateValue !== 'open' || this.recovering || this.active !== relay) return this.retire(next)
      // Move only when the direct path is quicker: a Tailscale path through a distant relay may not be.
      const [direct, relayed] = await Promise.all([this.roundTrip(next.leaf), this.roundTrip(relay.leaf)])
      if (direct === undefined || (relayed !== undefined && direct >= relayed)) return this.retire(next)
      if (this.stateValue !== 'open' || this.recovering || this.active !== relay) return this.retire(next)
      this.adopt(next)
    } finally {
      this.upgrading = false
      this.probeSoon()
    }
  }

  /** Checks that the current path still answers; a silent one is replaced at once. */
  async checkPath(): Promise<void> {
    if (this.stateValue !== 'open' || this.recovering) return
    const path = this.active
    const direct = this.options.livenessTimeoutMs ?? LIVENESS_TIMEOUT_MS
    try {
      await path.leaf.probe(path.kind === 'direct' ? direct : Math.max(direct, RELAY_LIVENESS_TIMEOUT_MS))
    } catch (error) {
      if (path.leaf.state === 'open' && codeOf(error) === 'deadline_exceeded')
        path.leaf.close(new NetError('peer_offline', 'The computer stopped answering on this network.'))
    }
  }

  private networkChanged(): void {
    if (this.stateValue !== 'open') return
    clearTimeout(this.settleTimer)
    this.settleTimer = setTimeout(() => {
      void this.checkPath().then(() => this.probe())
    }, this.options.settleMs ?? NETWORK_SETTLE_MS)
  }

  private probeSoon(delay = this.options.probeIntervalMs ?? PROBE_INTERVAL_MS): void {
    clearTimeout(this.probeTimer)
    if (this.stateValue !== 'open' || this.options.autoProbe === false || this.active.kind === 'direct' || !this.directSupported) return
    this.probeTimer = setTimeout(() => void this.probe(), delay)
  }

  private async discover(path: Path): Promise<void> {
    path.busy++
    try {
      const endpoints = parseDirectEndpoints(await path.leaf.rpc(ENDPOINTS_METHOD, {}, { deadlineMs: 10_000 }))
      this.endpoints = endpoints
    } catch (error) {
      // A computer without the method refuses it; it never offers a direct path.
      if (codeOf(error) === 'forbidden') {
        this.directSupported = false
        this.endpoints = []
      }
    } finally {
      path.busy--
      this.retireIfIdle(path)
    }
  }

  /** Tries every endpoint at once; the first session to open wins and the rest are closed. */
  private async openDirect(): Promise<Path | undefined> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.options.directTimeoutMs ?? DIRECT_OPEN_TIMEOUT_MS)
    let winner: LeafSession | undefined
    const attempts = this.endpoints.map((endpoint) =>
      this.options.open.direct(endpoint, controller.signal).then(
        (leaf) => {
          if (winner || controller.signal.aborted) leaf.close()
          else {
            winner = leaf
            controller.abort()
          }
        },
        () => undefined,
      ),
    )
    await Promise.all(attempts)
    clearTimeout(timer)
    if (!winner) return undefined
    if (winner.state !== 'open') return undefined
    return this.track('direct', winner)
  }

  private async roundTrip(leaf: LeafSession): Promise<number | undefined> {
    try {
      return await leaf.probe(this.options.livenessTimeoutMs ?? LIVENESS_TIMEOUT_MS)
    } catch {
      return undefined
    }
  }

  private track(kind: PathKind, leaf: LeafSession): Path {
    const path: Path = { kind, leaf, busy: 0, retired: false }
    leaf.onClose((error) => this.lost(path, error))
    return path
  }

  /** Makes `next` the current path and moves every stream onto it from where it left off. */
  private adopt(next: Path): void {
    const old = this.active
    this.active = next
    for (const sub of this.subscriptions.values()) {
      sub.attached.get(old)?.()
      sub.attached.delete(old)
      this.attach(sub, next, false)
    }
    if (old !== next && !old.retired && old.leaf.state === 'open') {
      this.draining.add(old)
      this.retireIfIdle(old)
    }
    this.probeSoon()
  }

  private attach(sub: Subscription, path: Path, first: boolean): void {
    let off: () => void
    try {
      off = path.leaf.subscribe(sub.stream, sub.head, {
        subscribed: (head) => {
          if (path !== this.active || sub.subscribedSent) return
          sub.subscribedSent = true
          sub.handlers.subscribed?.(head)
        },
        records: (records, replay) => {
          if (this.subscriptions.get(sub.stream) !== sub) return
          // Records already delivered from another path are dropped, so nothing arrives twice.
          const fresh = records.filter((record) => after(record, sub.head))
          if (!fresh.length) return
          const last = fresh.at(-1)!
          sub.head = { epoch: last.epoch, seq: last.seq }
          sub.handlers.records(fresh, replay)
        },
        caughtUp: () => {
          if (path === this.active) sub.handlers.caughtUp?.()
        },
        snapshotRequired: (reason, head) => {
          sub.attached.delete(path)
          if (path !== this.active || this.subscriptions.get(sub.stream) !== sub) return
          this.subscriptions.delete(sub.stream)
          this.detachAll(sub)
          sub.handlers.snapshotRequired?.(reason, head)
        },
        ended: (error) => {
          sub.attached.delete(path)
          // A path that closed is replaced, and the stream moves with it.
          if (path.leaf.state === 'closed' || path !== this.active || this.subscriptions.get(sub.stream) !== sub) return
          this.subscriptions.delete(sub.stream)
          this.detachAll(sub)
          sub.handlers.ended?.(error)
        },
      })
    } catch (error) {
      // The path closed under us; recovery attaches the stream to the next one.
      if (path.leaf.state === 'closed') return
      this.subscriptions.delete(sub.stream)
      if (first) throw error
      sub.handlers.ended?.(error instanceof Error ? error : new NetError('bad_request'))
      return
    }
    sub.attached.set(path, off)
  }

  private detachAll(sub: Subscription): void {
    for (const off of sub.attached.values()) off()
    sub.attached.clear()
  }

  /** Waits for a replacement path when one is being opened. */
  private async current(): Promise<Path> {
    if (this.recovering) await this.recovering
    if (this.stateValue !== 'open') throw this.closedError()
    return this.active
  }

  /** The request failed because its path was lost, and another path can take it. */
  private lostWith(path: Path, error: unknown): boolean {
    return this.stateValue === 'open' && !path.retired && path.leaf.state === 'closed' && error === path.leaf.closeReason
  }

  private retireIfIdle(path: Path): void {
    if (!this.draining.has(path) || path.busy > 0) return
    this.draining.delete(path)
    this.retire(path)
  }

  private retire(path: Path): void {
    path.retired = true
    path.leaf.close()
  }

  private lost(path: Path, error?: Error): void {
    if (path.retired || this.stateValue !== 'open') return
    this.draining.delete(path)
    if (path !== this.active) return
    const reason = error ?? new NetError('route_unreachable', 'The computer closed the session.')
    if (!PATH_LOST.has(codeOf(reason) ?? '')) return this.fail(reason)
    this.recovering = this.recover(path, reason).finally(() => {
      this.recovering = undefined
    })
  }

  /**
   * Opens the next path after the current one was lost. After a relay loss a known direct endpoint
   * is tried alongside a new relay session and wins when it opens; after a direct loss the relay
   * takes over.
   */
  private async recover(dead: Path, reason: Error): Promise<void> {
    let next: Path | undefined
    let failure: unknown
    const relay = this.options.open.relay()
    relay.catch(() => undefined)
    if (dead.kind === 'relay' && this.endpoints.length) next = await this.openDirect().catch(() => undefined)
    if (next) void relay.then((leaf) => leaf.close(), () => undefined)
    else
      try {
        next = this.track('relay', await relay)
      } catch (error) {
        failure = error
      }
    if (this.stateValue !== 'open') {
      if (next) this.retire(next)
      return
    }
    if (!next) {
      // Both paths failed: close as before. A refusal says more than the lost path.
      const code = codeOf(failure)
      return this.fail(code && !PATH_LOST.has(code) && code !== 'cancelled' ? (failure as Error) : reason)
    }
    this.adopt(next)
  }

  private closedError(): Error {
    return this.closeError ?? new NetError('route_unreachable', 'The session is not open.')
  }

  private fail(error: Error): void {
    if (this.stateValue === 'closed') return
    this.closeError = error
    this.stateValue = 'closed'
    clearTimeout(this.probeTimer)
    clearTimeout(this.settleTimer)
    this.offNetwork()
    for (const listener of [...this.stateListeners]) listener('closed')
    const subscriptions = [...this.subscriptions.values()]
    this.subscriptions.clear()
    for (const path of [this.active, ...this.draining]) {
      path.retired = true
      path.leaf.close(error)
    }
    this.draining.clear()
    for (const sub of subscriptions) {
      sub.attached.clear()
      sub.handlers.ended?.(error)
    }
    for (const listener of [...this.closeListeners]) listener(error)
  }
}
