// Joining a user's Net as a leaf node with an `mj1_` invite. The phone dials the inviting computer
// through the invite's hosted relay rendezvous, opens TLS pinned to the computer's transport key, and
// runs the enrollment-only handshake (`enroll.v1`). It proves it holds the invite token with an HMAC
// bound to the TLS exporter, and receives its signed delegation and the roster. A port of the joiner
// half of the desktop's EnrollmentService and EnrollmentQuarantine.
import { b64url, equalBytes, fromB64url, fromUtf8, utf8 } from './bytes'
import { canonicalJson, isId } from './canonical'
import { encodeMessage, type WireMessage } from './codec'
import { hkdfSha256, hmacSha256, sha256, verifyDocument, sameJson, type Signed } from './crypto'
import { NetError } from './errors'
import {
  CAPABILITIES,
  NET_PROTO_MAJOR,
  NET_PROTO_MINOR,
  NODE_DELEGATION_TTL_MS,
  currentNode,
  sameKeys,
  verifyDelegation,
  verifyRoster,
  verifyRoutes,
  type Capability,
  type NodeDelegation,
  type Roster,
} from './identity'
import type { NodeKeys } from './keys'
import { StreamMux } from './mux'
import { canonicalAudience, dialRelay, rendezvousRegistration, type RelaySocketFactory } from './relay'
import { PREAUTH_DEADLINE_MS, PREAUTH_MAX_BYTES } from './session'
import { connectTls, type SecureChannel } from './tls13/client'

export const INVITE_PREFIX = 'mj1_'
export const ENROLL_EXPORTER_LABEL = 'EXPORTER-mousse-net-enroll'
const INVITE_MAX_BYTES = 64 * 1024
const NAME_MAX_CHARS = 256
/** Every capability the desktop recognises in a hello; only `enroll.v1` may be offered here. */
const SESSION_CAPABILITIES = ['streams.v1', 'blobs.v1', 'rpc.v1', 'presence.v1', 'enroll.v1', 'relay.v1', 'space.discovery.v1']

export interface RelayRendezvous {
  transport: 'relay' | 'plus-relay'
  /** Relay audience without a query string. */
  relay: string
  ticket: string
  expiresAt: number
}

export interface NodeInviteAuthorization {
  v: 1
  kind: 'nodeInvite'
  invite: string
  user: string
  node: string
  rootKey: string
  roster: Signed
  delegation: Signed
  routes: Signed
  transportFingerprint: string
  tokenHash: string
  issuedAt: number
  expiresAt: number
  caps: Capability[]
  name?: string
  rendezvous?: RelayRendezvous
}

export interface ParsedInvite {
  document: NodeInviteAuthorization
  /** The inviting computer's delegation as of the invite. */
  authority: NodeDelegation
  /** HKDF of the invite token; the token itself is not kept. */
  proofKey: Uint8Array
}

/** What the phone keeps after joining: everything it needs to reconnect and register. */
export interface Enrollment {
  v: 1
  user: string
  rootKey: string
  node: string
  /** The computer that admitted this phone (the user's authority node). */
  authority: string
  authorityName: string
  name: string
  caps: Capability[]
  delegation: Signed
  roster: Signed
  /** Routes of the authority from the invite; the phone dials its `plus-relay` route. */
  routes: Signed
  enrolledAt: number
}

const invalid = (message = 'This invite is not valid.'): never => {
  throw new NetError('invite_invalid', message)
}

export function invitationProofKey(token: Uint8Array): Uint8Array {
  if (token.length !== 32) return invalid()
  return hkdfSha256(token, new Uint8Array(0), utf8('mousse-net/enroll/v1'), 32)
}

/** HMAC-SHA256(proofKey, exporter ‖ inviteId ‖ SHA-256(canonical request without proof)). */
export function invitationProof(key: Uint8Array, exporter: Uint8Array, request: { invite: string; proof?: string }): string {
  if (key.length !== 32 || exporter.length !== 32 || !isId('invite', request.invite)) return invalid()
  const { proof: _proof, ...stable } = request
  return b64url(hmacSha256(key, exporter, utf8(request.invite), sha256(canonicalJson(stable))))
}

function validName(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && [...value].length <= NAME_MAX_CHARS
}

/** Parses and fully verifies an invite the way the desktop joiner does, plus the phone's own limits. */
export function parseInvite(text: string, now = Date.now()): ParsedInvite {
  if (typeof text !== 'string' || utf8(text).length > INVITE_MAX_BYTES || !text.startsWith(INVITE_PREFIX)) return invalid()
  let parsed: ParsedInvite
  try {
    const outer = JSON.parse(fromUtf8(fromB64url(text.slice(INVITE_PREFIX.length)))) as {
      v: number
      authorization: Signed
      token: string
    }
    if (!outer || outer.v !== 1 || Object.keys(outer).sort().join(',') !== 'authorization,token,v') return invalid()
    const raw = JSON.parse(fromUtf8(fromB64url(outer.authorization.payload))) as NodeInviteAuthorization
    const roster = verifyRoster(raw.roster, raw.rootKey)
    const issued = currentNode(roster, raw.node, raw.issuedAt)
    const document = verifyDocument<NodeInviteAuthorization>(outer.authorization, issued.delegation.keys.sign)
    const required = [
      'v',
      'kind',
      'invite',
      'user',
      'node',
      'rootKey',
      'roster',
      'delegation',
      'routes',
      'transportFingerprint',
      'tokenHash',
      'issuedAt',
      'expiresAt',
      'caps',
    ]
    if (
      !document ||
      required.some((key) => !Object.hasOwn(document, key)) ||
      Object.keys(document).some((key) => ![...required, 'name', 'rendezvous'].includes(key)) ||
      document.v !== 1 ||
      document.kind !== 'nodeInvite' ||
      !isId('invite', document.invite) ||
      !isId('user', document.user) ||
      !isId('node', document.node) ||
      roster.owner !== document.user ||
      roster.rootKey !== document.rootKey ||
      roster.authorityNode !== document.node ||
      !Number.isSafeInteger(document.issuedAt) ||
      !Number.isSafeInteger(document.expiresAt) ||
      document.issuedAt < roster.issuedAt ||
      document.expiresAt <= document.issuedAt ||
      document.expiresAt > issued.delegation.expiresAt ||
      document.expiresAt - document.issuedAt > NODE_DELEGATION_TTL_MS ||
      !sameJson(document.delegation, issued.signed) ||
      !Array.isArray(document.caps) ||
      !document.caps.length ||
      new Set(document.caps).size !== document.caps.length ||
      document.caps.some((cap) => !CAPABILITIES.includes(cap)) ||
      (document.name !== undefined && !validName(document.name))
    )
      return invalid()
    const routes = verifyRoutes(document.routes, issued.delegation.keys.sign, document.node)
    if (
      routes.issuedAt > document.issuedAt ||
      !routes.routes.length ||
      !equalBytes(fromB64url(document.transportFingerprint, 32), sha256(fromB64url(issued.delegation.keys.transport)))
    )
      return invalid()
    if (document.rendezvous !== undefined) validateRendezvous(document.rendezvous, document, routes.routes)
    const token = fromB64url(outer.token, 32)
    if (!equalBytes(sha256(token), fromB64url(document.tokenHash, 32))) return invalid()
    parsed = { document, authority: issued.delegation, proofKey: invitationProofKey(token) }
    token.fill(0)
  } catch {
    return invalid()
  }
  // Phone limits, reported with clearer messages than the structural checks above.
  if (parsed.document.rendezvous?.transport !== 'plus-relay')
    return invalid('This invite cannot be used from a phone. Create a new one on the computer.')
  if (now >= parsed.document.expiresAt) return invalid('This invite has expired. Create a new one on the computer.')
  return parsed
}

function validateRendezvous(value: RelayRendezvous, document: NodeInviteAuthorization, routes: Array<{ transport: string; address: string }>): void {
  if (
    !value ||
    typeof value !== 'object' ||
    Object.keys(value).sort().join(',') !== 'expiresAt,relay,ticket,transport' ||
    !['relay', 'plus-relay'].includes(value.transport) ||
    value.expiresAt !== document.expiresAt ||
    typeof value.ticket !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/.test(value.ticket)
  )
    return invalid()
  fromB64url(value.ticket, 32)
  // Raw relays are a desktop transport; the phone only checks the hosted form it can dial.
  if (value.transport !== 'plus-relay') return
  if (canonicalAudience(value.relay) !== value.relay) return invalid()
  const listed = routes.some((route) => {
    if (route.transport !== 'plus-relay') return false
    try {
      const url = new URL(route.address)
      if ([...url.searchParams.keys()].some((key) => key !== 'node') || url.searchParams.getAll('node').length !== 1) return false
      const target = url.searchParams.get('node')
      url.search = ''
      return target === document.node && canonicalAudience(url.toString()) === value.relay
    } catch {
      return false
    }
  })
  if (!listed) return invalid()
}

export interface RedeemOptions {
  invite: string
  /** The phone's node id for this user; a fresh `nod_` id. */
  node: string
  keys: NodeKeys
  /** Delegation name; must equal the invite's name when it carries one. */
  name: string
  now?: () => number
  signal?: AbortSignal
  socketFactory?: RelaySocketFactory
  /** Tests replace the relay and TLS layers. Must return a channel pinned to `expectedSpki`. */
  openChannel?: (target: { route: string; ticket: string; expectedSpki: Uint8Array }) => Promise<SecureChannel>
}

/** Redeems an invite end to end. The result is ready to store and to register with Mousse ID. */
export async function redeemInvite(options: RedeemOptions): Promise<Enrollment> {
  const now = options.now ?? Date.now
  const parsed = parseInvite(options.invite, now())
  const { document } = parsed
  if (!isId('node', options.node)) throw new NetError('bad_request', 'Invalid node id.')
  if (!validName(options.name) || (document.name !== undefined && document.name !== options.name))
    return invalid('The device name does not match the invite.')
  const rendezvous = document.rendezvous!
  const expectedSpki = fromB64url(parsed.authority.keys.transport)
  const route = `${rendezvous.relay}?node=${document.node}`
  const channel = options.openChannel
    ? await options.openChannel({ route, ticket: rendezvous.ticket, expectedSpki })
    : await connectTls(
        await dialRelay({
          route,
          identity: { node: options.node, signKey: options.keys.public.sign, signSecret: options.keys.signSecret },
          registration: rendezvousRegistration(rendezvous.ticket),
          ticket: rendezvous.ticket,
          socketFactory: options.socketFactory,
          signal: options.signal,
        }),
        { transport: options.keys.transport, expectedServerSpki: expectedSpki },
      )
  try {
    if (!equalBytes(sha256(channel.peerSpki), fromB64url(document.transportFingerprint, 32)))
      throw new NetError('peer_key_mismatch', 'The computer presented a different key.')
    return await new JoinHandshake(channel, parsed, options, now).completed
  } finally {
    parsed.proofKey.fill(0)
    channel.close()
  }
}

const enrollmentOnly = (caps: string[]): boolean =>
  caps.includes('enroll.v1') && caps.filter((cap) => SESSION_CAPABILITIES.includes(cap)).every((cap) => cap === 'enroll.v1')

/** The quarantined, enrollment-only exchange on one channel. */
class JoinHandshake {
  readonly completed: Promise<Enrollment>
  private resolve!: (value: Enrollment) => void
  private reject!: (error: Error) => void
  private readonly mux: StreamMux
  private bytes = 0
  private hello?: Extract<WireMessage, { t: 'hello' }>
  private ackSent = false
  private ackReceived = false
  private requested = false
  private done = false
  private readonly timer: ReturnType<typeof setTimeout>

  constructor(
    private readonly channel: SecureChannel,
    private readonly invite: ParsedInvite,
    private readonly options: RedeemOptions,
    private readonly now: () => number,
  ) {
    this.completed = new Promise((resolve, reject) => {
      this.resolve = resolve
      this.reject = reject
    })
    this.timer = setTimeout(() => this.fail(new NetError('deadline_exceeded', 'The computer did not answer in time.')), PREAUTH_DEADLINE_MS)
    const abort = () => this.fail(new NetError('cancelled'))
    options.signal?.addEventListener('abort', abort, { once: true })
    void this.completed.then(
      () => options.signal?.removeEventListener('abort', abort),
      () => options.signal?.removeEventListener('abort', abort),
    )
    this.mux = new StreamMux(channel, {
      onBytesReceived: (count) => {
        if (this.done) return
        this.bytes += count
        if (this.bytes > PREAUTH_MAX_BYTES) throw new NetError('too_large', 'Enrollment exceeds 16 KiB.')
      },
    })
    this.mux.onClose((error) => this.fail(error ?? new NetError('peer_offline', 'The computer closed the connection.')))
    this.mux.onMessage((lane, message) => {
      if (this.done) return
      if (lane !== 'control' || message.parts.length) return this.fail(new NetError('forbidden'))
      void this.receive(message.header).catch((error) => this.fail(error))
    })
    void this.send({
      t: 'hello',
      protoMajor: NET_PROTO_MAJOR,
      protoMinor: NET_PROTO_MINOR,
      caps: ['enroll.v1'],
      node: options.node,
      now: now(),
    }).catch((error) => this.fail(error))
  }

  private send(header: WireMessage): Promise<void> {
    return this.mux.send({ header, parts: [] })
  }

  private minor(): number {
    return Math.min(NET_PROTO_MINOR, this.hello!.protoMinor)
  }

  private async receive(h: WireMessage): Promise<void> {
    if (h.t === 'hello') {
      if (this.hello || h.protoMajor !== NET_PROTO_MAJOR || !(h.protoMinor >= 0) || !enrollmentOnly(h.caps))
        throw new NetError('incompatible_peer')
      this.verifyAuthority(h)
      this.hello = h
      await this.send({ t: 'helloAck', protoMinor: this.minor(), caps: ['enroll.v1'], now: this.now() })
      this.ackSent = true
      return this.maybeRequest()
    }
    if (h.t === 'helloAck') {
      if (!this.hello || this.ackReceived || h.protoMinor !== this.minor() || h.caps.length !== 1 || h.caps[0] !== 'enroll.v1')
        throw new NetError('incompatible_peer')
      this.ackReceived = true
      return this.maybeRequest()
    }
    if (h.t === 'enroll.result' && this.requested) {
      if (h.error) throw new NetError(h.error.code, enrollErrorMessage(h.error.code))
      this.finish(this.accept(h.delegation, h.roster))
      return
    }
    throw new NetError('forbidden')
  }

  private verifyAuthority(hello: Extract<WireMessage, { t: 'hello' }>): void {
    const { document } = this.invite
    if (!hello.roster || !hello.delegation || hello.node !== document.node) throw new NetError('peer_key_mismatch')
    const roster = verifyRoster(hello.roster, document.rootKey)
    const issuer = currentNode(roster, hello.node, this.now())
    if (
      roster.owner !== document.user ||
      roster.authorityNode !== hello.node ||
      !sameJson(hello.delegation, issuer.signed) ||
      !equalBytes(fromB64url(issuer.delegation.keys.transport), this.channel.peerSpki)
    )
      throw new NetError('bad_delegation')
  }

  private async maybeRequest(): Promise<void> {
    if (!this.hello || !this.ackSent || !this.ackReceived || this.requested) return
    this.requested = true
    const stable = {
      t: 'enroll.request' as const,
      invite: this.invite.document.invite,
      node: this.options.node,
      keys: this.options.keys.public,
      name: this.options.name,
    }
    const exporter = this.channel.exportKeyingMaterial(ENROLL_EXPORTER_LABEL, 32)
    const request = { ...stable, proof: invitationProof(this.invite.proofKey, exporter, stable) }
    if (encodeMessage(request).length > PREAUTH_MAX_BYTES) throw new NetError('too_large')
    await this.send(request)
  }

  private accept(delegationSigned: Signed | undefined, rosterSigned: Signed | undefined): Enrollment {
    const { document } = this.invite
    if (!delegationSigned || !rosterSigned) throw new NetError('bad_request')
    let roster: Roster
    let delegation: NodeDelegation
    try {
      roster = verifyRoster(rosterSigned, document.rootKey)
      delegation = verifyDelegation(delegationSigned, document.rootKey)
    } catch {
      throw new NetError('bad_delegation', 'The computer sent an invalid delegation.')
    }
    if (
      roster.owner !== document.user ||
      roster.authorityNode !== document.node ||
      delegation.owner !== document.user ||
      delegation.subject !== this.options.node ||
      delegation.name !== this.options.name ||
      !sameKeys(delegation.keys, this.options.keys.public) ||
      !roster.nodes.some((row) => sameJson(row, delegationSigned))
    )
      throw new NetError('bad_delegation', 'The computer sent an invalid delegation.')
    const authority = currentNode(roster, document.node, this.now())
    return {
      v: 1,
      user: document.user,
      rootKey: document.rootKey,
      node: this.options.node,
      authority: document.node,
      authorityName: authority.delegation.name,
      name: delegation.name,
      caps: delegation.caps,
      delegation: delegationSigned,
      roster: rosterSigned,
      routes: document.routes,
      enrolledAt: this.now(),
    }
  }

  private finish(result: Enrollment): void {
    if (this.done) return
    this.done = true
    clearTimeout(this.timer)
    this.mux.close()
    this.resolve(result)
  }

  private fail(error: unknown): void {
    if (this.done) return
    this.done = true
    clearTimeout(this.timer)
    this.mux.close(error instanceof Error ? error : new NetError('internal'))
    this.reject(error instanceof Error ? error : new NetError('internal'))
  }
}

function enrollErrorMessage(code: string): string {
  switch (code) {
    case 'invite_invalid':
      return 'The computer no longer accepts this invite. Create a new one.'
    case 'peer_key_mismatch':
      return 'This invite was made for another device.'
    case 'forbidden':
      return 'The computer refused to add this phone.'
    default:
      return `The computer could not add this phone (${code}).`
  }
}

/** Wraps an invite the way the desktop encodes it. Tests and the fake connection use this. */
export function encodeInvite(authorization: Signed, token: Uint8Array): string {
  return INVITE_PREFIX + b64url(canonicalJson({ v: 1, authorization, token: b64url(token) }))
}
