import { PROTOCOL_MAJOR, PROTOCOL_MINOR } from '../constants'

export type RelayRole = 'mms' | 'mobile'

export interface AdmissionCredential {
  admissionId: string
  installationId: string
  deviceId: string
  pairingId: string
  role: RelayRole
  nonce: string
  expiresAt: number
  protocolMajor: typeof PROTOCOL_MAJOR
  protocolMinor?: number
  token: string
}

export interface RelayAuthMessage {
  type: 'auth'
  admission: AdmissionCredential
  connectorEpoch?: number
  challengeResponse?: string
  protocolMajor: typeof PROTOCOL_MAJOR
  protocolMinor?: number
}

export interface RelayAuthOkMessage {
  type: 'authOk'
  role: RelayRole
  pairingId: string
  gatewayId?: string
  epoch?: number
  serverTime?: number
}

export interface RelayAuthFailMessage {
  type: 'authFail'
  code:
    | 'AUTH_REQUIRED'
    | 'AUTH_EXPIRED'
    | 'DEVICE_REVOKED'
    | 'PAIRING_REQUIRED'
    | 'PROTOCOL_INCOMPATIBLE'
    | 'FORBIDDEN'
    | 'RATE_LIMITED'
    | 'INVALID_REQUEST'
    | string
  message: string
}

/**
 * Build the canonical first-message auth body from an issued admission.
 * Key insertion order: type, admission, connectorEpoch?, challengeResponse?, protocolMajor, protocolMinor?
 */
export function buildRelayAuthMessage(input: {
  admission: AdmissionCredential
  connectorEpoch?: number
  challengeResponse?: string
  protocolMinor?: number
}): RelayAuthMessage {
  const msg: Record<string, unknown> = {
    type: 'auth',
    admission: input.admission,
  }
  if (input.connectorEpoch !== undefined) {
    msg.connectorEpoch = input.connectorEpoch
  }
  if (input.challengeResponse !== undefined) {
    msg.challengeResponse = input.challengeResponse
  }
  msg.protocolMajor = PROTOCOL_MAJOR
  if (input.protocolMinor !== undefined) {
    msg.protocolMinor = input.protocolMinor
  }
  return msg as unknown as RelayAuthMessage
}

export function parseRelayControlMessage(
  data: unknown,
): RelayAuthOkMessage | RelayAuthFailMessage | { type: 'ping' } | { type: 'pong' } | unknown {
  if (typeof data === 'string') {
    try {
      return JSON.parse(data)
    } catch {
      throw new Error('invalid JSON')
    }
  }
  return data
}
