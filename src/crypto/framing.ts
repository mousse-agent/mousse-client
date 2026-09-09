import { CHUNK_MAX_BYTES, MESSAGE_MAX_BYTES } from '../constants'

export const FRAME_MAGIC = 0x4d50 as const // 'MP'
export const FRAME_VERSION = 1 as const
export const FRAME_HEADER_BYTES = 8 as const
export const FRAME_FLAG_FIN = 0x01 as const
export const FRAME_FLAG_CONTROL = 0x02 as const
export const FRAME_MAX_PAYLOAD_BYTES = CHUNK_MAX_BYTES

export const TAG_LEN = 16
export const MAX_FRAME_PAYLOAD_BYTES = FRAME_MAX_PAYLOAD_BYTES
export const MAX_PLAINTEXT_CHUNK_BYTES = MAX_FRAME_PAYLOAD_BYTES - TAG_LEN

export class FrameError extends Error {
  override readonly name = 'FrameError'
}

export function writeFrameHeader(
  payloadLength: number,
  flags: number = FRAME_FLAG_FIN,
): Uint8Array {
  if (
    !Number.isInteger(payloadLength) ||
    payloadLength < 0 ||
    payloadLength > FRAME_MAX_PAYLOAD_BYTES
  ) {
    throw new RangeError(
      `frame payload length must be 0..${FRAME_MAX_PAYLOAD_BYTES}`,
    )
  }
  if (!Number.isInteger(flags) || flags < 0 || flags > 0xff) {
    throw new RangeError('frame flags must be a byte')
  }
  const header = new Uint8Array(FRAME_HEADER_BYTES)
  const view = new DataView(header.buffer)
  view.setUint16(0, FRAME_MAGIC, false)
  view.setUint8(2, FRAME_VERSION)
  view.setUint8(3, flags)
  view.setUint32(4, payloadLength, false)
  return header
}

export function readFrameHeader(bytes: Uint8Array): {
  magic: number
  version: number
  flags: number
  length: number
} {
  if (bytes.byteLength < FRAME_HEADER_BYTES) {
    throw new RangeError('frame header truncated')
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const magic = view.getUint16(0, false)
  const version = view.getUint8(2)
  const flags = view.getUint8(3)
  const length = view.getUint32(4, false)
  if (magic !== FRAME_MAGIC) {
    throw new FrameError(`INVALID_MAGIC: invalid frame magic: 0x${magic.toString(16)}`)
  }
  if (version !== FRAME_VERSION) {
    throw new Error(`unsupported frame version: ${version}`)
  }
  if (length > FRAME_MAX_PAYLOAD_BYTES) {
    throw new Error(`frame payload exceeds ${FRAME_MAX_PAYLOAD_BYTES} bytes`)
  }
  return { magic, version, flags, length }
}

/** Encode one complete relay binary frame (header + payload). */
export function encodeRelayFrame(
  payload: Uint8Array,
  flags: number = FRAME_FLAG_FIN,
): Uint8Array {
  const header = writeFrameHeader(payload.byteLength, flags)
  const out = new Uint8Array(header.byteLength + payload.byteLength)
  out.set(header, 0)
  out.set(payload, header.byteLength)
  return out
}

/** Decode one complete relay binary frame from a WebSocket binary message. */
export function decodeRelayFrame(bytes: Uint8Array): {
  flags: number
  payload: Uint8Array
} {
  const header = readFrameHeader(bytes)
  const total = FRAME_HEADER_BYTES + header.length
  if (bytes.byteLength !== total) {
    throw new Error(
      `frame length mismatch: got ${bytes.byteLength}, expected ${total}`,
    )
  }
  return {
    flags: header.flags,
    payload: bytes.subarray(FRAME_HEADER_BYTES, total),
  }
}

/**
 * Encode a canonical Control Protocol 2.0 relay frame around a Noise payload:
 * magic(2)=MP | version(1)=1 | flags(1) | length(4 BE) | payload.
 */
export function encodeFrame(
  payload: Uint8Array,
  flags: number = FRAME_FLAG_FIN,
): Uint8Array {
  if (payload.byteLength > MAX_FRAME_PAYLOAD_BYTES) {
    throw new FrameError(
      `frame payload ${payload.byteLength} exceeds limit ${MAX_FRAME_PAYLOAD_BYTES}`,
    )
  }
  if (payload.byteLength === 0) {
    throw new FrameError('empty frame payload')
  }
  try {
    return encodeRelayFrame(payload, flags)
  } catch (err) {
    throw new FrameError(err instanceof Error ? err.message : 'encode failed')
  }
}

/**
 * Decode one canonical relay frame. Rejects truncated, oversized, or empty payloads.
 */
export function decodeFrame(data: Uint8Array): {
  payload: Uint8Array
  flags: number
  bytesConsumed: number
} {
  try {
    const { payload, flags } = decodeRelayFrame(data)
    if (payload.byteLength === 0) {
      throw new FrameError('empty frame payload')
    }
    return {
      payload,
      flags,
      bytesConsumed: data.byteLength,
    }
  } catch (err) {
    if (err instanceof FrameError) throw err
    throw new FrameError(err instanceof Error ? err.message : 'decode failed')
  }
}

/** Split application data into plaintext chunks that fit encrypted frame limits. */
export function chunkPlaintext(plaintext: Uint8Array): Uint8Array[] {
  if (plaintext.byteLength === 0) {
    return [new Uint8Array(0)]
  }
  if (plaintext.byteLength > MESSAGE_MAX_BYTES) {
    throw new FrameError(
      `message ${plaintext.byteLength} exceeds limit ${MESSAGE_MAX_BYTES}`,
    )
  }
  const chunks: Uint8Array[] = []
  for (let offset = 0; offset < plaintext.byteLength; offset += MAX_PLAINTEXT_CHUNK_BYTES) {
    chunks.push(plaintext.subarray(offset, offset + MAX_PLAINTEXT_CHUNK_BYTES))
  }
  return chunks
}
