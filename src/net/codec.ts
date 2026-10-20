// Mux message encoding, compatible with the desktop `sync/codec.ts`:
// u32BE headerLength ‖ canonical JSON header ‖ binary parts declared by `header.parts`.
import { canonicalJson } from './canonical'
import { NetError } from './errors'
import type { Signed } from './crypto'
import type { NodePublicKeys } from './keys'
import type { WireError } from './errors'

export const MAX_MESSAGE_HEADER_BYTES = 64 * 1024
export const MAX_MESSAGE_BYTES = 1024 * 1024
export const PREAUTH_MAX_BYTES = 16 * 1024

export type Lane = 'control' | 'bulk'

export interface StreamHead {
  epoch: number
  seq: number
}
export interface RecordHeader {
  seq: number
  epoch: number
  recvTs: number
}

/** The wire messages the phone sends or reads. Other known types are passed through untyped. */
export type WireMessage =
  | {
      t: 'hello'
      protoMajor: number
      protoMinor: number
      caps: string[]
      node: string
      delegation?: Signed
      roster?: Signed
      routes?: Signed
      now: number
    }
  | { t: 'helloAck'; protoMinor: number; caps: string[]; now: number }
  | { t: 'ping'; n: number; now: number }
  | { t: 'pong'; n: number; now: number }
  | { t: 'goAway'; error: WireError }
  | { t: 'error'; re?: string; error: WireError }
  | { t: 'subscribe'; stream: string; after: StreamHead }
  | { t: 'subscribed'; stream: string; head: StreamHead; replayThrough: number }
  | { t: 'events'; stream: string; records: RecordHeader[]; replay: boolean; parts: number[] }
  | { t: 'caughtUp'; stream: string }
  | { t: 'snapshotRequired'; stream: string; reason: string; head: StreamHead }
  | { t: 'unsubscribe'; stream: string }
  | { t: 'rpc.request'; id: string; method: string; params: unknown; idem?: string; deadlineMs: number }
  | { t: 'rpc.progress'; id: string; data: unknown }
  | { t: 'rpc.result'; id: string; result?: unknown; error?: WireError; blob?: unknown }
  | { t: 'rpc.cancel'; id: string }
  | { t: 'rpc.result.get'; id: string }
  | { t: 'ephemeral'; stream: string; kind: 'typing' | 'delta'; data: unknown }
  | { t: 'revoked'; subject: string }
  | { t: 'rosterUpdate'; roster: Signed }
  | { t: 'enroll.request'; invite: string; node: string; keys: NodePublicKeys; name: string; proof: string }
  | { t: 'enroll.result'; delegation?: Signed; roster?: Signed; error?: WireError }
  | {
      t: 'snapshot.chunk'
      stream: string
      epoch: number
      throughSeq: number
      records: RecordHeader[]
      done: boolean
      parts: number[]
    }

export interface MuxMessage {
  header: WireMessage
  parts: Uint8Array[]
}

/** Every type the desktop defines; anything else is skipped as a newer protocol message. */
const KNOWN_TYPES = new Set(
  (
    'hello helloAck ping pong goAway error subscribe subscribed events caughtUp snapshotRequired snapshot.get ' +
    'snapshot.chunk unsubscribe metaHead.get metaHead space.discovery.get space.discovery.result ' +
    'space.identity.get space.identity.result space.proof.cancel append appendResult blob.put.begin blob.chunk ' +
    'blob.put.end blob.put.result blob.get blob.end rpc.request rpc.progress rpc.result rpc.cancel rpc.result.get ' +
    'presence ephemeral revoked rosterUpdate enroll.request enroll.result space.join.request space.join.result'
  ).split(' '),
)
const BULK_TYPES = new Set(['snapshot.chunk', 'blob.chunk', 'space.discovery.result'])

export function laneFor(header: { t: string; replay?: unknown }): Lane {
  if (header.t === 'events') return header.replay ? 'bulk' : 'control'
  return BULK_TYPES.has(header.t) ? 'bulk' : 'control'
}

const fail = (message: string): never => {
  throw new NetError('bad_request', message)
}
const large = (message: string): never => {
  throw new NetError('too_large', message)
}

const isUint = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0

function checkHeader(value: unknown): WireMessage {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return fail('Header must be an object.')
  const t = (value as { t?: unknown }).t
  if (typeof t !== 'string') return fail('Header type is missing.')
  if (!KNOWN_TYPES.has(t)) throw new NetError('unsupported_version', 'Unknown wire message type.')
  const header = value as WireMessage & { parts?: unknown; records?: unknown }
  if ('parts' in header && (!Array.isArray(header.parts) || !header.parts.every(isUint)))
    return fail('Invalid part lengths.')
  if (header.t === 'events' || header.t === 'snapshot.chunk') {
    if (!Array.isArray(header.records) || !Array.isArray(header.parts)) return fail('Invalid record batch.')
    for (const record of header.records)
      if (!record || !isUint(record.seq) || !isUint(record.epoch) || !isUint(record.recvTs))
        return fail('Invalid record header.')
  }
  if (header.t === 'subscribed') {
    if (!header.head || !isUint(header.head.seq) || header.replayThrough !== header.head.seq)
      return fail('Replay boundary differs from captured head.')
  }
  return header
}

function declaredParts(header: WireMessage): number[] {
  return 'parts' in header && Array.isArray(header.parts) ? header.parts : []
}

function checkParts(header: WireMessage, parts: readonly Uint8Array[]): void {
  const lengths = declaredParts(header)
  if (parts.length !== lengths.length) fail('Binary part count mismatch.')
  for (let i = 0; i < parts.length; i++) if (parts[i].byteLength !== lengths[i]) fail('Binary part length mismatch.')
  if (header.t === 'events' || header.t === 'snapshot.chunk') {
    if (lengths.length !== header.records.length * 2) fail('Each record needs envelope and signature parts.')
    for (let i = 0; i < lengths.length; i += 2) if (lengths[i + 1] !== 64) fail('Ed25519 signatures must be 64 bytes.')
    for (let i = 1; i < header.records.length; i++) {
      const prev = header.records[i - 1]
      const next = header.records[i]
      if (next.epoch !== prev.epoch || next.seq !== prev.seq + 1) fail('Record batch is not a dense sequence.')
    }
  }
}

export function encodeMessage(header: WireMessage, parts: readonly Uint8Array[] = []): Uint8Array {
  const headerBytes = canonicalJson(header)
  if (headerBytes.length > MAX_MESSAGE_HEADER_BYTES) large('Message header exceeds 64 KiB.')
  checkHeader(header)
  checkParts(header, parts)
  const length = 4 + headerBytes.length + parts.reduce((total, part) => total + part.length, 0)
  if (length > MAX_MESSAGE_BYTES) large('Message exceeds 1 MiB.')
  const bytes = new Uint8Array(length)
  new DataView(bytes.buffer).setUint32(0, headerBytes.length, false)
  bytes.set(headerBytes, 4)
  let offset = 4 + headerBytes.length
  for (const part of parts) {
    bytes.set(part, offset)
    offset += part.length
  }
  return bytes
}

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

export function decodeMessage(bytes: Uint8Array, lane?: Lane): MuxMessage {
  if (bytes.length > MAX_MESSAGE_BYTES) large('Message exceeds 1 MiB.')
  if (bytes.length < 4) fail('Truncated message prefix.')
  const headerLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, false)
  if (headerLength > MAX_MESSAGE_HEADER_BYTES) large('Message header exceeds 64 KiB.')
  if (headerLength === 0 || headerLength + 4 > bytes.length) fail('Truncated message header.')
  let parsed: unknown
  try {
    parsed = JSON.parse(decoder.decode(bytes.subarray(4, 4 + headerLength)))
  } catch {
    return fail('Invalid header JSON.')
  }
  const header = checkHeader(parsed)
  if (lane !== undefined && laneFor(header) !== lane) fail('Message arrived on the wrong lane.')
  const parts: Uint8Array[] = []
  let offset = 4 + headerLength
  for (const length of declaredParts(header)) {
    if (length > bytes.length - offset) fail('Truncated binary part.')
    parts.push(bytes.subarray(offset, offset + length))
    offset += length
  }
  if (offset !== bytes.length) fail('Undeclared trailing bytes.')
  checkParts(header, parts)
  return { header, parts }
}
