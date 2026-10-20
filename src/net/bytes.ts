// Small byte helpers shared by the Net and Mousse ID code. Browser-safe: no Buffer.

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

export function utf8(text: string): Uint8Array {
  return encoder.encode(text)
}

export function fromUtf8(bytes: Uint8Array): string {
  return decoder.decode(bytes)
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  let length = 0
  for (const part of parts) length += part.length
  const out = new Uint8Array(length)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
const B64_INDEX = new Map([...B64].map((char, index) => [char, index]))

/** Base64url without padding. */
export function b64url(bytes: Uint8Array): string {
  let out = ''
  let i = 0
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2]
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63]
  }
  const rest = bytes.length - i
  if (rest === 1) {
    const n = bytes[i] << 16
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63]
  } else if (rest === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8)
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63]
  }
  return out
}

/** Strict base64url decode: rejects padding, foreign characters and non-canonical trailing bits. */
export function fromB64url(text: string, expectedLength?: number): Uint8Array {
  if (typeof text !== 'string' || text.length % 4 === 1) throw new Error('Invalid base64url.')
  const out = new Uint8Array(Math.floor((text.length * 3) / 4))
  let bits = 0
  let value = 0
  let offset = 0
  for (const char of text) {
    const index = B64_INDEX.get(char)
    if (index === undefined) throw new Error('Invalid base64url.')
    value = (value << 6) | index
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[offset++] = (value >> bits) & 0xff
    }
  }
  if (bits && value & ((1 << bits) - 1)) throw new Error('Invalid base64url.')
  if (expectedLength !== undefined && out.length !== expectedLength)
    throw new Error('Invalid base64url length.')
  return out
}

export function u16(value: number): Uint8Array {
  return Uint8Array.of((value >>> 8) & 0xff, value & 0xff)
}

export function u24(value: number): Uint8Array {
  return Uint8Array.of((value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff)
}

export function u32(value: number): Uint8Array {
  return Uint8Array.of((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff)
}

export function readU16(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] << 8) | bytes[offset + 1]
}

export function readU24(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] << 16) | (bytes[offset + 1] << 8) | bytes[offset + 2]
}

export function readU32(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0
}

export function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length)
  globalThis.crypto.getRandomValues(out)
  return out
}

/** Sequential reader that throws on truncation. */
export class Reader {
  offset = 0
  constructor(readonly bytes: Uint8Array) {}
  get remaining(): number {
    return this.bytes.length - this.offset
  }
  take(length: number): Uint8Array {
    if (length < 0 || this.offset + length > this.bytes.length) throw new Error('Truncated message.')
    const out = this.bytes.subarray(this.offset, this.offset + length)
    this.offset += length
    return out
  }
  u8(): number {
    return this.take(1)[0]
  }
  u16(): number {
    return readU16(this.take(2), 0)
  }
  u24(): number {
    return readU24(this.take(3), 0)
  }
  vec8(): Uint8Array {
    return this.take(this.u8())
  }
  vec16(): Uint8Array {
    return this.take(this.u16())
  }
  vec24(): Uint8Array {
    return this.take(this.u24())
  }
  end(): void {
    if (this.remaining !== 0) throw new Error('Trailing bytes.')
  }
}
