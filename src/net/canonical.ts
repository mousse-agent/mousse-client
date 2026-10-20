import { randomBytes, utf8 } from './bytes'

const MAX_DEPTH = 64
const MAX_NODES = 100_000
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u

/** Compact sorted-key JSON, byte-identical to the desktop `canonicalJson`. */
export function canonicalJsonText(value: unknown): string {
  let nodes = 0
  const serialize = (item: unknown, depth: number): string => {
    if (depth > MAX_DEPTH || ++nodes > MAX_NODES) throw new Error('JSON structure exceeds bounds.')
    if (item === null || typeof item === 'boolean') return JSON.stringify(item)
    if (typeof item === 'number') {
      if (!Number.isFinite(item) || (Number.isInteger(item) && !Number.isSafeInteger(item)))
        throw new Error('Unsafe JSON number.')
      return JSON.stringify(item)
    }
    if (typeof item === 'string') {
      if (LONE_SURROGATE.test(item)) throw new Error('Unpaired Unicode surrogate.')
      return JSON.stringify(item)
    }
    if (Array.isArray(item)) {
      for (let i = 0; i < item.length; i++)
        if (!Object.hasOwn(item, i)) throw new Error('Sparse arrays are not canonical JSON.')
      return `[${item.map((entry) => serialize(entry, depth + 1)).join(',')}]`
    }
    if (
      typeof item === 'object' &&
      (Object.getPrototypeOf(item) === Object.prototype || Object.getPrototypeOf(item) === null)
    ) {
      const record = item as Record<string, unknown>
      return `{${Object.keys(record)
        .sort()
        .map((key) => `${serialize(key, depth + 1)}:${serialize(record[key], depth + 1)}`)
        .join(',')}}`
    }
    throw new Error('Expected a JSON value.')
  }
  return serialize(value, 0)
}

export function canonicalJson(value: unknown): Uint8Array {
  return utf8(canonicalJsonText(value))
}

const CROCKFORD = '0123456789abcdefghjkmnpqrstvwxyz'
export const ID_PREFIXES = {
  user: 'usr',
  node: 'nod',
  invite: 'inv',
  rpc: 'rpc',
  event: 'evt',
  stream: 'str',
  space: 'spc',
  bot: 'bot',
  execution: 'exe',
} as const
export type IdKind = keyof typeof ID_PREFIXES

/** `prefix_` + 26 Crockford base32 characters of 128 random bits, big-endian. */
export function newId(kind: IdKind): string {
  const bytes = randomBytes(16)
  let value = 0n
  for (const byte of bytes) value = (value << 8n) | BigInt(byte)
  let out = ''
  for (let i = 0; i < 26; i++) {
    out = CROCKFORD[Number(value & 31n)] + out
    value >>= 5n
  }
  return `${ID_PREFIXES[kind]}_${out}`
}

export function isId(kind: IdKind, value: unknown): value is string {
  return (
    typeof value === 'string' &&
    new RegExp(`^${ID_PREFIXES[kind]}_[0-9a-hjkmnp-tv-z]{26}$`).test(value)
  )
}
