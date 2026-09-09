import { CipherState, TAG_LEN } from './noise'
import {
  MAX_FRAME_PAYLOAD_BYTES,
  encodeFrame,
  decodeFrame,
  FrameError,
} from './framing'

export class SessionError extends Error {
  override readonly name = 'SessionError'
}

/**
 * Post-handshake transport session with distinct per-direction keys/nonces.
 * Nonces are sequential; replay and out-of-order ciphertext fail AEAD and are rejected.
 */
export class SecureSession {
  private closed = false

  constructor(
    private readonly sendCipher: CipherState,
    private readonly recvCipher: CipherState,
    readonly handshakeHash: Uint8Array,
    readonly remoteStaticPublicKey: Uint8Array,
  ) {}

  get sendNonce(): bigint {
    return this.sendCipher.nonce
  }

  get recvNonce(): bigint {
    return this.recvCipher.nonce
  }

  /** Encrypt plaintext into a length-prefixed transport frame. */
  encrypt(plaintext: Uint8Array): Uint8Array {
    this.assertOpen()
    const ciphertext = this.sendCipher.encryptWithAd(new Uint8Array(0), plaintext)
    if (ciphertext.byteLength > MAX_FRAME_PAYLOAD_BYTES) {
      throw new SessionError(
        `ciphertext ${ciphertext.byteLength} exceeds frame limit ${MAX_FRAME_PAYLOAD_BYTES}`,
      )
    }
    return encodeFrame(ciphertext)
  }

  /**
   * Decrypt one length-prefixed transport frame.
   * Rejects truncated/oversized frames, AEAD failures, and thus replay/out-of-order.
   */
  decrypt(frame: Uint8Array): Uint8Array {
    this.assertOpen()
    let payload: Uint8Array
    try {
      ;({ payload } = decodeFrame(frame))
    } catch (err) {
      if (err instanceof FrameError) {
        throw new SessionError(err.message)
      }
      throw err
    }
    if (payload.byteLength < TAG_LEN) {
      throw new SessionError('ciphertext too short')
    }
    try {
      return this.recvCipher.decryptWithAd(new Uint8Array(0), payload)
    } catch {
      throw new SessionError('AUTH_FAILED: REPLAY_DETECTED: decrypt failed: authentication, replay, or out-of-order')
    }
  }

  /** Decrypt raw Noise transport ciphertext without length framing (tests/vectors). */
  decryptRaw(ciphertext: Uint8Array): Uint8Array {
    this.assertOpen()
    try {
      return this.recvCipher.decryptWithAd(new Uint8Array(0), ciphertext)
    } catch {
      throw new SessionError('AUTH_FAILED: REPLAY_DETECTED: decrypt failed: authentication, replay, or out-of-order')
    }
  }

  /** Encrypt raw Noise transport ciphertext without length framing (tests/vectors). */
  encryptRaw(plaintext: Uint8Array): Uint8Array {
    this.assertOpen()
    return this.sendCipher.encryptWithAd(new Uint8Array(0), plaintext)
  }

  close(): void {
    this.closed = true
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new SessionError('session closed')
    }
  }
}
