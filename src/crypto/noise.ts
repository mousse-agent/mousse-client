/**
 * Noise Protocol Framework primitives for
 * Noise_*_25519_ChaChaPoly_SHA256 (rev 34).
 * Conforms strictly to WIRE_PROTOCOL.md and frozen test vectors.
 */
import { chacha20poly1305 } from '@noble/ciphers/chacha.js'
import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { dh, generateKeyPair, type X25519KeyPair } from './keys'

export const HASH_LEN = 32
export const KEY_LEN = 32
export const DH_LEN = 32
export const TAG_LEN = 16
export const MAX_NONCE = (1n << 64n) - 1n

const EMPTY = new Uint8Array(0)

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  let total = 0
  for (const part of parts) total += part.byteLength
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.byteLength
  }
  return out
}

export function hashSha256(data: Uint8Array): Uint8Array {
  return sha256(data)
}

function hmacSha256(key: Uint8Array, data: Uint8Array): Uint8Array {
  return hmac(sha256, key, data)
}

/** Noise HKDF: returns numOutputs HASHLEN blocks (1–3). */
export function hkdf(
  chainingKey: Uint8Array,
  inputKeyMaterial: Uint8Array,
  numOutputs: 1 | 2 | 3,
): Uint8Array[] {
  const tempKey = hmacSha256(chainingKey, inputKeyMaterial)
  const out1 = hmacSha256(tempKey, new Uint8Array([0x01]))
  if (numOutputs === 1) return [out1]
  const out2 = hmacSha256(tempKey, concatBytes(out1, new Uint8Array([0x02])))
  if (numOutputs === 2) return [out1, out2]
  const out3 = hmacSha256(tempKey, concatBytes(out2, new Uint8Array([0x03])))
  return [out1, out2, out3]
}

function nonceBytes(n: bigint): Uint8Array {
  if (n < 0n || n > MAX_NONCE) {
    throw new Error('nonce exhausted')
  }
  const buf = new Uint8Array(12)
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  view.setBigUint64(4, n, true)
  return buf
}

export class CipherState {
  private k: Uint8Array | undefined
  private n = 0n

  initializeKey(key: Uint8Array | undefined): void {
    this.k = key ? new Uint8Array(key) : undefined
    this.n = 0n
  }

  hasKey(): boolean {
    return this.k !== undefined
  }

  get nonce(): bigint {
    return this.n
  }

  setNonce(n: bigint): void {
    this.n = n
  }

  encryptWithAd(ad: Uint8Array, plaintext: Uint8Array): Uint8Array {
    if (!this.k) {
      return new Uint8Array(plaintext)
    }
    const nonce = nonceBytes(this.n)
    const cipher = chacha20poly1305(this.k, nonce, ad)
    const enc = cipher.encrypt(plaintext)
    this.n += 1n
    return enc
  }

  decryptWithAd(ad: Uint8Array, ciphertext: Uint8Array): Uint8Array {
    if (!this.k) {
      return new Uint8Array(ciphertext)
    }
    if (ciphertext.byteLength < TAG_LEN) {
      throw new Error('ciphertext too short')
    }
    const nonce = nonceBytes(this.n)
    const cipher = chacha20poly1305(this.k, nonce, ad)
    try {
      const dec = cipher.decrypt(ciphertext)
      this.n += 1n
      return dec
    } catch {
      throw new Error('AEAD authentication failed')
    }
  }
}

export class SymmetricState {
  private ck: Uint8Array = new Uint8Array(HASH_LEN)
  private h: Uint8Array = new Uint8Array(HASH_LEN)
  readonly cipher = new CipherState()

  initializeSymmetric(protocolName: string): void {
    const nameBytes = new TextEncoder().encode(protocolName)
    if (nameBytes.byteLength <= HASH_LEN) {
      this.h = new Uint8Array(HASH_LEN)
      this.h.set(nameBytes)
    } else {
      this.h = hashSha256(nameBytes)
    }
    this.ck = new Uint8Array(this.h)
    this.cipher.initializeKey(undefined)
  }

  mixKey(inputKeyMaterial: Uint8Array): void {
    const [ck, tempK] = hkdf(this.ck, inputKeyMaterial, 2)
    this.ck = ck!
    this.cipher.initializeKey(tempK)
  }

  mixHash(data: Uint8Array): void {
    this.h = hashSha256(concatBytes(this.h, data))
  }

  mixKeyAndHash(inputKeyMaterial: Uint8Array): void {
    const [ck, tempH, tempK] = hkdf(this.ck, inputKeyMaterial, 3)
    this.ck = ck!
    this.mixHash(tempH!)
    this.cipher.initializeKey(tempK)
  }

  encryptAndHash(plaintext: Uint8Array): Uint8Array {
    const ciphertext = this.cipher.encryptWithAd(this.h, plaintext)
    this.mixHash(ciphertext)
    return ciphertext
  }

  decryptAndHash(ciphertext: Uint8Array): Uint8Array {
    const plaintext = this.cipher.decryptWithAd(this.h, ciphertext)
    this.mixHash(ciphertext)
    return plaintext
  }

  getHandshakeHash(): Uint8Array {
    return new Uint8Array(this.h)
  }

  split(): [CipherState, CipherState] {
    const [k1, k2] = hkdf(this.ck, EMPTY, 2)
    const c1 = new CipherState()
    const c2 = new CipherState()
    c1.initializeKey(k1)
    c2.initializeKey(k2)
    return [c1, c2]
  }
}

export type HandshakeRole = 'initiator' | 'responder'

export interface NoiseKeyPair {
  privateKey: Uint8Array
  publicKey: Uint8Array
}

export class HandshakeState {
  readonly symmetric = new SymmetricState()
  readonly role: HandshakeRole
  private readonly s: NoiseKeyPair | undefined
  private e: NoiseKeyPair | undefined
  private rs: Uint8Array | undefined
  private re: Uint8Array | undefined
  private readonly psk: Uint8Array | undefined
  private messageIndex = 0
  private readonly pattern: 'XXpsk0' | 'IK'
  private complete = false

  private constructor(
    pattern: 'XXpsk0' | 'IK',
    role: HandshakeRole,
    opts: {
      prologue: Uint8Array
      staticKeyPair?: NoiseKeyPair
      remoteStaticPublicKey?: Uint8Array
      psk?: Uint8Array
      ephemeralKeyPair?: NoiseKeyPair
    },
  ) {
    this.pattern = pattern
    this.role = role
    this.s = opts.staticKeyPair
    this.e = opts.ephemeralKeyPair
    this.rs = opts.remoteStaticPublicKey ? new Uint8Array(opts.remoteStaticPublicKey) : undefined
    this.psk = opts.psk ? new Uint8Array(opts.psk) : undefined

    const protocolName =
      pattern === 'XXpsk0'
        ? 'Noise_XXpsk0_25519_ChaChaPoly_SHA256'
        : 'Noise_IK_25519_ChaChaPoly_SHA256'

    this.symmetric.initializeSymmetric(protocolName)
    this.symmetric.mixHash(opts.prologue)

    if (pattern === 'IK') {
      if (role === 'initiator') {
        if (!this.rs) {
          throw new Error('IK initiator requires remote static public key')
        }
        this.symmetric.mixHash(this.rs)
      } else {
        if (!this.s) {
          throw new Error('IK responder requires static key')
        }
        this.symmetric.mixHash(this.s.publicKey)
        this.rs = undefined
      }
    }
  }

  static createXXpsk0(
    role: HandshakeRole,
    opts: {
      prologue: Uint8Array
      staticKeyPair: NoiseKeyPair
      psk: Uint8Array
      ephemeralKeyPair?: NoiseKeyPair
    },
  ): HandshakeState {
    if (opts.psk.byteLength !== 32) {
      throw new Error('psk must be 32 bytes')
    }
    return new HandshakeState('XXpsk0', role, opts)
  }

  static createIK(
    role: HandshakeRole,
    opts: {
      prologue: Uint8Array
      staticKeyPair: NoiseKeyPair
      remoteStaticPublicKey?: Uint8Array
      ephemeralKeyPair?: NoiseKeyPair
    },
  ): HandshakeState {
    if (role === 'initiator' && !opts.remoteStaticPublicKey) {
      throw new Error('IK initiator requires remoteStaticPublicKey')
    }
    return new HandshakeState('IK', role, opts)
  }

  get remoteStaticPublicKey(): Uint8Array | undefined {
    return this.rs ? new Uint8Array(this.rs) : undefined
  }

  isComplete(): boolean {
    return this.complete
  }

  writeMessage(payload: Uint8Array = EMPTY): Uint8Array {
    if (this.complete) {
      throw new Error('handshake already complete')
    }
    const out: Uint8Array[] = []

    if (this.pattern === 'XXpsk0') {
      if (this.role === 'initiator' && this.messageIndex === 0) {
        this.mixPsk()
        this.writeE(out)
        out.push(this.symmetric.encryptAndHash(payload))
        this.messageIndex = 1
        return concatBytes(...out)
      }
      if (this.role === 'responder' && this.messageIndex === 1) {
        this.writeE(out)
        this.dhEe()
        this.writeS(out)
        this.dhEs()
        out.push(this.symmetric.encryptAndHash(payload))
        this.messageIndex = 2
        return concatBytes(...out)
      }
      if (this.role === 'initiator' && this.messageIndex === 2) {
        this.writeS(out)
        this.dhSe()
        out.push(this.symmetric.encryptAndHash(payload))
        this.messageIndex = 3
        this.complete = true
        return concatBytes(...out)
      }
    }

    if (this.pattern === 'IK') {
      if (this.role === 'initiator' && this.messageIndex === 0) {
        this.writeE(out)
        this.dhEs()
        this.writeS(out)
        this.dhSs()
        out.push(this.symmetric.encryptAndHash(payload))
        this.messageIndex = 1
        return concatBytes(...out)
      }
      if (this.role === 'responder' && this.messageIndex === 1) {
        this.writeE(out)
        this.dhEe()
        this.dhSe()
        out.push(this.symmetric.encryptAndHash(payload))
        this.messageIndex = 2
        this.complete = true
        return concatBytes(...out)
      }
    }

    throw new Error(
      `unexpected writeMessage in ${this.pattern} as ${this.role} at step ${this.messageIndex}`,
    )
  }

  readMessage(message: Uint8Array): Uint8Array {
    if (this.complete) {
      throw new Error('handshake already complete')
    }
    let offset = 0
    const take = (n: number): Uint8Array => {
      if (offset + n > message.byteLength) {
        throw new Error('handshake message truncated')
      }
      const slice = message.subarray(offset, offset + n)
      offset += n
      return slice
    }

    if (this.pattern === 'XXpsk0') {
      if (this.role === 'responder' && this.messageIndex === 0) {
        this.mixPsk()
        this.readE(take)
        const payload = this.symmetric.decryptAndHash(message.subarray(offset))
        this.messageIndex = 1
        return payload
      }
      if (this.role === 'initiator' && this.messageIndex === 1) {
        this.readE(take)
        this.dhEe()
        this.readS(take)
        this.dhEs()
        const payload = this.symmetric.decryptAndHash(message.subarray(offset))
        this.messageIndex = 2
        return payload
      }
      if (this.role === 'responder' && this.messageIndex === 2) {
        this.readS(take)
        this.dhSe()
        const payload = this.symmetric.decryptAndHash(message.subarray(offset))
        this.messageIndex = 3
        this.complete = true
        return payload
      }
    }

    if (this.pattern === 'IK') {
      if (this.role === 'responder' && this.messageIndex === 0) {
        this.readE(take)
        this.dhEs()
        this.readS(take)
        this.dhSs()
        const payload = this.symmetric.decryptAndHash(message.subarray(offset))
        this.messageIndex = 1
        return payload
      }
      if (this.role === 'initiator' && this.messageIndex === 1) {
        this.readE(take)
        this.dhEe()
        this.dhSe()
        const payload = this.symmetric.decryptAndHash(message.subarray(offset))
        this.messageIndex = 2
        this.complete = true
        return payload
      }
    }

    throw new Error(
      `unexpected readMessage in ${this.pattern} as ${this.role} at step ${this.messageIndex}`,
    )
  }

  splitTransport(): { send: CipherState; recv: CipherState; handshakeHash: Uint8Array } {
    if (!this.complete) {
      throw new Error('handshake not complete')
    }
    const [c1, c2] = this.symmetric.split()
    const handshakeHash = this.symmetric.getHandshakeHash()
    if (this.role === 'initiator') {
      return { send: c1, recv: c2, handshakeHash }
    }
    return { send: c2, recv: c1, handshakeHash }
  }

  private mixPsk(): void {
    if (!this.psk) {
      throw new Error('missing psk')
    }
    this.symmetric.mixKeyAndHash(this.psk)
  }

  private ensureEphemeral(): NoiseKeyPair {
    if (!this.e) {
      this.e = generateKeyPair()
    }
    return this.e
  }

  private writeE(out: Uint8Array[]): void {
    const e = this.ensureEphemeral()
    out.push(new Uint8Array(e.publicKey))
    this.symmetric.mixHash(e.publicKey)
  }

  private readE(take: (n: number) => Uint8Array): void {
    this.re = new Uint8Array(take(DH_LEN))
    this.symmetric.mixHash(this.re)
  }

  private writeS(out: Uint8Array[]): void {
    if (!this.s) {
      throw new Error('missing static key')
    }
    out.push(this.symmetric.encryptAndHash(this.s.publicKey))
  }

  private readS(take: (n: number) => Uint8Array): void {
    const len = this.symmetric.cipher.hasKey() ? DH_LEN + TAG_LEN : DH_LEN
    this.rs = new Uint8Array(this.symmetric.decryptAndHash(take(len)))
  }

  private dhEe(): void {
    const e = this.ensureEphemeral()
    if (!this.re) throw new Error('missing remote ephemeral')
    this.symmetric.mixKey(dh(e.privateKey, this.re))
  }

  private dhEs(): void {
    if (this.role === 'initiator') {
      const e = this.ensureEphemeral()
      if (!this.rs) throw new Error('missing remote static')
      this.symmetric.mixKey(dh(e.privateKey, this.rs))
    } else {
      if (!this.s) throw new Error('missing static key')
      if (!this.re) throw new Error('missing remote ephemeral')
      this.symmetric.mixKey(dh(this.s.privateKey, this.re))
    }
  }

  private dhSe(): void {
    if (this.role === 'initiator') {
      if (!this.s) throw new Error('missing static key')
      if (!this.re) throw new Error('missing remote ephemeral')
      this.symmetric.mixKey(dh(this.s.privateKey, this.re))
    } else {
      const e = this.ensureEphemeral()
      if (!this.rs) throw new Error('missing remote static')
      this.symmetric.mixKey(dh(e.privateKey, this.rs))
    }
  }

  private dhSs(): void {
    if (!this.s) throw new Error('missing static key')
    if (!this.rs) throw new Error('missing remote static')
    this.symmetric.mixKey(dh(this.s.privateKey, this.rs))
  }
}
