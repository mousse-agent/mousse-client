/** A protocol failure with a desktop-compatible error code (see shared/net/errors.ts). */
export class NetError extends Error {
  readonly code: string
  readonly retryable: boolean
  constructor(code: string, message: string = code, options?: { retryable?: boolean; cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'NetError'
    this.code = code
    this.retryable = options?.retryable ?? RETRYABLE.has(code)
  }
}

/** Mirrors `retryable: true` in the desktop NET_ERRORS table; the daemon schema enforces it. */
const RETRYABLE = new Set([
  'snapshot_required',
  'meta_stale',
  'rate_limited',
  'clock_skew',
  'route_unreachable',
  'peer_offline',
  'deadline_exceeded',
])

export function wireError(error: unknown): WireError {
  const code = error instanceof NetError && KNOWN_CODES.has(error.code) ? error.code : 'internal'
  return { code, message: code, retryable: RETRYABLE.has(code) }
}

const KNOWN_CODES = new Set(
  (
    'unsupported_version incompatible_peer upgrade_required downgrade_unsupported bad_request too_large ' +
    'bad_signature bad_delegation peer_key_mismatch revoked disabled not_enrolled not_member forbidden ' +
    'invite_invalid roster_conflict conflict stream_unknown snapshot_required meta_stale space_frozen ' +
    'rate_limited quota_exceeded storage_full storage_corrupt keystore_locked keystore_missing clock_skew ' +
    'route_unreachable peer_offline deadline_exceeded cancelled budget_exhausted profile_unsupported ' +
    'repo_not_bound outcome_uncertain internal'
  ).split(' '),
)

export interface WireError {
  code: string
  message: string
  retryable: boolean
  cause?: Array<{ code?: string; message: string }>
}

export function fromWireError(error: WireError): NetError {
  return new NetError(error.code, error.message || error.code, { retryable: error.retryable })
}
