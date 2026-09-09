import { sha256 } from '@noble/hashes/sha2.js'
import {
  PairingHandshake,
  ReconnectHandshake,
  runPairingHandshake,
  runReconnectHandshake,
  type HandshakeResult,
  type StaticIdentity,
} from './handshake'
import { SecureSession } from './session'
import { encodePrologue, type PrologueContext } from './prologue'
import {
  canonicalizeEnvelope,
  decodeEnvelopeBytes,
  encodeEnvelopeBytes,
  type Envelope,
} from './envelopes'
import {
  base64UrlDecode,
  base64UrlEncode,
  generateKeyPair,
  hexToBytes,
  type X25519KeyPair,
} from './keys'

export type { ChannelMode, ChannelRole, PrologueContext } from './prologue'
export type { HandshakeResult, HandshakePattern } from './handshake'
export { SecureSession } from './session'

export interface ChannelPrologue {
  protocolMajor: number
  protocolMinor: number
  installationId: string
  controlOrigin: string
  mode: 'hosted' | 'self-hosted'
  accountId?: string
  mmsDeviceId: string
  mobileDeviceId: string
  pairingId: string
  initiatorRole?: 'mobile' | 'mms'
  responderRole?: 'mms' | 'mobile'
}

interface PendingInitiator {
  channel: SecureChannel
  m1: Uint8Array
  pattern: 'XXpsk0' | 'IK'
  clientKeyPair: X25519KeyPair
  prologue: ChannelPrologue
  psk?: Uint8Array
}
const pendingInitiators = new Map<string, PendingInitiator>()

export class SecureChannel {
  private session: SecureSession | null = null
  private pairingHandshake: PairingHandshake | null = null
  private reconnectHandshake: ReconnectHandshake | null = null
  private activePattern: 'XXpsk0' | 'IK' | null = null

  static encodePrologue(p: ChannelPrologue): Uint8Array {
    return encodePrologue({
      protocolMajor: p.protocolMajor,
      protocolMinor: p.protocolMinor,
      installationId: p.installationId,
      controlOrigin: p.controlOrigin,
      mode: p.mode,
      accountId: p.accountId,
      mmsDeviceId: p.mmsDeviceId,
      mobileDeviceId: p.mobileDeviceId,
      pairingId: p.pairingId,
      initiatorRole: p.initiatorRole ?? 'mobile',
      responderRole: p.responderRole ?? 'mms',
    })
  }

  isEstablished(): boolean {
    return this.session !== null
  }

  getSession(): SecureSession | null {
    return this.session
  }

  setSession(session: SecureSession): void {
    this.session = session
    this.pairingHandshake = null
    this.reconnectHandshake = null
  }

  reset(): void {
    if (this.session) {
      try {
        this.session.close()
      } catch {}
    }
    this.session = null
    this.pairingHandshake = null
    this.reconnectHandshake = null
    this.activePattern = null
  }

  /**
   * Initializes an in-memory Noise session (for testing / compatibility).
   */
  async initializeSession(options: {
    peerStaticPublicKey: Uint8Array | string
    pairingSecret?: Uint8Array | string
    prologue: ChannelPrologue
    role?: 'client' | 'server'
    peerEphemeralPublicKey?: Uint8Array | string
    localPrivateKey?: Uint8Array | any
  }): Promise<{ clientEphemeralPublic: string; clientStaticPublic: string; prologueHash: string }> {
    this.reset()
    const role = options.role ?? 'client'

    const peerStatic =
      typeof options.peerStaticPublicKey === 'string'
        ? options.peerStaticPublicKey.length === 64 && /^[0-9a-fA-F]+$/.test(options.peerStaticPublicKey)
          ? hexToBytes(options.peerStaticPublicKey)
          : base64UrlDecode(options.peerStaticPublicKey)
        : options.peerStaticPublicKey

    let psk: Uint8Array = new Uint8Array(32)
    if (options.pairingSecret) {
      psk =
        typeof options.pairingSecret === 'string'
          ? options.pairingSecret.length === 64 && /^[0-9a-fA-F]+$/.test(options.pairingSecret)
            ? hexToBytes(options.pairingSecret)
            : base64UrlDecode(options.pairingSecret)
          : options.pairingSecret
    }

    if (role === 'client') {
      const clientKeyPair = generateKeyPair()
      const clientIdentity: StaticIdentity = { keyPair: clientKeyPair }
      let m1: Uint8Array
      let pattern: 'XXpsk0' | 'IK'
      if (options.pairingSecret) {
        m1 = this.startPairingHandshake({
          prologue: options.prologue,
          identity: clientIdentity,
          pairingSecret: psk,
        })
        pattern = 'XXpsk0'
      } else {
        m1 = this.startReconnectHandshake({
          prologue: options.prologue,
          identity: clientIdentity,
          peerStaticPublicKey: peerStatic,
        })
        pattern = 'IK'
      }
      const ephemeralKey = base64UrlEncode(clientKeyPair.publicKey)
      const pBytes = encodePrologue({
        protocolMajor: options.prologue.protocolMajor,
        protocolMinor: options.prologue.protocolMinor,
        installationId: options.prologue.installationId,
        controlOrigin: options.prologue.controlOrigin,
        mode: options.prologue.mode,
        accountId: options.prologue.accountId,
        mmsDeviceId: options.prologue.mmsDeviceId,
        mobileDeviceId: options.prologue.mobileDeviceId,
        pairingId: options.prologue.pairingId,
        initiatorRole: options.prologue.initiatorRole ?? 'mobile',
        responderRole: options.prologue.responderRole ?? 'mms',
      })
      const pHash = base64UrlEncode(sha256(pBytes))
      pendingInitiators.set(ephemeralKey, {
        channel: this,
        m1,
        pattern,
        clientKeyPair,
        prologue: options.prologue,
        psk,
      })
      return {
        clientEphemeralPublic: ephemeralKey,
        clientStaticPublic: base64UrlEncode(clientKeyPair.publicKey),
        prologueHash: pHash,
      }
    }

    if (role === 'server') {
      const ephemeralKey =
        typeof options.peerEphemeralPublicKey === 'string'
          ? options.peerEphemeralPublicKey
          : options.peerEphemeralPublicKey
            ? base64UrlEncode(options.peerEphemeralPublicKey)
            : ''
      if (!ephemeralKey) {
        throw new Error('peerEphemeralPublicKey required for server role')
      }
      const pending = pendingInitiators.get(ephemeralKey)
      if (!pending) {
        throw new Error('no matching client handshake found for ephemeral key')
      }
      pendingInitiators.delete(ephemeralKey)

      let serverPrivKey: Uint8Array = new Uint8Array(32)
      if (options.localPrivateKey instanceof Uint8Array) {
        serverPrivKey =
          options.localPrivateKey.byteLength > 32
            ? options.localPrivateKey.subarray(options.localPrivateKey.byteLength - 32)
            : options.localPrivateKey
      } else if (options.localPrivateKey && typeof options.localPrivateKey === 'object') {
        try {
          const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', options.localPrivateKey))
          serverPrivKey = pkcs8.subarray(pkcs8.byteLength - 32)
        } catch {}
      }

      const serverIdentity: StaticIdentity = {
        keyPair: {
          privateKey: serverPrivKey,
          publicKey: peerStatic,
        },
      }

      const prologueCtx: PrologueContext = {
        protocolMajor: pending.prologue.protocolMajor,
        protocolMinor: pending.prologue.protocolMinor,
        installationId: pending.prologue.installationId,
        controlOrigin: pending.prologue.controlOrigin,
        mode: pending.prologue.mode,
        accountId: pending.prologue.accountId,
        mmsDeviceId: pending.prologue.mmsDeviceId,
        mobileDeviceId: pending.prologue.mobileDeviceId,
        pairingId: pending.prologue.pairingId,
        initiatorRole: pending.prologue.initiatorRole ?? 'mobile',
        responderRole: pending.prologue.responderRole ?? 'mms',
      }

      if (pending.pattern === 'XXpsk0') {
        const responder = PairingHandshake.responder({
          prologue: prologueCtx,
          identity: serverIdentity,
          pairingSecret: pending.psk!,
        })
        responder.read(pending.m1)
        const m2 = responder.write()
        const { outboundFrame: m3 } = pending.channel.handleHandshakeFrame(m2)
        responder.read(m3!)
        const serverResult = responder.finish()
        this.session = serverResult.session
        return {
          clientEphemeralPublic: ephemeralKey,
          clientStaticPublic: base64UrlEncode(serverResult.remoteStaticPublicKey),
          prologueHash: base64UrlEncode(serverResult.handshakeHash),
        }
      } else {
        const responder = ReconnectHandshake.responder({
          prologue: prologueCtx,
          identity: serverIdentity,
        })
        responder.read(pending.m1)
        const m2 = responder.write()
        pending.channel.handleHandshakeFrame(m2)
        const serverResult = responder.finish()
        this.session = serverResult.session
        return {
          clientEphemeralPublic: ephemeralKey,
          clientStaticPublic: base64UrlEncode(serverResult.remoteStaticPublicKey),
          prologueHash: base64UrlEncode(serverResult.handshakeHash),
        }
      }
    }

    throw new Error(`unsupported role: ${role}`)
  }

  /**
   * Start initial pairing handshake (Noise_XXpsk0_25519_ChaChaPoly_SHA256) as initiator.
   * Returns message 1 frame (CONTROL|FIN) to send to MMS over the relay.
   */
  startPairingHandshake(options: {
    prologue: ChannelPrologue
    identity: StaticIdentity
    pairingSecret: Uint8Array | string
    ephemeral?: X25519KeyPair
    payload?: Uint8Array
  }): Uint8Array {
    this.reset()
    const psk =
      typeof options.pairingSecret === 'string'
        ? options.pairingSecret.length === 64 && /^[0-9a-fA-F]+$/.test(options.pairingSecret)
          ? hexToBytes(options.pairingSecret)
          : base64UrlDecode(options.pairingSecret)
        : options.pairingSecret

    this.pairingHandshake = PairingHandshake.initiator({
      prologue: {
        protocolMajor: options.prologue.protocolMajor,
        protocolMinor: options.prologue.protocolMinor,
        installationId: options.prologue.installationId,
        controlOrigin: options.prologue.controlOrigin,
        mode: options.prologue.mode,
        accountId: options.prologue.accountId,
        mmsDeviceId: options.prologue.mmsDeviceId,
        mobileDeviceId: options.prologue.mobileDeviceId,
        pairingId: options.prologue.pairingId,
        initiatorRole: options.prologue.initiatorRole ?? 'mobile',
        responderRole: options.prologue.responderRole ?? 'mms',
      },
      identity: options.identity,
      pairingSecret: psk,
      ephemeral: options.ephemeral,
    })
    this.activePattern = 'XXpsk0'
    return this.pairingHandshake.write(options.payload ?? new Uint8Array(0))
  }

  /**
   * Start reconnect handshake (Noise_IK_25519_ChaChaPoly_SHA256) as initiator.
   * Returns message 1 frame (CONTROL|FIN) to send to MMS over the relay.
   */
  startReconnectHandshake(options: {
    prologue: ChannelPrologue
    identity: StaticIdentity
    peerStaticPublicKey: Uint8Array | string
    ephemeral?: X25519KeyPair
    payload?: Uint8Array
  }): Uint8Array {
    this.reset()
    const peerStatic =
      typeof options.peerStaticPublicKey === 'string'
        ? options.peerStaticPublicKey.length === 64 && /^[0-9a-fA-F]+$/.test(options.peerStaticPublicKey)
          ? hexToBytes(options.peerStaticPublicKey)
          : base64UrlDecode(options.peerStaticPublicKey)
        : options.peerStaticPublicKey

    this.reconnectHandshake = ReconnectHandshake.initiator({
      prologue: {
        protocolMajor: options.prologue.protocolMajor,
        protocolMinor: options.prologue.protocolMinor,
        installationId: options.prologue.installationId,
        controlOrigin: options.prologue.controlOrigin,
        mode: options.prologue.mode,
        accountId: options.prologue.accountId,
        mmsDeviceId: options.prologue.mmsDeviceId,
        mobileDeviceId: options.prologue.mobileDeviceId,
        pairingId: options.prologue.pairingId,
        initiatorRole: options.prologue.initiatorRole ?? 'mobile',
        responderRole: options.prologue.responderRole ?? 'mms',
      },
      identity: options.identity,
      remoteStaticPublicKey: peerStatic,
      ephemeral: options.ephemeral,
    })
    this.activePattern = 'IK'
    return this.reconnectHandshake.write(options.payload ?? new Uint8Array(0))
  }

  /**
   * Handle an incoming handshake message frame from MMS.
   * - In XXpsk0: reads message 2, writes message 3, finishes handshake. Returns msg3 frame.
   * - In IK: reads message 2, finishes handshake. Returns null.
   */
  handleHandshakeFrame(frame: Uint8Array): { outboundFrame: Uint8Array | null; result: HandshakeResult } {
    if (this.activePattern === 'XXpsk0' && this.pairingHandshake) {
      this.pairingHandshake.read(frame)
      const outboundFrame = this.pairingHandshake.write(new Uint8Array(0))
      const result = this.pairingHandshake.finish()
      this.session = result.session
      this.pairingHandshake = null
      return { outboundFrame, result }
    }

    if (this.activePattern === 'IK' && this.reconnectHandshake) {
      this.reconnectHandshake.read(frame)
      const result = this.reconnectHandshake.finish()
      this.session = result.session
      this.reconnectHandshake = null
      return { outboundFrame: null, result }
    }

    throw new Error('no handshake in progress to receive frame')
  }

  /** Encrypt an application envelope into a transport relay frame. */
  async encryptEnvelope(envelope: Envelope): Promise<Uint8Array> {
    if (!this.session) {
      throw new Error('secure channel session not established')
    }
    const plainBytes = encodeEnvelopeBytes(envelope)
    return this.session.encrypt(plainBytes)
  }

  /** Decrypt a transport relay frame into an application envelope. */
  async decryptFrame(frame: Uint8Array): Promise<Envelope> {
    if (!this.session) {
      throw new Error('secure channel session not established')
    }
    const plainBytes = this.session.decrypt(frame)
    return decodeEnvelopeBytes(plainBytes)
  }
}
