// One computer session that moves between network paths without the screens noticing. It starts on
// the Mousse ID relay, or directly on the phone's network when the computer advertises itself
// there (which needs no internet). From the relay it moves to the LAN as soon as the computer is
// seen there, or as soon as the computer names LAN addresses the phone can reach. When the computer reports that it takes WebRTC offers and a peer-to-peer path
// opens and answers faster than the relay, a full second session opens there and
// streams and new requests move onto it; the relay session closes once its requests in flight
// finish. When the direct path stops answering, the session falls back to the relay. Callers see
// one open session the whole time and never learn which path carries it.
import { MousseIdError } from '../mousseId/http'
import { newId } from '../net/canonical'
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
import { parseLanEndpoints, type LanHint } from '../net/lan'
import { parseDirectEndpoints, type DirectEndpoint } from '../net/webrtc'
import { deviceNetworkSignals, type NetworkSignals } from './networkSignals'

/** The computer's RPC that says which direct paths it takes, for a phone that came through Mousse ID. */
export const ENDPOINTS_METHOD = 'net.direct.endpoints'
/** How often a session on the relay tries the direct path again. */
export const PROBE_INTERVAL_MS = 30_000
/**
 * How long one attempt to open a direct session may take, per kind: gathering, the offer through
 * the relay, ICE, DTLS, the inner TLS and the session hello. With STUN, gathering waits for a
 * round trip to the STUN server and ICE has more pairs to check.
 */
export const DIRECT_OPEN_TIMEOUT_MS: Record<DirectEndpoint['kind'], { sameNetwork: number; stun: number }> = {
  webrtc: { sameNetwork: 8_000, stun: 10_000 },
}
/** How long a direct path may take to answer a ping after the network changed. */
export const LIVENESS_TIMEOUT_MS = 2_500
/** The relay crosses the internet and may sit on a slow mobile network; it gets longer. */
export const RELAY_LIVENESS_TIMEOUT_MS = 6_000
/** Ping interval on a direct path, so a silent drop is noticed within a few seconds. */
export const DIRECT_PING_INTERVAL_MS = 5_000
const NETWORK_SETTLE_MS = 300
const MAX_ATTEMPTS = 3
/**
 * Waits before each attempt to open the relay again after the current path dropped. The Mousse ID
 * relay restarts on every deploy and the computer then registers again, so the first attempts can
 * find it down or the computer not yet back; requests wait meanwhile.
 */
export const RELAY_RECOVERY_DELAYS_MS = [0, 1_000, 2_000, 4_000]
/** No new relay attempt starts this long after the path dropped; the session closes instead. */
export const RELAY_RECOVERY_WINDOW_MS = 12_000

export type PathKind = 'relay' | 'direct'

/** What a direct opener may use of the session it is opened from. */
export interface DirectLink {
  /** Sends a request (the offer) on the path the attempt started from. */
  rpc(method: string, params: unknown, options?: RpcOptions): Promise<unknown>
  /** The direct path may have stalled (ICE `disconnected`); checks the current path. */
  checkPath(): void
}

export interface PathOpeners {
  /** Opens a session over the Mousse ID relay; resolves once it is open. */
  relay(): Promise<LeafSession>
  /**
   * Opens a session to the computer on the phone's own network, without the internet; undefined
   * when the computer was not seen there. Tried before the relay whenever a path is needed.
   */
  lan?(): Promise<LeafSession | undefined>
  /**
   * Keeps the LAN addresses the computer reported in its endpoints answer, for `lan` to dial;
   * resolves true when one of them is new to the phone.
   */
  learnLan?(addresses: LanHint[]): Promise<boolean>
  /** Opens a session on one direct endpoint; resolves once it is open. Aborting closes it. */
  direct(endpoint: DirectEndpoint, signal: AbortSignal, link: DirectLink): Promise<LeafSession>
  /** False when direct paths are switched off (Mousse ID's kill switch, no WebRTC on the device). */
  directAllowed?(): Promise<boolean>
  /** How long an attempt on `endpoint` may take; defaults to the STUN timeout. */
  directTimeoutMs?(endpoint: DirectEndpoint): number
}

export interface PathSessionOptions {
  /** The session that is already open, on the relay unless `firstKind` says it is direct (the LAN). */
  first: LeafSession
  firstKind?: PathKind
  open: PathOpeners
  network?: NetworkSignals
  probeIntervalMs?: number
  directTimeoutMs?: number
  livenessTimeoutMs?: number
  /** How long to let the network settle after a change before checking the path. */
  settleMs?: number
  /** Tests start probing by hand. */
  autoProbe?: boolean
  recoveryDelaysMs?: number[]
  recoveryWindowMs?: number
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
  /** Every record through this position was delivered to the caller; a new path resumes after it. */
  head: StreamHead
  /** Records past a gap in `head`'s epoch already delivered: live ones can overtake a replay. */
  ahead: Set<number>
  attached: Map<Path, () => void>
  subscribedSent: boolean
}

/** Codes that only say the path is gone, not that the computer refused this phone. */
const PATH_LOST = new Set(['route_unreachable', 'peer_offline', 'deadline_exceeded', 'unavailable', 'too_large', 'bad_request'])

const after = (record: StreamRecord, head: StreamHead) => record.epoch > head.epoch || (record.epoch === head.epoch && record.seq > head.seq)

const codeOf = (error: unknown) => (error instanceof NetError ? error.code : undefined)

/**
 * A relay attempt failed only because the path is not there yet: the relay or the computer is
 * away, or Mousse ID could not renew the registration for now (it is restarting, or the phone's
 * network is not back after the app returned).
 */
const notThereYet = (error: unknown) => PATH_LOST.has(codeOf(error) ?? '') || (error instanceof MousseIdError && error.retryable)

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
  private recoveryWait?: { timer: ReturnType<typeof setTimeout>; resolve: () => void }
  private readonly offNetwork: () => void

  constructor(private readonly options: PathSessionOptions) {
    this.active = this.track(options.firstKind ?? 'relay', options.first)
    this.offNetwork = (options.network ?? deviceNetworkSignals).onChange(() => this.networkChanged())
    if (options.autoProbe !== false) this.probeSoon(0)
    void this.refreshLan(this.active)
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
    const sub: Subscription = { stream, handlers, head: { epoch: from.epoch, seq: from.seq }, ahead: new Set(), attached: new Map(), subscribedSent: false }
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
    if (this.stateValue !== 'open' || this.recovering || this.upgrading || this.active.kind === 'direct' || !this.searches()) return
    this.upgrading = true
    clearTimeout(this.probeTimer)
    try {
      const relay = this.active
      // The computer on the phone's own network needs no signaling and is always nearer than the relay.
      const lan = await this.openLan()
      if (lan) {
        if (this.stateValue !== 'open' || this.recovering || this.active !== relay || lan.state !== 'open') return lan.close()
        return this.adopt(this.track('direct', lan))
      }
      if (!this.directSupported) return
      const webrtc = !this.options.open.directAllowed || (await this.options.open.directAllowed().catch(() => false))
      if (!webrtc && !this.options.open.learnLan) return
      if (this.stateValue !== 'open' || this.recovering || this.active !== relay) return
      // The computer's answer may name its LAN addresses: new ones are tried before WebRTC, which needs the relay to signal.
      const reported = await this.discover(relay)
      if (reported && (await this.learnLan(reported))) {
        const near = await this.openLan()
        if (near) {
          if (this.stateValue !== 'open' || this.recovering || this.active !== relay || near.state !== 'open') return near.close()
          return this.adopt(this.track('direct', near))
        }
      }
      if (!webrtc || !this.endpoints.length) return
      if (this.stateValue !== 'open' || this.recovering || this.active !== relay) return
      const next = await this.openDirect(relay)
      if (!next) return
      if (this.stateValue !== 'open' || this.recovering || this.active !== relay) return this.retire(next)
      // Move only when the direct path is quicker: a peer-to-peer route across networks may not be.
      const [direct, relayed] = await Promise.all([this.roundTrip(next.leaf), this.roundTrip(relay.leaf)])
      if (direct === undefined || (relayed !== undefined && direct >= relayed)) return this.retire(next)
      if (this.stateValue !== 'open' || this.recovering || this.active !== relay || next.leaf.state !== 'open') return this.retire(next)
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
    if (this.stateValue !== 'open' || this.options.autoProbe === false || this.active.kind === 'direct' || !this.searches()) return
    this.probeTimer = setTimeout(() => void this.probe(), delay)
  }

  /** Whether there is any direct path to look for: WebRTC through the computer, or the LAN. */
  private searches(): boolean {
    return this.directSupported || !!this.options.open.lan
  }

  /** A LAN session when the computer is on this network; never throws. */
  private async openLan(): Promise<LeafSession | undefined> {
    try {
      return (await this.options.open.lan?.()) ?? undefined
    } catch {
      return undefined
    }
  }

  /** Asks the computer which direct paths it takes; resolves with the LAN addresses it reported, if any. */
  private async discover(path: Path): Promise<LanHint[] | undefined> {
    path.busy++
    try {
      const answer = await path.leaf.rpc(ENDPOINTS_METHOD, {}, { deadlineMs: 10_000 })
      this.endpoints = parseDirectEndpoints(answer)
      return parseLanEndpoints(answer)
    } catch (error) {
      // A computer without the method refuses it; it never offers a direct path.
      if (codeOf(error) === 'forbidden') {
        this.directSupported = false
        this.endpoints = []
      }
      return undefined
    } finally {
      path.busy--
      this.retireIfIdle(path)
    }
  }

  /** Keeps the LAN addresses the computer reported; true when one is new. Never throws. */
  private async learnLan(addresses: LanHint[]): Promise<boolean> {
    try {
      return (await this.options.open.learnLan?.(addresses)) ?? false
    } catch {
      return false
    }
  }

  /**
   * Asks the computer for its current LAN addresses on a direct path that just opened, so they stay
   * fresh without the relay. An answer without them is no news: the remembered ones stay.
   */
  private async refreshLan(path: Path): Promise<void> {
    if (!this.options.open.learnLan || path.kind !== 'direct') return
    path.busy++
    try {
      const reported = parseLanEndpoints(await path.leaf.rpc(ENDPOINTS_METHOD, {}, { deadlineMs: 10_000 }))
      if (reported && this.stateValue === 'open') await this.learnLan(reported)
    } catch {
      // An older computer or a path that just dropped; the remembered addresses stay.
    } finally {
      path.busy--
      this.retireIfIdle(path)
    }
  }

  /** How long an attempt on `endpoint` may take. */
  private timeoutFor(endpoint: DirectEndpoint): number {
    return this.options.directTimeoutMs ?? this.options.open.directTimeoutMs?.(endpoint) ?? DIRECT_OPEN_TIMEOUT_MS[endpoint.kind].stun
  }

  /**
   * Tries every endpoint at once, signaling over `via`; the first session to open wins and the
   * rest are closed.
   */
  private async openDirect(via: Path): Promise<Path | undefined> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), Math.max(...this.endpoints.map((endpoint) => this.timeoutFor(endpoint))))
    const link: DirectLink = {
      rpc: async (method, params, options) => {
        via.busy++
        try {
          return await via.leaf.rpc(method, params, options)
        } finally {
          via.busy--
          this.retireIfIdle(via)
        }
      },
      checkPath: () => void this.checkPath(),
    }
    let winner: LeafSession | undefined
    const attempts = this.endpoints.map((endpoint) =>
      this.options.open.direct(endpoint, controller.signal, link).then(
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
    if (old !== next) void this.refreshLan(next)
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
          const fresh = records.filter((record) => after(record, sub.head) && !(record.epoch === sub.head.epoch && sub.ahead.has(record.seq)))
          if (!fresh.length) return
          for (const record of fresh) {
            if (record.epoch !== sub.head.epoch) {
              sub.head = { epoch: record.epoch, seq: record.seq }
              sub.ahead.clear()
            } else if (record.seq === sub.head.seq + 1) {
              sub.head = { epoch: record.epoch, seq: record.seq }
              while (sub.ahead.delete(sub.head.seq + 1)) sub.head = { epoch: sub.head.epoch, seq: sub.head.seq + 1 }
            } else sub.ahead.add(record.seq)
          }
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
   * Opens the next path after the current one was lost: the computer on the phone's network when
   * it is seen there, otherwise the relay, since a WebRTC path is signaled through an open session. A relay that is restarting, or a computer that has not
   * registered with it again yet, gets a few more attempts within a short window before the
   * session closes, so a brief drop never reaches the screens. After a relay loss on a computer
   * with a direct path, the direct path is tried again from the new relay session at once.
   */
  private async recover(dead: Path, reason: Error): Promise<void> {
    const delays = this.options.recoveryDelaysMs ?? RELAY_RECOVERY_DELAYS_MS
    const until = Date.now() + (this.options.recoveryWindowMs ?? RELAY_RECOVERY_WINDOW_MS)
    let next: Path | undefined
    let failure: unknown
    for (const [index, delay] of delays.entries()) {
      if (index > 0 && Date.now() + delay >= until) break
      if (delay > 0) await this.waitToRecover(delay)
      if (this.stateValue !== 'open') return
      const lan = await this.openLan()
      if (lan) {
        if (this.stateValue !== 'open') return lan.close()
        next = this.track('direct', lan)
        break
      }
      try {
        next = this.track('relay', await this.options.open.relay())
        break
      } catch (error) {
        failure = error
        // A refusal is final; only a path that is not there yet is worth another attempt.
        if (!notThereYet(error)) break
      }
    }
    if (this.stateValue !== 'open') {
      if (next) this.retire(next)
      return
    }
    if (!next) {
      // Every attempt failed: close as before. A refusal says more than the lost path.
      const code = codeOf(failure)
      return this.fail(code && !PATH_LOST.has(code) && code !== 'cancelled' ? (failure as Error) : reason)
    }
    this.adopt(next)
    if (next.kind === 'relay' && dead.kind === 'relay' && this.endpoints.length) this.probeSoon(0)
  }

  /** Waits before the next relay attempt; closing the session ends the wait. */
  private waitToRecover(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.recoveryWait = {
        timer: setTimeout(() => {
          this.recoveryWait = undefined
          resolve()
        }, ms),
        resolve,
      }
    })
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
    if (this.recoveryWait) {
      clearTimeout(this.recoveryWait.timer)
      this.recoveryWait.resolve()
      this.recoveryWait = undefined
    }
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
