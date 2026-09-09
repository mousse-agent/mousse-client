import {
  ERROR_CODES,
  MAX_CONCURRENT_RPCS,
  PROTOCOL_MAJOR,
  PROTOCOL_MINOR
} from '../constants'
import { SecureChannel } from '../crypto/secureChannel'
import { RelayClient } from '../relay/relayClient'
import {
  ConnectionStatus,
  ControlEnvelope,
  OutcomeUnknownError,
  ResponseEnvelope
} from '../types'

export type V2TransportOptions = {
  relayUrl: string
  deviceId: string
  pairingId: string
  peerStaticPublicKey: string
  installationId: string
  controlOrigin: string
  mode: 'hosted' | 'self-hosted'
  accountId?: string
  mmsDeviceId: string
  pairingSecret?: string
  isInitialPairing?: boolean
  getAdmissionToken: () => Promise<string>
  onStatusChange?: (status: ConnectionStatus) => void
  onHealthUpdate?: (health: { latencyMs: number; lastHeartbeat: number }) => void
  onEvent?: (event: { event: string; payload: unknown; seq: number; instanceId: string }) => void
  onSnapshotRequired?: (reason: string) => void
  onRevoked?: () => void
}

type InFlightRequest = {
  method: string
  params: Record<string, unknown>
  mutate: boolean
  idempotencyKey?: string
  resolve: (result: unknown) => void
  reject: (error: Error) => void
  timer: number
}

export class V2Transport {
  private relay: RelayClient | null = null
  private readonly secureChannel = new SecureChannel()
  private inFlight = new Map<string, InFlightRequest>()
  private status: ConnectionStatus = 'offline'
  private cursor: { instanceId: string; seq: number } = { instanceId: '', seq: 0 }
  private approvalPending = false
  private stopped = false

  public outcomeUnknownOperations: Array<{
    requestId: string
    idempotencyKey?: string
    method: string
    params: Record<string, unknown>
    timestamp: number
  }> = []

  constructor(private readonly options: V2TransportOptions) {}

  start(): void {
    this.stopped = false
    this.approvalPending = Boolean(this.options.isInitialPairing)

    this.relay = new RelayClient({
      relayUrl: this.options.relayUrl,
      deviceId: this.options.deviceId,
      pairingId: this.options.pairingId,
      getAdmissionToken: this.options.getAdmissionToken,
      onFrame: frame => void this.handleIncomingFrame(frame),
      onStatusChange: status => this.handleRelayStatus(status),
      onHealthUpdate: health => this.options.onHealthUpdate?.(health)
    })

    this.relay.start()
  }

  stop(): void {
    this.stopped = true
    if (this.relay) {
      this.relay.stop()
      this.relay = null
    }
    this.secureChannel.reset()
    this.rejectInFlightAll('Transport stopped')
    if (this.status !== 'revoked') {
      this.setStatus('offline')
    }
  }

  private setStatus(next: ConnectionStatus): void {
    if (this.status === next) return
    this.status = next
    this.options.onStatusChange?.(next)
  }

  getStatus(): ConnectionStatus {
    return this.status
  }

  getCursor(): { instanceId: string; seq: number } {
    return { ...this.cursor }
  }

  private handleRelayStatus(relayStatus: ConnectionStatus): void {
    if (this.stopped) return

    if (relayStatus === 'live') {
      void this.initiateChannel()
    } else if (relayStatus === 'offline' || relayStatus === 'reconnecting') {
      // Reject non-mutating in-flight; flag mutating as outcome_unknown
      this.handleConnectionDrop()
      this.setStatus(relayStatus)
    } else {
      this.setStatus(relayStatus)
    }
  }

  private async initiateChannel(): Promise<void> {
    try {
      await this.secureChannel.initializeSession({
        peerStaticPublicKey: this.options.peerStaticPublicKey,
        pairingSecret: this.options.pairingSecret,
        prologue: {
          protocolMajor: PROTOCOL_MAJOR,
          protocolMinor: PROTOCOL_MINOR,
          installationId: this.options.installationId,
          controlOrigin: this.options.controlOrigin,
          mode: this.options.mode,
          accountId: this.options.accountId,
          mmsDeviceId: this.options.mmsDeviceId,
          mobileDeviceId: this.options.deviceId,
          pairingId: this.options.pairingId
        },
        role: 'client'
      })

      if (this.approvalPending) {
        this.setStatus('approval_pending')
        // Send initial handshake request to MMS proving pairingSecret possession
        await this.request('pairing.requestApproval', {
          deviceId: this.options.deviceId,
          deviceName: 'Mousse Mobile',
          scopes: ['mousse:read', 'mousse:chat', 'mousse:write', 'mousse:terminal', 'mousse:settings']
        })
        this.approvalPending = false
      }

      this.setStatus('live')
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      if (msg.includes(ERROR_CODES.DEVICE_REVOKED) || msg.includes(ERROR_CODES.PAIRING_REVOKED)) {
        this.handleRevocation()
      } else {
        this.setStatus('reconnecting')
      }
    }
  }

  private async handleIncomingFrame(frame: Uint8Array): Promise<void> {
    let envelope: ControlEnvelope
    try {
      envelope = await this.secureChannel.decryptFrame(frame)
    } catch (error) {
      return
    }

    if (envelope.type === 'response') {
      this.handleResponse(envelope)
    } else if (envelope.type === 'event') {
      this.cursor = { instanceId: envelope.instanceId, seq: envelope.seq }
      this.options.onEvent?.({
        event: envelope.event,
        payload: envelope.payload,
        seq: envelope.seq,
        instanceId: envelope.instanceId
      })
    } else if (envelope.type === 'snapshotRequired') {
      this.options.onSnapshotRequired?.(envelope.reason)
    } else if (envelope.type === 'ping') {
      // Send pong
      void this.sendEnvelope({ type: 'pong', timestamp: envelope.timestamp })
    }
  }

  private handleResponse(res: ResponseEnvelope): void {
    const pending = this.inFlight.get(res.requestId)
    if (!pending) return
    this.inFlight.delete(res.requestId)
    clearTimeout(pending.timer)

    if (res.error) {
      const code = res.error.code
      if (code === ERROR_CODES.DEVICE_REVOKED || code === ERROR_CODES.PAIRING_REVOKED) {
        this.handleRevocation()
        pending.reject(new Error(`${code}: ${res.error.message}`))
        return
      }
      if (code === ERROR_CODES.SNAPSHOT_REQUIRED) {
        this.options.onSnapshotRequired?.(res.error.message)
      }
      pending.reject(new Error(res.error.message || `RPC error (${code})`))
    } else {
      pending.resolve(res.result)
    }
  }

  private handleRevocation(): void {
    this.setStatus('revoked')
    this.options.onRevoked?.()
    this.stop()
  }

  private handleConnectionDrop(): void {
    for (const [id, req] of this.inFlight.entries()) {
      clearTimeout(req.timer)
      this.inFlight.delete(id)
      if (req.mutate) {
        this.outcomeUnknownOperations.push({
          requestId: id,
          idempotencyKey: req.idempotencyKey,
          method: req.method,
          params: req.params,
          timestamp: Date.now()
        })
        req.reject(
          new OutcomeUnknownError(
            `Connection interrupted during ${req.method}. Outcome is unknown.`,
            {
              requestId: id,
              idempotencyKey: req.idempotencyKey,
              method: req.method,
              params: req.params
            }
          )
        )
      } else {
        req.reject(new Error(`Connection closed before ${req.method} response`))
      }
    }
  }

  private rejectInFlightAll(reason: string): void {
    for (const [id, req] of this.inFlight.entries()) {
      clearTimeout(req.timer)
      this.inFlight.delete(id)
      req.reject(new Error(reason))
    }
  }

  private async sendEnvelope(envelope: ControlEnvelope): Promise<void> {
    if (!this.relay || !this.secureChannel.isEstablished()) {
      throw new Error('Channel is not ready')
    }
    const frame = await this.secureChannel.encryptEnvelope(envelope)
    this.relay.sendFrame(frame)
  }

  async request<T>(
    method: string,
    params: Record<string, unknown> = {},
    mutate = false,
    options?: { idempotencyKey?: string }
  ): Promise<T> {
    if (this.status === 'revoked') {
      throw new Error(`${ERROR_CODES.DEVICE_REVOKED}: Pairing has been revoked`)
    }

    if (this.inFlight.size >= MAX_CONCURRENT_RPCS) {
      throw new Error(`Exceeded maximum concurrent RPC limit (${MAX_CONCURRENT_RPCS})`)
    }

    const requestId = crypto.randomUUID()
    const idempotencyKey = mutate ? options?.idempotencyKey || crypto.randomUUID() : undefined

    const envelope: ControlEnvelope = {
      type: 'request',
      requestId,
      method,
      params,
      idempotencyKey,
      protocolVersion: '2.0'
    }

    return new Promise<T>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        const pending = this.inFlight.get(requestId)
        if (pending) {
          this.inFlight.delete(requestId)
          if (mutate) {
            this.outcomeUnknownOperations.push({
              requestId,
              idempotencyKey,
              method,
              params,
              timestamp: Date.now()
            })
            reject(
              new OutcomeUnknownError(
                `Timeout waiting for response to ${method}. Outcome is unknown.`,
                { requestId, idempotencyKey, method, params }
              )
            )
          } else {
            reject(new Error(`Request timed out waiting for ${method}`))
          }
        }
      }, 60_000)

      this.inFlight.set(requestId, {
        method,
        params,
        mutate,
        idempotencyKey,
        resolve: resolve as (val: unknown) => void,
        reject,
        timer
      })

      void this.sendEnvelope(envelope).catch(err => {
        const pending = this.inFlight.get(requestId)
        if (pending) {
          clearTimeout(pending.timer)
          this.inFlight.delete(requestId)
          pending.reject(err instanceof Error ? err : new Error(String(err)))
        }
      })
    })
  }

  dismissOutcomeUnknown(requestId: string): void {
    this.outcomeUnknownOperations = this.outcomeUnknownOperations.filter(
      op => op.requestId !== requestId
    )
  }
}
