import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  bytesToHex,
  hexToBytes,
  publicKeyFromPrivate,
  encodePrologue,
  runPairingHandshake,
  runReconnectHandshake,
  TEST_VECTORS,
  encodeRelayFrame,
  decodeRelayFrame,
  FRAME_FLAG_CONTROL,
  FRAME_FLAG_FIN,
  wireModeFromStorage,
  storageModeFromWire,
  buildRelayAuthMessage,
  canonicalizeEnvelope,
  encodeEnvelopeBytes,
  requestEnvelope,
  responseResultEnvelope,
  eventEnvelope,
  base64UrlEncode,
} from '../src/crypto'
import {
  canonicalizeQrPayload,
  encodeQrUri,
  parseQrUri,
} from '../src/connectionQr'

const __dirname = dirname(fileURLToPath(import.meta.url))
const frozen = JSON.parse(
  readFileSync(join(__dirname, '..', 'test-vectors', 'control-protocol-2.0.json'), 'utf8'),
)

describe('frozen Control Protocol 2.0 vectors conformance', () => {
  it('maps storage self_hosted to wire self-hosted and vice-versa', () => {
    expect(wireModeFromStorage('self_hosted')).toBe('self-hosted')
    expect(wireModeFromStorage('hosted')).toBe('hosted')
    expect(storageModeFromWire('self-hosted')).toBe('self_hosted')
    expect(storageModeFromWire('hosted')).toBe('hosted')
  })

  it('matches deterministic key material', () => {
    expect(bytesToHex(TEST_VECTORS.keys.initiatorStaticPrivate)).toBe(
      frozen.keys.initiatorStaticPrivate,
    )
    expect(bytesToHex(publicKeyFromPrivate(TEST_VECTORS.keys.initiatorStaticPrivate))).toBe(
      frozen.keys.initiatorStaticPublic,
    )
    expect(bytesToHex(publicKeyFromPrivate(TEST_VECTORS.keys.responderStaticPrivate))).toBe(
      frozen.keys.responderStaticPublic,
    )
    expect(bytesToHex(publicKeyFromPrivate(TEST_VECTORS.keys.initiatorEphemeralPrivate))).toBe(
      frozen.keys.initiatorEphemeralPublic,
    )
    expect(bytesToHex(publicKeyFromPrivate(TEST_VECTORS.keys.responderEphemeralPrivate))).toBe(
      frozen.keys.responderEphemeralPublic,
    )
  })

  it('reproduces hosted and self-hosted QR canonical JSON and URIs', () => {
    expect(canonicalizeQrPayload(frozen.qr.hosted.input)).toBe(frozen.qr.hosted.canonicalJson)
    expect(encodeQrUri(frozen.qr.hosted.input)).toBe(frozen.qr.hosted.uri)
    const parsedHosted = parseQrUri(frozen.qr.hosted.uri, { rejectExpired: false })
    expect(parsedHosted.installationId).toBe(frozen.qr.hosted.input.installationId)
    expect(parsedHosted.pairingId).toBe(frozen.qr.hosted.input.pairingId)
    expect(parsedHosted.controlOrigin).toBe(frozen.qr.hosted.input.controlOrigin)
    expect(parsedHosted.accountId).toBe(frozen.qr.hosted.input.accountId)
    expect(parsedHosted.pairingSecret).toBe(frozen.qr.hosted.input.pairingSecret)

    expect(canonicalizeQrPayload(frozen.qr.selfHosted.input)).toBe(
      frozen.qr.selfHosted.canonicalJson,
    )
    expect(encodeQrUri(frozen.qr.selfHosted.input)).toBe(frozen.qr.selfHosted.uri)
    const parsedSelfHosted = parseQrUri(frozen.qr.selfHosted.uri, { rejectExpired: false })
    expect(parsedSelfHosted.installationId).toBe(frozen.qr.selfHosted.input.installationId)
    expect(parsedSelfHosted.pairingId).toBe(frozen.qr.selfHosted.input.pairingId)
    expect(parsedSelfHosted.controlOrigin).toBe(frozen.qr.selfHosted.input.controlOrigin)
    expect(parsedSelfHosted.accountId).toBeUndefined()
  })

  it('encodes the exact prologue bytes and base64url', () => {
    const bytes = encodePrologue(frozen.prologue.input)
    expect(bytesToHex(bytes)).toBe(frozen.prologue.bytesHex)
    expect(base64UrlEncode(bytes)).toBe(frozen.prologue.bytesBase64url)
  })

  it('reproduces relay frames and auth messages', () => {
    const payload = hexToBytes(frozen.relay.frame.samplePayloadHex)
    expect(bytesToHex(encodeRelayFrame(payload, FRAME_FLAG_CONTROL | FRAME_FLAG_FIN))).toBe(
      frozen.relay.frame.controlFrameHex,
    )
    expect(bytesToHex(encodeRelayFrame(payload, FRAME_FLAG_FIN))).toBe(
      frozen.relay.frame.dataFrameHex,
    )
    const decoded = decodeRelayFrame(hexToBytes(frozen.relay.frame.dataFrameHex))
    expect(bytesToHex(decoded.payload)).toBe(frozen.relay.frame.samplePayloadHex)

    const mobileAuth = buildRelayAuthMessage({
      admission: frozen.relay.authMobile.message.admission,
    })
    expect(JSON.stringify(mobileAuth)).toBe(frozen.relay.authMobile.json)

    const mmsAuth = buildRelayAuthMessage({
      admission: frozen.relay.authMms.message.admission,
      connectorEpoch: frozen.relay.authMms.message.connectorEpoch,
    })
    expect(JSON.stringify(mmsAuth)).toBe(frozen.relay.authMms.json)
  })

  it('reproduces canonical application envelopes', () => {
    const req = requestEnvelope({
      requestId: 'req_test_001',
      method: 'agent.status',
      params: { projectId: 'proj_01' },
      idempotencyKey: 'idem_test_001',
    })
    expect(canonicalizeEnvelope(req)).toBe(frozen.envelopes.request.canonicalJson)
    expect(bytesToHex(encodeEnvelopeBytes(req))).toBe(frozen.envelopes.request.bytesHex)

    const res = responseResultEnvelope('req_test_001', { status: 'idle' })
    expect(canonicalizeEnvelope(res)).toBe(frozen.envelopes.response.canonicalJson)
    expect(bytesToHex(encodeEnvelopeBytes(res))).toBe(frozen.envelopes.response.bytesHex)

    const evt = eventEnvelope({
      instanceId: 'daemon_test_001',
      sequence: 1,
      eventType: 'thread.updated',
      payload: { id: 'thread_01' },
    })
    expect(canonicalizeEnvelope(evt)).toBe(frozen.envelopes.event.canonicalJson)
    expect(bytesToHex(encodeEnvelopeBytes(evt))).toBe(frozen.envelopes.event.bytesHex)
  })

  it('reproduces Noise_XXpsk0 handshake frames and transport ciphertext', () => {
    const initiator = {
      keyPair: {
        privateKey: TEST_VECTORS.keys.initiatorStaticPrivate,
        publicKey: publicKeyFromPrivate(TEST_VECTORS.keys.initiatorStaticPrivate),
      },
    }
    const responder = {
      keyPair: {
        privateKey: TEST_VECTORS.keys.responderStaticPrivate,
        publicKey: publicKeyFromPrivate(TEST_VECTORS.keys.responderStaticPrivate),
      },
    }
    const { initiator: initResult, responder: respResult, messages } = runPairingHandshake({
      prologue: frozen.prologue.input,
      initiatorIdentity: initiator,
      responderIdentity: responder,
      pairingSecret: TEST_VECTORS.pairingSecret,
      initiatorPayload: TEST_VECTORS.payloads.initiator,
      responderPayload: TEST_VECTORS.payloads.responder,
      initiatorEphemeral: {
        privateKey: TEST_VECTORS.keys.initiatorEphemeralPrivate,
        publicKey: publicKeyFromPrivate(TEST_VECTORS.keys.initiatorEphemeralPrivate),
      },
      responderEphemeral: {
        privateKey: TEST_VECTORS.keys.responderEphemeralPrivate,
        publicKey: publicKeyFromPrivate(TEST_VECTORS.keys.responderEphemeralPrivate),
      },
    })

    expect(bytesToHex(messages[0])).toBe(frozen.pairingHandshake.message1FrameHex)
    expect(bytesToHex(messages[1])).toBe(frozen.pairingHandshake.message2FrameHex)
    expect(bytesToHex(messages[2])).toBe(frozen.pairingHandshake.message3FrameHex)
    expect(bytesToHex(initResult.handshakeHash)).toBe(frozen.pairingHandshake.handshakeHashHex)
    expect(bytesToHex(respResult.handshakeHash)).toBe(frozen.pairingHandshake.handshakeHashHex)

    const frame = initResult.session.encrypt(TEST_VECTORS.payloads.transport)
    expect(bytesToHex(frame)).toBe(frozen.pairingHandshake.transport.ciphertextFrameHex)
    expect(bytesToHex(respResult.session.decrypt(frame))).toBe(
      frozen.pairingHandshake.transport.decryptedPlaintextHex,
    )
  })

  it('reproduces Noise_IK reconnect handshake frames and transport ciphertext', () => {
    const initiator = {
      keyPair: {
        privateKey: TEST_VECTORS.keys.initiatorStaticPrivate,
        publicKey: publicKeyFromPrivate(TEST_VECTORS.keys.initiatorStaticPrivate),
      },
    }
    const responder = {
      keyPair: {
        privateKey: TEST_VECTORS.keys.responderStaticPrivate,
        publicKey: publicKeyFromPrivate(TEST_VECTORS.keys.responderStaticPrivate),
      },
    }
    const { initiator: initResult, responder: respResult, messages } = runReconnectHandshake({
      prologue: frozen.prologue.input,
      initiatorIdentity: initiator,
      responderIdentity: responder,
      initiatorPayload: TEST_VECTORS.payloads.initiator,
      responderPayload: TEST_VECTORS.payloads.responder,
      initiatorEphemeral: {
        privateKey: TEST_VECTORS.keys.initiatorEphemeralPrivate,
        publicKey: publicKeyFromPrivate(TEST_VECTORS.keys.initiatorEphemeralPrivate),
      },
      responderEphemeral: {
        privateKey: TEST_VECTORS.keys.responderEphemeralPrivate,
        publicKey: publicKeyFromPrivate(TEST_VECTORS.keys.responderEphemeralPrivate),
      },
    })

    expect(bytesToHex(messages[0])).toBe(frozen.reconnectHandshake.message1FrameHex)
    expect(bytesToHex(messages[1])).toBe(frozen.reconnectHandshake.message2FrameHex)
    expect(bytesToHex(initResult.handshakeHash)).toBe(frozen.reconnectHandshake.handshakeHashHex)

    const frame = initResult.session.encrypt(TEST_VECTORS.payloads.transport)
    expect(bytesToHex(frame)).toBe(frozen.reconnectHandshake.transport.ciphertextFrameHex)

    expect(bytesToHex(respResult.session.decrypt(hexToBytes(frozen.reconnectHandshake.transport.ciphertextFrameHex)))).toBe(
      bytesToHex(TEST_VECTORS.payloads.transport),
    )
  })
})
