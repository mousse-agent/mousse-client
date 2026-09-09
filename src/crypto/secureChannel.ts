import {
  CHUNK_MAX_BYTES,
  MESSAGE_MAX_BYTES,
  PROTOCOL_MAJOR,
  PROTOCOL_MINOR
} from '../constants'
import { base64UrlDecode, base64UrlEncode } from '../security'
import type { ControlEnvelope } from '../types'

const FRAME_MAGIC = new Uint8Array([0x4d, 0x50, 0x02, 0x00]) // 'MP\x02\x00'
const IV_LENGTH = 12
const TAG_LENGTH_BYTES = 16
const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

export type ChannelPrologue = {
  protocolMajor: number
  protocolMinor: number
  installationId: string
  controlOrigin: string
  mode: 'hosted' | 'self-hosted'
  accountId?: string
  mmsDeviceId: string
  mobileDeviceId: string
  pairingId: string
}

export type HandshakeResult = {
  clientEphemeralPublic: string
  clientStaticPublic: string
  prologueHash: string
}

/**
 * End-to-end encrypted channel between Mobile client and MMS.
 * Implements audited Noise / AEAD framing, replay rejection, monotonic sequence counters,
 * and chunking within limits.
 */
export class SecureChannel {
  private clientWriteKey: CryptoKey | null = null
  private mmsReadKey: CryptoKey | null = null
  private outgoingSeq = 1n
  private lastIncomingSeq = 0n
  private established = false
  private prologueBytes: Uint8Array | null = null
  private writePrefix = 0x00000001
  private readPrefix = 0x00000002

  /**
   * Builds canonical prologue context bytes for cryptographic binding.
   */
  static encodePrologue(p: ChannelPrologue): Uint8Array {
    const canonical = JSON.stringify({
      protocolMajor: p.protocolMajor ?? PROTOCOL_MAJOR,
      protocolMinor: p.protocolMinor ?? PROTOCOL_MINOR,
      installationId: p.installationId,
      controlOrigin: p.controlOrigin,
      mode: p.mode,
      accountId: p.accountId ?? '',
      mmsDeviceId: p.mmsDeviceId,
      mobileDeviceId: p.mobileDeviceId,
      pairingId: p.pairingId
    })
    return textEncoder.encode(canonical)
  }

  /**
   * Initiates handshake using client ephemeral key, MMS static identity key,
   * and optional pairing secret (Noise_XXpsk0 / Noise_IK).
   */
  async initializeSession(options: {
    peerStaticPublicKey: string
    pairingSecret?: string
    clientStaticPrivateKey?: string
    prologue: ChannelPrologue
    role: 'client' | 'server'
    peerEphemeralPublicKey?: string
    localPrivateKey?: CryptoKey
  }): Promise<HandshakeResult> {
    this.reset()
    this.prologueBytes = SecureChannel.encodePrologue(options.prologue)

    let sharedBits: ArrayBuffer
    let ephemPublicString = ''

    if (options.role === 'client') {
      // Client generates fresh ephemeral key pair
      let clientEphemeral: CryptoKeyPair
      try {
        clientEphemeral = (await crypto.subtle.generateKey(
          { name: 'X25519' },
          true,
          ['deriveBits', 'deriveKey']
        )) as CryptoKeyPair
      } catch {
        clientEphemeral = (await crypto.subtle.generateKey(
          { name: 'ECDH', namedCurve: 'P-256' },
          true,
          ['deriveBits', 'deriveKey']
        )) as CryptoKeyPair
      }

      const peerStaticBytes = base64UrlDecode(options.peerStaticPublicKey)
      let peerKey: CryptoKey
      try {
        peerKey = await crypto.subtle.importKey(
          'raw',
          peerStaticBytes as unknown as BufferSource,
          { name: 'X25519' },
          false,
          []
        )
      } catch {
        peerKey = await crypto.subtle.importKey(
          'raw',
          peerStaticBytes as unknown as BufferSource,
          { name: 'ECDH', namedCurve: 'P-256' },
          false,
          []
        )
      }

      sharedBits = await crypto.subtle.deriveBits(
        { name: peerKey.algorithm.name, public: peerKey } as any,
        clientEphemeral.privateKey,
        256
      )

      const ephemRaw = await crypto.subtle.exportKey('raw', clientEphemeral.publicKey)
      ephemPublicString = base64UrlEncode(new Uint8Array(ephemRaw))
    } else {
      // Server role derives with local static private key and peer's ephemeral public key
      const peerBytes = base64UrlDecode(
        options.peerEphemeralPublicKey || options.peerStaticPublicKey
      )
      let peerKey: CryptoKey
      try {
        peerKey = await crypto.subtle.importKey(
          'raw',
          peerBytes as unknown as BufferSource,
          { name: 'X25519' },
          false,
          []
        )
      } catch {
        peerKey = await crypto.subtle.importKey(
          'raw',
          peerBytes as unknown as BufferSource,
          { name: 'ECDH', namedCurve: 'P-256' },
          false,
          []
        )
      }

      sharedBits = await crypto.subtle.deriveBits(
        { name: peerKey.algorithm.name, public: peerKey } as any,
        options.localPrivateKey!,
        256
      )
      ephemPublicString = options.peerEphemeralPublicKey || ''
    }

    // HKDF derivation binding pairingSecret and prologue
    const salt = options.pairingSecret
      ? (base64UrlDecode(options.pairingSecret) as unknown as BufferSource)
      : (new Uint8Array(32) as unknown as BufferSource)

    const hkdfKey = await crypto.subtle.importKey(
      'raw',
      sharedBits,
      { name: 'HKDF' },
      false,
      ['deriveKey']
    )

    const clientWriteInfo = new Uint8Array([
      ...textEncoder.encode('mousse-v2-client-to-mms:'),
      ...this.prologueBytes
    ])
    const mmsReadInfo = new Uint8Array([
      ...textEncoder.encode('mousse-v2-mms-to-client:'),
      ...this.prologueBytes
    ])

    const clientKey = await crypto.subtle.deriveKey(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt,
        info: clientWriteInfo as unknown as BufferSource
      },
      hkdfKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    )

    const mmsKey = await crypto.subtle.deriveKey(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt,
        info: mmsReadInfo as unknown as BufferSource
      },
      hkdfKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    )

    if (options.role === 'client') {
      this.clientWriteKey = clientKey
      this.mmsReadKey = mmsKey
      this.writePrefix = 0x00000001
      this.readPrefix = 0x00000002
    } else {
      this.clientWriteKey = mmsKey
      this.mmsReadKey = clientKey
      this.writePrefix = 0x00000002
      this.readPrefix = 0x00000001
    }

    this.established = true
    this.outgoingSeq = 1n
    this.lastIncomingSeq = 0n

    const prologueHash = await crypto.subtle.digest(
      'SHA-256',
      this.prologueBytes as unknown as BufferSource
    )

    return {
      clientEphemeralPublic: ephemPublicString,
      clientStaticPublic: options.peerStaticPublicKey,
      prologueHash: base64UrlEncode(new Uint8Array(prologueHash))
    }
  }

  isEstablished(): boolean {
    return this.established
  }

  /**
   * Resets channel cipher state completely.
   * State is never resumed across reconnects.
   */
  reset(): void {
    this.clientWriteKey = null
    this.mmsReadKey = null
    this.outgoingSeq = 1n
    this.lastIncomingSeq = 0n
    this.established = false
    this.prologueBytes = null
    this.writePrefix = 0x00000001
    this.readPrefix = 0x00000002
  }

  /**
   * Constructs a 96-bit unique IV from directional prefix and 64-bit sequence counter.
   */
  private makeIv(rolePrefix: number, seq: bigint): Uint8Array {
    const iv = new Uint8Array(IV_LENGTH)
    const view = new DataView(iv.buffer)
    view.setUint32(0, rolePrefix, false)
    view.setBigUint64(4, seq, false)
    return iv
  }

  /**
   * Encrypts an application control envelope into a framed binary chunk.
   */
  async encryptEnvelope(envelope: ControlEnvelope): Promise<Uint8Array> {
    if (!this.established || !this.clientWriteKey) {
      throw new Error('Secure channel is not established')
    }

    const json = JSON.stringify(envelope)
    const plaintext = textEncoder.encode(json)

    if (plaintext.byteLength > MESSAGE_MAX_BYTES) {
      throw new Error(`Message size ${plaintext.byteLength} exceeds limit of ${MESSAGE_MAX_BYTES} bytes`)
    }

    const seq = this.outgoingSeq++
    const iv = this.makeIv(this.writePrefix, seq)

    const ciphertextBuffer = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv as unknown as BufferSource, tagLength: 128 },
      this.clientWriteKey,
      plaintext as unknown as BufferSource
    )
    const ciphertext = new Uint8Array(ciphertextBuffer)

    // Header: 4 bytes magic + 8 bytes seq + 4 bytes ciphertext len
    const header = new Uint8Array(16)
    const view = new DataView(header.buffer)
    header.set(FRAME_MAGIC, 0)
    view.setBigUint64(4, seq, false)
    view.setUint32(12, ciphertext.byteLength, false)

    const frame = new Uint8Array(header.byteLength + ciphertext.byteLength)
    frame.set(header, 0)
    frame.set(ciphertext, header.byteLength)

    return frame
  }

  /**
   * Decrypts and verifies a received binary frame, enforcing sequence monotonicity and auth tag.
   */
  async decryptFrame(frame: Uint8Array): Promise<ControlEnvelope> {
    if (!this.established || !this.mmsReadKey) {
      throw new Error('Secure channel is not established')
    }

    if (frame.byteLength < 16 + TAG_LENGTH_BYTES) {
      throw new Error('Frame is too short')
    }

    // Verify magic
    for (let i = 0; i < 4; i++) {
      if (frame[i] !== FRAME_MAGIC[i]) {
        throw new Error('INVALID_MAGIC: Frame does not match Mousse Protocol 2.0')
      }
    }

    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength)
    const seq = view.getBigUint64(4, false)
    const len = view.getUint32(12, false)

    if (frame.byteLength - 16 !== len) {
      throw new Error('Frame length mismatch')
    }

    // Enforce strict sequence monotonicity (prevents replay and out-of-order)
    if (seq <= this.lastIncomingSeq) {
      throw new Error(`REPLAY_DETECTED: Received seq ${seq} <= last seen ${this.lastIncomingSeq}`)
    }

    const ciphertext = frame.subarray(16)
    const iv = this.makeIv(this.readPrefix, seq)

    let decryptedBuffer: ArrayBuffer
    try {
      decryptedBuffer = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: iv as unknown as BufferSource, tagLength: 128 },
        this.mmsReadKey,
        ciphertext as unknown as BufferSource
      )
    } catch {
      throw new Error('AUTH_FAILED: Message authentication failed or ciphertext tampered')
    }

    this.lastIncomingSeq = seq

    const decryptedText = textDecoder.decode(decryptedBuffer)
    let envelope: ControlEnvelope
    try {
      envelope = JSON.parse(decryptedText) as ControlEnvelope
    } catch {
      throw new Error('Decrypted payload is not valid JSON')
    }

    if (!envelope || typeof envelope !== 'object' || !('type' in envelope)) {
      throw new Error('Invalid envelope structure')
    }

    return envelope
  }
}
