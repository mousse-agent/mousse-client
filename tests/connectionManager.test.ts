import { beforeEach, describe, expect, it, vi } from 'vitest'
import { connectionManager } from '../src/connectionManager'
import { plusApi } from '../src/relay/plusApi'
import { connectionCache, deviceIdentity, hostedSession, machines, tokens } from '../src/storage'
import type { HostedSession, MachineRecord, QrPayloadV2 } from '../src/types'

vi.mock('../src/relay/plusApi', () => ({
  plusApi: {
    claimPairingAttempt: vi.fn(async () => ({
      success: true,
      relayUrl: 'wss://relay.example.com/v1/relay'
    })),
    getRelayAdmission: vi.fn(async () => ({
      admissionToken: 'mock-admission-token',
      expiresIn: 30
    })),
    revokePairing: vi.fn(async () => {})
  }
}))

vi.mock('../src/transport/v2Transport', () => {
  return {
    V2Transport: vi.fn().mockImplementation(function (this: any, options: any) {
      this.options = options
      this.status = 'live'
      this.outcomeUnknownOperations = []
      this.start = vi.fn(() => {
        this.options.onStatusChange?.('live')
      })
      this.stop = vi.fn(() => {
        this.status = 'offline'
        this.options.onStatusChange?.('offline')
      })
      this.getStatus = vi.fn(() => this.status)
      this.getCursor = vi.fn(() => ({ instanceId: 'inst-1', seq: 10 }))
      this.request = vi.fn(async (method: string) => ({ method, success: true }))
      this.dismissOutcomeUnknown = vi.fn()
    })
  }
})

describe('ConnectionManager', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    await machines.clear()
    await hostedSession.clear()
    await tokens.clear()
    await connectionCache.clear()
    await connectionManager.disconnect()
  })

  it('manages modes and notifies subscribers', () => {
    let notified = false
    const unsubscribe = connectionManager.subscribe(() => {
      notified = true
    })

    connectionManager.setMode('self-hosted')
    expect(connectionManager.getMode()).toBe('self-hosted')
    expect(notified).toBe(true)

    unsubscribe()
  })

  it('migrates legacy tokens and connection cache to machine records during initialize()', async () => {
    // Setup legacy storage state
    await connectionCache.set({
      baseUrl: 'http://192.168.1.50:8080',
      apiEndpoint: 'http://192.168.1.50:8080/v1',
      eventsEndpoint: 'http://192.168.1.50:8080/events',
      tokenEndpoint: 'http://192.168.1.50:8080/oauth/token',
      clientId: 'legacy-client',
      serverName: 'Studio Mac'
    })
    await tokens.set({
      access_token: 'legacy-acc',
      refresh_token: 'legacy-ref',
      expires_at: Date.now() + 100000,
      client_id: 'legacy-client',
      scope: 'mousse:read',
      base_url: 'http://192.168.1.50:8080',
      issuer: 'http://192.168.1.50:8080'
    })

    await connectionManager.initialize()

    const all = connectionManager.getMachines()
    expect(all.length).toBeGreaterThanOrEqual(1)
    const migrated = all.find(m => m.name === 'Studio Mac' || m.mode === 'legacy')
    expect(migrated).toBeDefined()
    expect(migrated?.mode).toBe('legacy')
    expect(connectionManager.getActiveMachine()?.id).toBe(migrated?.id)
  })

  it('pairs QR v2 in self-hosted mode and sets as active machine', async () => {
    const qr: QrPayloadV2 = {
      protocolMajor: 2,
      protocolMinor: 0,
      mode: 'self-hosted',
      controlOrigin: 'https://control.example.com',
      installationId: 'inst-test-1',
      installationPublicKey: 'inst-pk-1',
      mmsDeviceId: 'mms-dev-1',
      mmsIdentityPublicKey: 'mms-pk-1',
      pairingId: 'pair-xyz',
      pairingSecret: 'sec-12345678901234567890123456789012',
      expiresAt: Date.now() + 60000
    }

    const machine = await connectionManager.pairQrV2(qr, 'fp-client', 'fp-mms', {
      customName: 'Office Desktop'
    })

    expect(machine.id).toBe('pair-xyz')
    expect(machine.name).toBe('Office Desktop')
    expect(machine.mode).toBe('self-hosted')

    expect(plusApi.claimPairingAttempt).toHaveBeenCalledWith(
      'https://control.example.com',
      'pair-xyz',
      expect.objectContaining({
        mobileName: 'Office Desktop',
        pairingSecretProof: qr.pairingSecret
      })
    )

    expect(connectionManager.getActiveMachine()?.id).toBe('pair-xyz')
    const list = connectionManager.getMachines()
    expect(list.some(m => m.id === 'pair-xyz')).toBe(true)
  })

  it('rejects QR v2 in hosted mode if account does not match session', async () => {
    // Save session with account-A
    const session: HostedSession = {
      access_token: 'acc-tok',
      refresh_token: 'ref-tok',
      expires_at: Date.now() + 10000,
      account_id: 'account-A',
      dashboard_url: 'https://mousse.example.com'
    }
    await hostedSession.set(session)
    await connectionManager.initialize()

    const qr: QrPayloadV2 = {
      protocolMajor: 2,
      protocolMinor: 0,
      mode: 'hosted',
      controlOrigin: 'https://control.example.com',
      installationId: 'inst-test-1',
      installationPublicKey: 'inst-pk-1',
      mmsDeviceId: 'mms-dev-1',
      mmsIdentityPublicKey: 'mms-pk-1',
      pairingId: 'pair-abc',
      pairingSecret: 'sec-12345678901234567890123456789012',
      accountId: 'account-B', // Different account
      expiresAt: Date.now() + 60000
    }

    await expect(
      connectionManager.pairQrV2(qr, 'fp-client', 'fp-mms', { customName: 'Other Account PC' })
    ).rejects.toThrow(/Account mismatch/)
  })

  it('switches between machines, forgets machine, and revokes machine', async () => {
    // Create two mock machines
    const m1: MachineRecord = {
      id: 'machine-1',
      name: 'Laptop',
      mode: 'self-hosted',
      controlOrigin: 'https://control.example.com',
      installationId: 'inst-1',
      installationPublicKey: 'pk-1',
      mmsDeviceId: 'mms-1',
      mmsIdentityPublicKey: 'mms-pk-1',
      pairingId: 'machine-1',
      pairedAt: Date.now(),
      lastSeen: Date.now(),
      status: 'live',
      health: { state: 'live' }
    }
    const m2: MachineRecord = {
      id: 'machine-2',
      name: 'Server',
      mode: 'self-hosted',
      controlOrigin: 'https://control.example.com',
      installationId: 'inst-2',
      installationPublicKey: 'pk-2',
      mmsDeviceId: 'mms-2',
      mmsIdentityPublicKey: 'mms-pk-2',
      pairingId: 'machine-2',
      pairedAt: Date.now(),
      lastSeen: Date.now(),
      status: 'live',
      health: { state: 'live' }
    }

    await machines.save(m1)
    await machines.save(m2)
    await machines.setActiveId('machine-1')

    await connectionManager.initialize()
    expect(connectionManager.getActiveMachine()?.id).toBe('machine-1')

    // Switch to machine-2
    await connectionManager.switchMachine('machine-2')
    expect(connectionManager.getActiveMachine()?.id).toBe('machine-2')

    // Revoke machine-2
    await connectionManager.revokeMachine('machine-2')
    expect(plusApi.revokePairing).toHaveBeenCalledWith(
      'https://control.example.com',
      'machine-2',
      undefined
    )
    const revokedM2 = await machines.get('machine-2')
    expect(revokedM2?.status).toBe('revoked')

    // Forget machine-1
    await connectionManager.forgetMachine('machine-1')
    const remaining = connectionManager.getMachines()
    expect(remaining.some(m => m.id === 'machine-1')).toBe(false)
  })

  it('routes requests to the active transport', async () => {
    const m1: MachineRecord = {
      id: 'machine-active',
      name: 'Workstation',
      mode: 'self-hosted',
      controlOrigin: 'https://control.example.com',
      installationId: 'inst-1',
      installationPublicKey: 'pk-1',
      mmsDeviceId: 'mms-1',
      mmsIdentityPublicKey: 'mms-pk-1',
      pairingId: 'machine-active',
      pairedAt: Date.now(),
      lastSeen: Date.now(),
      status: 'live',
      health: { state: 'live' }
    }
    await machines.save(m1)
    await machines.setActiveId('machine-active')
    await connectionManager.initialize()

    const res = await connectionManager.request<any>('threads.list', { limit: 10 })
    expect(res).toEqual({ method: 'threads.list', success: true })
  })
})
