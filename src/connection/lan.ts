// Finds the user's computers on the phone's network and opens connections to them there, without
// the internet. Discovery listens for the computers' encrypted advertisements; a connection is a
// native TCP socket to the advertised port, a WebSocket on the computer's Net path and the same
// pinned TLS and session hello as over the relay. An advertisement only says where to try: the
// computer still proves its pinned key, and the session its roster membership.
import { fromB64url } from '../net/bytes'
import { currentNode, verifyDelegation } from '../net/identity'
import { LanHints, lanReceiveKey, type LanPeerKey } from '../net/lan'
import type { NativeLan } from '../net/nativeLan'
import type { TransportKey } from '../net/cert'
import { connectTls, type SecureChannel } from '../net/tls13/client'
import { openWebSocket } from '../net/websocket'
import type { LoadedEnrollment } from './enrollmentStore'
import type { NetworkSignals } from './networkSignals'

/** How long one LAN attempt may take to connect the socket; a computer on the same network answers at once. */
export const LAN_CONNECT_TIMEOUT_MS = 3_000
/** How long the TLS handshake may take over the LAN. */
export const LAN_TLS_TIMEOUT_MS = 5_000
/** Computers advertise every five seconds: how long to wait for one after the relay failed. */
export const LAN_WAIT_MS = 6_000
/** Addresses tried per attempt, freshest first. */
const ADDRESSES_PER_ATTEMPT = 3
/** The computer's peer keys of at most this many devices; a computer advertises to at most 64. */
const PEERS_MAX = 64

export interface LanConnectorOptions {
  native: NativeLan
  network?: NetworkSignals
  now?: () => number
  /** Tests replace the WebSocket and TLS layers; the channel must be pinned to `expectedSpki`. */
  openChannel?: (target: { node: string; host: string; port: number; expectedSpki: Uint8Array }) => Promise<SecureChannel>
  /** Lifecycle of the app: discovery pauses in the background. Defaults to Capacitor's App plugin. */
  lifecycle?: { onPause(listener: () => void): void; onResume(listener: () => void): void }
}

export class LanConnector {
  readonly hints: LanHints
  private peers: LanPeerKey[] = []
  private running = false
  private paused = false
  private wired = false
  /** Discovery was running when the app went to the background. */
  private resume = false
  private starting: Promise<void> = Promise.resolve()
  private readonly now: () => number

  constructor(private readonly options: LanConnectorOptions) {
    this.now = options.now ?? Date.now
    this.hints = new LanHints(() => this.peers, this.now)
  }

  /**
   * The computers whose advertisements this phone can open: every current device in each
   * enrollment's roster other than the phone itself, keyed with that enrollment's agreement key.
   * Discovery runs while there is at least one.
   */
  update(entries: LoadedEnrollment[]): void {
    const now = this.now()
    const peers: LanPeerKey[] = []
    const seen = new Set<string>()
    for (const entry of entries) {
      const own = entry.stored.enrollment.node
      for (const signed of entry.roster.nodes) {
        if (peers.length >= PEERS_MAX) break
        try {
          const subject = verifyDelegation(signed, entry.roster.rootKey).subject
          if (subject === own || seen.has(`${own}:${subject}`)) continue
          seen.add(`${own}:${subject}`)
          const delegation = currentNode(entry.roster, subject, now).delegation
          peers.push({ node: subject, receiveKey: lanReceiveKey(entry.keys.agreeSecret, fromB64url(delegation.keys.agree, 32), subject) })
        } catch {
          // A revoked, expired or damaged row is not a computer to look for.
        }
      }
    }
    this.peers = peers
    if (peers.length) this.start()
    else this.stop()
  }

  /** Whether `node` advertised on this network within the last 30 seconds. */
  seen(node: string): boolean {
    return this.hints.routes(node).length > 0
  }

  /** Resolves once `node` is seen, or false after `ms`. */
  waitFor(node: string, ms = LAN_WAIT_MS): Promise<boolean> {
    if (this.seen(node)) return Promise.resolve(true)
    if (!this.running) return Promise.resolve(false)
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        off()
        resolve(false)
      }, ms)
      const off = this.hints.onChange((changed) => {
        if (changed !== node) return
        clearTimeout(timer)
        off()
        resolve(true)
      })
    })
  }

  /**
   * A TLS channel to `node` over the LAN, pinned to `expectedSpki`, or undefined when the computer
   * was not seen here or none of its addresses answered. Errors never carry an address.
   */
  async open(node: string, transport: TransportKey, expectedSpki: Uint8Array): Promise<SecureChannel | undefined> {
    for (const hint of this.hints.routes(node).slice(0, ADDRESSES_PER_ATTEMPT)) {
      try {
        if (this.options.openChannel) return await this.options.openChannel({ node, ...hint, expectedSpki })
        const socket = await this.options.native.dial(hint.host, hint.port, LAN_CONNECT_TIMEOUT_MS)
        const bytes = await openWebSocket(socket, hint.host, hint.port)
        return await connectTls(bytes, { transport, expectedServerSpki: expectedSpki, timeoutMs: LAN_TLS_TIMEOUT_MS })
      } catch {
        // The next address, or the relay.
      }
    }
    return undefined
  }

  private start(): void {
    this.wire()
    if (this.running || this.paused) return
    this.running = true
    this.restart()
  }

  private stop(): void {
    if (!this.running) return
    this.running = false
    this.hints.clear()
    this.starting = this.starting.then(() => this.options.native.advertisements.stop()).catch(() => undefined)
  }

  /** Joins the group again: after a network change the socket may sit on the old interface. */
  private restart(): void {
    this.starting = this.starting
      .then(() => this.options.native.advertisements.start((packet, source) => this.hints.receive(packet, source)))
      .catch(() => undefined)
  }

  private wire(): void {
    if (this.wired) return
    this.wired = true
    this.options.network?.onChange(() => {
      if (this.running) this.restart()
    })
    const lifecycle = this.options.lifecycle ?? capacitorLifecycle()
    lifecycle.onPause(() => {
      this.paused = true
      if (this.running) {
        this.stop()
        this.resume = true
      }
    })
    lifecycle.onResume(() => {
      this.paused = false
      if (this.resume && this.peers.length) {
        this.resume = false
        this.start()
      }
    })
  }
}

function capacitorLifecycle(): NonNullable<LanConnectorOptions['lifecycle']> {
  const app = import('@capacitor/app').then(({ App }) => App).catch(() => undefined)
  return {
    onPause: (listener) => void app.then((App) => App?.addListener('pause', listener)).catch(() => undefined),
    onResume: (listener) => void app.then((App) => App?.addListener('resume', listener)).catch(() => undefined),
  }
}
