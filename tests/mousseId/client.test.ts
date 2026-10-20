// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { b64url, fromB64url } from '../../src/net/bytes'
import { canonicalJson, newId } from '../../src/net/canonical'
import { sha256, verifyBytes } from '../../src/net/crypto'
import { MemoryKeyStorage, generateNodeKeys } from '../../src/net/keys'
import { MousseIdError, MousseIdHttp, checkedOrigin, type FetchLike } from '../../src/mousseId/http'
import { MousseIdNet, type ControlIdentity } from '../../src/mousseId/net'
import { MousseIdSession } from '../../src/mousseId/session'
import { delegate, roster, testComputer, testUser } from '../net/fixtures'

const ORIGIN = 'https://id.test'
const RELAY = 'wss://id.test/v1/net/relay'

interface Call {
  method: string
  path: string
  bearer?: string
  body?: Record<string, unknown>
}

type Handler = (call: Call) => { status?: number; body?: unknown }

function fakeServer(handler: Handler) {
  const calls: Call[] = []
  const fetcher: FetchLike = async (input, init) => {
    const url = new URL(input)
    expect(url.origin).toBe(ORIGIN)
    expect(init.redirect).toBe('error')
    expect(init.credentials).toBe('omit')
    const headers = init.headers as Record<string, string>
    const call: Call = {
      method: init.method!,
      path: url.pathname,
      bearer: headers.authorization?.replace(/^Bearer /, ''),
      body: init.body ? JSON.parse(init.body as string) : undefined,
    }
    calls.push(call)
    const answer = handler(call)
    const status = answer.status ?? 200
    return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), { status })
  }
  return { calls, fetcher }
}

function appSession(n: number, expiresAt = Date.now() + 3_600_000) {
  return { accessToken: `access-${n}`, refreshToken: `refresh-${n}`, expiresAt, account: { id: 'acct_1', email: 'a@b.test' } }
}

describe('Mousse ID HTTP', () => {
  it('accepts only https origins, or http on loopback', () => {
    expect(checkedOrigin('https://id.test/')).toBe('https://id.test')
    expect(checkedOrigin('http://127.0.0.1:8787')).toBe('http://127.0.0.1:8787')
    expect(() => checkedOrigin('http://id.test')).toThrow(expect.objectContaining({ code: 'not_configured' }))
    expect(() => checkedOrigin('https://id.test/api')).toThrow(expect.objectContaining({ code: 'not_configured' }))
    expect(() => checkedOrigin(undefined)).toThrow(expect.objectContaining({ code: 'not_configured' }))
  })

  it('folds both server error styles into one code and maps network failures to offline', async () => {
    const { fetcher } = fakeServer((call) =>
      call.path === '/a'
        ? { status: 429, body: { error: { code: 'RATE_LIMITED', message: 'RATE_LIMITED' } } }
        : { status: 403, body: { error: { code: 'revoked', message: 'revoked' } } },
    )
    const http = new MousseIdHttp(ORIGIN, fetcher)
    await expect(http.request('GET', '/a')).rejects.toMatchObject({ code: 'rate_limited', retryable: true })
    await expect(http.request('GET', '/b')).rejects.toMatchObject({ code: 'revoked', status: 403 })
    const offline = new MousseIdHttp(ORIGIN, async () => {
      throw new TypeError('network')
    })
    await expect(offline.request('GET', '/a')).rejects.toMatchObject({ code: 'offline' })
  })
})

describe('Mousse ID session', () => {
  it('signs in with a password, stores the session and signs out locally even when offline', async () => {
    const { calls, fetcher } = fakeServer((call) => {
      if (call.path === '/v1/app/session/password') return { body: appSession(1) }
      return { status: 500 }
    })
    const storage = new MemoryKeyStorage()
    const session = new MousseIdSession(new MousseIdHttp(ORIGIN, fetcher), storage)
    const seen: unknown[] = []
    session.onChange((value) => seen.push(value?.account.id))
    await expect(session.signInWithPassword('a@b.test', '')).rejects.toMatchObject({ code: 'bad_request' })
    await session.signInWithPassword(' a@b.test ', 'pw')
    expect(calls[0].body).toEqual({ email: 'a@b.test', password: 'pw' })

    const restored = new MousseIdSession(new MousseIdHttp(ORIGIN, fetcher), storage)
    expect(await restored.accessToken()).toBe('access-1')
    await restored.signOut()
    expect(restored.current()).toBeUndefined()
    expect(storage.items.size).toBe(0)
    expect(seen).toEqual(['acct_1'])
  })

  it('signs in with Google through the browser and redeems the code with the PKCE verifier', async () => {
    const { calls, fetcher } = fakeServer((call) =>
      call.path === '/v1/app/session/oauth' ? { body: appSession(1) } : { status: 404 },
    )
    const storage = new MemoryKeyStorage()
    const session = new MousseIdSession(new MousseIdHttp(ORIGIN, fetcher), storage)
    const opened: URL[] = []
    const result = await session.signInWithGoogle(async (url) => {
      opened.push(new URL(url))
      return new URL('com.ryspa.mousse:/oauth/callback?code=handoff-1')
    })

    expect(opened).toHaveLength(1)
    const start = opened[0]
    expect(start.origin + start.pathname).toBe(`${ORIGIN}/v1/app/oauth/google/start`)
    expect(start.searchParams.get('redirect_uri')).toBe('com.ryspa.mousse:/oauth/callback')
    expect(start.search).toContain(`redirect_uri=${encodeURIComponent('com.ryspa.mousse:/oauth/callback')}`)
    const challenge = start.searchParams.get('code_challenge')!
    expect(calls).toHaveLength(1)
    expect(calls[0].method).toBe('POST')
    const body = calls[0].body as { code: string; code_verifier: string }
    expect(body.code).toBe('handoff-1')
    expect(body.code_verifier).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(challenge).toBe(b64url(sha256(new TextEncoder().encode(body.code_verifier))))

    expect(result.accessToken).toBe('access-1')
    const restored = new MousseIdSession(new MousseIdHttp(ORIGIN, fetcher), storage)
    expect(await restored.accessToken()).toBe('access-1')
  })

  it('reports a failed or empty Google callback without calling the API', async () => {
    const { calls, fetcher } = fakeServer(() => ({ body: appSession(1) }))
    const session = new MousseIdSession(new MousseIdHttp(ORIGIN, fetcher), new MemoryKeyStorage())
    await expect(
      session.signInWithGoogle(async () => new URL('com.ryspa.mousse:/oauth/callback?error=oauth_failed')),
    ).rejects.toMatchObject({ code: 'unauthorized' })
    await expect(session.signInWithGoogle(async () => new URL('com.ryspa.mousse:/oauth/callback'))).rejects.toMatchObject({
      code: 'bad_response',
    })
    await expect(
      session.signInWithGoogle(async () => {
        throw new Error('Sign-in was cancelled when the browser closed.')
      }),
    ).rejects.toThrow('cancelled')
    expect(calls).toHaveLength(0)
    expect(session.current()).toBeUndefined()
  })

  it('refreshes once for concurrent callers and retries a call after a 401', async () => {
    let refreshes = 0
    const { fetcher } = fakeServer((call) => {
      if (call.path === '/v1/app/session/password') return { body: appSession(1, Date.now() + 10_000) }
      if (call.path === '/v1/app/session/refresh') {
        refreshes++
        return { body: appSession(refreshes + 1) }
      }
      return { status: 404 }
    })
    const session = new MousseIdSession(new MousseIdHttp(ORIGIN, fetcher), new MemoryKeyStorage())
    await session.signInWithPassword('a@b.test', 'pw')
    // The token expires within the refresh margin, so both callers wait on one refresh.
    expect(await Promise.all([session.accessToken(), session.accessToken()])).toEqual(['access-2', 'access-2'])
    expect(refreshes).toBe(1)

    const tokens: string[] = []
    const result = await session.authorized(async (token) => {
      tokens.push(token)
      if (token === 'access-2') throw new MousseIdError('unauthorized')
      return 'ok'
    })
    expect(result).toBe('ok')
    expect(tokens).toEqual(['access-2', 'access-3'])
  })

  it('drops the session when the refresh token is refused', async () => {
    const { fetcher } = fakeServer((call) =>
      call.path === '/v1/app/session/password' ? { body: appSession(1, 0) } : { status: 401, body: { error: { code: 'UNAUTHORIZED' } } },
    )
    const session = new MousseIdSession(new MousseIdHttp(ORIGIN, fetcher), new MemoryKeyStorage())
    await session.signInWithPassword('a@b.test', 'pw')
    await expect(session.accessToken()).rejects.toMatchObject({ code: 'unauthorized' })
    expect(session.current()).toBeUndefined()
  })
})

function phoneIdentity(): ControlIdentity {
  const user = testUser()
  const computer = testComputer(user)
  const keys = generateNodeKeys()
  const node = newId('node')
  const delegation = delegate(user, node, keys, { name: 'Pixel' })
  return { user: user.user, rootKey: user.rootKey, node, roster: roster(user, computer.node), delegation, signSecret: keys.signSecret, ...{ signPublic: keys.public.sign } } as ControlIdentity
}

const CONFIG = { protocol: 'mousse-plus/net-control/v1', installationId: 'inst_1', gatewayId: 'gw_1', relayAudience: RELAY }

function controlServer(identity: ControlIdentity, tamper: (statement: Record<string, unknown>) => void = () => {}) {
  const challenges: Record<string, unknown>[] = []
  const server = fakeServer((call) => {
    if (call.path === '/v1/app/session/password') return { body: appSession(1) }
    if (call.path === '/v1/net/config') return { body: CONFIG }
    if (call.path === '/v1/net/challenges') {
      const body = call.body!
      const statement: Record<string, unknown> = {
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
        issuedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      }
      tamper(statement)
      challenges.push(statement)
      return { body: statement }
    }
    const registration = { id: 'reg_1', accountId: 'acct_1', userId: identity.user, nodeId: identity.node, generation: 1, expiresAt: Date.now() + 3_600_000 }
    if (call.path === '/v1/net/registrations') return { status: 201, body: { registration, connectorToken: 'c'.repeat(40), relayAudience: RELAY } }
    if (call.path === '/v1/net/registrations/reg_1/renew') return { body: { ...registration, generation: 2 } }
    return { status: 404, body: { error: { code: 'not_found' } } }
  })
  return { ...server, challenges }
}

async function signedIn(fetcher: FetchLike) {
  const session = new MousseIdSession(new MousseIdHttp(ORIGIN, fetcher), new MemoryKeyStorage())
  await session.signInWithPassword('a@b.test', 'pw')
  return new MousseIdNet(session)
}

describe('Mousse ID Net routes', () => {
  it('registers the phone with a signed register challenge whose intent carries kind phone', async () => {
    const identity = phoneIdentity()
    const server = controlServer(identity)
    const net = await signedIn(server.fetcher)
    const grant = await net.registerPhone(identity)
    expect(grant.registration).toMatchObject({ id: 'reg_1', generation: 1 })

    const challengeCall = server.calls.find((call) => call.path === '/v1/net/challenges')!
    expect(challengeCall.bearer).toBe('access-1')
    expect(challengeCall.body).toMatchObject({ purpose: 'register', nodeId: identity.node, intent: { kind: 'phone', gatewayId: 'gw_1' } })
    expect(challengeCall.body).not.toHaveProperty('registrationId')
    const register = server.calls.find((call) => call.path === '/v1/net/registrations')!
    expect(register.body).toMatchObject({ kind: 'phone', operationId: challengeCall.body!.operationId, challengeId: server.challenges[0].challengeId })
    const signPublic = (identity as unknown as { signPublic: string }).signPublic
    expect(verifyBytes(canonicalJson(server.challenges[0]), fromB64url(register.body!.proof as string), fromB64url(signPublic))).toBe(true)

    const renewed = await net.renew(identity, grant, 'acct_1')
    expect(renewed.generation).toBe(2)
    const renewChallenge = server.calls.filter((call) => call.path === '/v1/net/challenges')[1]
    expect(renewChallenge).toMatchObject({ bearer: grant.connectorToken, body: { purpose: 'renew', registrationId: 'reg_1' } })
    const renewCall = server.calls.find((call) => call.path.endsWith('/renew'))!
    expect(renewCall).toMatchObject({ bearer: grant.connectorToken, body: { connectorToken: grant.connectorToken, registrationId: 'reg_1', generation: 1 } })
  })

  it.each([
    ['another account', (s: Record<string, unknown>) => (s.accountId = 'acct_2')],
    ['another intent', (s: Record<string, unknown>) => (s.intentHash = b64url(new Uint8Array(32)))],
    ['an extra field', (s: Record<string, unknown>) => (s.extra = 1)],
    ['a long window', (s: Record<string, unknown>) => (s.expiresAt = (s.issuedAt as number) + 10 * 60_000)],
    ['another audience', (s: Record<string, unknown>) => (s.audience = 'wss://other.test/')],
  ])('refuses to sign a challenge for %s', async (_name, tamper) => {
    const identity = phoneIdentity()
    const server = controlServer(identity, tamper)
    const net = await signedIn(server.fetcher)
    await expect(net.registerPhone(identity)).rejects.toMatchObject({ code: 'forbidden' })
    expect(server.calls.some((call) => call.path === '/v1/net/registrations')).toBe(false)
  })

  it('creates and polls enrollment requests, collects offers and reads the inventory', async () => {
    const { calls, fetcher } = fakeServer((call) => {
      if (call.path === '/v1/app/session/password') return { body: appSession(1) }
      if (call.path === '/v1/net/enrollment-requests') return { status: 201, body: { id: 'enr_1', expiresAt: 5 } }
      if (call.path === '/v1/net/enrollment-requests/enr_1') return { body: { id: 'enr_1', status: 'approved', expiresAt: 6, sealedInvite: 'abc' } }
      if (call.path === '/v1/net/enrollment-offers/off_1') return { body: { sealedInvite: 'xyz' } }
      if (call.path === '/v1/net/enrollment-offers/off_2') return { status: 410, body: { error: { code: 'expired' } } }
      if (call.path === '/v1/net/inventory')
        return {
          body: {
            limits: { maxRegistrations: 16, maxPhones: 5 },
            devices: { used: 2, limit: 5 },
            registrations: [
              { id: 'r1', userId: 'u', nodeId: 'n1', generation: 1, expiresAt: 9, revokedAt: null, kind: 'computer', deviceName: 'Studio', online: true },
              { id: 'r2', userId: 'u', nodeId: 'n2', generation: 1, expiresAt: 9, revokedAt: null },
              { broken: true },
            ],
          },
        }
      return { status: 404 }
    })
    const net = await signedIn(fetcher)
    const fp = b64url(new Uint8Array(32).fill(1))
    await expect(net.createEnrollmentRequest({ targetNodeId: 'n1', deviceName: 'Pixel\u0007', boxPublicKey: fp, transportFingerprint: fp })).rejects.toMatchObject({ code: 'bad_request' })
    expect(await net.createEnrollmentRequest({ targetNodeId: 'n1', deviceName: ' Pixel ', boxPublicKey: fp, transportFingerprint: fp })).toEqual({ id: 'enr_1', expiresAt: 5 })
    expect(calls.at(-1)!.body).toEqual({ targetNodeId: 'n1', deviceName: 'Pixel', kind: 'phone', boxPublicKey: fp, transportFingerprint: fp })
    expect(await net.enrollmentRequest('enr_1')).toEqual({ id: 'enr_1', status: 'approved', expiresAt: 6, sealedInvite: 'abc' })
    expect(await net.offer('off_1')).toBe('xyz')
    await expect(net.offer('off_2')).rejects.toMatchObject({ code: 'expired' })
    await expect(net.offer('../x')).rejects.toMatchObject({ code: 'bad_request' })

    const inventory = await net.inventory()
    expect(inventory.limits).toEqual({ maxRegistrations: 16, maxComputers: undefined, maxPhones: 5 })
    expect(inventory.devices).toEqual({ used: 2, limit: 5 })
    expect(inventory.registrations).toEqual([
      expect.objectContaining({ id: 'r1', kind: 'computer', deviceName: 'Studio', online: true }),
      expect.objectContaining({ id: 'r2', kind: 'computer', online: false }),
    ])
  })
})
