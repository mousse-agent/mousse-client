// Minimal X.509 for Net transport keys (ECDSA P-256). Mirrors the desktop
// selfSignedCert.ts: peers never validate chains, they pin the SPKI fingerprint.
import { p256 } from '@noble/curves/nist.js'
import { concat, equalBytes, randomBytes, utf8 } from './bytes'
import { fingerprint } from './crypto'

const DAY_MS = 86_400_000
const DEFAULT_VALIDITY_DAYS = 36_500

// ------------------------------------------------------------------ DER encode

function derLength(length: number): Uint8Array {
  if (length < 0x80) return Uint8Array.of(length)
  const bytes: number[] = []
  for (let rest = length; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest % 256)
  return Uint8Array.of(0x80 | bytes.length, ...bytes)
}

function tlv(tag: number, ...parts: Uint8Array[]): Uint8Array {
  const body = concat(...parts)
  return concat(Uint8Array.of(tag), derLength(body.length), body)
}

const sequence = (...parts: Uint8Array[]) => tlv(0x30, ...parts)
const set = (...parts: Uint8Array[]) => tlv(0x31, ...parts)
const hex = (text: string) => Uint8Array.from(text.match(/../g)!.map((pair) => parseInt(pair, 16)))
const oid = (text: string) => tlv(0x06, hex(text))

function unsignedInteger(bytes: Uint8Array): Uint8Array {
  let start = 0
  while (start < bytes.length - 1 && bytes[start] === 0) start += 1
  const trimmed = bytes.subarray(start)
  return tlv(0x02, trimmed[0] & 0x80 ? concat(Uint8Array.of(0), trimmed) : trimmed)
}

function time(ms: number): Uint8Array {
  const iso = new Date(ms).toISOString()
  const digits = iso.replace(/[-:T]/g, '').slice(0, 14)
  const year = Number(iso.slice(0, 4))
  if (year >= 1950 && year < 2050) return tlv(0x17, utf8(`${digits.slice(2)}Z`))
  return tlv(0x18, utf8(`${digits}Z`))
}

const ECDSA_WITH_SHA256 = sequence(oid('2a8648ce3d040302'))
const COMMON_NAME_OID = oid('550403')
/** SPKI prefix for an uncompressed P-256 point (id-ecPublicKey, prime256v1). */
const P256_SPKI_PREFIX = hex('3059301306072a8648ce3d020106082a8648ce3d030107034200')

// ------------------------------------------------------------------ keys

export interface TransportKey {
  /** 32-byte P-256 scalar. */
  secretKey: Uint8Array
  /** SubjectPublicKeyInfo DER (uncompressed point), the Net `keys.transport`. */
  spki: Uint8Array
  /** Self-signed X.509 certificate DER. */
  certificate: Uint8Array
}

export function p256Spki(publicKey: Uint8Array): Uint8Array {
  const point = publicKey.length === 65 ? publicKey : p256.Point.fromBytes(publicKey).toBytes(false)
  return concat(P256_SPKI_PREFIX, point)
}

/** Uncompressed P-256 point from an SPKI DER; throws if it is not exactly a P-256 SPKI. */
export function p256PointFromSpki(spki: Uint8Array): Uint8Array {
  if (spki.length !== P256_SPKI_PREFIX.length + 65 || !equalBytes(spki.subarray(0, P256_SPKI_PREFIX.length), P256_SPKI_PREFIX))
    throw new Error('Transport keys must be ECDSA P-256.')
  const point = spki.slice(P256_SPKI_PREFIX.length)
  p256.Point.fromBytes(point).assertValidity()
  return point
}

export function generateTransportKey(options: { now?: number; commonName?: string } = {}): TransportKey {
  const secretKey = p256.utils.randomSecretKey()
  return transportKeyFromSecret(secretKey, options)
}

export function transportKeyFromSecret(
  secretKey: Uint8Array,
  options: { now?: number; commonName?: string; validityDays?: number } = {},
): TransportKey {
  const spki = p256Spki(p256.getPublicKey(secretKey, false))
  const now = options.now ?? Date.now()
  const name = sequence(set(sequence(COMMON_NAME_OID, tlv(0x0c, utf8(options.commonName ?? 'Mousse Net')))))
  const serial = randomBytes(16)
  serial[0] = (serial[0] & 0x7f) | 0x40
  const tbs = sequence(
    tlv(0xa0, unsignedInteger(Uint8Array.of(2))),
    unsignedInteger(serial),
    ECDSA_WITH_SHA256,
    name,
    sequence(time(now - DAY_MS), time(now + (options.validityDays ?? DEFAULT_VALIDITY_DAYS) * DAY_MS)),
    name,
    spki,
  )
  const signature = ecdsaSignDer(tbs, secretKey)
  const certificate = sequence(tbs, ECDSA_WITH_SHA256, tlv(0x03, Uint8Array.of(0), signature))
  return { secretKey, spki, certificate }
}

/** ECDSA P-256 over SHA-256(message), DER-encoded signature (TLS and X.509 form). */
export function ecdsaSignDer(message: Uint8Array, secretKey: Uint8Array): Uint8Array {
  return p256.sign(message, secretKey, { prehash: true, lowS: false, format: 'der' })
}

export function ecdsaVerifyDer(signature: Uint8Array, message: Uint8Array, spki: Uint8Array): boolean {
  try {
    return p256.verify(signature, message, p256PointFromSpki(spki), { prehash: true, lowS: false, format: 'der' })
  } catch {
    return false
  }
}

// ------------------------------------------------------------------ DER parse

interface Tlv {
  tag: number
  /** Full encoding including tag and length. */
  raw: Uint8Array
  body: Uint8Array
  next: number
}

function readTlv(bytes: Uint8Array, offset: number): Tlv {
  if (offset + 2 > bytes.length) throw new Error('Truncated DER.')
  const tag = bytes[offset]
  let length = bytes[offset + 1]
  let cursor = offset + 2
  if (length & 0x80) {
    const count = length & 0x7f
    if (count === 0 || count > 4 || cursor + count > bytes.length) throw new Error('Bad DER length.')
    length = 0
    for (let i = 0; i < count; i++) length = length * 256 + bytes[cursor + i]
    cursor += count
  }
  if (cursor + length > bytes.length) throw new Error('Truncated DER.')
  return { tag, raw: bytes.subarray(offset, cursor + length), body: bytes.subarray(cursor, cursor + length), next: cursor + length }
}

/** SPKI DER of the key inside an X.509 certificate DER. */
export function spkiFromCertificate(certificate: Uint8Array): Uint8Array {
  const cert = readTlv(certificate, 0)
  if (cert.tag !== 0x30 || cert.next !== certificate.length) throw new Error('Bad certificate.')
  const tbs = readTlv(cert.body, 0)
  if (tbs.tag !== 0x30) throw new Error('Bad certificate.')
  let offset = 0
  let field = readTlv(tbs.body, offset)
  if (field.tag === 0xa0) field = readTlv(tbs.body, (offset = field.next))
  // serial, signature, issuer, validity, subject, spki
  for (let i = 0; i < 5; i++) field = readTlv(tbs.body, (offset = field.next))
  if (field.tag !== 0x30) throw new Error('Bad certificate.')
  return field.raw.slice()
}

export function spkiFingerprint(spki: Uint8Array): string {
  return fingerprint(spki)
}
