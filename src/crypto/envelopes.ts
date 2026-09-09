import { PROTOCOL_MAJOR, PROTOCOL_MINOR } from '../constants'

export type EnvelopeType =
  | 'request'
  | 'response'
  | 'event'
  | 'cancel'
  | 'snapshotRequired'
  | 'ping'
  | 'pong'

export interface WireError {
  code: string | number
  message: string
  details?: unknown
  data?: Record<string, unknown>
}

export interface RequestEnvelope {
  type: 'request'
  requestId: string
  method: string
  params?: Record<string, unknown> | unknown
  idempotencyKey?: string
  protocolMajor?: typeof PROTOCOL_MAJOR
  protocolMinor?: number
  protocolVersion?: string
}

export interface ResponseEnvelope {
  type: 'response'
  requestId: string
  result?: unknown
  error?: WireError
}

export interface EventEnvelope {
  type: 'event'
  instanceId: string
  sequence: number
  eventType: string
  payload?: unknown
}

export interface CancelEnvelope {
  type: 'cancel'
  requestId: string
}

export interface SnapshotRequiredEnvelope {
  type: 'snapshotRequired'
  reason?: 'ring_overflow' | 'restart' | 'authorization_change' | 'gap' | 'explicit' | string
  cursor?: {
    instanceId: string
    sequence: number
  }
}

export interface PingEnvelope {
  type: 'ping'
  nonce?: string
  sentAt?: number
  timestamp?: number
}

export interface PongEnvelope {
  type: 'pong'
  nonce?: string
  sentAt?: number
  timestamp?: number
}

export type Envelope =
  | RequestEnvelope
  | ResponseEnvelope
  | EventEnvelope
  | CancelEnvelope
  | SnapshotRequiredEnvelope
  | PingEnvelope
  | PongEnvelope

export function requestEnvelope(input: {
  requestId: string
  method: string
  params?: unknown
  idempotencyKey?: string
  protocolMajor?: typeof PROTOCOL_MAJOR
  protocolMinor?: number
}): RequestEnvelope {
  return {
    type: 'request',
    requestId: input.requestId,
    method: input.method,
    params: input.params ?? {},
    ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
    protocolMajor: PROTOCOL_MAJOR,
    ...(input.protocolMinor !== undefined ? { protocolMinor: input.protocolMinor } : {}),
  }
}

export function responseResultEnvelope(
  requestId: string,
  result: unknown,
): ResponseEnvelope {
  return {
    type: 'response',
    requestId,
    result,
  }
}

export function responseErrorEnvelope(
  requestId: string,
  error: WireError,
): ResponseEnvelope {
  return {
    type: 'response',
    requestId,
    error,
  }
}

export function eventEnvelope(input: {
  instanceId: string
  sequence: number
  eventType: string
  payload?: unknown
}): EventEnvelope {
  return {
    type: 'event',
    instanceId: input.instanceId,
    sequence: input.sequence,
    eventType: input.eventType,
    payload: input.payload ?? {},
  }
}

export function cancelEnvelope(requestId: string): CancelEnvelope {
  return {
    type: 'cancel',
    requestId,
  }
}

export function snapshotRequiredEnvelope(input: {
  reason?: SnapshotRequiredEnvelope['reason']
  cursor?: SnapshotRequiredEnvelope['cursor']
} = {}): SnapshotRequiredEnvelope {
  return {
    type: 'snapshotRequired',
    ...input,
  }
}

export function pingEnvelope(input: { nonce?: string; sentAt?: number } = {}): PingEnvelope {
  return {
    type: 'ping',
    ...input,
  }
}

/**
 * Deterministic JSON serialization with fixed schema key order for envelopes.
 */
export function canonicalizeEnvelope(envelope: Envelope): string {
  if (envelope.type === 'request') {
    const obj: Record<string, unknown> = {
      type: 'request',
      requestId: envelope.requestId,
      method: envelope.method,
      params: envelope.params ?? {},
    }
    if (envelope.idempotencyKey !== undefined) {
      obj.idempotencyKey = envelope.idempotencyKey
    }
    obj.protocolMajor = envelope.protocolMajor ?? PROTOCOL_MAJOR
    if (envelope.protocolMinor !== undefined) {
      obj.protocolMinor = envelope.protocolMinor
    }
    if (envelope.protocolVersion !== undefined) {
      obj.protocolVersion = envelope.protocolVersion
    }
    return JSON.stringify(obj)
  }

  if (envelope.type === 'response') {
    const obj: Record<string, unknown> = {
      type: 'response',
      requestId: envelope.requestId,
    }
    if (envelope.result !== undefined) {
      obj.result = envelope.result
    }
    if (envelope.error !== undefined) {
      obj.error = envelope.error
    }
    return JSON.stringify(obj)
  }

  if (envelope.type === 'event') {
    const obj: Record<string, unknown> = {
      type: 'event',
      instanceId: envelope.instanceId,
      sequence: envelope.sequence,
      eventType: envelope.eventType,
      payload: envelope.payload ?? {},
    }
    return JSON.stringify(obj)
  }

  if (envelope.type === 'cancel') {
    return JSON.stringify({
      type: 'cancel',
      requestId: envelope.requestId,
    })
  }

  if (envelope.type === 'snapshotRequired') {
    const obj: Record<string, unknown> = {
      type: 'snapshotRequired',
    }
    if (envelope.reason !== undefined) {
      obj.reason = envelope.reason
    }
    if (envelope.cursor !== undefined) {
      obj.cursor = envelope.cursor
    }
    return JSON.stringify(obj)
  }

  if (envelope.type === 'ping') {
    const obj: Record<string, unknown> = {
      type: 'ping',
    }
    if (envelope.nonce !== undefined) {
      obj.nonce = envelope.nonce
    }
    if (envelope.sentAt !== undefined) {
      obj.sentAt = envelope.sentAt
    }
    if (envelope.timestamp !== undefined) {
      obj.timestamp = envelope.timestamp
    }
    return JSON.stringify(obj)
  }

  if (envelope.type === 'pong') {
    const obj: Record<string, unknown> = {
      type: 'pong',
    }
    if (envelope.nonce !== undefined) {
      obj.nonce = envelope.nonce
    }
    if (envelope.sentAt !== undefined) {
      obj.sentAt = envelope.sentAt
    }
    if (envelope.timestamp !== undefined) {
      obj.timestamp = envelope.timestamp
    }
    return JSON.stringify(obj)
  }

  return JSON.stringify(envelope)
}

export function encodeEnvelopeBytes(envelope: Envelope): Uint8Array {
  return new TextEncoder().encode(canonicalizeEnvelope(envelope))
}

export function parseEnvelope(value: unknown): Envelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('envelope must be an object')
  }
  const obj = value as Record<string, unknown>
  const type = obj.type
  if (typeof type !== 'string') {
    throw new Error('envelope missing type')
  }

  if (type === 'request') {
    const res: RequestEnvelope = {
      type: 'request',
      requestId: String(obj.requestId),
      method: String(obj.method),
      params: obj.params ?? {},
      protocolMajor: (obj.protocolMajor as any) ?? PROTOCOL_MAJOR,
    }
    if (obj.idempotencyKey !== undefined) {
      res.idempotencyKey = String(obj.idempotencyKey)
    }
    if (typeof obj.protocolMinor === 'number') {
      res.protocolMinor = obj.protocolMinor
    }
    if (obj.protocolVersion !== undefined) {
      res.protocolVersion = String(obj.protocolVersion)
    }
    return res
  }

  if (type === 'response') {
    return {
      type: 'response',
      requestId: String(obj.requestId),
      result: obj.result,
      error: obj.error as WireError | undefined,
    }
  }

  if (type === 'event') {
    return {
      type: 'event',
      instanceId: String(obj.instanceId),
      sequence: Number(obj.sequence ?? obj.seq),
      eventType: String(obj.eventType ?? obj.event),
      payload: obj.payload ?? {},
    }
  }

  if (type === 'cancel') {
    return {
      type: 'cancel',
      requestId: String(obj.requestId),
    }
  }

  if (type === 'snapshotRequired') {
    return {
      type: 'snapshotRequired',
      reason: obj.reason as any,
      cursor: obj.cursor as any,
    }
  }

  if (type === 'ping') {
    return {
      type: 'ping',
      nonce: obj.nonce ? String(obj.nonce) : undefined,
      sentAt: typeof obj.sentAt === 'number' ? obj.sentAt : undefined,
      timestamp: typeof obj.timestamp === 'number' ? obj.timestamp : undefined,
    }
  }

  if (type === 'pong') {
    return {
      type: 'pong',
      nonce: obj.nonce ? String(obj.nonce) : undefined,
      sentAt: typeof obj.sentAt === 'number' ? obj.sentAt : undefined,
      timestamp: typeof obj.timestamp === 'number' ? obj.timestamp : undefined,
    }
  }

  throw new Error(`unrecognized envelope type: ${type}`)
}

export function decodeEnvelopeBytes(bytes: Uint8Array): Envelope {
  const text = new TextDecoder().decode(bytes)
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error('envelope plaintext is not valid JSON')
  }
  return parseEnvelope(json)
}
