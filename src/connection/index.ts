// The real MousseConnection: Mousse ID sign-in and inventory, phone enrollment through enrollment
// requests or QR offers, and sessions with the user's computers over the hosted relay.
import { MousseIdError, checkedOrigin, type FetchLike, MousseIdHttp } from '../mousseId/http'
import { MousseIdNet, type ControlIdentity, type InventoryRegistration, type RegistrationGrant } from '../mousseId/net'
import { MOUSSE_ID_ORIGIN } from '../mousseId/origin'
import { matchCode, openOfferSeal, openRequestSeal, parseJoinQr } from '../mousseId/seal'
import { MousseIdSession, type AuthBrowser } from '../mousseId/session'
import { b64url, fromB64url } from '../net/bytes'
import { newId } from '../net/canonical'
import { sha256, type Signed } from '../net/crypto'
import { parseInvite, redeemInvite, type Enrollment, type RedeemOptions } from '../net/enrollment'
import { NetError } from '../net/errors'
import { currentNode } from '../net/identity'
import { generateNodeKeys, SecureKeyStorage, serializeNodeKeys, type KeyStorage, type NodeKeys } from '../net/keys'
import { dialRelay, type RelaySocketFactory } from '../net/relay'
import { LeafSession, type LeafIdentity } from '../net/session'
import { connectTls, type SecureChannel } from '../net/tls13/client'
import { RealComputerSession } from './computerSession'
import { EnrollmentStore, type LoadedEnrollment } from './enrollmentStore'
import type { AccountState, Computer, ComputerSession, EnrollmentProgress, MousseConnection } from './types'

/** Renew the phone's registration this often while a session is open; the lease is 60 seconds. */
export const RENEW_INTERVAL_MS = 30_000
/** Renew before connecting when the lease ends sooner than this. */
const LEASE_MARGIN_MS = 15_000
const POLL_INTERVAL_MS = 2_000
const DEFAULT_PHONE_NAME = 'Phone'
/** Mousse ID errors that mean the registration is gone and the phone must register again. */
const REREGISTER = new Set(['not_found', 'revoked', 'forbidden', 'expired', 'unauthorized'])

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
  /** Tests replace invite redemption. */
  redeem?: (options: RedeemOptions) => Promise<Enrollment>
  pollMs?: number
  renewMs?: number
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
    case 'not_enrolled':
    case 'bad_delegation':
      return new Error(`${name} no longer accepts this phone. Add it again.`)
    case 'peer_key_mismatch':
      return new Error(`${name} presented an unexpected key. Add this phone to it again.`)
    default:
      return error instanceof Error ? error : new Error(`Could not connect to ${name}.`)
  }
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

  constructor(
    private readonly deps: ConnectionDeps,
    private readonly configError?: MousseIdError,
  ) {
    this.now = deps.now ?? Date.now
    const storage = deps.storage ?? new SecureKeyStorage()
    this.store = new EnrollmentStore(storage)
    if (configError) return
    this.session = new MousseIdSession(new MousseIdHttp(deps.origin ?? MOUSSE_ID_ORIGIN!, deps.fetcher), storage, this.now)
    this.net = new MousseIdNet(this.session, this.now)
    this.session.onChange((current) => {
      if (!current) this.devices = undefined
      this.emit()
      if (current) void this.refreshDevices()
    })
  }

  async load(): Promise<void> {
    await this.session?.load()
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
    const enrollments = await this.store.loaded(accountId)
    const ownNodes = new Set(enrollments.map((entry) => entry.stored.enrollment.node))
    const rows = new Map<string, InventoryRegistration>()
    for (const row of inventory.registrations) {
      if (row.revokedAt !== null || ownNodes.has(row.nodeId)) continue
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

  async openComputer(nodeId: string): Promise<ComputerSession> {
    const { net } = this.signedIn()
    const accountId = this.accountId()
    const now = this.now()
    const entry = await this.store.forComputer(accountId, nodeId, now)
    if (!entry) throw new Error('Add this phone to that computer first.')
    const peer = currentNode(entry.roster, nodeId, now).delegation
    const name = peer.name || 'The computer'
    const identity = controlIdentity(entry, now)
    let grant: RegistrationGrant
    try {
      grant = await this.ensureGrant(entry, identity, accountId)
    } catch (error) {
      throw new Error(`Mousse ID did not admit this phone: ${errorMessage(error)}`)
    }
    const expectedSpki = fromB64url(peer.keys.transport)
    const route = `${grant.relayAudience}?node=${nodeId}`
    let channel: SecureChannel
    try {
      channel = this.deps.openChannel
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
    } catch (error) {
      throw connectFailure(error, name)
    }
    const user = entry.stored.enrollment.user
    const leafIdentity: LeafIdentity = {
      user,
      rootKey: identity.rootKey,
      node: identity.node,
      roster: identity.roster,
      delegation: identity.delegation,
    }
    let leaf: LeafSession
    try {
      leaf = new LeafSession(channel, {
        identity: leafIdentity,
        peerNode: nodeId,
        now: this.now,
        onRoster: (roster: Signed) => void this.store.setRoster(user, roster).catch(() => undefined),
      })
    } catch (error) {
      channel.close?.()
      throw connectFailure(error, name)
    }
    try {
      await leaf.opened
    } catch (error) {
      leaf.close()
      throw connectFailure(error, name)
    }
    const renewal = setInterval(() => {
      void this.renewOnce(entry, identity, accountId, net).catch((error: unknown) => {
        if (REREGISTER.has(codeOf(error) ?? '')) leaf.close(new NetError('revoked', 'Mousse ID no longer admits this phone.'))
      })
    }, this.deps.renewMs ?? RENEW_INTERVAL_MS)
    return new RealComputerSession({ nodeId, leaf, onClose: () => clearInterval(renewal) })
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

  private async renewOnce(entry: LoadedEnrollment, identity: ControlIdentity, accountId: string, net: MousseIdNet): Promise<void> {
    const node = identity.node
    const stored = (await this.store.list()).find((row) => row.enrollment.node === node)
    if (!stored?.grant) throw new MousseIdError('unauthorized', 'This phone has no Mousse ID registration.')
    const registration = await net.renew(identity, stored.grant, accountId)
    const renewed = { ...stored.grant, registration }
    entry.stored.grant = renewed
    await this.store.setGrant(node, renewed)
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
