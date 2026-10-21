// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { b64url, fromB64url, randomBytes } from '../../src/net/bytes'
import { x25519PublicKey } from '../../src/net/crypto'
import { matchCode, openOfferSeal, openRequestSeal, parseJoinQr, sealForOffer, sealForRequest } from '../../src/mousseId/seal'
import vectors from './enrollment-seal.vectors.json'

describe('desktop conformance vectors', () => {
  const request = vectors.requestSeal
  const offer = vectors.offerSeal

  it('seals and opens the request seal byte for byte', () => {
    const boxSecret = fromB64url(request.boxPrivateKey)
    expect(b64url(x25519PublicKey(boxSecret))).toBe(request.boxPublicKey)
    const sealed = sealForRequest(vectors.invite, fromB64url(request.boxPublicKey), request.requestId, fromB64url(request.ephemeralPrivateKey), fromB64url(request.nonce))
    expect(sealed).toBe(request.sealedInvite)
    expect(openRequestSeal(request.sealedInvite, boxSecret, request.requestId)).toBe(vectors.invite)
    expect(() => openRequestSeal(request.sealedInvite, boxSecret, vectors.rejections[0].requestId!)).toThrow(expect.objectContaining({ code: 'bad_response' }))
  })

  it('seals and opens the offer seal byte for byte', () => {
    const key = fromB64url(offer.key)
    expect(sealForOffer(vectors.invite, key, fromB64url(offer.nonce))).toBe(offer.sealedInvite)
    expect(openOfferSeal(offer.sealedInvite, key)).toBe(vectors.invite)
    // The same bytes under the request-seal aad do not open.
    expect(() => openRequestSeal(offer.sealedInvite, key, 'x')).toThrow()
    expect(() => openOfferSeal(offer.sealedInvite.slice(0, -2) + 'AA', key)).toThrow(expect.objectContaining({ code: 'bad_response' }))
  })

  it('computes the match code', () => {
    expect(matchCode(fromB64url(vectors.matchCode.boxPublicKey), vectors.matchCode.transportFingerprint)).toBe(vectors.matchCode.matchCode)
  })

  it('parses the join QR code', () => {
    const parsed = parseJoinQr(offer.joinUrl)
    expect(parsed).toMatchObject({ origin: offer.plusOrigin, offer: offer.offerId })
    expect(b64url(parsed.key)).toBe(offer.key)
    expect(() => parseJoinQr(offer.joinUrl.replace('v=1', 'v=2'))).toThrow(/newer version/)
    expect(() => parseJoinQr(offer.joinUrl.replace(/key=[^&]+/, 'key=short'))).toThrow(/not a Mousse join code/)
    expect(() => parseJoinQr('https://example.test/join?v=1')).toThrow(/not a Mousse join code/)
  })
})

describe('sealed invite size', () => {
  it('opens the invite of a computer with many devices, and still refuses one past 64 KiB', () => {
    const boxSecret = randomBytes(32),
      boxPublic = x25519PublicKey(boxSecret)
    // Fourteen devices, the most a desktop roster can hold, seal to about 39 KiB.
    const invite = 'mj1_' + 'A'.repeat(29_000)
    const sealed = sealForRequest(invite, boxPublic, 'req_big')
    expect(sealed.length).toBeGreaterThan(16_384)
    expect(openRequestSeal(sealed, boxSecret, 'req_big')).toBe(invite)
    const oversized = sealForRequest('mj1_' + 'A'.repeat(49_200), boxPublic, 'req_huge')
    expect(oversized.length).toBeGreaterThan(64 * 1024)
    expect(() => openRequestSeal(oversized, boxSecret, 'req_huge')).toThrow(expect.objectContaining({ code: 'bad_response' }))
  })
})
