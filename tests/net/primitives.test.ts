// @vitest-environment node
import { X509Certificate, createPublicKey, verify as nodeVerify, createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { b64url, fromB64url, Reader, utf8 } from '../../src/net/bytes'
import { canonicalJsonText, isId, newId } from '../../src/net/canonical'
import { ecdsaSignDer, ecdsaVerifyDer, generateTransportKey, spkiFromCertificate, spkiFingerprint } from '../../src/net/cert'
import { signDocument, verifyDocument, x25519Shared, generateAgreementKey, generateSigningKey } from '../../src/net/crypto'
import { deserializeNodeKeys, generateNodeKeys, MemoryKeyStorage, readJson, serializeNodeKeys, writeJson } from '../../src/net/keys'
import { NetError, wireError } from '../../src/net/errors'

describe('bytes', () => {
  it('round-trips base64url and rejects non-canonical input', () => {
    for (let n = 0; n < 40; n++) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37 + n) & 0xff)
      expect(b64url(bytes)).toBe(Buffer.from(bytes).toString('base64url'))
      expect([...fromB64url(b64url(bytes))]).toEqual([...bytes])
    }
    expect(() => fromB64url('AB=')).toThrow()
    expect(() => fromB64url('AA')).not.toThrow()
    expect(() => fromB64url('AB')).toThrow() // trailing bits set
    expect(() => fromB64url('A')).toThrow()
    expect(() => fromB64url('AAAA', 2)).toThrow()
  })

  it('reader throws on truncation', () => {
    const reader = new Reader(Uint8Array.of(0, 3, 1, 2))
    expect(() => reader.vec16()).toThrow()
  })
})

describe('canonical JSON and ids', () => {
  it('sorts keys and rejects non-JSON', () => {
    expect(canonicalJsonText({ b: 1, a: [true, null, 'x'], c: { z: 1, y: 2 } })).toBe(
      '{"a":[true,null,"x"],"b":1,"c":{"y":2,"z":1}}',
    )
    expect(() => canonicalJsonText({ a: undefined })).toThrow()
    expect(() => canonicalJsonText(2 ** 60)).toThrow()
    expect(() => canonicalJsonText('\ud800')).toThrow()
    expect(() => canonicalJsonText(new Date())).toThrow()
  })

  it('creates valid ids', () => {
    const id = newId('node')
    expect(isId('node', id)).toBe(true)
    expect(isId('user', id)).toBe(false)
  })
})

describe('errors', () => {
  it('derives retryable from the code', () => {
    expect(new NetError('peer_offline').retryable).toBe(true)
    expect(new NetError('forbidden').retryable).toBe(false)
    expect(wireError(new Error('secret detail'))).toEqual({ code: 'internal', message: 'internal', retryable: false })
  })
})

describe('Ed25519 and X25519', () => {
  it('signs documents that node:crypto verifies', () => {
    const key = generateSigningKey()
    const doc = signDocument({ hello: 'world', n: 1 }, key.secretKey)
    const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), key.publicKey])
    const publicKey = createPublicKey({ key: spki, format: 'der', type: 'spki' })
    expect(nodeVerify(null, fromB64url(doc.payload), publicKey, fromB64url(doc.sig))).toBe(true)
    expect(verifyDocument(doc, b64url(key.publicKey))).toEqual({ hello: 'world', n: 1 })
    const tampered = { ...doc, payload: b64url(utf8('{"hello":"world","n":2}')) }
    expect(() => verifyDocument(tampered, b64url(key.publicKey))).toThrow(NetError)
  })

  it('agrees on X25519 secrets', () => {
    const a = generateAgreementKey()
    const b = generateAgreementKey()
    expect(b64url(x25519Shared(a.secretKey, b.publicKey))).toBe(b64url(x25519Shared(b.secretKey, a.publicKey)))
  })
})

describe('P-256 transport certificate', () => {
  it('produces a self-signed certificate node:crypto accepts', () => {
    const key = generateTransportKey()
    const cert = new X509Certificate(Buffer.from(key.certificate))
    expect(cert.subject).toBe('CN=Mousse Net')
    expect(cert.verify(cert.publicKey)).toBe(true)
    const spki = cert.publicKey.export({ type: 'spki', format: 'der' })
    expect(b64url(spki)).toBe(b64url(key.spki))
    expect(b64url(spkiFromCertificate(key.certificate))).toBe(b64url(key.spki))
    expect(spkiFingerprint(key.spki)).toBe(createHash('sha256').update(spki).digest('base64url'))
    expect(new Date(cert.validTo).getUTCFullYear()).toBeGreaterThan(2100)
  })

  it('creates DER signatures node:crypto verifies', () => {
    const key = generateTransportKey()
    const message = utf8('transcript')
    const signature = ecdsaSignDer(message, key.secretKey)
    const publicKey = createPublicKey({ key: Buffer.from(key.spki), format: 'der', type: 'spki' })
    expect(nodeVerify('sha256', message, publicKey, signature)).toBe(true)
    expect(ecdsaVerifyDer(signature, message, key.spki)).toBe(true)
    expect(ecdsaVerifyDer(signature, utf8('other'), key.spki)).toBe(false)
  })
})

describe('key storage', () => {
  it('persists and restores node keys', async () => {
    const storage = new MemoryKeyStorage()
    const keys = generateNodeKeys()
    await writeJson(storage, 'k', serializeNodeKeys(keys))
    const restored = deserializeNodeKeys((await readJson(storage, 'k'))!)
    expect(restored.public).toEqual(keys.public)
    expect(fromB64url(keys.public.sign)).toHaveLength(32)
    expect(() => deserializeNodeKeys({ ...serializeNodeKeys(keys), transportCert: serializeNodeKeys(generateNodeKeys()).transportCert })).toThrow(
      /unreadable/,
    )
  })
})
