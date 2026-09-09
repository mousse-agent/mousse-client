import {
  AUTH_DEADLINE_MS,
  ERROR_CODES,
  HEARTBEAT_INTERVAL_MS,
  MAX_OUTBOUND_QUEUED_BYTES,
  OFFLINE_AFTER_MS,
  RECONNECT_BACKOFF_MAX_MS,
  RECONNECT_BACKOFF_MIN_MS
} from '../constants'
import type { ConnectionStatus, RelayAuthMessage, RelayAuthResponse } from '../types'

export type RelayClientOptions = {
  relayUrl: string
  deviceId: string
  pairingId: string
  getAdmissionToken: () => Promise<string>
  onFrame: (data: Uint8Array) => void
  onStatusChange: (status: ConnectionStatus) => void
  onHealthUpdate?: (health: { latencyMs: number; lastHeartbeat: number }) => void
}

export class RelayClient {
  private ws: WebSocket | null = null
  private stopped = false
  private authenticated = false
  private authTimer: number | null = null
  private heartbeatTimer: number | null = null
  private lastPingSent = 0
  private lastProofOfLife = 0
  private retries = 0
  private reconnectTimeout: number | null = null

  constructor(private readonly options: RelayClientOptions) {}

  start(): void {
    this.stopped = false
    this.retries = 0
    void this.connect()
  }

  stop(): void {
    this.stopped = true
    this.clearTimers()
    if (this.ws) {
      try {
        this.ws.close(1000, 'Client disconnected')
      } catch {}
      this.ws = null
    }
    this.authenticated = false
    this.options.onStatusChange('offline')
  }

  private clearTimers(): void {
    if (this.authTimer !== null) {
      clearTimeout(this.authTimer)
      this.authTimer = null
    }
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
    if (this.reconnectTimeout !== null) {
      clearTimeout(this.reconnectTimeout)
      this.reconnectTimeout = null
    }
  }

  private async connect(): Promise<void> {
    if (this.stopped) return
    this.clearTimers()
    this.options.onStatusChange(this.retries === 0 ? 'connecting' : 'reconnecting')

    try {
      const admissionToken = await this.options.getAdmissionToken()
      if (this.stopped) return

      const url = new URL(this.options.relayUrl)
      // Enforce: NO bearer tokens in URL query params
      url.search = ''

      const ws = new WebSocket(url.toString())
      ws.binaryType = 'arraybuffer'
      this.ws = ws

      // 5-second unauthenticated deadline
      this.authTimer = window.setTimeout(() => {
        if (!this.authenticated && this.ws === ws) {
          try {
            ws.close(4001, 'AUTH_TIMEOUT')
          } catch {}
          this.handleDisconnect('AUTH_TIMEOUT: First message authentication deadline exceeded')
        }
      }, AUTH_DEADLINE_MS)

      ws.onopen = () => {
        if (this.ws !== ws) return
        // Send authenticated first message immediately
        const authMsg: RelayAuthMessage = {
          type: 'auth',
          admissionToken,
          deviceId: this.options.deviceId,
          pairingId: this.options.pairingId,
          role: 'client'
        }
        ws.send(JSON.stringify(authMsg))
      }

      ws.onmessage = (event: MessageEvent) => {
        if (this.ws !== ws) return
        this.lastProofOfLife = Date.now()

        if (!this.authenticated) {
          try {
            const raw = typeof event.data === 'string'
              ? event.data
              : new TextDecoder().decode(event.data as ArrayBuffer)
            const parsed = JSON.parse(raw) as RelayAuthResponse
            if (parsed.type === 'auth_ok') {
              this.authenticated = true
              if (this.authTimer !== null) {
                clearTimeout(this.authTimer)
                this.authTimer = null
              }
              this.retries = 0
              this.options.onStatusChange('live')
              this.startHeartbeat()
              return
            } else if (parsed.type === 'error') {
              ws.close(4003, parsed.code || 'AUTH_REJECTED')
              this.handleDisconnect(`Authentication rejected: ${parsed.message || parsed.code}`)
              return
            }
          } catch {
            ws.close(4002, 'BAD_AUTH_RESPONSE')
            this.handleDisconnect('Invalid authentication response from relay')
            return
          }
        }

        // Handle heartbeat pong messages if formatted as JSON
        if (typeof event.data === 'string') {
          try {
            const json = JSON.parse(event.data) as { type?: string; timestamp?: number }
            if (json.type === 'pong') {
              const latency = this.lastPingSent ? Date.now() - this.lastPingSent : 0
              this.options.onHealthUpdate?.({ latencyMs: latency, lastHeartbeat: Date.now() })
              return
            }
          } catch {
            // Not a control JSON, pass as binary/text
          }
        }

        // Pass binary/application frame to secure channel
        const bytes = event.data instanceof ArrayBuffer
          ? new Uint8Array(event.data)
          : typeof event.data === 'string'
            ? new TextEncoder().encode(event.data)
            : new Uint8Array(event.data)
        this.options.onFrame(bytes)
      }

      ws.onerror = () => {
        if (this.ws !== ws) return
        // Will be followed by onclose
      }

      ws.onclose = (e) => {
        if (this.ws !== ws) return
        this.handleDisconnect(`Relay connection closed (${e.code}: ${e.reason || 'network'})`)
      }
    } catch (error) {
      this.handleDisconnect(error instanceof Error ? error.message : 'Relay connection failed')
    }
  }

  private startHeartbeat(): void {
    this.lastProofOfLife = Date.now()
    this.heartbeatTimer = window.setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return

      // Check proof of life
      if (Date.now() - this.lastProofOfLife > OFFLINE_AFTER_MS) {
        this.handleDisconnect('Proof of life threshold exceeded (peer offline)')
        return
      }

      // Send ping
      this.lastPingSent = Date.now()
      try {
        this.ws.send(JSON.stringify({ type: 'ping', timestamp: this.lastPingSent }))
      } catch {}
    }, HEARTBEAT_INTERVAL_MS)
  }

  private handleDisconnect(reason: string): void {
    this.clearTimers()
    this.authenticated = false
    if (this.ws) {
      try {
        this.ws.close()
      } catch {}
      this.ws = null
    }

    if (this.stopped) return

    this.options.onStatusChange('reconnecting')

    // Exponential backoff with jitter (1s - 30s)
    const baseDelay = Math.min(
      RECONNECT_BACKOFF_MAX_MS,
      RECONNECT_BACKOFF_MIN_MS * 1.5 ** this.retries++
    )
    const jitter = Math.random() * 1000
    const delay = Math.round(baseDelay + jitter)

    this.reconnectTimeout = window.setTimeout(() => {
      void this.connect()
    }, delay)
  }

  sendFrame(frame: Uint8Array): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.authenticated) {
      throw new Error('Relay socket is not connected or authenticated')
    }

    if (this.ws.bufferedAmount + frame.byteLength > MAX_OUTBOUND_QUEUED_BYTES) {
      throw new Error('Outbound queued bytes exceeded limit (relay backpressure)')
    }

    this.ws.send(frame)
  }

  isConnected(): boolean {
    return this.authenticated && this.ws !== null && this.ws.readyState === WebSocket.OPEN
  }
}
