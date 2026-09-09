import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RelayClient } from '../src/relay/relayClient'
import type { ConnectionStatus } from '../src/types'

class MockWebSocket {
  static instances: MockWebSocket[] = []
  static OPEN = 1
  static CLOSED = 3

  url: string
  readyState = MockWebSocket.OPEN
  bufferedAmount = 0
  binaryType = 'blob'

  onopen: (() => void) | null = null
  onmessage: ((event: { data: any }) => void) | null = null
  onerror: ((error: any) => void) | null = null
  onclose: ((event: { code: number; reason: string }) => void) | null = null

  sent: any[] = []

  constructor(url: string) {
    this.url = url
    MockWebSocket.instances.push(this)
    // Simulate connection opening on next microtick
    setTimeout(() => {
      if (this.readyState === MockWebSocket.OPEN && this.onopen) {
        this.onopen()
      }
    }, 5)
  }

  send(data: any): void {
    this.sent.push(data)
  }

  close(code = 1000, reason = ''): void {
    this.readyState = MockWebSocket.CLOSED
    if (this.onclose) {
      this.onclose({ code, reason })
    }
  }

  receiveMessage(data: any): void {
    if (this.onmessage) {
      this.onmessage({ data })
    }
  }
}

describe('RelayClient', () => {
  let originalWebSocket: any

  beforeEach(() => {
    MockWebSocket.instances = []
    originalWebSocket = window.WebSocket
    ;(window as any).WebSocket = MockWebSocket as any
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    ;(window as any).WebSocket = originalWebSocket
  })

  it('connects, removes bearer query params from URL, and sends authenticated first message', async () => {
    const statuses: ConnectionStatus[] = []
    const client = new RelayClient({
      relayUrl: 'wss://relay.example.com/v1/relay?token=secret123',
      deviceId: 'device-abc',
      pairingId: 'pairing-xyz',
      getAdmissionToken: async () => 'adm-token-999',
      onFrame: () => {},
      onStatusChange: s => statuses.push(s)
    })

    client.start()
    expect(statuses).toContain('connecting')

    // Advance to let admission token resolve and WebSocket connect
    await vi.advanceTimersByTimeAsync(10)

    const ws = MockWebSocket.instances[0]
    expect(ws).toBeDefined()
    // Enforce: NO bearer tokens or query params in URL
    expect(ws.url).toBe('wss://relay.example.com/v1/relay')

    // On open, authenticated first message must be sent
    expect(ws.sent.length).toBe(1)
    const firstMsg = JSON.parse(ws.sent[0])
    expect(firstMsg).toEqual({
      type: 'auth',
      admissionToken: 'adm-token-999',
      deviceId: 'device-abc',
      pairingId: 'pairing-xyz',
      role: 'client'
    })

    // Server responds with auth_ok
    ws.receiveMessage(JSON.stringify({ type: 'auth_ok' }))
    expect(statuses).toContain('live')
    expect(client.isConnected()).toBe(true)

    client.stop()
  })

  it('enforces 5s unauthenticated deadline (AUTH_TIMEOUT)', async () => {
    const statuses: ConnectionStatus[] = []
    const client = new RelayClient({
      relayUrl: 'wss://relay.example.com/v1/relay',
      deviceId: 'device-abc',
      pairingId: 'pairing-xyz',
      getAdmissionToken: async () => 'adm-token-999',
      onFrame: () => {},
      onStatusChange: s => statuses.push(s)
    })

    client.start()
    await vi.advanceTimersByTimeAsync(10)

    const ws = MockWebSocket.instances[0]
    expect(ws).toBeDefined()

    // Advance 5000ms without auth response
    await vi.advanceTimersByTimeAsync(5100)

    // Should close and reconnect
    expect(ws.readyState).toBe(MockWebSocket.CLOSED)
    expect(statuses).toContain('reconnecting')

    client.stop()
  })

  it('handles auth rejection and triggers reconnect', async () => {
    const statuses: ConnectionStatus[] = []
    const client = new RelayClient({
      relayUrl: 'wss://relay.example.com/v1/relay',
      deviceId: 'device-abc',
      pairingId: 'pairing-xyz',
      getAdmissionToken: async () => 'adm-token-999',
      onFrame: () => {},
      onStatusChange: s => statuses.push(s)
    })

    client.start()
    await vi.advanceTimersByTimeAsync(10)

    const ws = MockWebSocket.instances[0]
    ws.receiveMessage(JSON.stringify({ type: 'error', code: 'ADMISSION_EXPIRED', message: 'Expired' }))

    expect(ws.readyState).toBe(MockWebSocket.CLOSED)
    expect(statuses).toContain('reconnecting')

    client.stop()
  })

  it('routes binary frames and handles outbound frames', async () => {
    const receivedFrames: Uint8Array[] = []
    const client = new RelayClient({
      relayUrl: 'wss://relay.example.com/v1/relay',
      deviceId: 'device-abc',
      pairingId: 'pairing-xyz',
      getAdmissionToken: async () => 'adm-token-999',
      onFrame: frame => receivedFrames.push(frame),
      onStatusChange: () => {}
    })

    // Attempting sendFrame before connected must throw
    expect(() => client.sendFrame(new Uint8Array([1, 2, 3]))).toThrow(/not connected/)

    client.start()
    await vi.advanceTimersByTimeAsync(10)

    const ws = MockWebSocket.instances[0]
    ws.receiveMessage(JSON.stringify({ type: 'auth_ok' }))

    // Now authenticated, send frame
    const payload = new Uint8Array([0x4d, 0x50, 0x02, 0x00, 0x99])
    client.sendFrame(payload)
    expect(ws.sent).toContain(payload)

    // Receive incoming binary frame from MMS via relay
    const inBuffer = new Uint8Array([10, 20, 30]).buffer
    ws.receiveMessage(inBuffer)
    expect(receivedFrames.length).toBe(1)
    expect(Array.from(receivedFrames[0])).toEqual([10, 20, 30])

    client.stop()
  })

  it('sends heartbeats and calculates latency on pong', async () => {
    let healthReport: { latencyMs: number; lastHeartbeat: number } | null = null
    const client = new RelayClient({
      relayUrl: 'wss://relay.example.com/v1/relay',
      deviceId: 'device-abc',
      pairingId: 'pairing-xyz',
      getAdmissionToken: async () => 'adm-token-999',
      onFrame: () => {},
      onStatusChange: () => {},
      onHealthUpdate: h => {
        healthReport = h
      }
    })

    client.start()
    await vi.advanceTimersByTimeAsync(10)
    const ws = MockWebSocket.instances[0]
    ws.receiveMessage(JSON.stringify({ type: 'auth_ok' }))

    // Advance 20s (HEARTBEAT_INTERVAL_MS)
    await vi.advanceTimersByTimeAsync(20_000)

    const pingMsg = ws.sent.find(s => typeof s === 'string' && s.includes('"ping"'))
    expect(pingMsg).toBeDefined()

    // Simulate pong
    ws.receiveMessage(JSON.stringify({ type: 'pong' }))
    expect(healthReport).not.toBeNull()
    const report = healthReport as { latencyMs: number; lastHeartbeat: number } | null
    expect(report?.lastHeartbeat).toBeGreaterThan(0)

    client.stop()
  })
})
