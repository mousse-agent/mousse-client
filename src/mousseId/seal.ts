// Sealed invites, the match code and the join QR code (contract §4 and §5).
import { chacha20poly1305 } from '@noble/ciphers/chacha.js'
import { b64url, concat, fromB64url, fromUtf8, randomBytes, readU32, utf8 } from '../net/bytes'
import { hkdfSha256, sha256, x25519PublicKey, x25519Shared } from '../net/crypto'
import { MousseIdError } from './http'

export const REQUEST_SEAL_INFO = 'mousse-net/enroll-seal/v1'
export const OFFER_SEAL_AAD = 'mousse-net/enroll-offer/v1'
const MATCH_DOMAIN = 'mousse-net/enroll-match/v1'
const NONCE_BYTES = 12
const TAG_BYTES = 16
const KEY_BYTES = 32
const SEALED_MAX_CHARS = 16_384

function invalidSeal(): never {
  throw new MousseIdError('bad_response', 'The invite from the computer could not be opened. Try again.')
}

function requestKey(shared: Uint8Array, ephemeralPublic: Uint8Array, boxPublic: Uint8Array): Uint8Array {
  return hkdfSha256(shared, concat(ephemeralPublic, boxPublic), utf8(REQUEST_SEAL_INFO), KEY_BYTES)
}

function decodeSealed(sealed: string, minBytes: number): Uint8Array {
  if (typeof sealed !== 'string' || sealed.length > SEALED_MAX_CHARS) invalidSeal()
  let bytes: Uint8Array
  try {
    bytes = fromB64url(sealed)
  } catch {
    invalidSeal()
  }
  if (bytes.length < minBytes) invalidSeal()
  return bytes
}

function openInvite(key: Uint8Array, nonce: Uint8Array, ciphertext: Uint8Array, aad: string): string {
  let plain: Uint8Array
  try {
    plain = chacha20poly1305(key, nonce, utf8(aad)).decrypt(ciphertext)
  } catch {
    invalidSeal()
  }
  let text: string
  try {
    text = fromUtf8(plain)
  } catch {
    invalidSeal()
  }
  if (!text.startsWith('mj1_')) invalidSeal()
  return text
}

/** Seals an invite to a phone's box key. The desktop does this; the phone uses it only in tests. */
export function sealForRequest(invite: string, boxPublicKey: Uint8Array, requestId: string, ephemeralSecret = randomBytes(32), nonce = randomBytes(NONCE_BYTES)): string {
  const ephemeralPublic = x25519PublicKey(ephemeralSecret)
  const key = requestKey(x25519Shared(ephemeralSecret, boxPublicKey), ephemeralPublic, boxPublicKey)
  const ciphertext = chacha20poly1305(key, nonce, utf8(`${REQUEST_SEAL_INFO}:${requestId}`)).encrypt(utf8(invite))
  return b64url(concat(ephemeralPublic, nonce, ciphertext))
}

export function openRequestSeal(sealed: string, boxSecretKey: Uint8Array, requestId: string): string {
  const bytes = decodeSealed(sealed, KEY_BYTES + NONCE_BYTES + TAG_BYTES)
  const ephemeralPublic = bytes.subarray(0, KEY_BYTES)
  const nonce = bytes.subarray(KEY_BYTES, KEY_BYTES + NONCE_BYTES)
  const boxPublic = x25519PublicKey(boxSecretKey)
  let shared: Uint8Array
  try {
    shared = x25519Shared(boxSecretKey, ephemeralPublic)
  } catch {
    invalidSeal()
  }
  const key = requestKey(shared, ephemeralPublic, boxPublic)
  return openInvite(key, nonce, bytes.subarray(KEY_BYTES + NONCE_BYTES), `${REQUEST_SEAL_INFO}:${requestId}`)
}

export function sealForOffer(invite: string, key: Uint8Array, nonce = randomBytes(NONCE_BYTES)): string {
  return b64url(concat(nonce, chacha20poly1305(key, nonce, utf8(OFFER_SEAL_AAD)).encrypt(utf8(invite))))
}

export function openOfferSeal(sealed: string, key: Uint8Array): string {
  if (key.length !== KEY_BYTES) invalidSeal()
  const bytes = decodeSealed(sealed, NONCE_BYTES + TAG_BYTES)
  return openInvite(key, bytes.subarray(0, NONCE_BYTES), bytes.subarray(NONCE_BYTES), OFFER_SEAL_AAD)
}

/** Six digits shown on the phone and the computer so a person can spot a swapped key. */
export function matchCode(boxPublicKey: Uint8Array, transportFingerprint: string): string {
  const hash = sha256(concat(utf8(MATCH_DOMAIN), new Uint8Array([0]), boxPublicKey, new Uint8Array([0]), utf8(transportFingerprint)))
  return String(readU32(hash, 0) % 1_000_000).padStart(6, '0')
}

export interface JoinQr {
  /** The Mousse ID API origin named by the QR code, as given (the caller compares it to the configured one). */
  origin: string
  offer: string
  key: Uint8Array
}

/** Parses `mousse://net/join?v=1&plus=<origin>&offer=<id>&key=<K>`. */
export function parseJoinQr(text: string): JoinQr {
  const invalid = (): never => {
    throw new MousseIdError('bad_request', 'This QR code is not a Mousse join code.')
  }
  let url: URL
  try {
    url = new URL(text.trim())
  } catch {
    return invalid()
  }
  // `mousse://net/join` parses as host "net" and path "/join".
  if (url.protocol !== 'mousse:' || url.host !== 'net' || url.pathname !== '/join') invalid()
  const params = url.searchParams
  if (params.get('v') !== '1') throw new MousseIdError('bad_request', 'This join code needs a newer version of the app.')
  const origin = params.get('plus')
  const offer = params.get('offer')
  const key = params.get('key')
  if (!origin || !offer || !key || !/^[A-Za-z0-9_-]{1,128}$/.test(offer)) invalid()
  let keyBytes: Uint8Array
  try {
    keyBytes = fromB64url(key!, KEY_BYTES)
  } catch {
    return invalid()
  }
  return { origin: origin!, offer: offer!, key: keyBytes }
}
