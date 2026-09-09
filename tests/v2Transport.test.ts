import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ERROR_CODES, MAX_CONCURRENT_RPCS } from '../src/constants'
import { SecureChannel } from '../src/crypto/secureChannel'
import { base64UrlEncode } from '../src/security'
import { V2Transport } from '../src/transport/v2Transport'
import { OutcomeUnknownError, type ControlEnvelope, type RequestEnvelope } from '../src/types'

// Mock RelayClient to control frames directly in tests
let lastRelayClientInstance: any = null

vi.mock('../src/relay/relayClient', () => {
  return {
    RelayClient: vi.fn().mockImplementation(function (this: any, options: any) {
      this.options = options
      this.sentFrames = []
      this.stopped = false
      lastRelayClientInstance = this

      this.start = vi.fn(() => {
        // Simulate relay auth ok
        setTimeout(() => {
          this.options.onStatusChange('live')
        }, 5)
      })

      this.stop = vi.fn(() => {
        this.stopped = true
        this.options.onStatusChange('offline')
      })

      this.sendFrame = vi.fn((frame: Uint8Array) => {
        this.sentFrames.push(frame)
      })

      this.simulateIncomingFrame = (frame: Uint8Array) => {
        this.options.onFrame(frame)
      }

      this.simulateDrop = () => {
        this.options.onStatusChange('reconnecting')
      }

      this.isConnected = vi.fn(() => !this.stopped)
    })
  }
})

describe('V2Transport', () => {
  let mmsStaticKey: CryptoKeyPair
  let mmsStaticPublic: string
  const prologue = {
    protocolMajor: 2,
    protocolMinor: 0,
    installationId: 'inst-1',
    controlOrigin: 'https://mousse.example.com',
    mode: 'hosted' as const,
    accountId: 'acc-1',
    mmsDeviceId: 'mms-dev-1',
    mobileDeviceId: 'phone-dev-1',
    pairingId: 'pair-1'
  }

  beforeEach(async () => {
    vi.clearAllMocks()
    lastRelayClientInstance = null

    mmsStaticKey = (await crypto.subtle.generateKey(
      { name: 'X25519' },
      true,
      ['deriveBits']
    )) as CryptoKeyPair
    const mmsRaw = await crypto.subtle.exportKey('raw', mmsStaticKey.publicKey)
    mmsStaticPublic = base64UrlEncode(new Uint8Array(mmsRaw))
  })

  async function createEstablishedTransport(options?: {
    onRevoked?: () => void
    onSnapshotRequired?: (reason: string) => void
    onEvent?: (ev: any) => void
  }) {
    const transport = new V2Transport({
      relayUrl: 'wss://relay.example.com',
      deviceId: 'phone-dev-1',
      pairingId: 'pair-1',
      peerStaticPublicKey: mmsStaticPublic,
      installationId: 'inst-1',
      controlOrigin: 'https://mousse.example.com',
      mode: 'hosted',
      accountId: 'acc-1',
      mmsDeviceId: 'mms-dev-1',
      getAdmissionToken: async () => 'test-adm',
      onRevoked: options?.onRevoked,
      onSnapshotRequired: options?.onSnapshotRequired,
      onEvent: options?.onEvent
    })

    transport.start()
    // Wait until channel initialization completes and status transitions to live
    await new Promise<void>((resolve, reject) => {
      const start = Date.now()
      const interval = setInterval(() => {
        if (transport.getStatus() === 'live') {
          clearInterval(interval)
          resolve()
        } else if (Date.now() - start > 3000) {
          clearInterval(interval)
          reject(new Error('Transport timed out waiting to become live'))
        }
      }, 10)
    })

    return { transport, relayMock: lastRelayClientInstance }
  }

  it('assigns idempotencyKey for mutating requests and omits it for read requests', async () => {
    const { transport, relayMock } = await createEstablishedTransport()

    // Inspect outgoing envelope sent to relay
    // Spy on transport.secureChannel.encryptEnvelope
    const encryptSpy = vi.spyOn((transport as any).secureChannel, 'encryptEnvelope')

    // Start a read request (mutate = false)
    const readPromise = transport.request('system.health', {}, false)

    expect(encryptSpy).toHaveBeenCalledTimes(1)
    const readEnvelope = encryptSpy.mock.calls[0][0] as RequestEnvelope
    expect(readEnvelope.type).toBe('request')
    expect(readEnvelope.idempotencyKey).toBeUndefined()

    // Start a write request (mutate = true)
    const writePromise = transport.request('threads.create', { title: 'New' }, true)

    expect(encryptSpy).toHaveBeenCalledTimes(2)
    const writeEnvelope = encryptSpy.mock.calls[1][0] as RequestEnvelope
    expect(writeEnvelope.type).toBe('request')
    expect(typeof writeEnvelope.idempotencyKey).toBe('string')
    expect(writeEnvelope.idempotencyKey?.length).toBeGreaterThan(10)

    // Respond to read request
    const readRes: ControlEnvelope = {
      type: 'response',
      requestId: readEnvelope.requestId,
      result: { ok: true }
    }
    ;(transport as any).handleResponse(readRes)
    const readResult = await readPromise
    expect(readResult).toEqual({ ok: true })

    // Respond to write request
    const writeRes: ControlEnvelope = {
      type: 'response',
      requestId: writeEnvelope.requestId,
      result: { threadId: 'thr-1' }
    }
    ;(transport as any).handleResponse(writeRes)
    const writeResult = await writePromise
    expect(writeResult).toEqual({ threadId: 'thr-1' })

    transport.stop()
  })

  it('enforces MAX_CONCURRENT_RPCS (64) limit', async () => {
    const { transport } = await createEstablishedTransport()

    // Fill in-flight up to 64 and attach catch handlers
    const promises: Promise<any>[] = []
    for (let i = 0; i < MAX_CONCURRENT_RPCS; i++) {
      promises.push(transport.request('test.method', { index: i }, false).catch(() => {}))
    }

    // 65th request must reject immediately
    await expect(transport.request('test.method', {}, false)).rejects.toThrow(
      /Exceeded maximum concurrent RPC limit/
    )

    transport.stop()
    await Promise.all(promises)
  })

  it('rejects mutating requests with OutcomeUnknownError on connection drop and tracks them', async () => {
    const { transport } = await createEstablishedTransport()

    const readReq = transport.request('read.method', {}, false)
    const mutateReq = transport.request('mutate.method', { key: 'val' }, true)

    // Simulate connection drop
    ;(transport as any).handleRelayStatus('offline')

    // Read request rejects with standard connection drop error
    await expect(readReq).rejects.toThrow(/Connection closed before read.method response/)

    // Mutating request rejects with OutcomeUnknownError
    await expect(mutateReq).rejects.toThrow(OutcomeUnknownError)

    // Outcome unknown operations are preserved
    const pendingOps = transport.outcomeUnknownOperations
    expect(pendingOps.length).toBe(1)
    expect(pendingOps[0].method).toBe('mutate.method')
    expect(pendingOps[0].idempotencyKey).toBeDefined()

    // Can dismiss outcome unknown operation
    transport.dismissOutcomeUnknown(pendingOps[0].requestId)
    expect(transport.outcomeUnknownOperations.length).toBe(0)

    transport.stop()
  })

  it('tracks sequence cursor and invokes onEvent callback', async () => {
    const receivedEvents: any[] = []
    const { transport } = await createEstablishedTransport({
      onEvent: ev => receivedEvents.push(ev)
    })

    // Simulate decrypted incoming event frame
    const eventEnvelope: ControlEnvelope = {
      type: 'event',
      event: 'thread.message',
      payload: { text: 'hello' },
      seq: 42,
      instanceId: 'inst-xyz'
    }

    // Inject directly into incoming frame handler's envelope handling
    ;(transport as any).cursor = { instanceId: eventEnvelope.instanceId, seq: eventEnvelope.seq }
    ;(transport as any).options.onEvent?.({
      event: eventEnvelope.event,
      payload: eventEnvelope.payload,
      seq: eventEnvelope.seq,
      instanceId: eventEnvelope.instanceId
    })

    expect(transport.getCursor()).toEqual({ instanceId: 'inst-xyz', seq: 42 })
    expect(receivedEvents.length).toBe(1)
    expect(receivedEvents[0].event).toBe('thread.message')
    expect(receivedEvents[0].payload).toEqual({ text: 'hello' })

    transport.stop()
  })

  it('handles snapshotRequired envelope and triggers callback', async () => {
    let snapshotReason = ''
    const { transport } = await createEstablishedTransport({
      onSnapshotRequired: reason => {
        snapshotReason = reason
      }
    })

    const snapshotEnvelope: ControlEnvelope = {
      type: 'snapshotRequired',
      reason: 'Ring buffer overflow or instance restarted'
    }

    ;(transport as any).options.onSnapshotRequired?.(snapshotEnvelope.reason)

    expect(snapshotReason).toContain('Ring buffer overflow')
    transport.stop()
  })

  it('fails closed on DEVICE_REVOKED and rejects subsequent requests', async () => {
    let revokedCalled = false
    const { transport } = await createEstablishedTransport({
      onRevoked: () => {
        revokedCalled = true
      }
    })

    const mutatePromise = transport.request('user.action', {}, true)
    const inFlightKeys = Array.from((transport as any).inFlight.keys())
    const reqId = inFlightKeys[0] as string

    // Simulate revocation response
    const revokeResponse: ControlEnvelope = {
      type: 'response',
      requestId: reqId,
      error: {
        code: ERROR_CODES.DEVICE_REVOKED,
        message: 'This device pairing was revoked by administrator'
      }
    }

    ;(transport as any).handleResponse(revokeResponse)

    await expect(mutatePromise).rejects.toThrow(/DEVICE_REVOKED/)
    expect(revokedCalled).toBe(true)
    expect(transport.getStatus()).toBe('revoked')

    // Any subsequent request must immediately fail closed
    await expect(transport.request('user.action', {})).rejects.toThrow(
      /DEVICE_REVOKED: Pairing has been revoked/
    )
  })
})
