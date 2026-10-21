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
import { sha256, signDocument, type Signed } from '../../src/net/crypto'
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
    if (path === '/v1/net/config') return reply(CONFIG)
    if (path === '/v1/net/inventory')
      return reply({
        registrations: [
          { id: 'reg_c', userId: world.user.user, nodeId: world.computer.node, kind: 'computer', deviceName: 'Studio', online: true, generation: 1, expiresAt: now + 60_000, revokedAt: null },
          { id: 'reg_old', userId: world.user.user, nodeId: world.computer.node, kind: 'computer', deviceName: 'Studio', online: false, generation: 1, expiresAt: now - 1, revokedAt: null },
          { id: 'reg_gone', userId: world.user.user, nodeId: 'nod_gone', kind: 'computer', deviceName: 'Old', online: false, generation: 1, expiresAt: now, revokedAt: now - 5 },
          ...(world.phoneNode
            ? [{ id: 'reg_p', userId: world.user.user, nodeId: world.phoneNode, kind: 'phone', deviceName: 'Pixel', online: false, generation: 1, expiresAt: now + 60_000, revokedAt: world.phoneRevokedAt ?? null }]
            : []),
        ],
        bindings: world.hostedRoster ? [{ userId: world.user.user, rootKey: world.user.rootKey, roster: world.hostedRoster, revocations: {} }] : [],
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
      if (world.renewError) return reply({ error: { code: world.renewError } }, world.renewStatus ?? 403)
      world.registrationExpiresAt = now + (world.registrationMs ?? 60_000)
      return reply({ id: 'reg_p', accountId: 'acct_1', userId: world.user.user, nodeId: world.phoneNode, generation: registrations, expiresAt: world.registrationExpiresAt })
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
  renewStatus?: number
  /** Set on the phone's own registration in the inventory, as Mousse ID does once a roster revokes the phone. */
  phoneRevokedAt?: number
  /** The roster the user's computers last pushed to Mousse ID. */
  hostedRoster?: Signed
  onRequest?: (id: string, body: Record<string, unknown>) => void
  decide?: (id: string, polls: number) => { status?: string; sealedInvite?: string } | undefined
  /** How long a registration or renewal lasts; Mousse ID uses 60 seconds. */
  registrationMs?: number
  /** When the phone's current registration ends, as Mousse ID holds it. */
  registrationExpiresAt?: number
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
    const url = 'ws://192.168.1.5:41234/mousse-net'
    deps.openDirectChannel = async (target) => {
      expect(target.url).toBe(url)
      expect(target.expectedSpki).toEqual(w.computer.keys.transport.spki)
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
    await relay.answer('net.direct.endpoints', { endpoints: [{ url, kind: 'lan' }] })
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
})
