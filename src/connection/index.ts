// The real MousseConnection: Mousse ID sign-in and inventory, phone enrollment through enrollment
// requests or QR offers, and sessions with the user's computers over the hosted relay.
import { Capacitor } from '@capacitor/core'
import { MousseIdError, checkedOrigin, type FetchLike, MousseIdHttp } from '../mousseId/http'
import { MousseIdNet, type ControlIdentity, type Inventory, type InventoryBinding, type InventoryRegistration, type Registration, type RegistrationGrant } from '../mousseId/net'
import { MOUSSE_ID_ORIGIN } from '../mousseId/origin'
import { matchCode, openOfferSeal, openRequestSeal, parseJoinQr } from '../mousseId/seal'
import { MousseIdSession, type AuthBrowser } from '../mousseId/session'
import { b64url, fromB64url } from '../net/bytes'
import { newId } from '../net/canonical'
import { peekDocument, sha256, type Signed } from '../net/crypto'
import { parseInvite, redeemInvite, type Enrollment, type RedeemOptions } from '../net/enrollment'
import { NetError } from '../net/errors'
import { currentNode, removesNode, verifyDelegation, verifyRoster, type Roster } from '../net/identity'
import { generateNodeKeys, readJson, SecureKeyStorage, serializeNodeKeys, writeJson, type KeyStorage, type NodeKeys } from '../net/keys'
import { dialRelay, type RelaySocketFactory } from '../net/relay'
import { LeafSession, type LeafIdentity } from '../net/session'
import { browserPeerConnectionFactory, dialWebRtc, type PeerConnectionFactory } from '../net/webrtc'
import { connectTls, type SecureChannel } from '../net/tls13/client'
import { nativeLan, type NativeLan } from '../net/nativeLan'
import { LanConnector } from './lan'
import { RealComputerSession } from './computerSession'
import { indexedDbThreadCacheBackend, ThreadCache } from './threadCache'
import { EnrollmentStore, type LoadedEnrollment, type StoredEnrollment } from './enrollmentStore'
import { deviceNetworkSignals, type NetworkSignals } from './networkSignals'
import { DIRECT_OPEN_TIMEOUT_MS, DIRECT_PING_INTERVAL_MS, PathSession, type DirectLink, type PathSessionOptions } from './pathSession'
import type { AccountState, Computer, ComputerSession, EnrollmentProgress, JoinPlan, MousseConnection, SessionEndReason } from './types'
import { isUnreachable, unreachable } from './types'

/**
 * The longest wait between registration renewals while a session is open. A registration lasts 10
 * minutes (60 seconds on older Mousse ID). The hosted relay renews the phone's admission every 30
 * seconds but never past the registration's end, and closes the circuit when the admission runs
 * out. So the registration must always outlast the relay's next renewal: like the computer, the
 * phone renews at a third of the remaining lifetime, and at least this often.
 */
export const RENEW_INTERVAL_MS = 5 * 60_000
/** The shortest wait before the next renewal. */
const RENEW_MIN_MS = 100
/** The wait before retrying a renewal that failed for a passing reason. */
const RENEW_RETRY_MS = 2_000
/**
 * Renew before connecting when the registration ends sooner than this. The relay fixes the first
 * admission's end when the phone connects and extends it 30 seconds later at the earliest.
 */
const LEASE_MARGIN_MS = 45_000
const POLL_INTERVAL_MS = 2_000
const DEFAULT_PHONE_NAME = 'Phone'
/** Accounts whose computers removed this phone; it does not join them again on its own. */
const REMOVED_KEY = 'net.removedFrom'
/** Mousse ID errors that mean the registration is gone and the phone must register again. */
/** Mousse ID refusals of a stored registration that a fresh registration may fix. */
const REREGISTER = new Set(['not_found', 'forbidden', 'expired', 'unauthorized'])
/**
 * Codes that mean the user's computers removed this phone: from a computer or the relay, and from
 * Mousse ID when it renews or registers a phone whose roster revokes it.
 */
const REMOVED = new Set(['revoked', 'not_member'])
/** The computers Mousse ID last listed, per account: shown, with what the LAN sees, while Mousse ID is out of reach. */
const COMPUTERS_KEY = 'net.lastComputers'
/** The longest wait before renewing again while Mousse ID is out of reach. */
const RENEW_OFFLINE_RETRY_MS = 30_000
/** Mousse ID refusals that concern the account session, never this phone's membership. */
const ACCOUNT_SESSION = new Set(['forbidden', 'unauthorized'])
/** Codes that say nothing about this phone's membership; the phone tries again later. */
const TRANSIENT = new Set([
  'peer_offline',
  'route_unreachable',
  'deadline_exceeded',
  'cancelled',
  'rate_limited',
  'clock_skew',
  'offline',
  'unavailable',
])

export interface ConnectionDeps {
  /** Mousse ID API origin; defaults to VITE_MOUSSE_ID_ORIGIN. */
  origin?: string
  storage?: KeyStorage
  fetcher?: FetchLike
  /** Opens the Google sign-in page and waits for the callback; defaults to the system browser. */
  openBrowser?: AuthBrowser
  /** Opens a page in the system browser, for sign-up. */
  openExternal?: (url: string) => Promise<void>
  now?: () => number
  socketFactory?: RelaySocketFactory
  /** Tests replace the relay and TLS layers for computer sessions. */
  openChannel?: (target: { route: string; nodeId: string; expectedSpki: Uint8Array; grant: RegistrationGrant }) => Promise<SecureChannel>
  /** Tests replace the WebRTC and TLS layers of a direct path to a computer. */
  openDirectChannel?: (target: { nodeId: string; expectedSpki: Uint8Array; signal: AbortSignal; link: DirectLink }) => Promise<SecureChannel>
  /** Creates the peer connection of a direct path; defaults to the webview's RTCPeerConnection. */
  peerConnectionFactory?: PeerConnectionFactory
  /** The device's platform; WebRTC direct paths run on Android and the web, never on iOS. */
  platform?: string
  /** Network changes and app resumes; defaults to the device's. */
  network?: NetworkSignals
  /** Tests tune or switch off the background search for a direct path. */
  paths?: Pick<PathSessionOptions, 'autoProbe' | 'probeIntervalMs' | 'directTimeoutMs' | 'livenessTimeoutMs' | 'settleMs'>
  /** Tests replace invite redemption. */
  redeem?: (options: RedeemOptions) => Promise<Enrollment>
  pollMs?: number
  renewMs?: number
  /** Saved thread contents; defaults to one in the webview's IndexedDB. */
  threadCache?: ThreadCache
  /**
   * Native sockets for reaching computers on the phone's own network without the internet; defaults
   * to the MousseLan plugin where the app has it (Android). Null switches LAN connections off.
   */
  lan?: NativeLan | null
  /** Tests replace the WebSocket and TLS layers of a LAN path to a computer. */
  openLanChannel?: (target: { node: string; host: string; port: number; expectedSpki: Uint8Array }) => Promise<SecureChannel>
  /** Tests replace the app's pause and resume events, which pause LAN discovery. */
  lifecycle?: { onPause(listener: () => void): void; onResume(listener: () => void): void }
}

const defaultOpenBrowser: AuthBrowser = async (url) => (await import('../authBrowser')).openAuthBrowser(url)
const defaultOpenExternal = async (url: string): Promise<void> => {
  const { Browser } = await import('@capacitor/browser')
  await Browser.open({ url })
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'Something went wrong.'
}

function codeOf(error: unknown): string | undefined {
  return error instanceof MousseIdError || error instanceof NetError ? error.code : undefined
}

/** Words for a failed connection to a computer. */
function connectFailure(error: unknown, name: string): Error {
  switch (codeOf(error)) {
    case 'peer_offline':
    case 'route_unreachable':
      return unreachable(new Error(`${name} is offline. Open Mousse on it and try again.`))
    case 'deadline_exceeded':
      return unreachable(new Error(`${name} did not answer in time. Try again.`))
    case 'revoked':
    case 'not_member':
      return removedError(name)
    case 'not_enrolled':
    case 'bad_delegation':
      return new Error(`${name} no longer accepts this phone. Add it again.`)
    case 'peer_key_mismatch':
      return new Error(`${name} presented an unexpected key. Add this phone to it again.`)
    default:
      return error instanceof Error ? error : new Error(`Could not connect to ${name}.`)
  }
}

function removedError(name: string): Error {
  return new Error(`${name} removed this phone. Add it again to reconnect.`)
}

class RealConnection implements MousseConnection {
  private readonly listeners = new Set<(state: AccountState) => void>()
  private readonly store: EnrollmentStore
  private readonly storage: KeyStorage
  private readonly now: () => number
  private readonly session?: MousseIdSession
  private readonly net?: MousseIdNet
  private devices?: { used: number; limit: number }
  private accountSnapshot?: { key: string; state: AccountState }
  private readonly grantLocks = new Map<string, Promise<unknown>>()
  /** Phone nodes forgotten in this run, kept out of the device list until Mousse ID drops them. */
  private readonly forgotten = new Set<string>()
  private readonly threads: ThreadCache
  /** The signed-in account, to clear its saved threads once it signs out. */
  private signedInAs?: string
  /** Computers on the phone's own network; absent where the app has no native sockets. */
  private readonly lan?: LanConnector
  private readonly computerListeners = new Set<() => void>()

  constructor(
    private readonly deps: ConnectionDeps,
    private readonly configError?: MousseIdError,
  ) {
    this.now = deps.now ?? Date.now
    const storage = deps.storage ?? new SecureKeyStorage()
    this.storage = storage
    this.store = new EnrollmentStore(storage)
    this.threads = deps.threadCache ?? new ThreadCache(indexedDbThreadCacheBackend())
    const native = deps.lan === null ? undefined : (deps.lan ?? nativeLan())
    if (native) {
      this.lan = new LanConnector({
        native,
        network: deps.network ?? deviceNetworkSignals,
        now: this.now,
        ...(deps.lifecycle ? { lifecycle: deps.lifecycle } : {}),
        ...(deps.openLanChannel ? { openChannel: deps.openLanChannel } : {}),
      })
      // A computer showing up on this network, or moving to a new port after it restarted, is news to the computer list.
      this.lan.hints.onChange(() => {
        for (const listener of [...this.computerListeners]) listener()
      })
    }
    if (configError) return
    this.session = new MousseIdSession(new MousseIdHttp(deps.origin ?? MOUSSE_ID_ORIGIN!, deps.fetcher), storage, this.now)
    this.net = new MousseIdNet(this.session, this.now)
    this.session.onChange((current) => {
      // Saved threads belong to the account: a signed-out phone keeps none of them.
      if (this.signedInAs && this.signedInAs !== current?.account.id) void this.threads.clearAccount(this.signedInAs)
      this.signedInAs = current?.account.id
      if (!current) this.devices = undefined
      this.emit()
      if (current) void this.refreshDevices()
    })
  }

  async load(): Promise<void> {
    await this.session?.load()
    this.signedInAs = this.session?.current()?.account.id
    await this.refreshLan()
  }

  onComputersChange(listener: () => void): () => void {
    this.computerListeners.add(listener)
    return () => this.computerListeners.delete(listener)
  }

  /** Looks on the phone's network for the computers of the signed-in account's enrollments. */
  private async refreshLan(): Promise<void> {
    if (!this.lan) return
    const accountId = this.session?.current()?.account.id
    try {
      this.lan.update(accountId ? (await this.store.loaded(accountId)).filter((entry) => !removesSelf(entry)) : [])
    } catch {
      // Discovery is best effort; the relay still works.
    }
  }

  /** The same object until the state changes: React's useSyncExternalStore re-renders forever otherwise. */
  account(): AccountState {
    const current = this.session?.current()
    const next: AccountState =
      !this.session || !current
        ? { status: 'signed-out' }
        : {
            status: 'signed-in',
            account: { id: current.account.id, email: current.account.email },
            idOrigin: this.session.http.origin,
            ...(this.devices ? { devices: this.devices } : {}),
          }
    const key = JSON.stringify(next)
    if (this.accountSnapshot?.key !== key) this.accountSnapshot = { key, state: next }
    return this.accountSnapshot.state
  }

  onAccountChange(listener: (state: AccountState) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  // Signing in again is a fresh start: a phone the computers removed may join them on its own again.
  async signInWithPassword(email: string, password: string): Promise<void> {
    await this.configured().session.signInWithPassword(email, password)
    await this.allowRejoin().catch(() => undefined)
  }

  async signInWithGoogle(): Promise<void> {
    await this.configured().session.signInWithGoogle(this.deps.openBrowser ?? defaultOpenBrowser)
    await this.allowRejoin().catch(() => undefined)
  }

  /** Signs out of Mousse ID and forgets this phone's relay credentials. Enrollments stay on the phone. */
  async signOut(): Promise<void> {
    await this.store.clearGrants()
    await this.session?.signOut()
  }

  async openSignUp(): Promise<void> {
    const config = await this.configured().net.configuration()
    if (!config.approvalOrigin) throw new Error('This Mousse ID server has no sign-up page.')
    await (this.deps.openExternal ?? defaultOpenExternal)(new URL('/signup', config.approvalOrigin).toString())
  }

  async listComputers(): Promise<Computer[]> {
    const { net } = this.signedIn()
    const accountId = this.accountId()
    void this.refreshLan()
    let inventory: Inventory
    try {
      inventory = await net.inventory()
    } catch (error) {
      // Without the internet, the computers listed last time are shown, online when they are seen on this network.
      const offline = this.lan && error instanceof MousseIdError && error.retryable ? await this.lastComputers(accountId) : undefined
      if (!offline) throw error
      return offline
    }
    this.setDevices(inventory.devices)
    await this.adoptRosters(inventory.bindings)
    await this.forgetRemoved(accountId)
    // Mousse ID marks a phone's registration revoked once a computer's roster revokes it, which reaches phones that were offline then.
    for (const row of inventory.registrations) {
      if (row.revokedAt === null) continue
      const own = (await this.store.loaded(accountId)).some((entry) => entry.stored.enrollment.node === row.nodeId)
      if (own) await this.forget(row.nodeId)
    }
    const enrollments = await this.store.loaded(accountId)
    const ownNodes = new Set([...this.forgotten, ...enrollments.map((entry) => entry.stored.enrollment.node)])
    const revocations = new Map(inventory.bindings.map((binding) => [binding.userId, binding.revocations]))
    const rows = new Map<string, InventoryRegistration>()
    for (const row of inventory.registrations) {
      if (row.revokedAt !== null || ownNodes.has(row.nodeId)) continue
      if ((revocations.get(row.userId)?.[row.nodeId] ?? 0) >= (row.keyEpoch ?? 1)) continue
      const held = rows.get(row.nodeId)
      if (!held || (row.online && !held.online) || (row.online === held.online && row.expiresAt > held.expiresAt)) rows.set(row.nodeId, row)
    }
    const now = this.now()
    const authority = chooseNetwork(inventory.bindings, now)?.roster.authorityNode
    const computers: Computer[] = [...rows.values()].map((row) => ({
      nodeId: row.nodeId,
      name: row.deviceName || (row.kind === 'phone' ? 'Phone' : 'Computer'),
      kind: row.kind,
      online: row.online,
      enrolled: row.kind === 'computer' && enrollments.some((entry) => reaches(entry, row.nodeId, now)),
      ...(row.kind === 'computer' && row.nodeId === authority ? { authority: true } : {}),
    }))
    await writeJson(this.storage, COMPUTERS_KEY, { accountId, computers }).catch(() => undefined)
    // A computer that cannot reach Mousse ID but is on this phone's network is still online here.
    return computers.map((computer) => (!computer.online && computer.kind === 'computer' && this.lan?.seen(computer.nodeId) ? { ...computer, online: true } : computer))
  }

  /** The computers Mousse ID listed last for this account, each online when the LAN sees it. */
  private async lastComputers(accountId: string): Promise<Computer[] | undefined> {
    const saved = await readJson<{ accountId?: unknown; computers?: unknown }>(this.storage, COMPUTERS_KEY).catch(() => undefined)
    if (!saved || saved.accountId !== accountId || !Array.isArray(saved.computers)) return undefined
    const now = this.now()
    const enrollments = (await this.store.loaded(accountId)).filter((entry) => !removesSelf(entry))
    return (saved.computers as Computer[])
      .filter((row) => row && typeof row.nodeId === 'string' && typeof row.name === 'string' && (row.kind === 'computer' || row.kind === 'phone'))
      .map((row) => {
        const enrolled = row.kind === 'computer' && enrollments.some((entry) => reaches(entry, row.nodeId, now))
        return { ...row, enrolled, online: enrolled && !!this.lan?.seen(row.nodeId) }
      })
  }

  /**
   * Whether this phone still has to join the account's computers. The computers share one roster;
   * when Mousse ID holds several (computers set up apart), the one with the most devices counts.
   * Its authority is the computer that adds devices, and it approves a request from its own
   * Mousse ID account on its own. A phone that holds an enrollment for that roster's user never
   * asks again, and one the computers removed waits until the user signs in again.
   */
  async joinPlan(): Promise<JoinPlan> {
    const { net } = this.signedIn()
    const accountId = this.accountId()
    const inventory = await net.inventory()
    this.setDevices(inventory.devices)
    await this.adoptRosters(inventory.bindings)
    await this.forgetRemoved(accountId)
    const now = this.now()
    const network = chooseNetwork(inventory.bindings, now)
    if (!network) return { status: 'none' }
    const enrollments = await this.store.loaded(accountId)
    if (enrollments.some((entry) => entry.stored.enrollment.user === network.userId && !removesSelf(entry))) return { status: 'joined' }
    const nodeId = network.roster.authorityNode
    const rows = inventory.registrations.filter((row) => row.nodeId === nodeId && row.revokedAt === null)
    const name = rows.find((row) => row.deviceName)?.deviceName || nodeName(network.roster, nodeId, now) || 'your computer'
    if (await this.removedFrom(accountId)) return { status: 'removed', computer: name }
    return { status: 'needed', target: { nodeId, name, online: rows.some((row) => row.online) } }
  }

  async allowRejoin(): Promise<void> {
    const accountId = this.session?.current()?.account.id
    if (!accountId) return
    const accounts = await this.removedAccounts()
    if (accounts.includes(accountId)) await writeJson(this.storage, REMOVED_KEY, accounts.filter((id) => id !== accountId))
  }

  private async removedAccounts(): Promise<string[]> {
    const value = await readJson<unknown>(this.storage, REMOVED_KEY).catch(() => undefined)
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []
  }

  private async removedFrom(accountId: string): Promise<boolean> {
    return (await this.removedAccounts()).includes(accountId)
  }

  /** Remembers that the account's computers removed this phone, so it does not join them again on its own. */
  private async markRemoved(): Promise<void> {
    const accountId = this.session?.current()?.account.id
    if (!accountId) return
    const accounts = await this.removedAccounts()
    if (!accounts.includes(accountId)) await writeJson(this.storage, REMOVED_KEY, [...accounts, accountId]).catch(() => undefined)
  }

  async enrollWithComputer(nodeId: string, deviceName: string, onProgress: (progress: EnrollmentProgress) => void): Promise<void> {
    await this.reporting(onProgress, async (stage) => {
      const { net } = this.signedIn()
      stage({ stage: 'requesting' })
      const keys = generateNodeKeys(this.now())
      const node = newId('node')
      const transportFingerprint = b64url(sha256(keys.transport.spki))
      const request = await net.createEnrollmentRequest({
        targetNodeId: nodeId,
        deviceName: deviceName.trim() || DEFAULT_PHONE_NAME,
        boxPublicKey: keys.public.agree,
        transportFingerprint,
      })
      const code = matchCode(fromB64url(keys.public.agree, 32), transportFingerprint)
      stage({ stage: 'waiting-approval', matchCode: code })
      let sealed: string | undefined
      for (;;) {
        const state = await net.enrollmentRequest(request.id)
        if (state.sealedInvite) {
          sealed = state.sealedInvite
          break
        }
        if (state.status === 'denied') return stage({ stage: 'denied', message: 'The computer declined this phone.' }, true)
        if (state.status === 'expired' || state.expiresAt <= this.now())
          return stage({ stage: 'expired', message: 'The request expired before the computer approved it.' }, true)
        if (state.status !== 'pending') throw new Error('The approved invite was already collected. Start again.')
        await sleep(this.deps.pollMs ?? POLL_INTERVAL_MS)
      }
      stage({ stage: 'connecting', matchCode: code })
      const invite = openRequestSeal(sealed, keys.agreeSecret, request.id)
      await this.join(invite, node, keys, deviceName.trim() || DEFAULT_PHONE_NAME)
      stage({ stage: 'done' })
    })
  }

  async enrollFromQr(payload: string, onProgress: (progress: EnrollmentProgress) => void): Promise<void> {
    await this.reporting(onProgress, async (stage) => {
      const { net, session } = this.signedIn()
      const qr = parseJoinQr(payload)
      let origin: string
      try {
        origin = checkedOrigin(qr.origin)
      } catch {
        throw new Error('This join code names an invalid Mousse ID address.')
      }
      if (origin !== session.http.origin) throw new Error(`This join code is for another Mousse ID server (${origin}).`)
      stage({ stage: 'requesting' })
      const sealed = await net.offer(qr.offer)
      const invite = openOfferSeal(sealed, qr.key)
      qr.key.fill(0)
      stage({ stage: 'connecting' })
      await this.join(invite, newId('node'), generateNodeKeys(this.now()), DEFAULT_PHONE_NAME)
      stage({ stage: 'done' })
    })
  }

  /**
   * STUN servers and a peer connection factory when the WebRTC direct path may run here: Mousse ID
   * has not switched it off, the device is not iOS (local network access there needs a prompt),
   * and the webview has WebRTC.
   */
  private async directSettings(net: MousseIdNet): Promise<{ stun: string[]; factory?: PeerConnectionFactory } | undefined> {
    const platform = this.deps.platform ?? Capacitor.getPlatform()
    if (platform === 'ios') return undefined
    const factory = this.deps.peerConnectionFactory ?? browserPeerConnectionFactory()
    if (!factory && !this.deps.openDirectChannel) return undefined
    const config = await net.configuration().catch(() => undefined)
    if (!config || !config.directWebrtc) return undefined
    return { stun: config.stun, factory }
  }

  async openComputer(nodeId: string): Promise<ComputerSession> {
    const { net } = this.signedIn()
    const accountId = this.accountId()
    const now = this.now()
    const removed = await this.forgetRemoved(accountId)
    const entry = await this.store.forComputer(accountId, nodeId, now)
    if (!entry) {
      const gone = removed.find((row) => nodeName(row.roster, nodeId, now) !== undefined)
      if (gone) throw removedError(nodeName(gone.roster, nodeId, now) || 'The computer')
      throw new Error('Add this phone to that computer first.')
    }
    const peer = currentNode(entry.roster, nodeId, now).delegation
    const name = peer.name || 'The computer'
    const identity = controlIdentity(entry, now)
    const expectedSpki = fromB64url(peer.keys.transport)
    await this.refreshLan()
    // On the phone's own network the computer is reached directly, and Mousse ID is not needed.
    const lanChannel = async (): Promise<SecureChannel | undefined> => this.lan?.open(nodeId, entry.keys.transport, expectedSpki)
    /** After the relay failed: the computer may still be here, and advertises within a few seconds. */
    const lanFallback = async (): Promise<SecureChannel | undefined> => ((await this.lan?.waitFor(nodeId)) ? lanChannel() : undefined)
    let grant: RegistrationGrant | undefined
    let channel = await lanChannel()
    const firstKind = channel ? 'direct' : 'relay'
    if (!channel) {
      try {
        grant = await this.ensureGrant(entry, identity, accountId)
      } catch (error) {
        if (await this.confirmRemoved(entry, accountId, error)) throw removedError(name)
        channel = await lanFallback()
        if (!channel) throw new Error(`Mousse ID did not admit this phone: ${errorMessage(error)}`)
      }
    }
    const relayChannel = async (grant: RegistrationGrant): Promise<SecureChannel> =>
      this.deps.openChannel
        ? await this.deps.openChannel({ route: `${grant.relayAudience}?node=${nodeId}`, nodeId, expectedSpki, grant })
        : await connectTls(
            await dialRelay({
              route: `${grant.relayAudience}?node=${nodeId}`,
              identity: { node: identity.node, signKey: entry.keys.public.sign, signSecret: entry.keys.signSecret },
              registration: { registrationId: grant.registration.id, generation: grant.registration.generation },
              socketFactory: this.deps.socketFactory,
            }),
            { transport: entry.keys.transport, expectedServerSpki: expectedSpki },
          )
    if (!channel) {
      try {
        channel = await relayChannel(grant!)
      } catch (error) {
        if (await this.confirmRemoved(entry, accountId, error)) throw removedError(name)
        channel = await lanFallback()
        if (!channel) throw connectFailure(error, name)
      }
    }
    const opened = channel
    const user = entry.stored.enrollment.user
    const ownNode = entry.stored.enrollment.node
    // Set when the computer sends a roster that removes this phone; the session then fails its own checks.
    let removedByRoster = false
    const leafIdentity: LeafIdentity = {
      user,
      rootKey: identity.rootKey,
      node: identity.node,
      roster: identity.roster,
      delegation: identity.delegation,
    }
    const onRoster = (roster: Signed) => {
      if (rosterRemoves(entry, roster)) removedByRoster = true
      // Later paths start from the newest roster the computer sent.
      leafIdentity.roster = roster
      void this.store.setRoster(user, roster).catch(() => undefined)
    }
    let first: LeafSession
    try {
      first = new LeafSession(opened, { identity: { ...leafIdentity }, peerNode: nodeId, now: this.now, onRoster, ...(firstKind === 'direct' ? { pingIntervalMs: DIRECT_PING_INTERVAL_MS } : {}) })
    } catch (error) {
      opened.close?.()
      throw connectFailure(error, name)
    }
    try {
      await first.opened
    } catch (error) {
      first.close()
      if (removedByRoster) {
        await this.forget(ownNode)
        throw removedError(name)
      }
      throw (await this.confirmRemoved(entry, accountId, error)) ? removedError(name) : connectFailure(error, name)
    }
    // Later sessions to the same computer, over the relay again or over a direct path.
    const openLeaf = async (opened: SecureChannel, pingIntervalMs?: number): Promise<LeafSession> => {
      let next: LeafSession
      try {
        next = new LeafSession(opened, { identity: { ...leafIdentity }, peerNode: nodeId, now: this.now, onRoster, ...(pingIntervalMs ? { pingIntervalMs } : {}) })
      } catch (error) {
        opened.close?.()
        throw error
      }
      try {
        await next.opened
      } catch (error) {
        next.close()
        throw error
      }
      return next
    }
    // The session moves between the relay and a WebRTC path to the computer on its own. The
    // configuration is already cached from registering; a failed fetch only means no direct path.
    const direct = this.directSettings(net).catch(() => undefined)
    let stun: string[] | undefined
    void direct.then((settings) => (stun = settings?.stun))
    // The registration is renewed only once the phone has one: a session that opened on the LAN registers when it first needs the relay.
    let startRenewal = () => {}
    const leaf = new PathSession({
      first,
      firstKind,
      network: this.deps.network,
      ...this.deps.paths,
      open: {
        relay: async () => {
          const fresh = await this.ensureGrant(entry, identity, accountId)
          startRenewal()
          return openLeaf(await relayChannel(fresh))
        },
        ...(this.lan
          ? {
              lan: async () => {
                const lan = await lanChannel()
                return lan ? openLeaf(lan, DIRECT_PING_INTERVAL_MS) : undefined
              },
            }
          : {}),
        directAllowed: async () => !!(await direct),
        directTimeoutMs: (endpoint) => DIRECT_OPEN_TIMEOUT_MS[endpoint.kind][stun?.length === 0 ? 'sameNetwork' : 'stun'],
        direct: async (_endpoint, signal, link) => {
          const settings = await direct
          if (!settings) throw new NetError('unavailable', 'Direct paths are off.')
          // Until the session is open, aborting the race closes the peer connection under it.
          let opening: { close(error?: Error): void } | undefined
          const abort = () => opening?.close(new NetError('cancelled'))
          signal.addEventListener('abort', abort, { once: true })
          try {
            let raw: SecureChannel
            if (this.deps.openDirectChannel) raw = await this.deps.openDirectChannel({ nodeId, expectedSpki, signal, link })
            else {
              const bytes = await dialWebRtc({
                stun: settings.stun,
                rpc: (method, params, options) => link.rpc(method, params, options),
                onDisconnected: () => link.checkPath(),
                peerConnectionFactory: settings.factory,
                signal,
              })
              opening = bytes
              raw = await connectTls(bytes, {
                transport: entry.keys.transport,
                expectedServerSpki: expectedSpki,
                timeoutMs: DIRECT_OPEN_TIMEOUT_MS.webrtc.stun,
              })
            }
            opening = raw
            if (signal.aborted) {
              raw.close()
              throw new NetError('cancelled')
            }
            return await openLeaf(raw, DIRECT_PING_INTERVAL_MS)
          } finally {
            signal.removeEventListener('abort', abort)
          }
        },
      },
    })
    // Keep the registration ahead of the relay's admission renewals for as long as the session is
    // open, on every path, so falling back to the relay never waits for Mousse ID.
    let renewal: ReturnType<typeof setTimeout> | undefined
    let stopped = false
    let renewing = false
    let expiresAt = grant?.registration.expiresAt ?? 0
    const scheduleRenewal = (failed?: string) => {
      if (stopped) return
      renewing = true
      // Without the internet a renewal cannot succeed; try again now and then rather than every two seconds.
      const retry = failed === undefined ? 0 : failed === 'offline' ? RENEW_OFFLINE_RETRY_MS : RENEW_RETRY_MS
      const wait = Math.max(RENEW_MIN_MS, (expiresAt - this.now()) / 3, retry)
      renewal = setTimeout(renew, Math.min(Math.max(this.deps.renewMs ?? RENEW_INTERVAL_MS, retry), wait))
    }
    const renew = () => {
      void this.renewOnce(entry, identity, accountId, net).then(
        (registration) => {
          expiresAt = registration.expiresAt
          scheduleRenewal()
        },
        async (error: unknown) => {
          const code = codeOf(error) ?? ''
          if (!REREGISTER.has(code) && !REMOVED.has(code)) return scheduleRenewal(code)
          const removed = await this.confirmRemoved(entry, accountId, error).catch(() => false)
          leaf.close(
            removed
              ? new NetError('revoked', `${name} removed this phone.`)
              : new NetError('forbidden', 'Mousse ID no longer admits this phone.'),
          )
        },
      )
    }
    startRenewal = () => {
      if (renewing) return
      const stored = entry.stored.grant
      if (stored) expiresAt = stored.registration.expiresAt
      scheduleRenewal()
    }
    if (grant) scheduleRenewal()
    // A computer that shows up on this network (or comes back on a new port) takes the session there at once.
    const offLan = this.lan?.hints.onChange((node) => {
      if (node === nodeId) void leaf.probe()
    })
    const endReason = (error?: Error): SessionEndReason => {
      if (!removedByRoster && !(error instanceof NetError && REMOVED.has(error.code)))
        return isUnreachable(error) ? 'lost' : 'ended'
      void this.threads.clearComputer(accountId, nodeId)
      void this.forget(ownNode).catch(() => undefined)
      return 'removed'
    }
    const stopRenewal = () => {
      stopped = true
      clearTimeout(renewal)
      offLan?.()
    }
    return new RealComputerSession({ nodeId, leaf, endReason, onClose: stopRenewal, threadCache: this.threads.scope(accountId, nodeId) })
  }

  /** Keeps the newer rosters the user's computers pushed to Mousse ID; each must verify with the pinned root key. */
  private async adoptRosters(bindings: InventoryBinding[]): Promise<void> {
    for (const binding of bindings) if (binding.roster) await this.store.setRoster(binding.userId, binding.roster)
  }

  /** Forgets the enrollments whose roster removes this phone, and returns them. */
  private async forgetRemoved(accountId: string): Promise<LoadedEnrollment[]> {
    const removed = (await this.store.loaded(accountId)).filter(removesSelf)
    for (const entry of removed) await this.forget(entry.stored.enrollment.node)
    return removed
  }

  /** Forgets an enrollment the user's computers removed. */
  private async forget(node: string): Promise<void> {
    this.forgotten.add(node)
    await this.markRemoved()
    await this.forgetThreads(node).catch(() => undefined)
    await this.store.forget(node)
    await this.refreshLan()
  }

  /** Clears the saved threads of every computer the forgotten enrollment reached. */
  private async forgetThreads(node: string): Promise<void> {
    const accountId = this.session?.current()?.account.id
    if (!accountId) return
    const entry = (await this.store.loaded(accountId)).find((row) => row.stored.enrollment.node === node)
    if (!entry) return
    for (const signed of entry.roster.nodes) {
      let subject: string
      try {
        subject = verifyDelegation(signed, entry.roster.rootKey).subject
      } catch {
        continue
      }
      if (subject !== node) await this.threads.clearComputer(accountId, subject)
    }
  }

  /**
   * Whether a refusal means the user's computers removed this phone; if so the enrollment is forgotten.
   * A computer, the relay or Mousse ID says so with `revoked` or `not_member`. Account session
   * problems (`forbidden`, `unauthorized`) never forget anything. For other refusals the phone reads
   * the roster the computers last pushed to Mousse ID and forgets the enrollment only when that
   * signed roster removes it.
   */
  private async confirmRemoved(entry: LoadedEnrollment, accountId: string, error: unknown): Promise<boolean> {
    const node = entry.stored.enrollment.node
    const code = codeOf(error)
    if (code && REMOVED.has(code)) {
      await this.forget(node)
      return true
    }
    if (!code || TRANSIENT.has(code) || ACCOUNT_SESSION.has(code)) return false
    try {
      await this.adoptRosters((await this.signedIn().net.inventory()).bindings)
    } catch {
      return false
    }
    const fresh = (await this.store.loaded(accountId)).find((row) => row.stored.enrollment.node === node)
    if (!fresh || !removesSelf(fresh)) return false
    await this.forget(node)
    return true
  }

  /** A registration valid for at least LEASE_MARGIN_MS: the stored one, renewed, or a new one. */
  private ensureGrant(entry: LoadedEnrollment, identity: ControlIdentity, accountId: string): Promise<RegistrationGrant> {
    const node = identity.node
    return this.grantTask(node, async () => {
      const { net } = this.signedIn()
      const stored = (await this.store.list()).find((row) => row.enrollment.node === node)
      const current = this.currentIdentity(entry, identity, stored)
      let grant = stored?.grant
      if (grant && grant.registration.accountId !== accountId) grant = undefined
      if (grant && grant.registration.expiresAt - this.now() > LEASE_MARGIN_MS) return grant
      if (grant) {
        try {
          const registration = await net.renew(current, grant, accountId)
          const renewed = { ...grant, registration }
          await this.store.setGrant(node, renewed)
          return renewed
        } catch (error) {
          if (!REREGISTER.has(codeOf(error) ?? '')) throw error
        }
      }
      const fresh = await net.registerPhone(current)
      await this.store.setGrant(node, fresh)
      entry.stored.grant = fresh
      return fresh
    })
  }

  /**
   * What this phone proves to Mousse ID, from the newest roster it holds for its user: a computer
   * sends a newer one while a session is open (a computer joined, a device was renamed), and
   * Mousse ID refuses an older roster than the account's. `fallback` is the identity the session
   * opened with, kept when the stored roster no longer names this phone as current.
   */
  private currentIdentity(entry: LoadedEnrollment, fallback: ControlIdentity, stored?: StoredEnrollment): ControlIdentity {
    if (!stored) return fallback
    try {
      const roster = verifyRoster(stored.enrollment.roster, stored.enrollment.rootKey)
      return controlIdentity({ ...entry, stored, roster }, this.now())
    } catch {
      return fallback
    }
  }

  /**
   * Runs `task` once every earlier registration change of this phone settled. Renewing a
   * registration that ended moves it to a new generation, and Mousse ID refuses the older one as
   * revoked; two renewals at once (the session's timer and a new relay path, after the phone slept)
   * would make the phone forget a computer that still has it.
   */
  private grantTask<T>(node: string, task: () => Promise<T>): Promise<T> {
    const run = (this.grantLocks.get(node) ?? Promise.resolve()).catch(() => undefined).then(task)
    this.grantLocks.set(node, run)
    return run
  }

  private renewOnce(entry: LoadedEnrollment, identity: ControlIdentity, accountId: string, net: MousseIdNet): Promise<Registration> {
    const node = identity.node
    return this.grantTask(node, async () => {
      const stored = (await this.store.list()).find((row) => row.enrollment.node === node)
      if (!stored?.grant) throw new MousseIdError('unauthorized', 'This phone has no Mousse ID registration.')
      const registration = await net.renew(this.currentIdentity(entry, identity, stored), stored.grant, accountId)
      const renewed = { ...stored.grant, registration }
      entry.stored.grant = renewed
      await this.store.setGrant(node, renewed)
      return registration
    })
  }

  /** Redeems an invite, stores the enrollment and registers the phone with Mousse ID. */
  private async join(invite: string, node: string, keys: NodeKeys, fallbackName: string): Promise<void> {
    const { net } = this.signedIn()
    const accountId = this.accountId()
    const parsed = parseInvite(invite, this.now())
    parsed.proofKey.fill(0)
    const name = parsed.document.name ?? fallbackName
    const enrollment = await (this.deps.redeem ?? redeemInvite)({
      invite,
      node,
      keys,
      name,
      now: this.now,
      socketFactory: this.deps.socketFactory,
    })
    await this.store.add({ accountId, enrollment, keys: serializeNodeKeys(keys) })
    await this.refreshLan()
    const identity: ControlIdentity = {
      user: enrollment.user,
      rootKey: enrollment.rootKey,
      node: enrollment.node,
      roster: enrollment.roster,
      delegation: enrollment.delegation,
      signSecret: keys.signSecret,
    }
    try {
      await this.store.setGrant(node, await net.registerPhone(identity))
    } catch (error) {
      throw new Error(`This phone joined, but Mousse ID did not register it: ${errorMessage(error)} It will try again when you open the computer.`)
    }
    void this.refreshDevices()
  }

  /** Runs an enrollment, reporting stages; a failure is reported as stage `error` and thrown. */
  private async reporting(
    onProgress: (progress: EnrollmentProgress) => void,
    run: (stage: (progress: EnrollmentProgress, final?: boolean) => void) => Promise<void>,
  ): Promise<void> {
    let finalError: Error | undefined
    const stage = (progress: EnrollmentProgress, final = false) => {
      onProgress(progress)
      if (final) finalError = new Error(progress.message ?? progress.stage)
    }
    try {
      await run(stage)
    } catch (error) {
      const message = errorMessage(error)
      onProgress({ stage: 'error', message })
      throw error instanceof Error ? error : new Error(message)
    }
    if (finalError) throw finalError
  }

  private configured(): { session: MousseIdSession; net: MousseIdNet } {
    if (!this.session || !this.net) throw this.configError ?? new MousseIdError('not_configured')
    return { session: this.session, net: this.net }
  }

  private signedIn(): { session: MousseIdSession; net: MousseIdNet } {
    const configured = this.configured()
    if (!configured.session.current()) throw new MousseIdError('unauthorized', 'Sign in to your Mousse ID first.')
    return configured
  }

  private accountId(): string {
    return this.signedIn().session.current()!.account.id
  }

  private async refreshDevices(): Promise<void> {
    try {
      if (this.session?.current()) this.setDevices((await this.net!.inventory()).devices)
    } catch {
      // The count is informational; the next listComputers tries again.
    }
  }

  private setDevices(devices: { used: number; limit: number } | undefined): void {
    if (devices?.used === this.devices?.used && devices?.limit === this.devices?.limit) return
    this.devices = devices
    this.emit()
  }

  private emit(): void {
    const state = this.account()
    for (const listener of this.listeners) listener(state)
  }
}

function reaches(entry: LoadedEnrollment, nodeId: string, now: number): boolean {
  try {
    currentNode(entry.roster, nodeId, now)
    currentNode(entry.roster, entry.stored.enrollment.node, now)
    return true
  } catch {
    return false
  }
}

/** Whether the enrollment's roster removes this phone's own node. */
function removesSelf(entry: LoadedEnrollment): boolean {
  return removesOwnNode(entry, entry.roster)
}

/** Whether a roster received for this enrollment removes this phone's own node. */
function rosterRemoves(entry: LoadedEnrollment, signed: Signed): boolean {
  try {
    return removesOwnNode(entry, verifyRoster(signed, entry.stored.enrollment.rootKey))
  } catch {
    return false
  }
}

function removesOwnNode(entry: LoadedEnrollment, roster: Roster): boolean {
  const { enrollment } = entry.stored
  let keyEpoch = 1
  try {
    keyEpoch = verifyDelegation(enrollment.delegation, enrollment.rootKey).keyEpoch
  } catch {
    // The roster's own rows still give the newest key epoch.
  }
  return removesNode(roster, enrollment.node, keyEpoch)
}

/** The name of a computer the roster delegates, or undefined when it has no current delegation. */
function nodeName(roster: Roster, nodeId: string, now: number): string | undefined {
  try {
    return currentNode(roster, nodeId, now).delegation.name
  } catch {
    return undefined
  }
}

/**
 * The roster the account's computers share, from the ones Mousse ID holds: the one with the most
 * current devices. Each is checked against the root key it names; the phone pins that key only
 * when it joins, through the authority's invite.
 */
function chooseNetwork(bindings: InventoryBinding[], now: number): { userId: string; roster: Roster } | undefined {
  let best: { userId: string; roster: Roster; size: number } | undefined
  for (const binding of bindings) {
    if (!binding.roster) continue
    let roster: Roster
    try {
      const rootKey = peekDocument<{ rootKey?: unknown }>(binding.roster).rootKey
      if (typeof rootKey !== 'string') continue
      roster = verifyRoster(binding.roster, rootKey)
    } catch {
      continue
    }
    if (roster.owner !== binding.userId) continue
    const subjects = new Set<string>()
    for (const signed of roster.nodes) {
      try {
        subjects.add(verifyDelegation(signed, roster.rootKey).subject)
      } catch {
        // A damaged row is not a device.
      }
    }
    const size = [...subjects].filter((node) => nodeName(roster, node, now) !== undefined).length
    if (!best || size > best.size) best = { userId: binding.userId, roster, size }
  }
  return best
}

function controlIdentity(entry: LoadedEnrollment, now: number): ControlIdentity {
  const { enrollment } = entry.stored
  return {
    user: enrollment.user,
    rootKey: enrollment.rootKey,
    node: enrollment.node,
    roster: enrollment.roster,
    delegation: currentNode(entry.roster, enrollment.node, now).signed,
    signSecret: entry.keys.signSecret,
  }
}

/**
 * Creates the phone's connection. Without a configured Mousse ID origin it still loads: the app
 * shows signed-out, and every sign-in attempt fails with "This build has no Mousse ID server configured."
 */
export async function createMousseConnection(deps: ConnectionDeps = {}): Promise<MousseConnection> {
  let configError: MousseIdError | undefined
  try {
    checkedOrigin(deps.origin ?? MOUSSE_ID_ORIGIN)
  } catch (error) {
    configError = error instanceof MousseIdError ? error : new MousseIdError('not_configured')
  }
  const connection = new RealConnection(deps, configError)
  await connection.load()
  return connection
}
