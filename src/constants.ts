/**
 * Mousse Control Protocol 2.0 constants and error codes.
 * Conforms to Mousse Plus system specification and shared protocol.
 */

export const PROTOCOL_MAJOR = 2 as const
export const PROTOCOL_MINOR = 0 as const
export const PROTOCOL_VERSION = '2.0' as const

/** Encrypted transport chunk size before reassembly (64 KiB). */
export const CHUNK_MAX_BYTES = 64 * 1024

/** Maximum reassembled application message size (4 MiB). */
export const MESSAGE_MAX_BYTES = 4 * 1024 * 1024

/** WebSocket / session heartbeat interval (20s). */
export const HEARTBEAT_INTERVAL_MS = 20_000

/** Mark peer offline after this many ms without proof of life (60s). */
export const OFFLINE_AFTER_MS = 60_000

/** Unauthenticated relay socket authentication deadline (5s). */
export const AUTH_DEADLINE_MS = 5_000

/** One-time relay admission credential TTL (30s). */
export const ADMISSION_TTL_MS = 30_000

/** QR pairing payload lifetime (2 minutes). */
export const QR_TTL_MS = 2 * 60_000

/** Maximum QR / deep-link payload size (decoded, 4 KiB). */
export const QR_MAX_PAYLOAD_BYTES = 4 * 1024

/** Pairing bootstrap secret length (256-bit / 32 bytes). */
export const PAIRING_SECRET_BYTES = 32

/** Public key length (32 bytes). */
export const PUBLIC_KEY_BYTES = 32

/** Concurrent in-flight RPCs per pairing. */
export const MAX_CONCURRENT_RPCS = 64

/** Per-connection outbound queued ciphertext bytes (2 MiB). */
export const MAX_OUTBOUND_QUEUED_BYTES = 2 * 1024 * 1024

/** Hosted route authorization lease renewal window (60s). */
export const AUTHORIZATION_LEASE_MS = 60_000

/** Local event ring size reused for remote replay. */
export const EVENT_RING_SIZE = 512

/** Reconnect backoff bounds (with jitter). */
export const RECONNECT_BACKOFF_MIN_MS = 1_000
export const RECONNECT_BACKOFF_MAX_MS = 30_000

/** Mobile default OAuth redirect URI. */
export const MOBILE_REDIRECT_URI = 'com.ryspa.mousse:/oauth/callback' as const

/** Deep link custom schemes. */
export const SCHEME_MOUSSE = 'mousse:' as const
export const SCHEME_APP = 'com.ryspa.mousse:' as const

/** Standard client execution scopes. */
export const DEFAULT_SCOPES = [
  'mousse:read',
  'mousse:chat',
  'mousse:write',
  'mousse:terminal',
  'mousse:settings'
] as const

/** Typed machine error codes defined in the specification. */
export const ERROR_CODES = {
  PAIRING_REQUIRED: 'PAIRING_REQUIRED',
  ACCOUNT_MISMATCH: 'ACCOUNT_MISMATCH',
  DEVICE_REVOKED: 'DEVICE_REVOKED',
  PAIRING_REVOKED: 'PAIRING_REVOKED',
  MMS_OFFLINE: 'MMS_OFFLINE',
  QUOTA_EXCEEDED: 'QUOTA_EXCEEDED',
  SNAPSHOT_REQUIRED: 'SNAPSHOT_REQUIRED',
  OUTCOME_UNKNOWN: 'OUTCOME_UNKNOWN',
  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
  AUTH_TIMEOUT: 'AUTH_TIMEOUT',
  ADMISSION_EXPIRED: 'ADMISSION_EXPIRED',
  INVALID_PAYLOAD: 'INVALID_PAYLOAD',
  REPLAY_DETECTED: 'REPLAY_DETECTED',
  APPROVAL_REJECTED: 'APPROVAL_REJECTED'
} as const

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES]
