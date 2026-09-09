export type OAuthMetadata = {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  revocation_endpoint?: string
  registration_endpoint: string
  code_challenge_methods_supported: string[]
  scopes_supported: string[]
}

export type MousseConfiguration = {
  protocol_version: string
  server_name: string
  server_version: string
  api_endpoint: string
  events_endpoint: string
  max_request_bytes: number
  event_retention: number
}

export type TokenSet = {
  access_token: string
  refresh_token: string
  expires_at: number
  scope: string
  client_id: string
  base_url: string
  issuer: string
}

export type Connection = {
  baseUrl: string
  serverName: string
  serverVersion: string
  apiEndpoint: string
  eventsEndpoint: string
  scopes: string[]
}

export type RpcError = {
  code: number | string
  message: string
  data?: {
    required_scope?: string
    retryable?: boolean
    [key: string]: unknown
  }
}

export type Thread = {
  id: string
  title: string
  projectId?: string
  model?: string
  active?: boolean
  updatedAt?: string
  settledAt?: string
}

export type Project = {
  id: string
  name: string
  path?: string
  pinned?: boolean
}

export type Message = {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  createdAt?: string
  streaming?: boolean
  toolCalls?: { name: string; status: string }[]
}

export type PendingQuestion = {
  requestId: string
  questions: {
    id: string
    prompt: string
    options?: { id: string; label: string }[]
    allowMultiple?: boolean
  }[]
}

export type AppSnapshot = {
  projects: Project[]
  threads: Thread[]
  messages: Record<string, Message[]>
  questions: Record<string, PendingQuestion[]>
  agents: Record<string, unknown>[]
  tasks: Record<string, unknown>[]
  workspace: Record<string, unknown>
  jobs: Record<string, unknown>[]
  channels: Record<string, unknown>
  settings: Record<string, unknown>
  mcp: Record<string, unknown>[]
  skills: Record<string, unknown>[]
}

/** Connection modes supported by Mousse Mobile client. */
export type ConnectionMode = 'hosted' | 'self-hosted' | 'legacy'

/** Detailed connection lifecycle state. */
export type ConnectionStatus =
  | 'offline'
  | 'connecting'
  | 'live'
  | 'reconnecting'
  | 'approval_pending'
  | 'revoked'

/** Canonical Mousse QR v2 payload. */
export type QrPayloadV2 = {
  mode: 'hosted' | 'self-hosted'
  controlOrigin: string
  installationId: string
  installationPublicKey: string
  mmsDeviceId: string
  mmsIdentityPublicKey: string
  pairingId: string
  expiresAt: number
  protocolMajor: number
  protocolMinor: number
  pairingSecret: string
  accountId?: string
}

/** Parsed QR payload result supporting both v1 and v2. */
export type ParsedQr =
  | {
      version: 2
      payload: QrPayloadV2
      fingerprint: string
      mmsFingerprint: string
    }
  | {
      version: 1
      baseUrl: string
    }

/** Per-installation persistent device identity key pair. */
export type DeviceIdentity = {
  deviceId: string
  publicKey: string
  privateKey: string
  createdAt: number
}

/** Hosted Supabase user session on mobile. */
export type HostedSession = {
  access_token: string
  refresh_token: string
  expires_at: number
  account_id: string
  email?: string
  dashboard_url: string
  supabase_url?: string
}

/** Paired computer / machine record stored securely on mobile. */
export type MachineRecord = {
  id: string
  name: string
  mode: ConnectionMode
  controlOrigin: string
  installationId: string
  installationPublicKey: string
  mmsDeviceId: string
  mmsIdentityPublicKey: string
  pairingId: string
  pairedAt: number
  lastSeen: number
  status: ConnectionStatus
  accountId?: string
  health?: {
    latencyMs?: number
    lastHeartbeat?: number
    state: string
  }
  legacyConnection?: Connection
  legacyTokens?: TokenSet
}

/** Application request envelope (inside encrypted channel). */
export type RequestEnvelope = {
  type: 'request'
  requestId: string
  method: string
  params: Record<string, unknown>
  idempotencyKey?: string
  protocolVersion: '2.0'
}

/** Application response envelope (inside encrypted channel). */
export type ResponseEnvelope = {
  type: 'response'
  requestId: string
  result?: unknown
  error?: {
    code: number | string
    message: string
    data?: Record<string, unknown>
  }
}

/** Sequenced event envelope with daemon instance cursor. */
export type EventEnvelope = {
  type: 'event'
  instanceId: string
  seq: number
  event: string
  payload: unknown
}

/** Cancel in-flight execution. */
export type CancelEnvelope = {
  type: 'cancel'
  requestId: string
}

/** Sent when daemon restarts or event ring overflows. */
export type SnapshotRequiredEnvelope = {
  type: 'snapshotRequired'
  reason: string
}

/** Session ping/pong heartbeats. */
export type PingEnvelope = {
  type: 'ping'
  timestamp: number
}

export type PongEnvelope = {
  type: 'pong'
  timestamp: number
}

/** Union of all validated envelopes inside encrypted session. */
export type ControlEnvelope =
  | RequestEnvelope
  | ResponseEnvelope
  | EventEnvelope
  | CancelEnvelope
  | SnapshotRequiredEnvelope
  | PingEnvelope
  | PongEnvelope

/** First message on relay WebSocket. */
export type RelayAuthMessage = {
  type: 'auth'
  admissionToken: string
  deviceId: string
  pairingId: string
  role: 'client'
}

export type RelayAuthResponse =
  | { type: 'auth_ok'; leaseExpiresAt?: number }
  | { type: 'error'; code: string; message: string }

/** Machine code or network disconnect when mutation outcome is ambiguous. */
export class OutcomeUnknownError extends Error {
  readonly code = 'OUTCOME_UNKNOWN'
  constructor(
    message: string,
    public readonly operation: {
      requestId: string
      idempotencyKey?: string
      method: string
      params: Record<string, unknown>
    }
  ) {
    super(message)
    this.name = 'OutcomeUnknownError'
  }
}
