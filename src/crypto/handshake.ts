import { PAIRING_SECRET_BYTES, PUBLIC_KEY_BYTES } from '../constants'
import { HandshakeState, type NoiseKeyPair } from './noise'
import { encodePrologue, type PrologueContext } from './prologue'
import { SecureSession } from './session'
import { cloneBytes, timingSafeEqual, type X25519KeyPair } from './keys'
import {
  FRAME_FLAG_CONTROL,
  FRAME_FLAG_FIN,
  encodeFrame,
  decodeFrame,
} from './framing'

const HANDSHAKE_FRAME_FLAGS = FRAME_FLAG_CONTROL | FRAME_FLAG_FIN

export type HandshakePattern = 'XXpsk0' | 'IK'

export interface HandshakeResult {
  session: SecureSession
  remoteStaticPublicKey: Uint8Array
  handshakeHash: Uint8Array
  pattern: HandshakePattern
}

export class HandshakeError extends Error {
  override readonly name = 'HandshakeError'
}

export interface StaticIdentity {
  keyPair: X25519KeyPair
}

function asNoiseKeyPair(keyPair: X25519KeyPair): NoiseKeyPair {
  return {
    privateKey: cloneBytes(keyPair.privateKey),
    publicKey: cloneBytes(keyPair.publicKey),
  }
}

function assertPsk(psk: Uint8Array): void {
  if (psk.byteLength !== PAIRING_SECRET_BYTES) {
    throw new HandshakeError(`psk must be ${PAIRING_SECRET_BYTES} bytes`)
  }
}

function assertPublicKey(key: Uint8Array, label: string): void {
  if (key.byteLength !== PUBLIC_KEY_BYTES) {
    throw new HandshakeError(`${label} must be ${PUBLIC_KEY_BYTES} bytes`)
  }
}

/**
 * Noise_XXpsk0_25519_ChaChaPoly_SHA256 pairing handshake.
 * Initiator is typically mobile; responder is MMS.
 * Responder static key may be pinned against the QR-advertised MMS identity key.
 */
export class PairingHandshake {
  private readonly state: HandshakeState
  private readonly pinnedRemoteStatic: Uint8Array | undefined
  private done = false

  private constructor(
    state: HandshakeState,
    pinnedRemoteStatic: Uint8Array | undefined,
  ) {
    this.state = state
    this.pinnedRemoteStatic = pinnedRemoteStatic
  }

  static initiator(opts: {
    prologue: PrologueContext
    identity: StaticIdentity
    pairingSecret: Uint8Array
    ephemeral?: X25519KeyPair
  }): PairingHandshake {
    assertPsk(opts.pairingSecret)
    const prologue = encodePrologue(opts.prologue)
    const state = HandshakeState.createXXpsk0('initiator', {
      prologue,
      staticKeyPair: asNoiseKeyPair(opts.identity.keyPair),
      psk: opts.pairingSecret,
      ephemeralKeyPair: opts.ephemeral ? asNoiseKeyPair(opts.ephemeral) : undefined,
    })
    return new PairingHandshake(state, undefined)
  }

  static responder(opts: {
    prologue: PrologueContext
    identity: StaticIdentity
    pairingSecret: Uint8Array
    expectedInitiatorStatic?: Uint8Array
    ephemeral?: X25519KeyPair
  }): PairingHandshake {
    assertPsk(opts.pairingSecret)
    if (opts.expectedInitiatorStatic) {
      assertPublicKey(opts.expectedInitiatorStatic, 'expectedInitiatorStatic')
    }
    const prologue = encodePrologue(opts.prologue)
    const state = HandshakeState.createXXpsk0('responder', {
      prologue,
      staticKeyPair: asNoiseKeyPair(opts.identity.keyPair),
      psk: opts.pairingSecret,
      ephemeralKeyPair: opts.ephemeral ? asNoiseKeyPair(opts.ephemeral) : undefined,
    })
    return new PairingHandshake(state, opts.expectedInitiatorStatic)
  }

  /** Write the next handshake message (framed with CONTROL|FIN). */
  write(payload: Uint8Array = new Uint8Array(0)): Uint8Array {
    this.assertActive()
    try {
      return encodeFrame(this.state.writeMessage(payload), HANDSHAKE_FRAME_FLAGS)
    } catch (err) {
      throw new HandshakeError(err instanceof Error ? err.message : 'write failed')
    }
  }

  /** Read the next handshake message (framed). */
  read(frame: Uint8Array): Uint8Array {
    this.assertActive()
    try {
      const { payload, flags } = decodeFrame(frame)
      if ((flags & FRAME_FLAG_CONTROL) === 0) {
        throw new HandshakeError('handshake frame missing CONTROL flag')
      }
      const plain = this.state.readMessage(payload)
      if (this.pinnedRemoteStatic && this.state.remoteStaticPublicKey) {
        if (!timingSafeEqual(this.state.remoteStaticPublicKey, this.pinnedRemoteStatic)) {
          throw new HandshakeError('remote static key does not match pin')
        }
      }
      return plain
    } catch (err) {
      if (err instanceof HandshakeError) throw err
      throw new HandshakeError(err instanceof Error ? err.message : 'read failed')
    }
  }

  finish(): HandshakeResult {
    if (!this.state.isComplete()) {
      throw new HandshakeError('handshake incomplete')
    }
    this.done = true
    const remote = this.state.remoteStaticPublicKey
    if (!remote) {
      throw new HandshakeError('missing remote static public key')
    }
    if (this.pinnedRemoteStatic && !timingSafeEqual(remote, this.pinnedRemoteStatic)) {
      throw new HandshakeError('remote static key does not match pin')
    }
    const { send, recv, handshakeHash } = this.state.splitTransport()
    return {
      session: new SecureSession(send, recv, handshakeHash, remote),
      remoteStaticPublicKey: remote,
      handshakeHash,
      pattern: 'XXpsk0',
    }
  }

  isComplete(): boolean {
    return this.state.isComplete()
  }

  get remoteStaticPublicKey(): Uint8Array | undefined {
    return this.state.remoteStaticPublicKey
  }

  private assertActive(): void {
    if (this.done) {
      throw new HandshakeError('handshake already finished')
    }
  }
}

/**
 * Noise_IK_25519_ChaChaPoly_SHA256 reconnect handshake.
 * Initiator knows the responder static key from a prior pairing.
 */
export class ReconnectHandshake {
  private readonly state: HandshakeState
  private done = false
  public expectedInitiatorStatic?: Uint8Array

  private constructor(state: HandshakeState) {
    this.state = state
  }

  static initiator(opts: {
    prologue: PrologueContext
    identity: StaticIdentity
    remoteStaticPublicKey: Uint8Array
    ephemeral?: X25519KeyPair
  }): ReconnectHandshake {
    assertPublicKey(opts.remoteStaticPublicKey, 'remoteStaticPublicKey')
    const prologue = encodePrologue(opts.prologue)
    const state = HandshakeState.createIK('initiator', {
      prologue,
      staticKeyPair: asNoiseKeyPair(opts.identity.keyPair),
      remoteStaticPublicKey: opts.remoteStaticPublicKey,
      ephemeralKeyPair: opts.ephemeral ? asNoiseKeyPair(opts.ephemeral) : undefined,
    })
    return new ReconnectHandshake(state)
  }

  static responder(opts: {
    prologue: PrologueContext
    identity: StaticIdentity
    expectedInitiatorStatic?: Uint8Array
    ephemeral?: X25519KeyPair
  }): ReconnectHandshake {
    if (opts.expectedInitiatorStatic) {
      assertPublicKey(opts.expectedInitiatorStatic, 'expectedInitiatorStatic')
    }
    const prologue = encodePrologue(opts.prologue)
    const state = HandshakeState.createIK('responder', {
      prologue,
      staticKeyPair: asNoiseKeyPair(opts.identity.keyPair),
      ephemeralKeyPair: opts.ephemeral ? asNoiseKeyPair(opts.ephemeral) : undefined,
    })
    const hs = new ReconnectHandshake(state)
    hs.expectedInitiatorStatic = opts.expectedInitiatorStatic
    return hs
  }

  write(payload: Uint8Array = new Uint8Array(0)): Uint8Array {
    this.assertActive()
    try {
      return encodeFrame(this.state.writeMessage(payload), HANDSHAKE_FRAME_FLAGS)
    } catch (err) {
      throw new HandshakeError(err instanceof Error ? err.message : 'write failed')
    }
  }

  read(frame: Uint8Array): Uint8Array {
    this.assertActive()
    try {
      const { payload, flags } = decodeFrame(frame)
      if ((flags & FRAME_FLAG_CONTROL) === 0) {
        throw new HandshakeError('handshake frame missing CONTROL flag')
      }
      const plain = this.state.readMessage(payload)
      if (this.expectedInitiatorStatic && this.state.remoteStaticPublicKey) {
        if (!timingSafeEqual(this.state.remoteStaticPublicKey, this.expectedInitiatorStatic)) {
          throw new HandshakeError('remote static key does not match pin')
        }
      }
      return plain
    } catch (err) {
      if (err instanceof HandshakeError) throw err
      throw new HandshakeError(err instanceof Error ? err.message : 'read failed')
    }
  }

  finish(): HandshakeResult {
    if (!this.state.isComplete()) {
      throw new HandshakeError('handshake incomplete')
    }
    this.done = true
    const remote = this.state.remoteStaticPublicKey
    if (!remote) {
      throw new HandshakeError('missing remote static public key')
    }
    const { send, recv, handshakeHash } = this.state.splitTransport()
    return {
      session: new SecureSession(send, recv, handshakeHash, remote),
      remoteStaticPublicKey: remote,
      handshakeHash,
      pattern: 'IK',
    }
  }

  isComplete(): boolean {
    return this.state.isComplete()
  }

  get remoteStaticPublicKey(): Uint8Array | undefined {
    return this.state.remoteStaticPublicKey
  }

  private assertActive(): void {
    if (this.done) {
      throw new HandshakeError('handshake already finished')
    }
  }
}

/**
 * Convenience orchestrator for testing and vectors:
 * runs a full in-memory XXpsk0 pairing handshake exchange between initiator and responder.
 */
export function runPairingHandshake(opts: {
  prologue: PrologueContext
  initiatorIdentity: StaticIdentity
  responderIdentity: StaticIdentity
  pairingSecret: Uint8Array
  initiatorPayload?: Uint8Array
  responderPayload?: Uint8Array
  initiatorEphemeral?: X25519KeyPair
  responderEphemeral?: X25519KeyPair
}): {
  initiator: HandshakeResult
  responder: HandshakeResult
  messages: [Uint8Array, Uint8Array, Uint8Array]
} {
  const init = PairingHandshake.initiator({
    prologue: opts.prologue,
    identity: opts.initiatorIdentity,
    pairingSecret: opts.pairingSecret,
    ephemeral: opts.initiatorEphemeral,
  })
  const resp = PairingHandshake.responder({
    prologue: opts.prologue,
    identity: opts.responderIdentity,
    pairingSecret: opts.pairingSecret,
    expectedInitiatorStatic: opts.initiatorIdentity.keyPair.publicKey,
    ephemeral: opts.responderEphemeral,
  })

  const m1 = init.write(opts.initiatorPayload)
  resp.read(m1)
  const m2 = resp.write(opts.responderPayload)
  init.read(m2)
  const m3 = init.write(new Uint8Array(0))
  resp.read(m3)

  return {
    initiator: init.finish(),
    responder: resp.finish(),
    messages: [m1, m2, m3],
  }
}

/**
 * Convenience orchestrator for testing and vectors:
 * runs a full in-memory IK reconnect handshake exchange.
 */
export function runReconnectHandshake(opts: {
  prologue: PrologueContext
  initiatorIdentity: StaticIdentity
  responderIdentity: StaticIdentity
  initiatorPayload?: Uint8Array
  responderPayload?: Uint8Array
  initiatorEphemeral?: X25519KeyPair
  responderEphemeral?: X25519KeyPair
}): {
  initiator: HandshakeResult
  responder: HandshakeResult
  messages: [Uint8Array, Uint8Array]
} {
  const init = ReconnectHandshake.initiator({
    prologue: opts.prologue,
    identity: opts.initiatorIdentity,
    remoteStaticPublicKey: opts.responderIdentity.keyPair.publicKey,
    ephemeral: opts.initiatorEphemeral,
  })
  const resp = ReconnectHandshake.responder({
    prologue: opts.prologue,
    identity: opts.responderIdentity,
    expectedInitiatorStatic: opts.initiatorIdentity.keyPair.publicKey,
    ephemeral: opts.responderEphemeral,
  })

  const m1 = init.write(opts.initiatorPayload)
  resp.read(m1)
  const m2 = resp.write(opts.responderPayload)
  init.read(m2)

  return {
    initiator: init.finish(),
    responder: resp.finish(),
    messages: [m1, m2],
  }
}
