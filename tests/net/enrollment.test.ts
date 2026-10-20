// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { b64url, randomBytes } from '../../src/net/bytes'
import { newId } from '../../src/net/canonical'
import { sha256, signDocument } from '../../src/net/crypto'
import {
  ENROLL_EXPORTER_LABEL,
  encodeInvite,
  invitationProof,
  invitationProofKey,
  parseInvite,
  redeemInvite,
  type NodeInviteAuthorization,
} from '../../src/net/enrollment'
import { verifyDelegation } from '../../src/net/identity'
import { generateNodeKeys } from '../../src/net/keys'
import { StreamMux } from '../../src/net/mux'
import { streamPair, type StreamEndpoint } from '../../src/net/stream'
import type { SecureChannel } from '../../src/net/tls13/client'
import type { WireMessage } from '../../src/net/codec'
import { delegate, roster, testComputer, testUser, type TestComputer, type TestUser } from './fixtures'

const RELAY = 'wss://id.test/v1/net/relay'

function makeInvite(options: { rendezvous?: 'plus-relay' | 'relay' | 'none'; name?: string; ttl?: number } = {}) {
  const user = testUser()
  const computer = testComputer(user)
  const signedRoster = roster(user, computer.node)
  const issuedAt = Date.now() - 500
  const expiresAt = issuedAt + (options.ttl ?? 10 * 60_000)
  const routes = signDocument(
    { v: 1, node: computer.node, routes: [{ transport: 'plus-relay', address: `${RELAY}?node=${computer.node}`, priority: 0 }], version: 1, issuedAt },
    computer.keys.signSecret,
  )
  const token = randomBytes(32)
  const kind = options.rendezvous ?? 'plus-relay'
  const document: NodeInviteAuthorization = {
    v: 1,
    kind: 'nodeInvite',
    invite: newId('invite'),
    user: user.user,
    node: computer.node,
    rootKey: user.rootKey,
    roster: signedRoster,
    delegation: computer.delegation,
    routes,
    transportFingerprint: b64url(sha256(computer.keys.transport.spki)),
    tokenHash: b64url(sha256(token)),
    issuedAt,
    expiresAt,
    caps: ['read', 'chat'],
    ...(options.name ? { name: options.name } : {}),
    ...(kind === 'none'
      ? {}
      : { rendezvous: { transport: kind, relay: kind === 'plus-relay' ? RELAY : 'wss://relay.test/', ticket: b64url(randomBytes(32)), expiresAt } }),
  }
  const text = encodeInvite(signDocument(document, computer.keys.signSecret), token)
  return { user, computer, signedRoster, document, token, text }
}

function channelOf(stream: StreamEndpoint, peerSpki: Uint8Array, exporter: Uint8Array): SecureChannel {
  return Object.assign(stream, {
    peerSpki,
    exportKeyingMaterial: (label: string, length: number) => {
      expect(label).toBe(ENROLL_EXPORTER_LABEL)
      expect(length).toBe(32)
      return exporter
    },
  }) as unknown as SecureChannel
}

/** The inviting computer's half of the enrollment-only handshake. */
async function authority(stream: StreamEndpoint, ctx: { user: TestUser; computer: TestComputer; signedRoster: unknown; token: Uint8Array }, exporter: Uint8Array, answer?: (request: Extract<WireMessage, { t: 'enroll.request' }>) => WireMessage) {
  const mux = new StreamMux(stream)
  const inbox: WireMessage[] = []
  let wake: (() => void) | undefined
  mux.onMessage((_lane, message) => {
    inbox.push(message.header)
    wake?.()
  })
  const next = async () => {
    while (!inbox.length) await new Promise<void>((resolve) => (wake = resolve))
    return inbox.shift()!
  }
  const hello = await next()
  expect(hello).toMatchObject({ t: 'hello', caps: ['enroll.v1'] })
  expect(hello).not.toHaveProperty('delegation')
  await mux.send({
    header: { t: 'hello', protoMajor: 1, protoMinor: 0, caps: ['enroll.v1'], node: ctx.computer.node, delegation: ctx.computer.delegation, roster: ctx.signedRoster as never, now: Date.now() },
    parts: [],
  })
  await mux.send({ header: { t: 'helloAck', protoMinor: 0, caps: ['enroll.v1'], now: Date.now() }, parts: [] })
  expect(await next()).toMatchObject({ t: 'helloAck', caps: ['enroll.v1'] })
  const request = (await next()) as Extract<WireMessage, { t: 'enroll.request' }>
  expect(request.t).toBe('enroll.request')
  expect(request.proof).toBe(invitationProof(invitationProofKey(ctx.token), exporter, request))
  const result =
    answer?.(request) ??
    (() => {
      const keys = { public: request.keys } as never
      const signed = delegate(ctx.user, request.node, keys, { name: request.name, caps: ['read', 'chat'] })
      return { t: 'enroll.result', delegation: signed, roster: roster(ctx.user, ctx.computer.node) } as WireMessage
    })()
  await mux.send({ header: result, parts: [] })
  return request
}

describe('invite parsing', () => {
  it('accepts a phone invite and rejects tampering, raw relays and expiry', () => {
    const good = makeInvite({ name: 'Pixel' })
    const parsed = parseInvite(good.text)
    expect(parsed.document.invite).toBe(good.document.invite)
    expect(parsed.authority.subject).toBe(good.computer.node)
    expect(() => parseInvite(good.text.slice(0, -2) + 'AA')).toThrow(expect.objectContaining({ code: 'invite_invalid' }))
    expect(() => parseInvite('mj2_' + good.text.slice(4))).toThrow(expect.objectContaining({ code: 'invite_invalid' }))
    expect(() => parseInvite(makeInvite({ rendezvous: 'none' }).text)).toThrow(/cannot be used from a phone/)
    expect(() => parseInvite(makeInvite({ rendezvous: 'relay' }).text)).toThrow(/cannot be used from a phone/)
    expect(() => parseInvite(good.text, good.document.expiresAt)).toThrow(/expired/)
    const forged = encodeInvite(signDocument(good.document, generateNodeKeys().signSecret), good.token)
    expect(() => parseInvite(forged)).toThrow(expect.objectContaining({ code: 'invite_invalid' }))
    const wrongToken = encodeInvite(signDocument(good.document, good.computer.keys.signSecret), randomBytes(32))
    expect(() => parseInvite(wrongToken)).toThrow(expect.objectContaining({ code: 'invite_invalid' }))
  })
})

describe('redeemInvite', () => {
  it('joins with a proof bound to the TLS exporter and returns a verified delegation', async () => {
    const ctx = makeInvite()
    const keys = generateNodeKeys()
    const node = newId('node')
    const exporter = randomBytes(32)
    const [a, b] = streamPair()
    let dialed: { route: string; ticket: string } | undefined
    const served = authority(b, ctx, exporter)
    const enrollment = await redeemInvite({
      invite: ctx.text,
      node,
      keys,
      name: 'Pixel',
      openChannel: async (target) => {
        dialed = target
        expect(b64url(target.expectedSpki)).toBe(ctx.computer.keys.public.transport)
        return channelOf(a, ctx.computer.keys.transport.spki, exporter)
      },
    })
    const request = await served
    expect(dialed).toMatchObject({ route: `${RELAY}?node=${ctx.computer.node}`, ticket: ctx.document.rendezvous!.ticket })
    expect(request).toMatchObject({ node, name: 'Pixel', keys: keys.public, invite: ctx.document.invite })
    expect(enrollment).toMatchObject({ user: ctx.user.user, node, authority: ctx.computer.node, authorityName: 'Studio', name: 'Pixel', caps: ['read', 'chat'] })
    expect(verifyDelegation(enrollment.delegation, ctx.user.rootKey).subject).toBe(node)
  })

  it('rejects a computer presenting another key, an error result and a delegation for other keys', async () => {
    const ctx = makeInvite()
    const keys = generateNodeKeys()
    const other = testComputer(ctx.user)
    const [a] = streamPair()
    await expect(
      redeemInvite({ invite: ctx.text, node: newId('node'), keys, name: 'Pixel', openChannel: async () => channelOf(a, other.keys.transport.spki, randomBytes(32)) }),
    ).rejects.toMatchObject({ code: 'peer_key_mismatch' })

    const exporter = randomBytes(32)
    const [c, d] = streamPair()
    void authority(d, ctx, exporter, () => ({ t: 'enroll.result', error: { code: 'invite_invalid', message: 'invite_invalid', retryable: false } }))
    await expect(
      redeemInvite({ invite: ctx.text, node: newId('node'), keys, name: 'Pixel', openChannel: async () => channelOf(c, ctx.computer.keys.transport.spki, exporter) }),
    ).rejects.toMatchObject({ code: 'invite_invalid' })

    const [e, f] = streamPair()
    void authority(f, ctx, exporter, (request) => {
      const signed = delegate(ctx.user, request.node, generateNodeKeys(), { name: request.name })
      return { t: 'enroll.result', delegation: signed, roster: roster(ctx.user, ctx.computer.node) }
    })
    await expect(
      redeemInvite({ invite: ctx.text, node: newId('node'), keys, name: 'Pixel', openChannel: async () => channelOf(e, ctx.computer.keys.transport.spki, exporter) }),
    ).rejects.toMatchObject({ code: 'bad_delegation' })
  })

  it('refuses a name that differs from the invite', async () => {
    const ctx = makeInvite({ name: 'Work phone' })
    await expect(
      redeemInvite({ invite: ctx.text, node: newId('node'), keys: generateNodeKeys(), name: 'Pixel', openChannel: async () => { throw new Error('should not dial') } }),
    ).rejects.toThrow(/does not match/)
  })
})
