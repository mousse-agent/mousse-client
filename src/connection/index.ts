// The real MousseConnection: Mousse ID sign-in and inventory, phone enrollment through enrollment
// requests or QR offers, and sessions with the user's computers over the hosted relay.
import { Capacitor } from '@capacitor/core'
import { MousseIdError, checkedOrigin, type FetchLike, MousseIdHttp } from '../mousseId/http'
import { MousseIdNet, type ControlIdentity, type InventoryBinding, type InventoryRegistration, type Registration, type RegistrationGrant } from '../mousseId/net'
import { MOUSSE_ID_ORIGIN } from '../mousseId/origin'
import { matchCode, openOfferSeal, openRequestSeal, parseJoinQr } from '../mousseId/seal'
import { MousseIdSession, type AuthBrowser } from '../mousseId/session'
import { b64url, fromB64url } from '../net/bytes'
import { newId } from '../net/canonical'
import { sha256, type Signed } from '../net/crypto'
import { parseInvite, redeemInvite, type Enrollment, type RedeemOptions } from '../net/enrollment'
import { NetError } from '../net/errors'
import { currentNode, removesNode, verifyDelegation, verifyRoster, type Roster } from '../net/identity'
import { generateNodeKeys, SecureKeyStorage, serializeNodeKeys, type KeyStorage, type NodeKeys } from '../net/keys'
import { dialRelay, type RelaySocketFactory } from '../net/relay'
import { LeafSession, type LeafIdentity } from '../net/session'
import { browserPeerConnectionFactory, dialWebRtc, type PeerConnectionFactory } from '../net/webrtc'
import { connectTls, type SecureChannel } from '../net/tls13/client'
import { RealComputerSession } from './computerSession'
import { indexedDbThreadCacheBackend, ThreadCache } from './threadCache'
import { EnrollmentStore, type LoadedEnrollment } from './enrollmentStore'
import type { NetworkSignals } from './networkSignals'
import { DIRECT_OPEN_TIMEOUT_MS, DIRECT_PING_INTERVAL_MS, PathSession, type DirectLink, type PathSessionOptions } from './pathSession'
import type { AccountState, Computer, ComputerSession, EnrollmentProgress, MousseConnection, SessionEndReason } from './types'

/**
 * The longest wait between registration renewals while a session is open. A registration lasts 60
 * seconds. The hosted relay renews the phone's admission every 30 seconds but never past the
 * registration's end, and closes the circuit when the admission runs out. So the registration must
 * always outlast the relay's next renewal: like the computer, the phone renews at a third of the
 * remaining lifetime, and at least this often.
 */
export const RENEW_INTERVAL_MS = 20_000
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
/** Mousse ID errors that mean the registration is gone and the phone must register again. */
/** Mousse ID refusals of a stored registration that a fresh registration may fix. */
const REREGISTER = new Set(['not_found', 'forbidden', 'expired', 'unauthorized'])
/**
 * Codes that mean the user's computers removed this phone: from a computer or the relay, and from
 * Mousse ID when it renews or registers a phone whose roster revokes it.
 */
const REMOVED = new Set(['revoked', 'not_member'])
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
      return new Error(`${name} is offline. Open Mousse on it and try again.`)
    case 'deadline_exceeded':
      return new Error(`${name} did not answer in time. Try again.`)
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

  constructor(
    private readonly deps: ConnectionDeps,
    private readonly configError?: MousseIdError,
  ) {
    this.now = deps.now ?? Date.now
    const storage = deps.storage ?? new SecureKeyStorage()
    this.store = new EnrollmentStore(storage)
    this.threads = deps.threadCache ?? new ThreadCache(indexedDbThreadCacheBackend())
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

  async signInWithPassword(email: string, password: string): Promise<void> {
    await this.configured().session.signInWithPassword(email, password)
  }

  async signInWithGoogle(): Promise<void> {
    await this.configured().session.signInWithGoogle(this.deps.openBrowser ?? defaultOpenBrowser)
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
    const inventory = await net.inventory()
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
    return [...rows.values()].map((row) => ({
      nodeId: row.nodeId,
      name: row.deviceName || (row.kind === 'phone' ? 'Phone' : 'Computer'),
      kind: row.kind,
      online: row.online,
      enrolled: row.kind === 'computer' && enrollments.some((entry) => reaches(entry, row.nodeId, now)),
    }))
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
    let grant: RegistrationGrant
    try {
      grant = await this.ensureGrant(entry, identity, accountId)
    } catch (error) {
      if (await this.confirmRemoved(entry, accountId, error)) throw removedError(name)
      throw new Error(`Mousse ID did not admit this phone: ${errorMessage(error)}`)
    }
    const expectedSpki = fromB64url(peer.keys.transport)
    const route = `${grant.relayAudience}?node=${nodeId}`
    const relayChannel = async (grant: RegistrationGrant): Promise<SecureChannel> =>
      this.deps.openChannel
        ? await this.deps.openChannel({ route, nodeId, expectedSpki, grant })
        : await connectTls(
            await dialRelay({
              route,
              identity: { node: identity.node, signKey: entry.keys.public.sign, signSecret: entry.keys.signSecret },
              registration: { registrationId: grant.registration.id, generation: grant.registration.generation },
              socketFactory: this.deps.socketFactory,
            }),
            { transport: entry.keys.transport, expectedServerSpki: expectedSpki },
          )
    let channel: SecureChannel
    try {
      channel = await relayChannel(grant)
    } catch (error) {
      throw (await this.confirmRemoved(entry, accountId, error)) ? removedError(name) : connectFailure(error, name)
    }
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
      first = new LeafSession(channel, { identity: { ...leafIdentity }, peerNode: nodeId, now: this.now, onRoster })
    } catch (error) {
      channel.close?.()
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
    const leaf = new PathSession({
      first,
      network: this.deps.network,
      ...this.deps.paths,
      open: {
        relay: async () => openLeaf(await relayChannel(await this.ensureGrant(entry, identity, accountId))),
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
    let expiresAt = grant.registration.expiresAt
    const scheduleRenewal = (failed = false) => {
      if (stopped) return
      const wait = Math.max(RENEW_MIN_MS, (expiresAt - this.now()) / 3, failed ? RENEW_RETRY_MS : 0)
      renewal = setTimeout(renew, Math.min(this.deps.renewMs ?? RENEW_INTERVAL_MS, wait))
    }
    const renew = () => {
      void this.renewOnce(entry, identity, accountId, net).then(
        (registration) => {
          expiresAt = registration.expiresAt
          scheduleRenewal()
        },
        async (error: unknown) => {
          const code = codeOf(error) ?? ''
          if (!REREGISTER.has(code) && !REMOVED.has(code)) return scheduleRenewal(true)
          const removed = await this.confirmRemoved(entry, accountId, error).catch(() => false)
          leaf.close(
            removed
              ? new NetError('revoked', `${name} removed this phone.`)
              : new NetError('forbidden', 'Mousse ID no longer admits this phone.'),
          )
        },
      )
    }
    scheduleRenewal()
    const endReason = (error?: Error): SessionEndReason => {
      if (!removedByRoster && !(error instanceof NetError && REMOVED.has(error.code))) return 'ended'
      void this.threads.clearComputer(accountId, nodeId)
      void this.forget(ownNode).catch(() => undefined)
      return 'removed'
    }
    const stopRenewal = () => {
      stopped = true
      clearTimeout(renewal)
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

  private async forget(node: string): Promise<void> {
    this.forgotten.add(node)
    await this.forgetThreads(node).catch(() => undefined)
    await this.store.forget(node)
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
    const run = (this.grantLocks.get(node) ?? Promise.resolve()).catch(() => undefined).then(async () => {
      const { net } = this.signedIn()
      const stored = (await this.store.list()).find((row) => row.enrollment.node === node)
      let grant = stored?.grant
      if (grant && grant.registration.accountId !== accountId) grant = undefined
      if (grant && grant.registration.expiresAt - this.now() > LEASE_MARGIN_MS) return grant
      if (grant) {
        try {
          const registration = await net.renew(identity, grant, accountId)
          const renewed = { ...grant, registration }
          await this.store.setGrant(node, renewed)
          return renewed
        } catch (error) {
          if (!REREGISTER.has(codeOf(error) ?? '')) throw error
        }
      }
      const fresh = await net.registerPhone(identity)
      await this.store.setGrant(node, fresh)
      entry.stored.grant = fresh
      return fresh
    })
    this.grantLocks.set(node, run)
    return run
  }

  private async renewOnce(entry: LoadedEnrollment, identity: ControlIdentity, accountId: string, net: MousseIdNet): Promise<Registration> {
    const node = identity.node
    const stored = (await this.store.list()).find((row) => row.enrollment.node === node)
    if (!stored?.grant) throw new MousseIdError('unauthorized', 'This phone has no Mousse ID registration.')
    const registration = await net.renew(identity, stored.grant, accountId)
    const renewed = { ...stored.grant, registration }
    entry.stored.grant = renewed
    await this.store.setGrant(node, renewed)
    return registration
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
