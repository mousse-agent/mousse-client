// The Net routes of the Mousse ID API that a phone uses: service configuration, the account inventory,
// signed control challenges, phone registration and renewal, enrollment requests and offers.
// Wire paths keep their `/v1/net/*` names; see phone-plus-contract.md.
import { b64url } from '../net/bytes'
import { canonicalJson } from '../net/canonical'
import { sha256, signBytes, type Signed } from '../net/crypto'
import { stunServers } from '../net/webrtc'
import { MousseIdError, badResponse, isObject, type MousseIdHttp } from './http'
import type { MousseIdSession } from './session'

export const CONTROL_DOMAIN = 'mousse-plus/net-control/v1'
/** The service allows at most this many registrations per account, whatever the per-kind limits say. */
export const ACCOUNT_REGISTRATION_CAP = 16
const CHALLENGE_MAX_WINDOW_MS = 5 * 60_000
const CHALLENGE_SKEW_MS = 30_000
const ID = /^[A-Za-z0-9_-]{1,128}$/
const DEVICE_NAME_MAX = 64

export interface MousseIdConfig {
  /** Protocol name, for example `mousse-plus/net-control/v1`. */
  protocol: string
  installationId: string
  gatewayId: string
  relayAudience: string
  approvalOrigin?: string
  /** STUN servers for the WebRTC direct path; empty means host candidates only. Never TURN. */
  stun: string[]
  /** False switches the WebRTC direct path off; absent means on. */
  directWebrtc: boolean
}

/** The node identity Mousse ID checks challenges against. `signSecret` is the node's Ed25519 key. */
export interface ControlIdentity {
  user: string
  rootKey: string
  node: string
  roster: Signed
  delegation: Signed
  signSecret: Uint8Array
}

export interface Registration {
  id: string
  accountId: string
  userId: string
  nodeId: string
  generation: number
  expiresAt: number
}

export interface RegistrationGrant {
  registration: Registration
  connectorToken: string
  relayAudience: string
}

export interface InventoryRegistration {
  id: string
  userId: string
  nodeId: string
  kind: 'computer' | 'phone'
  deviceName?: string
  online: boolean
  generation: number
  expiresAt: number
  revokedAt: number | null
  /** Key epoch of the registered delegation, when Mousse ID reports it. */
  keyEpoch?: number
}

/** A user's computers as Mousse ID holds them: the newest roster their computers pushed. */
export interface InventoryBinding {
  userId: string
  /** Signed by the user's root key; check it against the pinned root key before use. */
  roster?: Signed
  /** Revoked nodes and the key epoch they are revoked through, as Mousse ID reports them. */
  revocations: Record<string, number>
  /** Set once the list is revoked, also when it was merged into the account's one devices list. */
  revokedAt: number | null
}

export interface Inventory {
  registrations: InventoryRegistration[]
  bindings: InventoryBinding[]
  limits: { maxRegistrations?: number; maxComputers?: number; maxPhones?: number }
  /** Devices counted against the account's limit, when Mousse ID reports it. */
  devices?: { used: number; limit: number }
}

export type EnrollmentRequestStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'delivered'

export interface EnrollmentRequestState {
  id: string
  status: EnrollmentRequestStatus
  expiresAt: number
  sealedInvite?: string
}

type ChallengePurpose = 'register' | 'renew'

function checkedConfig(value: unknown): MousseIdConfig {
  if (
    !isObject(value) ||
    !((typeof value.protocol === 'string' && value.protocol) || Number.isSafeInteger(value.protocol)) ||
    typeof value.installationId !== 'string' ||
    !value.installationId ||
    typeof value.gatewayId !== 'string' ||
    !value.gatewayId ||
    typeof value.relayAudience !== 'string' ||
    !(value.approvalOrigin === undefined || typeof value.approvalOrigin === 'string')
  )
    return badResponse()
  let relay: URL
  try {
    relay = new URL(value.relayAudience)
  } catch {
    return badResponse()
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(relay.hostname)
  if (relay.protocol !== 'wss:' && !(relay.protocol === 'ws:' && loopback)) return badResponse()
  if (relay.search || relay.hash) return badResponse()
  return {
    protocol: String(value.protocol),
    installationId: value.installationId,
    gatewayId: value.gatewayId,
    relayAudience: value.relayAudience,
    ...(value.approvalOrigin ? { approvalOrigin: value.approvalOrigin } : {}),
    // A malformed field never takes the relay down with it: only an explicit false switches WebRTC off.
    stun: stunServers(value.stun),
    directWebrtc: value.directWebrtc !== false,
  }
}

function checkedRegistration(value: unknown): Registration {
  if (
    !isObject(value) ||
    typeof value.id !== 'string' ||
    !ID.test(value.id) ||
    typeof value.accountId !== 'string' ||
    typeof value.userId !== 'string' ||
    typeof value.nodeId !== 'string' ||
    !Number.isSafeInteger(value.generation) ||
    (value.generation as number) < 1 ||
    !Number.isSafeInteger(value.expiresAt)
  )
    return badResponse()
  return {
    id: value.id,
    accountId: value.accountId,
    userId: value.userId,
    nodeId: value.nodeId,
    generation: value.generation as number,
    expiresAt: value.expiresAt as number,
  }
}

function checkedInventoryRow(value: unknown): InventoryRegistration | undefined {
  if (
    !isObject(value) ||
    typeof value.id !== 'string' ||
    typeof value.userId !== 'string' ||
    typeof value.nodeId !== 'string' ||
    !Number.isSafeInteger(value.generation) ||
    !Number.isSafeInteger(value.expiresAt)
  )
    return undefined
  const kind = value.kind === 'phone' ? 'phone' : 'computer'
  const deviceName = typeof value.deviceName === 'string' && value.deviceName ? value.deviceName.slice(0, DEVICE_NAME_MAX) : undefined
  const revokedAt = Number.isSafeInteger(value.revokedAt) ? (value.revokedAt as number) : null
  const keyEpoch = isObject(value.delegation) ? positive(value.delegation.keyEpoch) : undefined
  return {
    id: value.id,
    userId: value.userId,
    nodeId: value.nodeId,
    kind,
    ...(deviceName ? { deviceName } : {}),
    online: value.online === true,
    generation: value.generation as number,
    expiresAt: value.expiresAt as number,
    revokedAt,
    ...(keyEpoch ? { keyEpoch } : {}),
  }
}

function checkedBinding(value: unknown): InventoryBinding | undefined {
  if (!isObject(value) || typeof value.userId !== 'string') return undefined
  const roster = value.roster
  const signed = isObject(roster) && typeof roster.payload === 'string' && typeof roster.sig === 'string' ? (roster as unknown as Signed) : undefined
  const revocations: Record<string, number> = {}
  if (isObject(value.revocations))
    for (const [node, row] of Object.entries(value.revocations)) {
      const through = isObject(row) ? positive(row.throughKeyEpoch) : undefined
      if (through) revocations[node] = through
    }
  const revokedAt = typeof value.revokedAt === 'number' ? value.revokedAt : null
  return { userId: value.userId, ...(signed ? { roster: signed } : {}), revocations, revokedAt }
}

function positive(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) > 0 ? (value as number) : undefined
}

function checkedDeviceName(name: string): string {
  const trimmed = name.trim()
  // eslint-disable-next-line no-control-regex
  if (!trimmed || trimmed.length > DEVICE_NAME_MAX || /[\u0000-\u001f\u007f-\u009f]/.test(trimmed))
    throw new MousseIdError('bad_request', 'Use a device name of 1 to 64 characters.')
  return trimmed
}

function encodedId(id: string): string {
  if (!ID.test(id)) throw new MousseIdError('bad_request', 'Invalid Mousse ID item.')
  return encodeURIComponent(id)
}

export class MousseIdNet {
  private config?: Promise<MousseIdConfig>

  constructor(
    private readonly session: MousseIdSession,
    private readonly now: () => number = Date.now,
  ) {}

  private get http(): MousseIdHttp {
    return this.session.http
  }

  /** The service configuration, fetched once per instance. */
  configuration(): Promise<MousseIdConfig> {
    this.config ??= this.http
      .request<unknown>('GET', '/v1/net/config')
      .then(checkedConfig)
      .catch((error: unknown) => {
        this.config = undefined
        throw error
      })
    return this.config
  }

  async inventory(signal?: AbortSignal): Promise<Inventory> {
    const value = await this.session.authorized((bearer) => this.http.request<unknown>('GET', '/v1/net/inventory', { bearer, signal }))
    if (!isObject(value) || !Array.isArray(value.registrations)) return badResponse()
    const limits = isObject(value.limits) ? value.limits : {}
    const devices =
      isObject(value.devices) && Number.isSafeInteger(value.devices.used) && (value.devices.used as number) >= 0 && positive(value.devices.limit)
        ? { used: value.devices.used as number, limit: value.devices.limit as number }
        : undefined
    return {
      registrations: value.registrations.map(checkedInventoryRow).filter((row): row is InventoryRegistration => !!row),
      bindings: Array.isArray(value.bindings) ? value.bindings.map(checkedBinding).filter((row): row is InventoryBinding => !!row) : [],
      limits: {
        maxRegistrations: positive(limits.maxRegistrations),
        maxComputers: positive(limits.maxComputers),
        maxPhones: positive(limits.maxPhones),
      },
      ...(devices ? { devices } : {}),
    }
  }

  /** Registers this phone as a leaf node, so the relay accepts it as a caller. */
  async registerPhone(identity: ControlIdentity, signal?: AbortSignal): Promise<RegistrationGrant> {
    const config = await this.configuration()
    const accountId = this.accountId()
    const intent = {
      roster: identity.roster,
      delegation: identity.delegation,
      connectorId: crypto.randomUUID(),
      gatewayId: config.gatewayId,
      kind: 'phone',
    }
    const value = await this.session.authorized(async (bearer) => {
      const body = await this.signed(bearer, config, accountId, identity, 'register', intent, undefined, signal)
      return this.http.request<unknown>('POST', '/v1/net/registrations', { bearer, body, signal })
    })
    if (!isObject(value) || typeof value.connectorToken !== 'string' || typeof value.relayAudience !== 'string') return badResponse()
    const registration = checkedRegistration(value.registration)
    if (
      value.relayAudience !== config.relayAudience ||
      registration.accountId !== accountId ||
      registration.userId !== identity.user ||
      registration.nodeId !== identity.node ||
      registration.expiresAt <= this.now() ||
      value.connectorToken.length < 32 ||
      value.connectorToken.length > 16_384
    )
      throw new MousseIdError('forbidden', 'Mousse ID returned a registration for another device.')
    return { registration, connectorToken: value.connectorToken, relayAudience: value.relayAudience }
  }

  /** Renews a registration with its connector token. The account session is not needed. */
  async renew(identity: ControlIdentity, grant: RegistrationGrant, accountId: string, signal?: AbortSignal): Promise<Registration> {
    const config = await this.configuration()
    const prior = grant.registration
    const intent = { registrationId: prior.id, generation: prior.generation, roster: identity.roster, delegation: identity.delegation }
    const bearer = grant.connectorToken
    const body = await this.signed(bearer, config, accountId, identity, 'renew', intent, prior.id, signal)
    const registration = checkedRegistration(
      await this.http.request<unknown>('POST', `/v1/net/registrations/${encodedId(prior.id)}/renew`, {
        bearer,
        body: { ...body, connectorToken: bearer },
        signal,
      }),
    )
    if (
      registration.id !== prior.id ||
      registration.generation < prior.generation ||
      registration.generation > prior.generation + 1 ||
      registration.accountId !== accountId ||
      registration.userId !== identity.user ||
      registration.nodeId !== identity.node ||
      registration.expiresAt <= this.now()
    )
      throw new MousseIdError('forbidden', 'Mousse ID returned a registration for another device.')
    return registration
  }

  async createEnrollmentRequest(
    input: { targetNodeId: string; deviceName: string; boxPublicKey: string; transportFingerprint: string },
    signal?: AbortSignal,
  ): Promise<{ id: string; expiresAt: number }> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(input.boxPublicKey) || !/^[A-Za-z0-9_-]{43}$/.test(input.transportFingerprint))
      throw new MousseIdError('bad_request', 'Invalid phone keys.')
    const body = {
      targetNodeId: input.targetNodeId,
      deviceName: checkedDeviceName(input.deviceName),
      kind: 'phone',
      boxPublicKey: input.boxPublicKey,
      transportFingerprint: input.transportFingerprint,
    }
    const value = await this.session.authorized((bearer) =>
      this.http.request<unknown>('POST', '/v1/net/enrollment-requests', { bearer, body, signal }),
    )
    if (!isObject(value) || typeof value.id !== 'string' || !ID.test(value.id) || !Number.isSafeInteger(value.expiresAt)) return badResponse()
    return { id: value.id, expiresAt: value.expiresAt as number }
  }

  async enrollmentRequest(id: string, signal?: AbortSignal): Promise<EnrollmentRequestState> {
    const value = await this.session.authorized((bearer) =>
      this.http.request<unknown>('GET', `/v1/net/enrollment-requests/${encodedId(id)}`, { bearer, signal }),
    )
    const statuses: EnrollmentRequestStatus[] = ['pending', 'approved', 'denied', 'expired', 'delivered']
    if (
      !isObject(value) ||
      value.id !== id ||
      !statuses.includes(value.status as EnrollmentRequestStatus) ||
      !Number.isSafeInteger(value.expiresAt) ||
      !(value.sealedInvite === undefined || typeof value.sealedInvite === 'string')
    )
      return badResponse()
    return {
      id,
      status: value.status as EnrollmentRequestStatus,
      expiresAt: value.expiresAt as number,
      ...(value.sealedInvite ? { sealedInvite: value.sealedInvite } : {}),
    }
  }

  /** Collects a QR offer's sealed invite. Mousse ID hands it out once. */
  async offer(id: string, signal?: AbortSignal): Promise<string> {
    const value = await this.session.authorized((bearer) =>
      this.http.request<unknown>('GET', `/v1/net/enrollment-offers/${encodedId(id)}`, { bearer, signal }),
    )
    if (!isObject(value) || typeof value.sealedInvite !== 'string' || !value.sealedInvite) return badResponse()
    return value.sealedInvite
  }

  private accountId(): string {
    const id = this.session.current()?.account.id
    if (!id) throw new MousseIdError('unauthorized', 'Sign in to Mousse ID first.')
    return id
  }

  /** Asks for a challenge, checks every field against what we asked for, and signs it with the node key. */
  private async signed(
    bearer: string,
    config: MousseIdConfig,
    accountId: string,
    identity: ControlIdentity,
    purpose: ChallengePurpose,
    intent: Record<string, unknown>,
    registrationId: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<Record<string, unknown>> {
    const operationId = crypto.randomUUID()
    const statement = await this.http.request<unknown>('POST', '/v1/net/challenges', {
      bearer,
      signal,
      body: {
        operationId,
        purpose,
        userId: identity.user,
        rootKey: identity.rootKey,
        nodeId: identity.node,
        intent,
        ...(registrationId ? { registrationId } : {}),
      },
    })
    const keys = [
      'v',
      'domain',
      'installationId',
      'audience',
      'challengeId',
      'nonce',
      'accountId',
      'userId',
      'rootKey',
      'nodeId',
      'purpose',
      'operationId',
      'intentHash',
      'issuedAt',
      'expiresAt',
    ]
    const now = this.now()
    if (
      !isObject(statement) ||
      Object.keys(statement).some((key) => !keys.includes(key)) ||
      keys.some((key) => !Object.hasOwn(statement, key)) ||
      statement.v !== 1 ||
      statement.domain !== CONTROL_DOMAIN ||
      statement.installationId !== config.installationId ||
      statement.audience !== config.relayAudience ||
      statement.accountId !== accountId ||
      statement.userId !== identity.user ||
      statement.rootKey !== identity.rootKey ||
      statement.nodeId !== identity.node ||
      statement.purpose !== purpose ||
      statement.operationId !== operationId ||
      statement.intentHash !== b64url(sha256(canonicalJson(intent))) ||
      !Number.isSafeInteger(statement.issuedAt) ||
      !Number.isSafeInteger(statement.expiresAt) ||
      (statement.issuedAt as number) > now + CHALLENGE_SKEW_MS ||
      (statement.expiresAt as number) <= now ||
      (statement.expiresAt as number) - (statement.issuedAt as number) > CHALLENGE_MAX_WINDOW_MS ||
      typeof statement.challengeId !== 'string' ||
      !ID.test(statement.challengeId) ||
      typeof statement.nonce !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/.test(statement.nonce)
    )
      throw new MousseIdError('forbidden', 'The Mousse ID challenge does not match this account and device.')
    const proof = b64url(signBytes(canonicalJson(statement), identity.signSecret))
    return { operationId, challengeId: statement.challengeId, proof, ...intent }
  }
}
