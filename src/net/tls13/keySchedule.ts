// RFC 8446 §7 key schedule for TLS_AES_128_GCM_SHA256.
import { gcm } from '@noble/ciphers/aes.js'
import { expand, extract } from '@noble/hashes/hkdf.js'
import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { concat, u16, utf8 } from '../bytes'

export const HASH_LEN = 32
export const KEY_LEN = 16
export const IV_LEN = 12
const ZEROS = new Uint8Array(HASH_LEN)
const EMPTY_HASH = sha256(new Uint8Array(0))

export function expandLabel(secret: Uint8Array, label: string, context: Uint8Array, length: number): Uint8Array {
  const fullLabel = utf8(`tls13 ${label}`)
  const info = concat(u16(length), Uint8Array.of(fullLabel.length), fullLabel, Uint8Array.of(context.length), context)
  return expand(sha256, secret, info, length)
}

/** Derive-Secret with an already computed transcript hash. */
export function deriveSecret(secret: Uint8Array, label: string, transcriptHash: Uint8Array): Uint8Array {
  return expandLabel(secret, label, transcriptHash, HASH_LEN)
}

export function earlySecret(): Uint8Array {
  return extract(sha256, ZEROS, ZEROS)
}

export function handshakeSecret(early: Uint8Array, sharedSecret: Uint8Array): Uint8Array {
  return extract(sha256, sharedSecret, deriveSecret(early, 'derived', EMPTY_HASH))
}

export function masterSecret(handshake: Uint8Array): Uint8Array {
  return extract(sha256, ZEROS, deriveSecret(handshake, 'derived', EMPTY_HASH))
}

export function finishedMac(baseKey: Uint8Array, transcriptHash: Uint8Array): Uint8Array {
  return hmac(sha256, expandLabel(baseKey, 'finished', new Uint8Array(0), HASH_LEN), transcriptHash)
}

export function nextTrafficSecret(secret: Uint8Array): Uint8Array {
  return expandLabel(secret, 'traffic upd', new Uint8Array(0), HASH_LEN)
}

/** RFC 8446 §7.5 exporter. */
export function exportKeyingMaterial(
  exporterMaster: Uint8Array,
  label: string,
  context: Uint8Array,
  length: number,
): Uint8Array {
  const secret = deriveSecret(exporterMaster, label, EMPTY_HASH)
  return expandLabel(secret, 'exporter', sha256(context), length)
}

/** Running transcript hash; `hash()` does not consume the state. */
export class Transcript {
  private state = sha256.create()
  add(message: Uint8Array): void {
    this.state.update(message)
  }
  hash(): Uint8Array {
    return this.state.clone().digest()
  }
}

/** One direction of record protection: AEAD key, static IV and sequence number. */
export class RecordCipher {
  private key: Uint8Array
  private iv: Uint8Array
  private seq = 0

  constructor(public secret: Uint8Array) {
    this.key = expandLabel(secret, 'key', new Uint8Array(0), KEY_LEN)
    this.iv = expandLabel(secret, 'iv', new Uint8Array(0), IV_LEN)
  }

  private nonce(): Uint8Array {
    if (this.seq >= Number.MAX_SAFE_INTEGER) throw new Error('TLS sequence number exhausted.')
    const nonce = this.iv.slice()
    let seq = this.seq++
    for (let i = IV_LEN - 1; i >= IV_LEN - 8 && seq > 0; i--) {
      nonce[i] ^= seq % 256
      seq = Math.floor(seq / 256)
    }
    return nonce
  }

  seal(header: Uint8Array, plaintext: Uint8Array): Uint8Array {
    return gcm(this.key, this.nonce(), header).encrypt(plaintext)
  }

  open(header: Uint8Array, ciphertext: Uint8Array): Uint8Array {
    return gcm(this.key, this.nonce(), header).decrypt(ciphertext)
  }

  next(): RecordCipher {
    return new RecordCipher(nextTrafficSecret(this.secret))
  }
}
