import {
  PROTOCOL_MAJOR,
  PROTOCOL_MINOR,
  QR_MAX_PAYLOAD_BYTES,
  QR_TTL_MS
} from './constants'
import {
  base64UrlDecode,
  base64UrlEncode,
  canonicalOrigin,
  fingerprint,
  normalizedBaseUrl
} from './security'
import type { ParsedQr, QrPayloadV2 } from './types'

const QR_VERSION_V1 = '1'

export const QR_PAYLOAD_KEY_ORDER = [
  'mode',
  'controlOrigin',
  'installationId',
  'installationPublicKey',
  'mmsDeviceId',
  'mmsIdentityPublicKey',
  'pairingId',
  'expiresAt',
  'protocolMajor',
  'pairingSecret',
  'accountId',
] as const

/**
 * Deterministic JSON object encoding with fixed key order (omit undefined).
 */
export function canonicalizeQrPayload(payload: QrPayloadV2 | Record<string, unknown>): string {
  const ordered: Record<string, unknown> = {}
  for (const key of QR_PAYLOAD_KEY_ORDER) {
    const value = (payload as Record<string, unknown>)[key]
    if (value !== undefined) {
      ordered[key] = value
    }
  }
  return JSON.stringify(ordered)
}

/**
 * Encodes a Mousse QR v2 payload to canonical URL string.
 * mousse://pair?v=2&data=<base64url(canonical-json)>
 */
export function encodeQrUri(payload: QrPayloadV2): string {
  const canonicalJson = canonicalizeQrPayload(payload)
  const encodedData = base64UrlEncode(new TextEncoder().encode(canonicalJson))
  return `mousse://pair?v=2&data=${encodedData}`
}

export const encodeQrV2 = encodeQrUri

/**
 * Parse a configuration-only desktop/CLI QR (version 1).
 * OAuth credentials are never accepted here. Preserved for backward compatibility.
 */
export function parseConnectionQrPayload(value: string): string {
  let payload: URL
  try {
    payload = new URL(value)
  } catch {
    throw new Error('This is not a valid Mousse connection QR code.')
  }
  if (
    payload.protocol !== 'mousse:' ||
    payload.hostname !== 'connect' ||
    payload.pathname !== '' ||
    payload.username ||
    payload.password ||
    payload.hash
  ) {
    throw new Error('This QR code is not a Mousse connection request.')
  }
  const keys = [...payload.searchParams.keys()]
  if (
    keys.some(key => key !== 'v' && key !== 'base') ||
    payload.searchParams.getAll('v').length !== 1 ||
    payload.searchParams.getAll('base').length !== 1 ||
    payload.searchParams.get('v') !== QR_VERSION_V1
  ) {
    throw new Error('This Mousse connection QR version is not supported.')
  }
  const base = payload.searchParams.get('base')
  if (!base) throw new Error('The Mousse connection QR has no server URL.')
  return normalizedBaseUrl(base)
}

export interface ParseQrOptions {
  rejectExpired?: boolean
  nowMs?: number
}

/**
 * Parses raw QR v2 URI and returns QrPayloadV2.
 */
export function parseQrUri(uri: string, options: ParseQrOptions = {}): QrPayloadV2 {
  let url: URL
  try {
    url = new URL(uri)
  } catch {
    throw new Error('This is not a valid Mousse connection QR code.')
  }

  if (url.protocol !== 'mousse:') {
    throw new Error('QR code must use the mousse: scheme.')
  }

  if (url.hostname !== 'pair' || url.pathname !== '') {
    throw new Error('This QR code is not a valid Mousse pairing request.')
  }

  if (url.username || url.password || url.hash) {
    throw new Error('Pairing QR must not contain user credentials or hash.')
  }

  const v = url.searchParams.get('v')
  if (v !== '2') {
    throw new Error(`Unsupported QR protocol major version: ${v ?? 'missing'}`)
  }

  const rawData = url.searchParams.get('data')
  if (!rawData) {
    throw new Error('Pairing QR code contains no data payload.')
  }

  let decodedBytes: Uint8Array
  try {
    decodedBytes = base64UrlDecode(rawData)
  } catch {
    throw new Error('Pairing QR payload is not valid base64url data.')
  }

  if (decodedBytes.byteLength > QR_MAX_PAYLOAD_BYTES) {
    throw new Error(
      `Pairing QR payload size (${decodedBytes.byteLength} bytes) exceeds limit of ${QR_MAX_PAYLOAD_BYTES} bytes.`
    )
  }

  let data: Record<string, unknown>
  try {
    const jsonString = new TextDecoder().decode(decodedBytes)
    data = JSON.parse(jsonString) as Record<string, unknown>
  } catch {
    throw new Error('Pairing QR payload is not valid JSON.')
  }

  if (data.mode !== 'hosted' && data.mode !== 'self-hosted') {
    throw new Error('Pairing QR mode must be either "hosted" or "self-hosted".')
  }

  if (typeof data.controlOrigin !== 'string' || !data.controlOrigin.trim()) {
    throw new Error('Pairing QR is missing controlOrigin.')
  }
  const canonical = canonicalOrigin(data.controlOrigin)

  if (typeof data.installationId !== 'string' || !data.installationId.trim()) {
    throw new Error('Pairing QR is missing installationId.')
  }
  if (typeof data.installationPublicKey !== 'string' || !data.installationPublicKey.trim()) {
    throw new Error('Pairing QR is missing installationPublicKey.')
  }
  if (typeof data.mmsDeviceId !== 'string' || !data.mmsDeviceId.trim()) {
    throw new Error('Pairing QR is missing mmsDeviceId.')
  }
  if (typeof data.mmsIdentityPublicKey !== 'string' || !data.mmsIdentityPublicKey.trim()) {
    throw new Error('Pairing QR is missing mmsIdentityPublicKey.')
  }
  if (typeof data.pairingId !== 'string' || !data.pairingId.trim()) {
    throw new Error('Pairing QR is missing pairingId.')
  }
  if (typeof data.pairingSecret !== 'string' || !data.pairingSecret.trim()) {
    throw new Error('Pairing QR is missing pairingSecret.')
  }

  if (typeof data.expiresAt !== 'number' || !Number.isFinite(data.expiresAt)) {
    throw new Error('Pairing QR is missing valid expiresAt timestamp.')
  }

  const rejectExpired = options.rejectExpired ?? true
  const nowMs = options.nowMs ?? Date.now()
  if (rejectExpired && nowMs >= data.expiresAt) {
    throw new Error('This pairing QR code has expired. Please request a fresh QR code from your computer.')
  }

  if (data.protocolMajor !== PROTOCOL_MAJOR) {
    throw new Error(`Unsupported protocol major version: ${String(data.protocolMajor)}`)
  }

  if (data.mode === 'hosted' && (typeof data.accountId !== 'string' || !data.accountId.trim())) {
    throw new Error('Hosted pairing QR requires an accountId.')
  }

  const payload: QrPayloadV2 = {
    mode: data.mode,
    controlOrigin: canonical,
    installationId: data.installationId,
    installationPublicKey: data.installationPublicKey,
    mmsDeviceId: data.mmsDeviceId,
    mmsIdentityPublicKey: data.mmsIdentityPublicKey,
    pairingId: data.pairingId,
    expiresAt: data.expiresAt,
    protocolMajor: data.protocolMajor,
    protocolMinor: typeof data.protocolMinor === 'number' ? data.protocolMinor : PROTOCOL_MINOR,
    pairingSecret: data.pairingSecret,
    accountId: typeof data.accountId === 'string' ? data.accountId : undefined
  }

  return payload
}

/**
 * Unified QR parser supporting both Control Protocol 2.0 (mousse://pair?v=2)
 * and legacy protocol 1.0 (mousse://connect?v=1).
 * Enforces strict schema, canonical origin, size bounds, and expiration.
 */
export async function parseQr(value: string, options: ParseQrOptions = {}): Promise<ParsedQr> {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('This is not a valid Mousse connection QR code.')
  }

  if (url.protocol !== 'mousse:') {
    throw new Error('QR code must use the mousse: scheme.')
  }

  // Check legacy v1 format
  if (url.hostname === 'connect') {
    const baseUrl = parseConnectionQrPayload(value)
    return { version: 1, baseUrl }
  }

  const payload = parseQrUri(value, options)

  const [fp, mmsFp] = await Promise.all([
    fingerprint(payload.installationPublicKey),
    fingerprint(payload.mmsIdentityPublicKey)
  ])

  return {
    version: 2,
    payload,
    fingerprint: fp,
    mmsFingerprint: mmsFp
  }
}
