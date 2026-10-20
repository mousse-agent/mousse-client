import { ed25519, x25519 } from '@noble/curves/ed25519.js'
import { sha256 as nobleSha256 } from '@noble/hashes/sha2.js'
import { hkdf as nobleHkdf } from '@noble/hashes/hkdf.js'
import { hmac } from '@noble/hashes/hmac.js'
import { b64url, fromB64url, fromUtf8 } from './bytes'
import { canonicalJson } from './canonical'
import { NetError } from './errors'

export interface Signed {
  payload: string
  sig: string
}

export function sha256(bytes: Uint8Array): Uint8Array {
  return nobleSha256(bytes)
}

export function hmacSha256(key: Uint8Array, ...parts: Uint8Array[]): Uint8Array {
  const mac = hmac.create(nobleSha256, key)
  for (const part of parts) mac.update(part)
  return mac.digest()
}

export function hkdfSha256(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, length: number): Uint8Array {
  return nobleHkdf(nobleSha256, ikm, salt, info, length)
}

export interface SigningKeyPair {
  /** 32-byte Ed25519 seed. */
  secretKey: Uint8Array
  publicKey: Uint8Array
}

export function generateSigningKey(): SigningKeyPair {
  const { secretKey, publicKey } = ed25519.keygen()
  return { secretKey, publicKey }
}

export function signBytes(bytes: Uint8Array, secretKey: Uint8Array): Uint8Array {
  return ed25519.sign(bytes, secretKey)
}

export function verifyBytes(bytes: Uint8Array, signature: Uint8Array, publicKey: Uint8Array): boolean {
  if (signature.length !== 64 || publicKey.length !== 32) return false
  try {
    return ed25519.verify(signature, bytes, publicKey, { zip215: false })
  } catch {
    return false
  }
}

export interface AgreementKeyPair {
  secretKey: Uint8Array
  publicKey: Uint8Array
}

export function generateAgreementKey(): AgreementKeyPair {
  const { secretKey, publicKey } = x25519.keygen()
  return { secretKey, publicKey }
}

export function x25519Shared(secretKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
  const shared = x25519.getSharedSecret(secretKey, publicKey)
  if (shared.every((byte) => byte === 0)) throw new NetError('bad_request', 'Low-order X25519 key.')
  return shared
}

export function x25519PublicKey(secretKey: Uint8Array): Uint8Array {
  return x25519.getPublicKey(secretKey)
}

/** `{payload: b64url(canonicalJson(value)), sig: b64url(ed25519(payload bytes))}`. */
export function signDocument(value: unknown, secretKey: Uint8Array): Signed {
  const bytes = canonicalJson(value)
  return { payload: b64url(bytes), sig: b64url(signBytes(bytes, secretKey)) }
}

/** Verifies a signed document with a base64url Ed25519 key and returns the parsed payload. */
export function verifyDocument<T>(document: Signed, publicKey: string): T {
  if (
    !document ||
    typeof document !== 'object' ||
    typeof document.payload !== 'string' ||
    typeof document.sig !== 'string'
  )
    throw new NetError('bad_request', 'Malformed signed wrapper.')
  let payload: Uint8Array
  let signature: Uint8Array
  let key: Uint8Array
  try {
    payload = fromB64url(document.payload)
    signature = fromB64url(document.sig, 64)
    key = fromB64url(publicKey, 32)
  } catch (cause) {
    throw new NetError('bad_signature', 'Malformed signature.', { cause })
  }
  if (!verifyBytes(payload, signature, key)) throw new NetError('bad_signature')
  return JSON.parse(fromUtf8(payload)) as T
}

/** Parses a signed payload without verifying it. Use only to pick the verification key. */
export function peekDocument<T>(document: Signed): T {
  return JSON.parse(fromUtf8(fromB64url(document.payload))) as T
}

export function sameJson(a: unknown, b: unknown): boolean {
  const left = canonicalJson(a)
  const right = canonicalJson(b)
  if (left.length !== right.length) return false
  return left.every((byte, index) => byte === right[index])
}

/** SHA-256 of bytes as base64url, the Net fingerprint form. */
export function fingerprint(bytes: Uint8Array): string {
  return b64url(sha256(bytes))
}
