import { x25519 } from '@noble/curves/ed25519.js'
import { PUBLIC_KEY_BYTES, PAIRING_SECRET_BYTES } from '../constants'

export const PRIVATE_KEY_BYTES = 32
export const DH_OUTPUT_BYTES = 32

export interface X25519KeyPair {
  publicKey: Uint8Array
  privateKey: Uint8Array
}

export function cloneBytes(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes)
}

export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) {
    return false
  }
  let diff = 0
  for (let i = 0; i < a.byteLength; i++) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0)
  }
  return diff === 0
}

export function randomKeyBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  return bytes
}

export function generateKeyPair(): X25519KeyPair {
  const privateKey = randomKeyBytes(32)
  const publicKey = x25519.getPublicKey(privateKey)
  return {
    privateKey,
    publicKey,
  }
}

export function publicKeyFromPrivate(privateKey: Uint8Array): Uint8Array {
  if (privateKey.byteLength !== PRIVATE_KEY_BYTES) {
    throw new Error(`privateKey must be ${PRIVATE_KEY_BYTES} bytes`)
  }
  return x25519.getPublicKey(privateKey)
}

export function dh(privateKey: Uint8Array, peerPublicKey: Uint8Array): Uint8Array {
  if (privateKey.byteLength !== PRIVATE_KEY_BYTES) {
    throw new Error(`privateKey must be ${PRIVATE_KEY_BYTES} bytes`)
  }
  if (peerPublicKey.byteLength !== PUBLIC_KEY_BYTES) {
    throw new Error(`peerPublicKey must be ${PUBLIC_KEY_BYTES} bytes`)
  }
  return x25519.getSharedSecret(privateKey, peerPublicKey)
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = ''
  const len = bytes.byteLength
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]!)
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

export function base64UrlDecode(str: string): Uint8Array {
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/')
  while (base64.length % 4 !== 0) {
    base64 += '='
  }
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i]!.toString(16).padStart(2, '0')
  }
  return out
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error('invalid hex string length')
  }
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16)
  }
  return bytes
}
