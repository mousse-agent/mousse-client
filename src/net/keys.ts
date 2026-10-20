import { b64url, fromB64url } from './bytes'
import { generateAgreementKey, generateSigningKey, x25519PublicKey } from './crypto'
import { ed25519 } from '@noble/curves/ed25519.js'
import { generateTransportKey, spkiFromCertificate, type TransportKey, p256Spki } from './cert'
import { p256 } from '@noble/curves/nist.js'
import { equalBytes } from './bytes'
import { NetError } from './errors'

/** String key-value storage for secrets. Production uses the platform keychain; tests use memory. */
export interface KeyStorage {
  getItem(key: string): Promise<string | null>
  setItem(key: string, value: string): Promise<void>
  removeItem(key: string): Promise<void>
}

export class MemoryKeyStorage implements KeyStorage {
  readonly items = new Map<string, string>()
  async getItem(key: string): Promise<string | null> {
    return this.items.get(key) ?? null
  }
  async setItem(key: string, value: string): Promise<void> {
    this.items.set(key, value)
  }
  async removeItem(key: string): Promise<void> {
    this.items.delete(key)
  }
}

/**
 * iOS Keychain / Android Keystore via @aparajita/capacitor-secure-storage. On the web build the
 * plugin falls back to localStorage, which is acceptable only for development.
 */
export class SecureKeyStorage implements KeyStorage {
  private plugin?: Promise<{
    getItem(key: string): Promise<string | null>
    setItem(key: string, value: string): Promise<void>
    removeItem(key: string): Promise<void>
  }>
  private load() {
    this.plugin ??= import('@aparajita/capacitor-secure-storage').then(async ({ SecureStorage }) => {
      await SecureStorage.setKeyPrefix('mousse.')
      return SecureStorage
    })
    return this.plugin
  }
  async getItem(key: string): Promise<string | null> {
    return (await this.load()).getItem(key)
  }
  async setItem(key: string, value: string): Promise<void> {
    await (await this.load()).setItem(key, value)
  }
  async removeItem(key: string): Promise<void> {
    await (await this.load()).removeItem(key)
  }
}

export async function readJson<T>(storage: KeyStorage, key: string): Promise<T | undefined> {
  const text = await storage.getItem(key)
  if (text === null) return undefined
  try {
    return JSON.parse(text) as T
  } catch (cause) {
    throw new NetError('storage_corrupt', `Stored ${key} is not valid JSON.`, { cause })
  }
}

export async function writeJson(storage: KeyStorage, key: string, value: unknown): Promise<void> {
  await storage.setItem(key, JSON.stringify(value))
}

/** The Net `keys` triple as published in delegations. */
export interface NodePublicKeys {
  sign: string
  agree: string
  transport: string
}

/** A node's private key material: Ed25519 signing, X25519 agreement and P-256 transport. */
export interface NodeKeys {
  signSecret: Uint8Array
  agreeSecret: Uint8Array
  transport: TransportKey
  public: NodePublicKeys
}

export interface StoredNodeKeys {
  v: 1
  sign: string
  agree: string
  transportKey: string
  transportCert: string
}

export function generateNodeKeys(now = Date.now()): NodeKeys {
  const sign = generateSigningKey()
  const agree = generateAgreementKey()
  const transport = generateTransportKey({ now })
  return withPublic(sign.secretKey, agree.secretKey, transport)
}

function withPublic(signSecret: Uint8Array, agreeSecret: Uint8Array, transport: TransportKey): NodeKeys {
  return {
    signSecret,
    agreeSecret,
    transport,
    public: {
      sign: b64url(ed25519.getPublicKey(signSecret)),
      agree: b64url(x25519PublicKey(agreeSecret)),
      transport: b64url(transport.spki),
    },
  }
}

export function serializeNodeKeys(keys: NodeKeys): StoredNodeKeys {
  return {
    v: 1,
    sign: b64url(keys.signSecret),
    agree: b64url(keys.agreeSecret),
    transportKey: b64url(keys.transport.secretKey),
    transportCert: b64url(keys.transport.certificate),
  }
}

export function deserializeNodeKeys(stored: StoredNodeKeys): NodeKeys {
  try {
    if (stored?.v !== 1) throw new Error('Unknown key format.')
    const transportSecret = fromB64url(stored.transportKey, 32)
    const certificate = fromB64url(stored.transportCert)
    const spki = p256Spki(p256.getPublicKey(transportSecret, false))
    if (!equalBytes(spkiFromCertificate(certificate), spki)) throw new Error('Certificate does not match key.')
    return withPublic(fromB64url(stored.sign, 32), fromB64url(stored.agree, 32), {
      secretKey: transportSecret,
      spki,
      certificate,
    })
  } catch (cause) {
    throw new NetError('storage_corrupt', 'Stored node keys are unreadable.', { cause })
  }
}
