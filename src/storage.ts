import { Preferences } from '@capacitor/preferences'
import { Capacitor } from '@capacitor/core'
import { SecureStorage } from '@aparajita/capacitor-secure-storage'
import { base64UrlEncode } from './security'
import type { DeviceIdentity, HostedSession, MachineRecord, TokenSet } from './types'

const TOKEN_KEY = 'mousse.connection.tokens.v1'
const CONNECTION_KEY = 'mousse.connection.info.v1'
const DEVICE_IDENTITY_KEY = 'mousse.device.identity.v2'
const HOSTED_SESSION_KEY = 'mousse.hosted.session.v2'
const MACHINES_KEY = 'mousse.machines.v2'
const ACTIVE_MACHINE_KEY = 'mousse.active.machine.v2'

async function secureGet(key: string): Promise<string | null> {
  try {
    const item = await SecureStorage.getItem(key)
    return item ?? null
  } catch {
    if (Capacitor.isNativePlatform()) {
      throw new Error('Secure storage is unavailable. Tokens cannot be stored on this device.')
    }
    const { value } = await Preferences.get({ key })
    return value ?? null
  }
}

async function secureSet(key: string, value: string): Promise<void> {
  try {
    await SecureStorage.setItem(key, value)
  } catch {
    if (Capacitor.isNativePlatform()) {
      throw new Error('Secure storage is unavailable. Tokens cannot be stored on this device.')
    }
    await Preferences.set({ key, value })
  }
}

async function secureRemove(key: string): Promise<void> {
  try {
    await SecureStorage.removeItem(key)
  } catch {
    if (Capacitor.isNativePlatform()) {
      throw new Error('Secure storage is unavailable. Tokens cannot be cleared safely on this device.')
    }
  }
  await Preferences.remove({ key })
}

/** Legacy TokenSet storage (preserved for backward compatibility). */
export const tokens = {
  async get(): Promise<TokenSet | null> {
    const raw = await secureGet(TOKEN_KEY)
    return raw ? (JSON.parse(raw) as TokenSet) : null
  },
  async set(value: TokenSet): Promise<void> {
    await secureSet(TOKEN_KEY, JSON.stringify(value))
  },
  async clear(): Promise<void> {
    await secureRemove(TOKEN_KEY)
    await Preferences.remove({ key: CONNECTION_KEY })
  }
}

/** Legacy connection cache (preserved for backward compatibility). */
export const connectionCache = {
  async get(): Promise<unknown | null> {
    const { value } = await Preferences.get({ key: CONNECTION_KEY })
    return value ? JSON.parse(value) : null
  },
  async set(value: unknown): Promise<void> {
    await Preferences.set({ key: CONNECTION_KEY, value: JSON.stringify(value) })
  },
  async clear(): Promise<void> {
    await Preferences.remove({ key: CONNECTION_KEY })
  }
}

/** Per-installation persistent device identity key pair storage. */
export const deviceIdentity = {
  async get(): Promise<DeviceIdentity | null> {
    const raw = await secureGet(DEVICE_IDENTITY_KEY)
    return raw ? (JSON.parse(raw) as DeviceIdentity) : null
  },
  async set(identity: DeviceIdentity): Promise<void> {
    await secureSet(DEVICE_IDENTITY_KEY, JSON.stringify(identity))
  },
  async getOrCreate(): Promise<DeviceIdentity> {
    const existing = await this.get()
    if (existing) return existing

    let keyPair: CryptoKeyPair
    try {
      keyPair = (await crypto.subtle.generateKey(
        { name: 'X25519' },
        true,
        ['deriveKey', 'deriveBits']
      )) as CryptoKeyPair
    } catch {
      keyPair = (await crypto.subtle.generateKey(
        { name: 'ECDH', namedCurve: 'P-256' },
        true,
        ['deriveKey', 'deriveBits']
      )) as CryptoKeyPair
    }

    const rawPublic = await crypto.subtle.exportKey('raw', keyPair.publicKey)
    const pkcs8Private = await crypto.subtle.exportKey('pkcs8', keyPair.privateKey)

    const identity: DeviceIdentity = {
      deviceId: crypto.randomUUID(),
      publicKey: base64UrlEncode(new Uint8Array(rawPublic)),
      privateKey: base64UrlEncode(new Uint8Array(pkcs8Private)),
      createdAt: Date.now()
    }
    await this.set(identity)
    return identity
  },
  async clear(): Promise<void> {
    await secureRemove(DEVICE_IDENTITY_KEY)
  }
}

/** Hosted Supabase user session storage. */
export const hostedSession = {
  async get(): Promise<HostedSession | null> {
    const raw = await secureGet(HOSTED_SESSION_KEY)
    return raw ? (JSON.parse(raw) as HostedSession) : null
  },
  async set(session: HostedSession): Promise<void> {
    await secureSet(HOSTED_SESSION_KEY, JSON.stringify(session))
  },
  async clear(): Promise<void> {
    await secureRemove(HOSTED_SESSION_KEY)
  }
}

/** Multi-machine paired computer registry. */
export const machines = {
  async getAll(): Promise<MachineRecord[]> {
    const raw = await secureGet(MACHINES_KEY)
    if (!raw) return []
    try {
      return JSON.parse(raw) as MachineRecord[]
    } catch {
      return []
    }
  },
  async get(id: string): Promise<MachineRecord | null> {
    const all = await this.getAll()
    return all.find(m => m.id === id || m.pairingId === id || m.mmsDeviceId === id) ?? null
  },
  async save(machine: MachineRecord): Promise<void> {
    const all = await this.getAll()
    const index = all.findIndex(
      m => m.id === machine.id || m.pairingId === machine.pairingId
    )
    if (index >= 0) {
      all[index] = { ...all[index], ...machine }
    } else {
      all.push(machine)
    }
    await secureSet(MACHINES_KEY, JSON.stringify(all))
  },
  async remove(id: string): Promise<void> {
    const all = await this.getAll()
    const filtered = all.filter(
      m => m.id !== id && m.pairingId !== id && m.mmsDeviceId !== id
    )
    await secureSet(MACHINES_KEY, JSON.stringify(filtered))
    const active = await this.getActiveId()
    if (active === id) {
      const next = filtered[0]?.id ?? null
      await this.setActiveId(next)
    }
  },
  async clear(): Promise<void> {
    await secureRemove(MACHINES_KEY)
    await this.setActiveId(null)
  },
  async getActiveId(): Promise<string | null> {
    const { value } = await Preferences.get({ key: ACTIVE_MACHINE_KEY })
    return value ?? null
  },
  async setActiveId(id: string | null): Promise<void> {
    if (id) {
      await Preferences.set({ key: ACTIVE_MACHINE_KEY, value: id })
    } else {
      await Preferences.remove({ key: ACTIVE_MACHINE_KEY })
    }
  },
  async getActive(): Promise<MachineRecord | null> {
    const activeId = await this.getActiveId()
    if (!activeId) {
      const all = await this.getAll()
      return all[0] ?? null
    }
    return this.get(activeId)
  }
}

/** Seamless migration helper from legacy v1 tokens to machine list. */
export async function migrateLegacyStorage(): Promise<void> {
  const [existingMachines, legacyTokens, legacyConn] = await Promise.all([
    machines.getAll(),
    tokens.get(),
    connectionCache.get()
  ])
  if (existingMachines.length === 0 && legacyTokens && legacyConn) {
    const conn = legacyConn as { baseUrl: string; serverName: string; serverVersion: string }
    const legacyRecord: MachineRecord = {
      id: `legacy-${Date.now()}`,
      name: conn.serverName || 'Legacy Mousse',
      mode: 'legacy',
      controlOrigin: conn.baseUrl,
      installationId: 'legacy',
      installationPublicKey: '',
      mmsDeviceId: 'legacy',
      mmsIdentityPublicKey: '',
      pairingId: 'legacy',
      pairedAt: Date.now(),
      lastSeen: Date.now(),
      status: 'offline',
      legacyConnection: legacyConn as any,
      legacyTokens
    }
    await machines.save(legacyRecord)
    await machines.setActiveId(legacyRecord.id)
  }
}
