// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMousseConnection, type ConnectionDeps } from '../../src/connection'
import { manualNetworkSignals } from '../../src/connection/networkSignals'
import { memoryThreadCacheBackend, ThreadCache, type CachedThread } from '../../src/connection/threadCache'
import type { EnrollmentProgress } from '../../src/connection/types'
import type { FetchLike } from '../../src/mousseId/http'
import { sealForOffer, sealForRequest } from '../../src/mousseId/seal'
import { b64url, fromB64url, randomBytes } from '../../src/net/bytes'
import { canonicalJson, newId } from '../../src/net/canonical'
import { sha256, signDocument, x25519PublicKey, x25519Shared, type Signed } from '../../src/net/crypto'
import { lanKey, sealAdvertisement } from '../../src/net/lan'
import type { NativeLan } from '../../src/net/nativeLan'
import { encodeInvite, type Enrollment, type NodeInviteAuthorization, type RedeemOptions } from '../../src/net/enrollment'
import { NetError } from '../../src/net/errors'
import { MemoryKeyStorage } from '../../src/net/keys'
import { streamPair } from '../../src/net/stream'
import { delegate, roster, testComputer, testUser, type TestComputer, type TestUser } from '../net/fixtures'
import { channelOf, fakeComputer, until } from './helpers'

const ORIGIN = 'https://id.test'
const RELAY = 'wss://id.test/v1/net/relay'
const CONFIG = { protocol: 'mousse-plus/net-control/v1', installationId: 'inst_1', gatewayId: 'gw_1', relayAudience: RELAY, approvalOrigin: 'https://dash.test' }

interface Call {
  method: string
  path: string
  bearer?: string
  body?: Record<string, unknown>
}

/** A Mousse ID API with one account, one computer and scripted enrollment answers. */
function idServer(world: World) {
  const calls: Call[] = []
  const requests = new Map<string, { status: string; sealedInvite?: string; polls: number }>()
  let registrations = 0
  /** The registration's generation; renewing one that has ended moves it on, as Mousse ID does. */
  let generation = 0
  const fetcher: FetchLike = async (input, init) => {
    const url = new URL(input)
    const headers = init.headers as Record<string, string>
    const call: Call = {
      method: init.method!,
      path: url.pathname,
      bearer: headers.authorization?.replace(/^Bearer /, ''),
      body: init.body ? JSON.parse(init.body as string) : undefined,
    }
    calls.push(call)
    const reply = (body: unknown, status = 200) => new Response(body === undefined ? null : JSON.stringify(body), { status })
    const now = Date.now()
    const path = call.path
    if (path === '/v1/app/session/password')
      return reply({ accessToken: 'access-1', refreshToken: 'refresh-1', expiresAt: now + 3_600_000, account: { id: 'acct_1', email: 'a@b.test' } })
    if (path === '/v1/app/session/logout') return reply(undefined, 204)
    if (path === '/v1/net/config') return reply({ ...CONFIG, ...world.config })
    if (path === '/v1/net/inventory')
      return reply({
        registrations: [
          { id: 'reg_c', userId: world.user.user, nodeId: world.computer.node, kind: 'computer', deviceName: 'Studio', online: !world.computerOffline, generation: 1, expiresAt: now + 60_000, revokedAt: null },
          { id: 'reg_old', userId: world.user.user, nodeId: world.computer.node, kind: 'computer', deviceName: 'Studio', online: false, generation: 1, expiresAt: now - 1, revokedAt: null },
          { id: 'reg_gone', userId: world.user.user, nodeId: 'nod_gone', kind: 'computer', deviceName: 'Old', online: false, generation: 1, expiresAt: now, revokedAt: now - 5 },
          ...(world.phoneNode
            ? [{ id: 'reg_p', userId: world.user.user, nodeId: world.phoneNode, kind: 'phone', deviceName: 'Pixel', online: false, generation: 1, expiresAt: now + 60_000, revokedAt: world.phoneRevokedAt ?? null }]
            : []),
        ],
        bindings: [
          ...(world.hostedRoster ? [{ userId: world.user.user, rootKey: world.user.rootKey, roster: world.hostedRoster, revocations: {} }] : []),
          ...(world.otherBindings ?? []),
        ],
        limits: { maxComputers: 3 },
        devices: { used: 1, limit: 5 },
      })
    if (path === '/v1/net/enrollment-requests' && call.method === 'POST') {
      const id = `req_${requests.size + 1}`
      requests.set(id, { status: 'pending', polls: 0 })
      world.onRequest?.(id, call.body!)
      return reply({ id, expiresAt: now + 600_000 }, 201)
    }
    const requestMatch = /^\/v1\/net\/enrollment-requests\/(req_\d+)$/.exec(path)
    if (requestMatch) {
      const entry = requests.get(requestMatch[1])!
      entry.polls++
      const decided = world.decide?.(requestMatch[1], entry.polls)
      if (decided) Object.assign(entry, decided)
      const sealed = entry.sealedInvite
      if (sealed) {
        entry.sealedInvite = undefined
        entry.status = 'delivered'
        return reply({ id: requestMatch[1], status: 'approved', expiresAt: now + 600_000, sealedInvite: sealed })
      }
      return reply({ id: requestMatch[1], status: entry.status, expiresAt: now + 600_000 })
    }
    if (path === '/v1/net/enrollment-offers/off_1') return world.offer ? reply({ sealedInvite: world.offer }) : reply({ error: { code: 'expired' } }, 410)
    if (path === '/v1/net/challenges') {
      const body = call.body!
      return reply({
        v: 1,
        domain: 'mousse-plus/net-control/v1',
        installationId: CONFIG.installationId,
        audience: RELAY,
        challengeId: crypto.randomUUID(),
        nonce: b64url(new Uint8Array(32).fill(7)),
        accountId: 'acct_1',
        userId: body.userId,
        rootKey: body.rootKey,
        nodeId: body.nodeId,
        purpose: body.purpose,
        operationId: body.operationId,
        intentHash: b64url(sha256(canonicalJson(body.intent))),
        issuedAt: now,
        expiresAt: now + 60_000,
      })
    }
    if (path === '/v1/net/registrations') {
      registrations++
      const intent = call.body!
      world.phoneNode = String(calls.filter((c) => c.path === '/v1/net/challenges').at(-1)!.body!.nodeId)
      expect(intent.kind).toBe('phone')
      world.registrationExpiresAt = now + (world.registrationMs ?? 60_000)
      generation = registrations
      return reply(
        {
          registration: { id: 'reg_p', accountId: 'acct_1', userId: world.user.user, nodeId: world.phoneNode, generation: registrations, expiresAt: world.registrationExpiresAt },
          connectorToken: 'c'.repeat(40),
          relayAudience: RELAY,
        },
        201,
      )
    }
    if (path === '/v1/net/registrations/reg_p/renew') {
      await world.renewGate
      if (world.renewError) return reply({ error: { code: world.renewError } }, world.renewStatus ?? 403)
      // Mousse ID refuses an older generation as revoked.
      if (call.body!.generation !== generation) return reply({ error: { code: 'revoked' } }, 403)
      if ((world.registrationExpiresAt ?? 0) <= Date.now()) generation++
      world.registrationExpiresAt = Date.now() + (world.registrationMs ?? 60_000)
      return reply({ id: 'reg_p', accountId: 'acct_1', userId: world.user.user, nodeId: world.phoneNode, generation, expiresAt: world.registrationExpiresAt })
    }
    return reply({ error: { code: 'not_found' } }, 404)
  }
  return { calls, fetcher, requests }
}

interface World {
  user: TestUser
  computer: TestComputer
  phoneNode?: string
  offer?: string
  renewError?: string
  /** Holds renewals until it settles. */
  renewGate?: Promise<void>
  renewStatus?: number
  /** Set on the phone's own registration in the inventory, as Mousse ID does once a roster revokes the phone. */
  phoneRevokedAt?: number
  /** The roster the user's computers last pushed to Mousse ID. */
  hostedRoster?: Signed
  /** Rosters of other computers on the account, set up apart from the world's computer. */
  otherBindings?: Array<{ userId: string; roster: Signed; revocations: Record<string, unknown> }>
  onRequest?: (id: string, body: Record<string, unknown>) => void
  decide?: (id: string, polls: number) => { status?: string; sealedInvite?: string } | undefined
  /** How long a registration or renewal lasts; Mousse ID uses 60 seconds. */
  registrationMs?: number
  /** Extra fields in the Mousse ID configuration. */
  config?: Record<string, unknown>
  /** When the phone's current registration ends, as Mousse ID holds it. */
  registrationExpiresAt?: number
  /** Mousse ID reports the computer offline (it cannot reach Mousse ID). */
  computerOffline?: boolean
}

/**
 * The hosted relay's lease rule (mousse-plus `NetRelayGateway.scheduleLease`): an admission lasts
 * until min(now + lease, registration end) and is renewed every `renewalMs`; the expiry timer is
 * armed before the renewal timer, so an admission that reaches its end before a renewal extends it
 * closes the circuit.
 */
function hostedRelayLease(w: World, close: () => void, timing: { renewalMs: number; leaseMs: number }): () => void {
  let expiry: ReturnType<typeof setTimeout> | undefined
  let renewal: ReturnType<typeof setTimeout> | undefined
  const schedule = () => {
    clearTimeout(expiry)
    clearTimeout(renewal)
    const expiresAt = Math.min(Date.now() + timing.leaseMs, w.registrationExpiresAt ?? 0)
    expiry = setTimeout(close, expiresAt - Date.now())
    renewal = setTimeout(schedule, timing.renewalMs)
  }
  schedule()
  return () => {
    clearTimeout(expiry)
    clearTimeout(renewal)
  }
}

function world(): World {
  const user = testUser()
  return { user, computer: testComputer(user) }
}

/** A real invite text from the world's computer, carrying the hosted relay rendezvous. */
function invite(w: World, name?: string): string {
  const issuedAt = Date.now() - 500
  const expiresAt = issuedAt + 10 * 60_000
  const routes = signDocument(
    { v: 1, node: w.computer.node, routes: [{ transport: 'plus-relay', address: `${RELAY}?node=${w.computer.node}`, priority: 0 }], version: 1, issuedAt },
    w.computer.keys.signSecret,
  )
  const token = randomBytes(32)
  const document: NodeInviteAuthorization = {
    v: 1,
    kind: 'nodeInvite',
    invite: newId('invite'),
    user: w.user.user,
    node: w.computer.node,
    rootKey: w.user.rootKey,
    roster: roster(w.user, w.computer.node),
    delegation: w.computer.delegation,
    routes,
    transportFingerprint: b64url(sha256(w.computer.keys.transport.spki)),
    tokenHash: b64url(sha256(token)),
    issuedAt,
    expiresAt,
    caps: ['read', 'chat'],
    ...(name ? { name } : {}),
    rendezvous: { transport: 'plus-relay', relay: RELAY, ticket: b64url(randomBytes(32)), expiresAt },
  }
  return encodeInvite(signDocument(document, w.computer.keys.signSecret), token)
}

/** Stands in for the enrollment handshake: the computer delegates the phone's keys. */
function fakeRedeem(w: World, seen: RedeemOptions[]) {
  return async (options: RedeemOptions): Promise<Enrollment> => {
    seen.push(options)
    const delegation = delegate(w.user, options.node, options.keys, { name: options.name, caps: ['read', 'chat'] })
    return {
      v: 1,
      user: w.user.user,
      rootKey: w.user.rootKey,
      node: options.node,
      authority: w.computer.node,
      authorityName: 'Studio',
      name: options.name,
      caps: ['read', 'chat'],
      delegation,
      roster: roster(w.user, w.computer.node),
      routes: signDocument({ v: 1 }, w.computer.keys.signSecret),
      enrolledAt: Date.now(),
    }
  }
}

async function connect(w: World, extra: Partial<ConnectionDeps> = {}) {
  const server = idServer(w)
  const storage = new MemoryKeyStorage()
  const redeemed: RedeemOptions[] = []
  // These tests script the computer's answers in order; the direct path search has its own tests.
  const deps: ConnectionDeps = {
    origin: ORIGIN,
    storage,
    fetcher: server.fetcher,
    redeem: fakeRedeem(w, redeemed),
    pollMs: 1,
    network: manualNetworkSignals(),
    paths: { autoProbe: false },
    ...extra,
  }
  const connection = await createMousseConnection(deps)
  return { connection, server, storage, redeemed, deps }
}

/** A signed-in connection with the phone added to the world's computer by QR code. */
async function enrolled(setup: (w: World) => void = () => undefined, extra: Partial<ConnectionDeps> = {}) {
  const w = world()
  setup(w)
  const { connection, storage, deps, server } = await connect(w, extra)
  await connection.signInWithPassword('a@b.test', 'pw')
  w.offer = sealForOffer(invite(w), new Uint8Array(32).fill(3))
  await connection.enrollFromQr(`mousse://net/join?v=1&plus=${encodeURIComponent(ORIGIN)}&offer=off_1&key=${b64url(new Uint8Array(32).fill(3))}`, () => undefined)
  expect((await connection.listComputers()).find((c) => c.nodeId === w.computer.node)?.enrolled).toBe(true)
  return { w, connection, storage, deps, server }
}

async function stored(storage: MemoryKeyStorage): Promise<unknown[]> {
  return JSON.parse((await storage.getItem('net.enrollments')) ?? '[]') as unknown[]
}

afterEach(() => {
  vi.useRealTimers()
})

const SAVED: CachedThread = { stream: 'str_t1', head: { epoch: 1, seq: 3 }, state: { messages: [], active: false }, savedAt: 1 }

describe('real connection without a Mousse ID server', () => {
  it('loads signed out and explains every sign-in attempt', async () => {
    const connection = await createMousseConnection({ origin: '', storage: new MemoryKeyStorage() })
    expect(connection.account()).toEqual({ status: 'signed-out' })
    await expect(connection.signInWithPassword('a@b.test', 'pw')).rejects.toThrow('This build has no Mousse ID server configured.')
    await expect(connection.signInWithGoogle()).rejects.toThrow('This build has no Mousse ID server configured.')
    await expect(connection.openSignUp()).rejects.toThrow('This build has no Mousse ID server configured.')
    await expect(connection.listComputers()).rejects.toThrow('This build has no Mousse ID server configured.')
    await connection.signOut()
  })

  it('rejects an origin that is not https', async () => {
    const connection = await createMousseConnection({ origin: 'http://id.test', storage: new MemoryKeyStorage() })
    await expect(connection.signInWithPassword('a@b.test', 'pw')).rejects.toMatchObject({ code: 'not_configured' })
  })
})

describe('real connection', () => {
  it('signs in, reports devices and lists computers once', async () => {
    const w = world()
    const { connection, storage } = await connect(w)
    const states: unknown[] = []
    connection.onAccountChange((state) => states.push(state))
    await connection.signInWithPassword('a@b.test', 'pw')
    expect(connection.account()).toMatchObject({ status: 'signed-in', account: { id: 'acct_1', email: 'a@b.test' }, idOrigin: ORIGIN })

    const computers = await connection.listComputers()
    expect(computers).toEqual([{ nodeId: w.computer.node, name: 'Studio', kind: 'computer', online: true, enrolled: false }])
    expect(connection.account()).toMatchObject({ devices: { used: 1, limit: 5 } })
    expect(states.length).toBeGreaterThan(0)

    // The session survives a restart.
    const again = await createMousseConnection({ origin: ORIGIN, storage, fetcher: idServer(w).fetcher })
    expect(again.account()).toMatchObject({ status: 'signed-in' })
  })

  it('returns the same account object until the account changes', async () => {
    // useSyncExternalStore re-renders forever when the snapshot is a new object each time.
    const { connection } = await connect(world())
    const signedOut = connection.account()
    expect(connection.account()).toBe(signedOut)
    await connection.signInWithPassword('a@b.test', 'pw')
    const signedIn = connection.account()
    expect(signedIn).not.toBe(signedOut)
    expect(connection.account()).toBe(signedIn)
  })

  it('opens the sign-up page of the configured server', async () => {
    const opened: string[] = []
    const { connection } = await connect(world(), { openExternal: async (url) => void opened.push(url) })
    await connection.openSignUp()
    expect(opened).toEqual(['https://dash.test/signup'])
  })

  it('enrolls through an approved request, registers the phone and opens the computer', async () => {
    const w = world()
    let boxKey = ''
    w.onRequest = (_id, body) => {
      boxKey = String(body.boxPublicKey)
      expect(body).toMatchObject({ targetNodeId: w.computer.node, deviceName: 'Pixel', kind: 'phone' })
      expect(String(body.transportFingerprint)).toMatch(/^[A-Za-z0-9_-]{43}$/)
    }
    w.decide = (id, polls) => (polls === 2 ? { status: 'approved', sealedInvite: sealForRequest(invite(w), fromB64url(boxKey, 32), id) } : undefined)
    const { connection, server, redeemed, deps } = await connect(w)
    await connection.signInWithPassword('a@b.test', 'pw')

    const progress: EnrollmentProgress[] = []
    await connection.enrollWithComputer(w.computer.node, 'Pixel', (p) => progress.push(p))
    expect(progress.map((p) => p.stage)).toEqual(['requesting', 'waiting-approval', 'connecting', 'done'])
    expect(progress[1].matchCode).toMatch(/^\d{6}$/)
    expect(redeemed[0]).toMatchObject({ name: 'Pixel' })
    expect(redeemed[0].node).toBe(w.phoneNode)
    expect(server.calls.filter((call) => call.path === '/v1/net/registrations')).toHaveLength(1)

    const computers = await connection.listComputers()
    expect(computers.find((c) => c.nodeId === w.computer.node)?.enrolled).toBe(true)

    // Open: the stored registration is still fresh, so no new registration; the session runs over the injected channel.
    let remote: ReturnType<typeof fakeComputer> | undefined
    deps.openChannel = async (target) => {
      expect(target.route).toBe(`${RELAY}?node=${w.computer.node}`)
      expect(target.grant.registration.id).toBe('reg_p')
      expect(target.expectedSpki).toEqual(w.computer.keys.transport.spki)
      const [a, b] = streamPair()
      remote = fakeComputer(b, w.user, w.computer, roster(w.user, w.computer.node))
      void remote.handshake()
      return channelOf(a, w.computer.keys.transport.spki)
    }
    const session = await connection.openComputer(w.computer.node)
    expect(session.state()).toBe('open')
    const projects = session.listProjects()
    await remote!.answer('projects.list', { projects: [{ id: 'p1', name: 'Site' }] })
    expect(await projects).toEqual([{ id: 'p1', name: 'Site' }])
    session.close()
    expect(server.calls.filter((call) => call.path === '/v1/net/registrations')).toHaveLength(1)
  })

  it('renews the registration while a session is open and closes it when Mousse ID revokes the phone', async () => {
    const w = world()
    const { connection, server, deps } = await connect(w, { renewMs: 20 })
    await connection.signInWithPassword('a@b.test', 'pw')
    w.offer = sealForOffer(invite(w), new Uint8Array(32).fill(3))
    await connection.enrollFromQr(`mousse://net/join?v=1&plus=${encodeURIComponent(ORIGIN)}&offer=off_1&key=${b64url(new Uint8Array(32).fill(3))}`, () => undefined)
    deps.openChannel = async () => {
      const [a, b] = streamPair()
      void fakeComputer(b, w.user, w.computer, roster(w.user, w.computer.node)).handshake()
      return channelOf(a, w.computer.keys.transport.spki)
    }
    const session = await connection.openComputer(w.computer.node)
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(server.calls.filter((call) => call.path === '/v1/net/registrations/reg_p/renew').length).toBeGreaterThan(0)
    w.renewError = 'revoked'
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(session.state()).toBe('closed')
    expect(session.endReason()).toBe('removed')
    expect((await connection.listComputers()).find((c) => c.nodeId === w.computer.node)?.enrolled).toBe(false)
  })

  it('moves the session to the computer\'s direct path and keeps renewing the registration there', async () => {
    const w = world()
    const network = manualNetworkSignals()
    const { connection, server, deps } = await connect(w, { renewMs: 20, network, paths: { autoProbe: false, settleMs: 1 } })
    await connection.signInWithPassword('a@b.test', 'pw')
    w.offer = sealForOffer(invite(w), new Uint8Array(32).fill(3))
    await connection.enrollFromQr(`mousse://net/join?v=1&plus=${encodeURIComponent(ORIGIN)}&offer=off_1&key=${b64url(new Uint8Array(32).fill(3))}`, () => undefined)
    const answerPings = (remote: ReturnType<typeof fakeComputer>, delayMs: number) =>
      void (async () => {
        for (;;) {
          const ping = await remote.next('ping')
          setTimeout(() => void remote.send({ t: 'pong', n: ping.n, now: Date.now() }).catch(() => undefined), delayMs)
        }
      })()
    let relay!: ReturnType<typeof fakeComputer>
    let direct!: ReturnType<typeof fakeComputer>
    deps.openChannel = async () => {
      const [a, b] = streamPair()
      relay = fakeComputer(b, w.user, w.computer, roster(w.user, w.computer.node))
      void relay.handshake()
      answerPings(relay, 30)
      return channelOf(a, w.computer.keys.transport.spki)
    }
    deps.openDirectChannel = async (target) => {
      expect(target.expectedSpki).toEqual(w.computer.keys.transport.spki)
      // The offer goes to the computer over the relay session.
      expect(await target.link.rpc('net.direct.webrtc.offer', { sdp: 'v=0 offer', v: 1 })).toEqual({ sdp: 'v=0 answer' })
      const [a, b] = streamPair()
      direct = fakeComputer(b, w.user, w.computer, roster(w.user, w.computer.node))
      void direct.handshake()
      answerPings(direct, 0)
      return channelOf(a, w.computer.keys.transport.spki)
    }
    const session = await connection.openComputer(w.computer.node)
    const states: string[] = []
    session.onStateChange((state) => states.push(state))
    // The phone joins a network: it checks its path and asks the computer for direct endpoints.
    network.fire()
    await relay.answer('net.direct.endpoints', { endpoints: [], webrtc: { v: 1 } })
    expect((await relay.answer('net.direct.webrtc.offer', { sdp: 'v=0 answer' })).params).toEqual({ sdp: 'v=0 offer', v: 1 })
    await until(() => !!direct, 200)
    const renewalsBefore = () => server.calls.filter((call) => call.path === '/v1/net/registrations/reg_p/renew').length
    await new Promise((resolve) => setTimeout(resolve, 100))
    const projects = session.listProjects()
    await direct.answer('projects.list', { projects: [{ id: 'p1', name: 'Site' }] })
    expect(await projects).toEqual([{ id: 'p1', name: 'Site' }])
    const renewed = renewalsBefore()
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(renewalsBefore()).toBeGreaterThan(renewed)
    expect(session.state()).toBe('open')
    expect(states).toEqual([])
    session.close()
  })

  it('never looks for a direct path when Mousse ID switches WebRTC off, or on iOS', async () => {
    for (const setup of [{ config: { directWebrtc: false } }, { platform: 'ios' }]) {
      const w = world()
      if (setup.config) w.config = setup.config
      const network = manualNetworkSignals()
      const { connection, deps } = await connect(w, { network, paths: { autoProbe: false, settleMs: 1 }, ...(setup.platform ? { platform: setup.platform } : {}) })
      await connection.signInWithPassword('a@b.test', 'pw')
      w.offer = sealForOffer(invite(w), new Uint8Array(32).fill(3))
      await connection.enrollFromQr(`mousse://net/join?v=1&plus=${encodeURIComponent(ORIGIN)}&offer=off_1&key=${b64url(new Uint8Array(32).fill(3))}`, () => undefined)
      let relay!: ReturnType<typeof fakeComputer>
      deps.openChannel = async () => {
        const [a, b] = streamPair()
        relay = fakeComputer(b, w.user, w.computer, roster(w.user, w.computer.node))
        void relay.handshake()
        return channelOf(a, w.computer.keys.transport.spki)
      }
      let dialed = false
      deps.openDirectChannel = async () => {
        dialed = true
        throw new NetError('route_unreachable')
      }
      const session = await connection.openComputer(w.computer.node)
      network.fire()
      // The first request the computer sees is the caller's, not the endpoints question.
      await new Promise((resolve) => setTimeout(resolve, 40))
      const projects = session.listProjects()
      expect((await relay.answer('projects.list', { projects: [] })).method).toBe('projects.list')
      await projects
      expect(dialed).toBe(false)
      session.close()
    }
  })

  it('keeps a session open over the hosted relay for several registration lifetimes', async () => {
    // Scaled from production: 60 s registrations, a 30 s relay renewal and a 60 s lease cap.
    const { w, connection, deps } = await enrolled((w) => (w.registrationMs = 600))
    let relayClosed = false
    const stops: Array<() => void> = []
    deps.openChannel = async () => {
      const [a, b] = streamPair()
      void fakeComputer(b, w.user, w.computer, roster(w.user, w.computer.node)).handshake()
      stops.push(
        hostedRelayLease(
          w,
          () => {
            relayClosed = true
            b.close()
          },
          { renewalMs: 300, leaseMs: 600 },
        ),
      )
      return channelOf(a, w.computer.keys.transport.spki)
    }
    const session = await connection.openComputer(w.computer.node)
    try {
      await new Promise((resolve) => setTimeout(resolve, 2_000))
      expect(relayClosed).toBe(false)
      expect(session.state()).toBe('open')
    } finally {
      session.close()
      for (const stop of stops) stop()
    }
  })

  it('renews one at a time, so renewing after the phone slept never ends the session or forgets the computer', async () => {
    const { w, connection, deps, server } = await enrolled((w) => (w.registrationMs = 30_000), { renewMs: 50 })
    const relays: Array<{ close(): void }> = []
    deps.openChannel = async () => {
      const [a, b] = streamPair()
      void fakeComputer(b, w.user, w.computer, roster(w.user, w.computer.node)).handshake()
      relays.push(b)
      return channelOf(a, w.computer.keys.transport.spki)
    }
    const session = await connection.openComputer(w.computer.node)
    const renewals = () => server.calls.filter((call) => call.path === '/v1/net/registrations/reg_p/renew').length
    // The phone slept past the registration's end and the relay closed meanwhile. On waking, the
    // renewal timer and the new relay path both renew, while Mousse ID answers slowly.
    w.registrationExpiresAt = Date.now() - 1
    let release!: () => void
    w.renewGate = new Promise((resolve) => (release = resolve))
    const before = renewals()
    await until(() => renewals() > before)
    relays[0].close()
    await new Promise((resolve) => setTimeout(resolve, 50))
    release()
    await until(() => relays.length === 2)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(session.state()).toBe('open')
    expect((await connection.listComputers()).find((c) => c.nodeId === w.computer.node)?.enrolled).toBe(true)
    session.close()
  })

  it('forgets the computer when it refuses this phone as revoked on open', async () => {
    const { w, connection, storage, deps } = await enrolled()
    deps.openChannel = async () => {
      throw new NetError('revoked', 'This device was revoked.')
    }
    await expect(connection.openComputer(w.computer.node)).rejects.toThrow('Studio removed this phone. Add it again to reconnect.')
    expect(await stored(storage)).toEqual([])
    expect((await connection.listComputers()).find((c) => c.nodeId === w.computer.node)?.enrolled).toBe(false)
    await expect(connection.openComputer(w.computer.node)).rejects.toThrow('Add this phone to that computer first.')
  })

  it('renews with the newest roster a computer sent during the session, not the one it enrolled with', async () => {
    const { w, connection, deps, server } = await enrolled(undefined, { renewMs: 20 })
    let remote: ReturnType<typeof fakeComputer> | undefined
    deps.openChannel = async () => {
      const [a, b] = streamPair()
      remote = fakeComputer(b, w.user, w.computer, roster(w.user, w.computer.node))
      void remote.handshake()
      return channelOf(a, w.computer.keys.transport.spki)
    }
    const session = await connection.openComputer(w.computer.node)
    expect(session.state()).toBe('open')
    // Another computer joins: the account's roster moves on while this session stays open.
    testComputer(w.user, 'Mac mini')
    const newer = roster(w.user, w.computer.node)
    await remote!.send({ t: 'rosterUpdate', roster: newer })
    const renewals = () => server.calls.filter((call) => call.path === '/v1/net/registrations/reg_p/renew')
    const before = renewals().length
    await until(() => renewals().length > before + 1, 400)
    expect(renewals().at(-1)!.body!.roster).toEqual(newer)
    expect(session.state()).toBe('open')
    session.close()
  })

  it('refuses a request from the computer and keeps the session open', async () => {
    const { w, connection, deps } = await enrolled()
    let remote: ReturnType<typeof fakeComputer> | undefined
    deps.openChannel = async () => {
      const [a, b] = streamPair()
      remote = fakeComputer(b, w.user, w.computer, roster(w.user, w.computer.node))
      void remote.handshake()
      return channelOf(a, w.computer.keys.transport.spki)
    }
    const session = await connection.openComputer(w.computer.node)
    expect(session.state()).toBe('open')
    // A computer asks every device for its version once a session opens.
    await remote!.send({ t: 'rpc.request', id: 'rpc_version', method: 'net.info', params: {}, deadlineMs: 10_000 })
    const answer = await remote!.next('rpc.result')
    expect(answer).toMatchObject({ id: 'rpc_version', error: { code: 'forbidden' } })
    expect(session.state()).toBe('open')
    session.close()
  })

  it('ends the session and forgets the computer when a roster removing this phone arrives', async () => {
    const { w, connection, storage, deps } = await enrolled()
    let remote: ReturnType<typeof fakeComputer> | undefined
    deps.openChannel = async () => {
      const [a, b] = streamPair()
      remote = fakeComputer(b, w.user, w.computer, roster(w.user, w.computer.node))
      void remote.handshake()
      return channelOf(a, w.computer.keys.transport.spki)
    }
    const session = await connection.openComputer(w.computer.node)
    expect(session.state()).toBe('open')
    w.user.revoked.push({ subject: w.phoneNode!, throughKeyEpoch: 1, revokedAt: Date.now() - 500 })
    await remote!.send({ t: 'rosterUpdate', roster: roster(w.user, w.computer.node) })
    await until(() => session.state() === 'closed')
    expect(session.endReason()).toBe('removed')
    expect((await connection.listComputers()).find((c) => c.nodeId === w.computer.node)?.enrolled).toBe(false)
    expect(await stored(storage)).toEqual([])
  })

  it('forgets the computer when Mousse ID shows the phone was revoked while offline', async () => {
    const { w, connection, storage } = await enrolled()
    w.phoneRevokedAt = Date.now() - 100
    expect((await connection.listComputers()).find((c) => c.nodeId === w.computer.node)?.enrolled).toBe(false)
    expect(await stored(storage)).toEqual([])
  })

  it('forgets the computer when the roster pushed to Mousse ID removes this phone, even while it was offline', async () => {
    const { w, connection, storage } = await enrolled()
    w.user.revoked.push({ subject: w.phoneNode!, throughKeyEpoch: 1, revokedAt: Date.now() - 500 })
    w.hostedRoster = roster(w.user, w.computer.node)
    expect((await connection.listComputers()).find((c) => c.nodeId === w.computer.node)?.enrolled).toBe(false)
    expect(await stored(storage)).toEqual([])
  })

  it('keeps the computer on transient failures and account session refusals', async () => {
    const { w, connection, storage, deps } = await enrolled()
    for (const code of ['peer_offline', 'route_unreachable', 'deadline_exceeded']) {
      deps.openChannel = async () => {
        throw new NetError(code, 'Not now.')
      }
      await expect(connection.openComputer(w.computer.node)).rejects.toThrow()
      expect(await stored(storage)).toHaveLength(1)
    }
    // An expired lease needs Mousse ID; it refuses the renewal for an account reason.
    vi.useFakeTimers({ now: Date.now() + 120_000, toFake: ['Date'] })
    w.renewError = 'forbidden'
    w.renewStatus = 403
    deps.openChannel = async () => {
      throw new NetError('peer_offline', 'Not now.')
    }
    await expect(connection.openComputer(w.computer.node)).rejects.toThrow()
    w.renewError = 'unauthorized'
    w.renewStatus = 401
    await expect(connection.openComputer(w.computer.node)).rejects.toThrow()
    expect(await stored(storage)).toHaveLength(1)
    vi.useRealTimers()
    expect((await connection.listComputers()).find((c) => c.nodeId === w.computer.node)?.enrolled).toBe(true)
  })

  it('reports a denied request and an unknown computer', async () => {
    const w = world()
    w.decide = () => ({ status: 'denied' })
    const { connection } = await connect(w)
    await connection.signInWithPassword('a@b.test', 'pw')
    const progress: EnrollmentProgress[] = []
    await expect(connection.enrollWithComputer(w.computer.node, 'Pixel', (p) => progress.push(p))).rejects.toThrow(/declined/)
    expect(progress.at(-1)).toMatchObject({ stage: 'denied' })
    await expect(connection.openComputer(w.computer.node)).rejects.toThrow('Add this phone to that computer first.')
  })

  it('refuses a QR code for another server', async () => {
    const { connection } = await connect(world())
    await connection.signInWithPassword('a@b.test', 'pw')
    const progress: EnrollmentProgress[] = []
    const key = b64url(new Uint8Array(32))
    await expect(
      connection.enrollFromQr(`mousse://net/join?v=1&plus=${encodeURIComponent('https://other.test')}&offer=off_1&key=${key}`, (p) => progress.push(p)),
    ).rejects.toThrow(/another Mousse ID server/)
    expect(progress).toEqual([{ stage: 'error', message: expect.stringMatching(/another Mousse ID server/) }])
  })

  it('clears saved threads of a computer that removed this phone', async () => {
    const backend = memoryThreadCacheBackend()
    const threadCache = new ThreadCache(backend)
    const { w, connection, deps } = await enrolled(() => undefined, { threadCache })
    threadCache.scope('acct_1', w.computer.node).write('t1', SAVED)
    threadCache.scope('acct_1', 'nod_other').write('t1', SAVED)
    await threadCache.settle()
    deps.openChannel = async () => {
      throw new NetError('revoked', 'This device was revoked.')
    }
    await expect(connection.openComputer(w.computer.node)).rejects.toThrow(/removed this phone/)
    await threadCache.settle()
    expect([...backend.index.values()].map((row) => row.nodeId)).toEqual(['nod_other'])
  })

  it('clears saved threads when a roster removing this phone ends an open session', async () => {
    const backend = memoryThreadCacheBackend()
    const threadCache = new ThreadCache(backend)
    const { w, connection, deps } = await enrolled(() => undefined, { threadCache })
    let remote: ReturnType<typeof fakeComputer> | undefined
    deps.openChannel = async () => {
      const [a, b] = streamPair()
      remote = fakeComputer(b, w.user, w.computer, roster(w.user, w.computer.node))
      void remote.handshake()
      return channelOf(a, w.computer.keys.transport.spki)
    }
    const session = await connection.openComputer(w.computer.node)
    threadCache.scope('acct_1', w.computer.node).write('t1', SAVED)
    await threadCache.settle()
    expect(backend.data.size).toBe(1)
    w.user.revoked.push({ subject: w.phoneNode!, throughKeyEpoch: 1, revokedAt: Date.now() - 500 })
    await remote!.send({ t: 'rosterUpdate', roster: roster(w.user, w.computer.node) })
    await until(() => session.state() === 'closed')
    expect(session.endReason()).toBe('removed')
    await threadCache.settle()
    expect(backend.data.size).toBe(0)
    expect(threadCache.scope('acct_1', w.computer.node).peek('t1')).toBeUndefined()
  })

  it('clears saved threads on sign-out', async () => {
    const backend = memoryThreadCacheBackend()
    const threadCache = new ThreadCache(backend)
    const { w, connection } = await enrolled(() => undefined, { threadCache })
    threadCache.scope('acct_1', w.computer.node).write('t1', SAVED)
    threadCache.scope('acct_other', w.computer.node).write('t1', SAVED)
    await threadCache.settle()
    await connection.signOut()
    await threadCache.settle()
    expect([...backend.index.values()].map((row) => row.accountId)).toEqual(['acct_other'])
  })

  it('forgets relay credentials but keeps enrollments on sign-out', async () => {
    const w = world()
    const { connection, storage } = await connect(w)
    await connection.signInWithPassword('a@b.test', 'pw')
    w.offer = sealForOffer(invite(w, 'Phone'), new Uint8Array(32).fill(4))
    await connection.enrollFromQr(`mousse://net/join?v=1&plus=${encodeURIComponent(ORIGIN)}&offer=off_1&key=${b64url(new Uint8Array(32).fill(4))}`, () => undefined)
    const read = async () => JSON.parse((await storage.getItem('net.enrollments'))!) as Array<{ grant?: unknown }>
    expect((await read())[0].grant).toBeTruthy()
    await connection.signOut()
    expect(connection.account()).toEqual({ status: 'signed-out' })
    const after = await read()
    expect(after).toHaveLength(1)
    expect(after[0].grant).toBeUndefined()
  })

  it('plans to join through the computer that adds devices, and never again once joined', async () => {
    const w = world()
    w.hostedRoster = roster(w.user, w.computer.node)
    let boxKey = ''
    w.onRequest = (_id, body) => {
      boxKey = String(body.boxPublicKey)
    }
    w.decide = (id) => (boxKey ? { status: 'approved', sealedInvite: sealForRequest(invite(w), fromB64url(boxKey, 32), id) } : undefined)
    const { connection } = await connect(w)
    await connection.signInWithPassword('a@b.test', 'pw')

    expect(await connection.joinPlan()).toEqual({ status: 'needed', target: { nodeId: w.computer.node, name: 'Studio', online: true } })
    expect((await connection.listComputers()).find((c) => c.nodeId === w.computer.node)).toMatchObject({ authority: true, enrolled: false })

    await connection.enrollWithComputer(w.computer.node, 'Pixel', () => undefined)
    expect(await connection.joinPlan()).toEqual({ status: 'joined' })
  })

  it('has nothing to join while the account has no computer roster', async () => {
    const { connection } = await connect(world())
    await connection.signInWithPassword('a@b.test', 'pw')
    expect(await connection.joinPlan()).toEqual({ status: 'none' })
  })

  it('joins the roster with the most devices when the account has several', async () => {
    const w = world()
    testComputer(w.user, 'Laptop')
    w.hostedRoster = roster(w.user, w.computer.node)
    const other = testUser()
    const lone = testComputer(other, 'Lone')
    w.otherBindings = [{ userId: other.user, roster: roster(other, lone.node), revocations: {} }]
    const { connection } = await connect(w)
    await connection.signInWithPassword('a@b.test', 'pw')
    expect(await connection.joinPlan()).toMatchObject({ status: 'needed', target: { nodeId: w.computer.node } })

    // The same account with the other roster larger.
    testComputer(other, 'Two')
    testComputer(other, 'Three')
    w.otherBindings = [{ userId: other.user, roster: roster(other, lone.node), revocations: {} }]
    // That computer has no registration with Mousse ID: it is offline and named from the roster.
    expect(await connection.joinPlan()).toEqual({ status: 'needed', target: { nodeId: lone.node, name: 'Lone', online: false } })
  })

  it('does not join again on its own after the computers removed the phone, until the user signs in again', async () => {
    const { w, connection } = await enrolled((world) => {
      world.hostedRoster = roster(world.user, world.computer.node)
    })
    expect(await connection.joinPlan()).toEqual({ status: 'joined' })
    w.user.revoked.push({ subject: w.phoneNode!, throughKeyEpoch: 1, revokedAt: Date.now() - 500 })
    w.hostedRoster = roster(w.user, w.computer.node)
    expect(await connection.joinPlan()).toEqual({ status: 'removed', computer: 'Studio' })
    expect(await connection.joinPlan()).toEqual({ status: 'removed', computer: 'Studio' })

    await connection.allowRejoin()
    expect(await connection.joinPlan()).toMatchObject({ status: 'needed', target: { nodeId: w.computer.node } })
  })

  it('lets a removed phone join again after signing in again', async () => {
    const { w, connection } = await enrolled((world) => {
      world.hostedRoster = roster(world.user, world.computer.node)
    })
    w.user.revoked.push({ subject: w.phoneNode!, throughKeyEpoch: 1, revokedAt: Date.now() - 500 })
    w.hostedRoster = roster(w.user, w.computer.node)
    expect(await connection.joinPlan()).toMatchObject({ status: 'removed' })
    await connection.signOut()
    await connection.signInWithPassword('a@b.test', 'pw')
    expect(await connection.joinPlan()).toMatchObject({ status: 'needed' })
  })
})

/** The phone's native LAN plugin as the test drives it: advertisements arrive when the test sends them. */
function testLan() {
  let deliver: ((packet: Uint8Array, source: string) => void) | undefined
  const lan: NativeLan = {
    dial: async () => {
      throw new Error('The test opens LAN channels itself.')
    },
    advertisements: {
      start: async (onPacket) => {
        deliver = onPacket
      },
      stop: async () => {
        deliver = undefined
      },
    },
  }
  return {
    lan,
    listening: () => !!deliver,
    /** `from` advertises its LAN port to the phone whose agreement secret is `phoneAgree`. */
    advertise(from: TestComputer, phoneAgree: string, port = 40123, source = '192.168.1.20') {
      const key = lanKey(x25519Shared(from.keys.agreeSecret, x25519PublicKey(fromB64url(phoneAgree, 32))), from.node)
      deliver?.(sealAdvertisement(key, port, Date.now(), randomBytes(12), randomBytes(6)), source)
    },
  }
}

const noLifecycle = { onPause() {}, onResume() {} }

describe('real connection on the same Wi-Fi without the internet', () => {
  it('lists and opens the computer on the LAN after the app restarts with Mousse ID out of reach', async () => {
    const before = testLan()
    const { w, storage, deps } = await enrolled(undefined, { lan: before.lan, lifecycle: noLifecycle })
    expect(before.listening()).toBe(true)
    // The app starts again with no internet: every Mousse ID request fails.
    const offline: string[] = []
    const after = testLan()
    const targets: Array<{ node: string; host: string; port: number }> = []
    let remote: ReturnType<typeof fakeComputer> | undefined
    const connection = await createMousseConnection({
      ...deps,
      storage,
      lan: after.lan,
      lifecycle: noLifecycle,
      fetcher: async (input) => {
        offline.push(new URL(input).pathname)
        throw new TypeError('Network request failed')
      },
      openChannel: async () => {
        throw new Error('The relay is not reachable.')
      },
      openLanChannel: async (target) => {
        targets.push({ node: target.node, host: target.host, port: target.port })
        expect(target.expectedSpki).toEqual(w.computer.keys.transport.spki)
        const [a, b] = streamPair()
        remote = fakeComputer(b, w.user, w.computer, roster(w.user, w.computer.node))
        void remote.handshake()
        return channelOf(a, w.computer.keys.transport.spki)
      },
    })
    expect(after.listening()).toBe(true)
    // Last listed computers, offline until the computer is seen here.
    expect((await connection.listComputers()).find((c) => c.nodeId === w.computer.node)).toMatchObject({ enrolled: true, online: false })
    const phoneAgree = ((await stored(storage))[0] as { keys: { agree: string } }).keys.agree
    // An advertisement from a computer that is not this phone's opens nothing.
    after.advertise(testComputer(testUser()), phoneAgree)
    expect((await connection.listComputers()).find((c) => c.nodeId === w.computer.node)?.online).toBe(false)
    const changed = vi.fn()
    connection.onComputersChange?.(changed)
    after.advertise(w.computer, phoneAgree)
    expect(changed).toHaveBeenCalled()
    expect((await connection.listComputers()).find((c) => c.nodeId === w.computer.node)?.online).toBe(true)

    const session = await connection.openComputer(w.computer.node)
    expect(session.state()).toBe('open')
    expect(targets).toEqual([{ node: w.computer.node, host: '192.168.1.20', port: 40123 }])
    const projects = session.listProjects()
    await remote!.answer('projects.list', { projects: [{ id: 'p1', name: 'Site' }] })
    expect(await projects).toEqual([{ id: 'p1', name: 'Site' }])
    // The LAN needs no registration with Mousse ID.
    expect(offline.filter((path) => path.startsWith('/v1/net/registrations'))).toEqual([])
    session.close()
  })

  it('shows a computer online that Mousse ID reports offline but this network sees', async () => {
    const lan = testLan()
    const { w, connection, storage } = await enrolled(undefined, { lan: lan.lan, lifecycle: noLifecycle })
    w.computerOffline = true
    expect((await connection.listComputers()).find((c) => c.nodeId === w.computer.node)?.online).toBe(false)
    const phoneAgree = ((await stored(storage))[0] as { keys: { agree: string } }).keys.agree
    lan.advertise(w.computer, phoneAgree)
    expect((await connection.listComputers()).find((c) => c.nodeId === w.computer.node)?.online).toBe(true)
  })
})
