import { assertAccountMatch, refreshHostedSession } from './hostedAuth'
import { discover, authorize } from './oauth'
import { plusApi } from './relay/plusApi'
import { MousseRpc } from './rpc'
import { ReconnectingSse, type SseEvent } from './sse'
import {
  connectionCache,
  deviceIdentity,
  hostedSession,
  machines,
  migrateLegacyStorage,
  tokens
} from './storage'
import { V2Transport } from './transport/v2Transport'
import type {
  Connection,
  ConnectionMode,
  ConnectionStatus,
  HostedSession,
  MachineRecord,
  OAuthMetadata,
  QrPayloadV2,
  TokenSet
} from './types'

export type ConnectionManagerListener = () => void

export class ConnectionManager {
  private static instance: ConnectionManager | null = null

  private mode: ConnectionMode = 'hosted'
  private session: HostedSession | null = null
  private machineList: MachineRecord[] = []
  private activeMachine: MachineRecord | null = null
  private status: ConnectionStatus = 'offline'
  private health: { latencyMs?: number; lastHeartbeat?: number; state: string } = {
    state: 'offline'
  }

  private v2Transport: V2Transport | null = null
  private legacyRpc: MousseRpc | null = null
  private legacySse: ReconnectingSse | null = null

  private listeners = new Set<ConnectionManagerListener>()
  private eventHandlers = new Set<(event: { event: string; payload: unknown }) => void>()
  private snapshotHandlers = new Set<() => void>()

  static getInstance(): ConnectionManager {
    if (!ConnectionManager.instance) {
      ConnectionManager.instance = new ConnectionManager()
    }
    return ConnectionManager.instance
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener()
      } catch {}
    }
  }

  subscribe(listener: ConnectionManagerListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  onEvent(handler: (event: { event: string; payload: unknown }) => void): () => void {
    this.eventHandlers.add(handler)
    return () => {
      this.eventHandlers.delete(handler)
    }
  }

  onSnapshotRequired(handler: () => void): () => void {
    this.snapshotHandlers.add(handler)
    return () => {
      this.snapshotHandlers.delete(handler)
    }
  }

  getMode(): ConnectionMode {
    return this.mode
  }

  setMode(mode: ConnectionMode): void {
    this.mode = mode
    this.notify()
  }

  getSession(): HostedSession | null {
    return this.session
  }

  getMachines(): MachineRecord[] {
    return [...this.machineList]
  }

  getActiveMachine(): MachineRecord | null {
    return this.activeMachine
  }

  getStatus(): ConnectionStatus {
    return this.status
  }

  getHealth(): { latencyMs?: number; lastHeartbeat?: number; state: string } {
    return { ...this.health }
  }

  getOutcomeUnknownOperations(): Array<{
    requestId: string
    idempotencyKey?: string
    method: string
    params: Record<string, unknown>
    timestamp: number
  }> {
    return this.v2Transport?.outcomeUnknownOperations || []
  }

  dismissOutcomeUnknown(requestId: string): void {
    this.v2Transport?.dismissOutcomeUnknown(requestId)
    this.notify()
  }

  async initialize(): Promise<void> {
    await migrateLegacyStorage()

    const [savedSession, savedMachines, active] = await Promise.all([
      hostedSession.get(),
      machines.getAll(),
      machines.getActive()
    ])

    this.session = savedSession
    this.machineList = savedMachines
    this.activeMachine = active

    if (active) {
      this.mode = active.mode
      await this.connectToMachine(active)
    }

    this.notify()
  }

  async pairQrV2(
    qr: QrPayloadV2,
    devicePublicFp: string,
    mmsFp: string,
    options?: { customName?: string }
  ): Promise<MachineRecord> {
    const identity = await deviceIdentity.getOrCreate()

    if (qr.mode === 'hosted') {
      if (!this.session) {
        throw new Error('Sign in to your Mousse Plus account before pairing.')
      }
      assertAccountMatch(qr.accountId, this.session.account_id)
    }

    this.status = 'connecting'
    this.notify()

    // 1. Claim pairing route on Control Server
    const claimResult = await plusApi.claimPairingAttempt(qr.controlOrigin, qr.pairingId, {
      token: this.session?.access_token,
      mobileDeviceId: identity.deviceId,
      mobilePublicKey: identity.publicKey,
      mobileName: options?.customName || 'Mousse Phone',
      pairingSecretProof: qr.mode === 'self-hosted' ? qr.pairingSecret : undefined
    })

    const relayUrl =
      claimResult.relayUrl ||
      `${qr.controlOrigin.replace(/^http/, 'ws')}/v1/relay`

    // 2. Create Machine Record
    const machineRecord: MachineRecord = {
      id: qr.pairingId,
      name: options?.customName || `Computer (${qr.mmsDeviceId.slice(0, 8)})`,
      mode: qr.mode,
      controlOrigin: qr.controlOrigin,
      installationId: qr.installationId,
      installationPublicKey: qr.installationPublicKey,
      mmsDeviceId: qr.mmsDeviceId,
      mmsIdentityPublicKey: qr.mmsIdentityPublicKey,
      pairingId: qr.pairingId,
      pairedAt: Date.now(),
      lastSeen: Date.now(),
      status: 'approval_pending',
      accountId: qr.accountId,
      health: { state: 'connecting' }
    }

    await machines.save(machineRecord)
    await machines.setActiveId(machineRecord.id)
    this.machineList = await machines.getAll()
    this.activeMachine = machineRecord
    this.mode = qr.mode

    // 3. Connect via V2Transport with isInitialPairing = true
    await this.startV2Transport(machineRecord, relayUrl, qr.pairingSecret, true)

    this.notify()
    return machineRecord
  }

  async pairLegacy(baseUrl: string, admin = false): Promise<MachineRecord> {
    this.status = 'connecting'
    this.notify()

    const discovered = await discover(baseUrl)
    const tokenSet = await authorize(discovered.connection, discovered.oauth, admin)

    const machineRecord: MachineRecord = {
      id: `legacy-${Date.now()}`,
      name: discovered.connection.serverName || 'Direct MMS',
      mode: 'legacy',
      controlOrigin: discovered.connection.baseUrl,
      installationId: 'legacy',
      installationPublicKey: '',
      mmsDeviceId: 'legacy',
      mmsIdentityPublicKey: '',
      pairingId: `legacy-${Date.now()}`,
      pairedAt: Date.now(),
      lastSeen: Date.now(),
      status: 'live',
      health: { state: 'live' },
      legacyConnection: discovered.connection,
      legacyTokens: tokenSet
    }

    await machines.save(machineRecord)
    await machines.setActiveId(machineRecord.id)
    this.machineList = await machines.getAll()
    this.activeMachine = machineRecord
    this.mode = 'legacy'

    await this.startLegacyTransport(machineRecord)
    this.notify()
    return machineRecord
  }

  async switchMachine(id: string): Promise<void> {
    const target = await machines.get(id)
    if (!target) throw new Error('Machine not found')

    this.stopTransports()
    await machines.setActiveId(target.id)
    this.activeMachine = target
    this.mode = target.mode
    this.notify()

    await this.connectToMachine(target)
  }

  private async connectToMachine(m: MachineRecord): Promise<void> {
    if (m.mode === 'legacy') {
      await this.startLegacyTransport(m)
    } else {
      const relayUrl = `${m.controlOrigin.replace(/^http/, 'ws')}/v1/relay`
      await this.startV2Transport(m, relayUrl)
    }
  }

  private async startV2Transport(
    machine: MachineRecord,
    relayUrl: string,
    pairingSecret?: string,
    isInitialPairing = false
  ): Promise<void> {
    this.stopTransports()

    const identity = await deviceIdentity.getOrCreate()

    this.v2Transport = new V2Transport({
      relayUrl,
      deviceId: identity.deviceId,
      pairingId: machine.pairingId,
      peerStaticPublicKey: machine.mmsIdentityPublicKey,
      installationId: machine.installationId,
      controlOrigin: machine.controlOrigin,
      mode: machine.mode === 'hosted' ? 'hosted' : 'self-hosted',
      accountId: machine.accountId,
      mmsDeviceId: machine.mmsDeviceId,
      pairingSecret,
      isInitialPairing,
      getAdmissionToken: async () => {
        let token = this.session?.access_token
        if (machine.mode === 'hosted' && this.session) {
          if (Date.now() > this.session.expires_at - 30_000) {
            this.session = await refreshHostedSession(this.session)
            token = this.session.access_token
          }
        }
        const adm = await plusApi.getRelayAdmission(machine.controlOrigin, machine.pairingId, {
          token,
          mobileDeviceId: identity.deviceId,
          role: 'client'
        })
        return adm.admissionToken
      },
      onStatusChange: status => {
        this.status = status
        machine.status = status
        machine.lastSeen = Date.now()
        void machines.save(machine)
        this.notify()
      },
      onHealthUpdate: health => {
        this.health = { ...health, state: this.status }
        this.notify()
      },
      onEvent: ev => {
        for (const handler of this.eventHandlers) {
          handler({ event: ev.event, payload: ev.payload })
        }
      },
      onSnapshotRequired: () => {
        for (const handler of this.snapshotHandlers) {
          handler()
        }
      },
      onRevoked: () => {
        machine.status = 'revoked'
        void machines.save(machine)
        this.notify()
      }
    })

    this.v2Transport.start()
  }

  private async startLegacyTransport(machine: MachineRecord): Promise<void> {
    this.stopTransports()
    if (!machine.legacyConnection || !machine.legacyTokens) {
      throw new Error('Incomplete legacy connection profile')
    }

    const conn = machine.legacyConnection
    let curTokens = machine.legacyTokens

    this.legacyRpc = new MousseRpc(conn.apiEndpoint, curTokens, next => {
      curTokens = next
      machine.legacyTokens = next
      void machines.save(machine)
      void tokens.set(next)
    })

    this.legacySse = new ReconnectingSse(
      conn.eventsEndpoint,
      curTokens,
      (event: SseEvent) => {
        if (event.event === 'stream.reset') {
          for (const handler of this.snapshotHandlers) handler()
          return
        }
        for (const handler of this.eventHandlers) {
          handler({ event: event.event, payload: event.data })
        }
      },
      status => {
        this.status = status
        machine.status = status
        machine.lastSeen = Date.now()
        this.notify()
      },
      () => {
        for (const handler of this.snapshotHandlers) handler()
      },
      force => this.legacyRpc!.activeToken(force)
    )

    this.legacySse.start()
    this.status = 'live'
    this.notify()
  }

  private stopTransports(): void {
    if (this.v2Transport) {
      this.v2Transport.stop()
      this.v2Transport = null
    }
    if (this.legacySse) {
      this.legacySse.stop()
      this.legacySse = null
    }
    this.legacyRpc = null
    this.status = 'offline'
  }

  async request<T>(
    method: string,
    params: Record<string, unknown> = {},
    mutate = false
  ): Promise<T> {
    if (this.v2Transport) {
      return this.v2Transport.request<T>(method, params, mutate)
    }
    if (this.legacyRpc) {
      return this.legacyRpc.request<T>(method, params, mutate)
    }
    throw new Error('Not connected to any machine')
  }

  async forgetMachine(id: string): Promise<void> {
    if (this.activeMachine?.id === id) {
      this.stopTransports()
      this.activeMachine = null
    }
    await machines.remove(id)
    this.machineList = await machines.getAll()
    this.activeMachine = await machines.getActive()
    if (this.activeMachine) {
      await this.connectToMachine(this.activeMachine)
    }
    this.notify()
  }

  async revokeMachine(id: string): Promise<void> {
    const target = await machines.get(id)
    if (!target) return

    try {
      if (target.mode === 'hosted' || target.mode === 'self-hosted') {
        await plusApi.revokePairing(target.controlOrigin, target.pairingId, this.session?.access_token)
      } else if (target.legacyTokens && target.legacyConnection) {
        await fetch(`${target.legacyConnection.baseUrl}/oauth/revoke`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            token: target.legacyTokens.refresh_token,
            client_id: target.legacyTokens.client_id,
            token_type_hint: 'refresh_token'
          })
        }).catch(() => undefined)
      }
    } catch {}

    target.status = 'revoked'
    await machines.save(target)
    if (this.activeMachine?.id === id) {
      this.stopTransports()
      this.status = 'revoked'
    }
    this.notify()
  }

  async disconnect(): Promise<void> {
    this.stopTransports()
    this.notify()
  }
}

export const connectionManager = ConnectionManager.getInstance()
