/**
 * Frozen cross-platform test vectors for @mousse-plus/secure-channel.
 * Keys and secrets are deterministic fixtures — not production material.
 */
import { hexToBytes } from './keys'

export const TEST_VECTORS = {
  suite: {
    pairing: 'Noise_XXpsk0_25519_ChaChaPoly_SHA256',
    reconnect: 'Noise_IK_25519_ChaChaPoly_SHA256',
  },
  /** Deterministic X25519 scalars (clamped by the X25519 implementation on use). */
  keys: {
    initiatorStaticPrivate: hexToBytes(
      '0101010101010101010101010101010101010101010101010101010101010101',
    ),
    responderStaticPrivate: hexToBytes(
      '0202020202020202020202020202020202020202020202020202020202020202',
    ),
    initiatorEphemeralPrivate: hexToBytes(
      '0303030303030303030303030303030303030303030303030303030303030303',
    ),
    responderEphemeralPrivate: hexToBytes(
      '0404040404040404040404040404040404040404040404040404040404040404',
    ),
  },
  pairingSecret: hexToBytes(
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  ),
  prologue: {
    protocolMajor: 2,
    protocolMinor: 0,
    installationId: 'inst_test_001',
    controlOrigin: 'https://control.example',
    mode: 'hosted' as const,
    accountId: 'acct_test_001',
    mmsDeviceId: 'mms_test_001',
    mobileDeviceId: 'mobile_test_001',
    pairingId: 'pair_test_001',
    initiatorRole: 'mobile' as const,
    responderRole: 'mms' as const,
  },
  payloads: {
    initiator: hexToBytes('696e6974'), // "init"
    responder: hexToBytes('72657370'), // "resp"
    transport: hexToBytes('68656c6c6f206d6f75737365'), // "hello mousse"
  },
} as const

export type TestVectors = typeof TEST_VECTORS
