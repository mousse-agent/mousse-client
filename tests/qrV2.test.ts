import { describe, expect, it } from 'vitest'
import { encodeQrV2, parseQr } from '../src/connectionQr'
import type { QrPayloadV2 } from '../src/types'

describe('Mousse QR v2 parser and trust', () => {
  const validHostedPayload: QrPayloadV2 = {
    mode: 'hosted',
    controlOrigin: 'https://control.example.com',
    installationId: 'inst-123',
    installationPublicKey: 'u3Q38k7K9tJvX_wP4_abc1234567890123456789012',
    mmsDeviceId: 'mms-laptop-456',
    mmsIdentityPublicKey: 'mmsKey_98765432101234567890123456789012345',
    pairingId: 'pair-789',
    expiresAt: Date.now() + 120_000,
    protocolMajor: 2,
    protocolMinor: 0,
    pairingSecret: 'secret_32bytes_random_urlsafe_data123456',
    accountId: 'acc-user-999'
  }

  it('correctly encodes and parses valid hosted QR v2', async () => {
    const qrString = encodeQrV2(validHostedPayload)
    expect(qrString).toMatch(/^mousse:\/\/pair\?v=2&data=/)

    const parsed = await parseQr(qrString)
    expect(parsed.version).toBe(2)
    if (parsed.version === 2) {
      expect(parsed.payload.mode).toBe('hosted')
      expect(parsed.payload.controlOrigin).toBe('https://control.example.com')
      expect(parsed.payload.mmsDeviceId).toBe('mms-laptop-456')
      expect(parsed.payload.accountId).toBe('acc-user-999')
      expect(parsed.fingerprint).toMatch(/^[0-9A-F]{2}(:[0-9A-F]{2}){15}$/)
      expect(parsed.mmsFingerprint).toMatch(/^[0-9A-F]{2}(:[0-9A-F]{2}){15}$/)
    }
  })

  it('correctly parses self-hosted QR v2 without accountId', async () => {
    const selfHostedPayload: QrPayloadV2 = {
      ...validHostedPayload,
      mode: 'self-hosted',
      accountId: undefined
    }
    const qrString = encodeQrV2(selfHostedPayload)
    const parsed = await parseQr(qrString)
    expect(parsed.version).toBe(2)
    if (parsed.version === 2) {
      expect(parsed.payload.mode).toBe('self-hosted')
      expect(parsed.payload.accountId).toBeUndefined()
    }
  })

  it('rejects expired QR codes', async () => {
    const expiredPayload: QrPayloadV2 = {
      ...validHostedPayload,
      expiresAt: Date.now() - 1000 // expired
    }
    const qrString = encodeQrV2(expiredPayload)
    await expect(parseQr(qrString)).rejects.toThrow(/expired/)
  })

  it('rejects unsupported protocol major versions', async () => {
    const futurePayload: QrPayloadV2 = {
      ...validHostedPayload,
      protocolMajor: 3
    }
    const qrString = encodeQrV2(futurePayload)
    await expect(parseQr(qrString)).rejects.toThrow(/major version/)
  })

  it('rejects hosted QR missing accountId', async () => {
    const invalidHosted = {
      ...validHostedPayload,
      accountId: undefined
    } as any
    const qrString = encodeQrV2(invalidHosted)
    await expect(parseQr(qrString)).rejects.toThrow(/requires an accountId/)
  })

  it('rejects untrusted non-loopback HTTP origins', async () => {
    const insecurePayload: QrPayloadV2 = {
      ...validHostedPayload,
      controlOrigin: 'http://remote.attacker.com'
    }
    const qrString = encodeQrV2(insecurePayload)
    await expect(parseQr(qrString)).rejects.toThrow(/HTTPS/)
  })

  it('allows loopback HTTP origin for local development', async () => {
    const loopbackPayload: QrPayloadV2 = {
      ...validHostedPayload,
      controlOrigin: 'http://localhost:3000'
    }
    const qrString = encodeQrV2(loopbackPayload)
    const parsed = await parseQr(qrString)
    expect(parsed.version).toBe(2)
  })

  it('rejects oversized payloads exceeding 4096 bytes', async () => {
    const oversizedPayload: QrPayloadV2 = {
      ...validHostedPayload,
      installationId: 'x'.repeat(4100)
    }
    const qrString = encodeQrV2(oversizedPayload)
    await expect(parseQr(qrString)).rejects.toThrow(/exceeds limit/)
  })

  it('preserves legacy v1 QR parsing', async () => {
    const legacyQr = 'mousse://connect?v=1&base=https%3A%2F%2Fmousse.example.test%3A28478'
    const parsed = await parseQr(legacyQr)
    expect(parsed.version).toBe(1)
    if (parsed.version === 1) {
      expect(parsed.baseUrl).toBe('https://mousse.example.test:28478')
    }
  })
})
