import { describe, expect, it } from 'vitest'
import { SecureChannel } from '../src/crypto/secureChannel'
import { base64UrlEncode } from '../src/security'
import type { ControlEnvelope } from '../src/types'

describe('Audited SecureChannel and E2E Envelopes', () => {
  const prologue = {
    protocolMajor: 2,
    protocolMinor: 0,
    installationId: 'inst-1',
    controlOrigin: 'https://control.example.com',
    mode: 'hosted' as const,
    accountId: 'acc-1',
    mmsDeviceId: 'mms-1',
    mobileDeviceId: 'phone-1',
    pairingId: 'pair-1'
  }

  it('performs key agreement, binds prologue, and encrypts/decrypts envelopes', async () => {
    // Generate peer (MMS) static key
    const mmsStatic = (await crypto.subtle.generateKey(
      { name: 'X25519' },
      true,
      ['deriveBits']
    )) as CryptoKeyPair
    const mmsRaw = await crypto.subtle.exportKey('raw', mmsStatic.publicKey)
    const mmsStaticPublic = base64UrlEncode(new Uint8Array(mmsRaw))

    const clientChannel = new SecureChannel()
    const pairingSecret = base64UrlEncode(new Uint8Array(32).fill(7))

    const handshakeResult = await clientChannel.initializeSession({
      peerStaticPublicKey: mmsStaticPublic,
      pairingSecret,
      prologue,
      role: 'client'
    })

    expect(clientChannel.isEstablished()).toBe(true)
    expect(handshakeResult.clientEphemeralPublic).toBeDefined()
    expect(handshakeResult.prologueHash).toBeDefined()

    // Encrypt request envelope
    const reqEnvelope: ControlEnvelope = {
      type: 'request',
      requestId: 'req-123',
      method: 'threads.list',
      params: {},
      protocolVersion: '2.0'
    }

    const frame = await clientChannel.encryptEnvelope(reqEnvelope)
    expect(frame.byteLength).toBeGreaterThan(16)

    // Set up server side channel with client ephemeral key and static private key
    const serverChannel = new SecureChannel()
    await serverChannel.initializeSession({
      peerStaticPublicKey: mmsStaticPublic,
      peerEphemeralPublicKey: handshakeResult.clientEphemeralPublic,
      localPrivateKey: mmsStatic.privateKey,
      pairingSecret,
      prologue,
      role: 'server'
    })

    const decrypted = await serverChannel.decryptFrame(frame)
    expect(decrypted).toEqual(reqEnvelope)
  })

  it('rejects replayed and out-of-order frames with REPLAY_DETECTED', async () => {
    const mmsStatic = (await crypto.subtle.generateKey(
      { name: 'X25519' },
      true,
      ['deriveBits']
    )) as CryptoKeyPair
    const mmsRaw = await crypto.subtle.exportKey('raw', mmsStatic.publicKey)
    const mmsStaticPublic = base64UrlEncode(new Uint8Array(mmsRaw))

    const clientChannel = new SecureChannel()
    const serverChannel = new SecureChannel()
    const pairingSecret = base64UrlEncode(new Uint8Array(32).fill(42))

    const handshake = await clientChannel.initializeSession({
      peerStaticPublicKey: mmsStaticPublic,
      pairingSecret,
      prologue,
      role: 'client'
    })
    await serverChannel.initializeSession({
      peerStaticPublicKey: mmsStaticPublic,
      peerEphemeralPublicKey: handshake.clientEphemeralPublic,
      localPrivateKey: mmsStatic.privateKey,
      pairingSecret,
      prologue,
      role: 'server'
    })

    const frame1 = await clientChannel.encryptEnvelope({
      type: 'ping',
      timestamp: 100
    })
    const frame2 = await clientChannel.encryptEnvelope({
      type: 'ping',
      timestamp: 200
    })

    // Decrypt frame 1
    const d1 = await serverChannel.decryptFrame(frame1)
    expect(d1.type).toBe('ping')

    // Replaying frame 1 must throw REPLAY_DETECTED
    await expect(serverChannel.decryptFrame(frame1)).rejects.toThrow(/REPLAY_DETECTED/)

    // Decrypt frame 2
    const d2 = await serverChannel.decryptFrame(frame2)
    expect(d2.type).toBe('ping')

    // Replaying frame 1 again must also throw REPLAY_DETECTED
    await expect(serverChannel.decryptFrame(frame1)).rejects.toThrow(/REPLAY_DETECTED/)
  })

  it('rejects tampered ciphertext with AUTH_FAILED', async () => {
    const mmsStatic = (await crypto.subtle.generateKey(
      { name: 'X25519' },
      true,
      ['deriveBits']
    )) as CryptoKeyPair
    const mmsRaw = await crypto.subtle.exportKey('raw', mmsStatic.publicKey)
    const mmsStaticPublic = base64UrlEncode(new Uint8Array(mmsRaw))

    const clientChannel = new SecureChannel()
    const serverChannel = new SecureChannel()

    const handshake = await clientChannel.initializeSession({
      peerStaticPublicKey: mmsStaticPublic,
      prologue,
      role: 'client'
    })
    await serverChannel.initializeSession({
      peerStaticPublicKey: mmsStaticPublic,
      peerEphemeralPublicKey: handshake.clientEphemeralPublic,
      localPrivateKey: mmsStatic.privateKey,
      prologue,
      role: 'server'
    })

    const frame = await clientChannel.encryptEnvelope({
      type: 'ping',
      timestamp: 999
    })

    // Tamper with payload byte
    frame[frame.byteLength - 5] ^= 0xff

    await expect(serverChannel.decryptFrame(frame)).rejects.toThrow(/AUTH_FAILED/)
  })

  it('rejects invalid magic header', async () => {
    const mmsStatic = (await crypto.subtle.generateKey(
      { name: 'X25519' },
      true,
      ['deriveBits']
    )) as CryptoKeyPair
    const mmsRaw = await crypto.subtle.exportKey('raw', mmsStatic.publicKey)
    const mmsStaticPublic = base64UrlEncode(new Uint8Array(mmsRaw))

    const clientChannel = new SecureChannel()
    const serverChannel = new SecureChannel()

    const handshake = await clientChannel.initializeSession({
      peerStaticPublicKey: mmsStaticPublic,
      prologue,
      role: 'client'
    })
    await serverChannel.initializeSession({
      peerStaticPublicKey: mmsStaticPublic,
      peerEphemeralPublicKey: handshake.clientEphemeralPublic,
      localPrivateKey: mmsStatic.privateKey,
      prologue,
      role: 'server'
    })

    const frame = await clientChannel.encryptEnvelope({
      type: 'ping',
      timestamp: 1
    })

    // Corrupt magic header
    frame[0] = 0x00

    await expect(serverChannel.decryptFrame(frame)).rejects.toThrow(/INVALID_MAGIC/)
  })

  it('resets cipher state on reset()', async () => {
    const channel = new SecureChannel()
    expect(channel.isEstablished()).toBe(false)
    await expect(channel.encryptEnvelope({ type: 'ping', timestamp: 1 })).rejects.toThrow(
      /not established/
    )
  })
})
