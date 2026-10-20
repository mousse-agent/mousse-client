// A deliberately small TLS 1.3 client (RFC 8446) for Net links:
// TLS_AES_128_GCM_SHA256, x25519, ecdsa_secp256r1_sha256 and a client certificate.
// The server certificate is not chain-validated; its SPKI must equal the pinned key.
// No session tickets, resumption, 0-RTT, ALPN or SNI.
import { x25519 } from '@noble/curves/ed25519.js'
import { concat, equalBytes, randomBytes, Reader, u16, u24, utf8 } from '../bytes'
import { ecdsaSignDer, ecdsaVerifyDer, spkiFromCertificate, type TransportKey } from '../cert'
import { NetError } from '../errors'
import type { ByteStream, StreamHandlers } from '../stream'
import {
  deriveSecret,
  earlySecret,
  exportKeyingMaterial,
  finishedMac,
  handshakeSecret,
  masterSecret,
  RecordCipher,
  Transcript,
} from './keySchedule'

const CONTENT_CCS = 20
const CONTENT_ALERT = 21
const CONTENT_HANDSHAKE = 22
const CONTENT_APPDATA = 23

const HS_CLIENT_HELLO = 1
const HS_SERVER_HELLO = 2
const HS_NEW_SESSION_TICKET = 4
const HS_ENCRYPTED_EXTENSIONS = 8
const HS_CERTIFICATE = 11
const HS_CERTIFICATE_REQUEST = 13
const HS_CERTIFICATE_VERIFY = 15
const HS_FINISHED = 20
const HS_KEY_UPDATE = 24

const EXT_SUPPORTED_GROUPS = 10
const EXT_SIGNATURE_ALGORITHMS = 13
const EXT_SUPPORTED_VERSIONS = 43
const EXT_KEY_SHARE = 51

const TLS13 = 0x0304
const AES_128_GCM_SHA256 = 0x1301
const X25519 = 0x001d
const ECDSA_P256_SHA256 = 0x0403

const MAX_PLAINTEXT = 16_384
const MAX_CIPHERTEXT = MAX_PLAINTEXT + 256
const MAX_HANDSHAKE_MESSAGE = 64 * 1024

// SHA-256("HelloRetryRequest"), RFC 8446 §4.1.3.
const HRR_RANDOM = Uint8Array.from(
  'cf21ad74e59a6111be1d8c021e65b891c2a211167abb8c5e079e09e2c8a8339c'.match(/../g)!.map((h) => parseInt(h, 16)),
)

const ALERT_CLOSE_NOTIFY = 0
const ALERT_UNEXPECTED_MESSAGE = 10
const ALERT_BAD_RECORD_MAC = 20
const ALERT_HANDSHAKE_FAILURE = 40
const ALERT_BAD_CERTIFICATE = 42
const ALERT_ILLEGAL_PARAMETER = 47
const ALERT_DECODE_ERROR = 50
const ALERT_DECRYPT_ERROR = 51

class TlsFailure extends Error {
  constructor(
    readonly alert: number,
    message: string,
    readonly code = 'bad_request',
  ) {
    super(message)
  }
}

export interface TlsClientOptions {
  /** Client certificate and its P-256 key. */
  transport: TransportKey
  /** SubjectPublicKeyInfo DER the server certificate must carry. */
  expectedServerSpki: Uint8Array
  /** Handshake deadline in milliseconds. */
  timeoutMs?: number
}

export interface SecureChannel extends ByteStream {
  readonly peerSpki: Uint8Array
  exportKeyingMaterial(label: string, length: number, context?: Uint8Array): Uint8Array
}

type State = 'server-hello' | 'encrypted-extensions' | 'certificate' | 'certificate-verify' | 'finished' | 'connected' | 'closed'

/** Runs a TLS 1.3 handshake over `stream` and resolves with the protected channel. */
export function connectTls(stream: ByteStream, options: TlsClientOptions): Promise<SecureChannel> {
  return new Promise((resolve, reject) => {
    const client = new Tls13Client(stream, options, resolve, reject)
    client.start()
  })
}

class Tls13Client implements SecureChannel {
  private state: State = 'server-hello'
  private readonly transcript = new Transcript()
  private readonly keyShare = x25519.utils.randomSecretKey()
  private readonly sessionId = randomBytes(32)
  private inbox: Uint8Array = new Uint8Array(0)
  private handshakeBuffer: Uint8Array = new Uint8Array(0)
  private readCipher?: RecordCipher
  private writeCipher?: RecordCipher
  private handshakeSecrets?: { client: Uint8Array; server: Uint8Array; secret: Uint8Array }
  private certificateRequestContext?: Uint8Array
  private serverSpki?: Uint8Array
  private exporterMaster?: Uint8Array
  private handlers?: StreamHandlers
  private pending: Uint8Array[] = []
  private closeEvent?: { error?: Error }
  private timer?: ReturnType<typeof setTimeout>

  constructor(
    private readonly stream: ByteStream,
    private readonly options: TlsClientOptions,
    private readonly onConnected: (channel: SecureChannel) => void,
    private readonly onFailed: (error: Error) => void,
  ) {}

  get closed(): boolean {
    return this.state === 'closed'
  }

  get peerSpki(): Uint8Array {
    if (!this.serverSpki) throw new Error('TLS handshake has not completed.')
    return this.serverSpki
  }

  start(): void {
    this.timer = setTimeout(
      () => this.fail(new NetError('deadline_exceeded', 'TLS handshake timed out.')),
      this.options.timeoutMs ?? 10_000,
    )
    this.stream.listen({
      data: (bytes) => this.receive(bytes),
      close: (error) =>
        this.state === 'connected'
          ? this.finish(error ?? undefined)
          : this.fail(error ?? new NetError('route_unreachable', 'Connection closed during TLS handshake.')),
    })
    const hello = this.clientHello()
    this.transcript.add(hello)
    this.sendRecord(CONTENT_HANDSHAKE, hello, 0x0301)
  }

  // ---------------------------------------------------------------- SecureChannel

  write(bytes: Uint8Array): void {
    if (this.state !== 'connected') throw new Error('TLS channel is not open.')
    for (let offset = 0; offset < bytes.length; offset += MAX_PLAINTEXT)
      this.sendRecord(CONTENT_APPDATA, bytes.subarray(offset, offset + MAX_PLAINTEXT))
  }

  close(error?: Error): void {
    if (this.state === 'closed') return
    if (this.writeCipher && !this.stream.closed) {
      try {
        this.sendRecord(CONTENT_ALERT, Uint8Array.of(1, ALERT_CLOSE_NOTIFY))
      } catch {
        // The transport is already gone.
      }
    }
    this.finish(error)
  }

  listen(handlers: StreamHandlers): void {
    this.handlers = handlers
    const pending = this.pending
    this.pending = []
    for (const bytes of pending) handlers.data(bytes)
    if (this.closeEvent) handlers.close(this.closeEvent.error)
  }

  exportKeyingMaterial(label: string, length: number, context = new Uint8Array(0)): Uint8Array {
    if (!this.exporterMaster) throw new Error('TLS handshake has not completed.')
    return exportKeyingMaterial(this.exporterMaster, label, context, length)
  }

  // ---------------------------------------------------------------- records

  private sendRecord(type: number, content: Uint8Array, legacyVersion = 0x0303): void {
    if (!this.writeCipher) {
      this.stream.write(concat(Uint8Array.of(type), u16(legacyVersion), u16(content.length), content))
      return
    }
    const inner = concat(content, Uint8Array.of(type))
    const header = concat(Uint8Array.of(CONTENT_APPDATA), u16(0x0303), u16(inner.length + 16))
    this.stream.write(concat(header, this.writeCipher.seal(header, inner)))
  }

  private receive(bytes: Uint8Array): void {
    if (this.state === 'closed') return
    this.inbox = this.inbox.length ? concat(this.inbox, bytes) : bytes
    try {
      while (this.inbox.length >= 5 && (this.state as State) !== 'closed') {
        const length = (this.inbox[3] << 8) | this.inbox[4]
        if (length > MAX_CIPHERTEXT) throw new TlsFailure(22, 'TLS record too large.')
        if (this.inbox.length < 5 + length) break
        const header = this.inbox.subarray(0, 5)
        const body = this.inbox.subarray(5, 5 + length)
        this.inbox = this.inbox.subarray(5 + length)
        this.record(header, body)
      }
    } catch (error) {
      this.fail(error as Error)
    }
  }

  private record(header: Uint8Array, body: Uint8Array): void {
    const type = header[0]
    if (type === CONTENT_CCS) {
      if (this.state === 'connected' || body.length !== 1 || body[0] !== 1)
        throw new TlsFailure(ALERT_UNEXPECTED_MESSAGE, 'Unexpected change_cipher_spec.')
      return
    }
    if (!this.readCipher) {
      if (type === CONTENT_ALERT) return this.alert(body)
      if (type !== CONTENT_HANDSHAKE) throw new TlsFailure(ALERT_UNEXPECTED_MESSAGE, 'Expected a plaintext handshake record.')
      return this.handshakeBytes(body)
    }
    if (type !== CONTENT_APPDATA) throw new TlsFailure(ALERT_UNEXPECTED_MESSAGE, 'Expected an encrypted record.')
    let inner: Uint8Array
    try {
      inner = this.readCipher.open(header, body)
    } catch {
      throw new TlsFailure(ALERT_BAD_RECORD_MAC, 'TLS record failed authentication.')
    }
    let end = inner.length - 1
    while (end >= 0 && inner[end] === 0) end--
    if (end < 0) throw new TlsFailure(ALERT_UNEXPECTED_MESSAGE, 'TLS record has no content type.')
    const innerType = inner[end]
    const content = inner.subarray(0, end)
    if (innerType === CONTENT_ALERT) return this.alert(content)
    if (innerType === CONTENT_HANDSHAKE) return this.handshakeBytes(content)
    if (innerType === CONTENT_APPDATA) {
      if (this.state !== 'connected' || this.handshakeBuffer.length)
        throw new TlsFailure(ALERT_UNEXPECTED_MESSAGE, 'Application data before handshake completion.')
      if (content.length) this.emit(content.slice())
      return
    }
    throw new TlsFailure(ALERT_UNEXPECTED_MESSAGE, 'Unknown TLS content type.')
  }

  private alert(body: Uint8Array): void {
    if (body.length !== 2) throw new TlsFailure(ALERT_DECODE_ERROR, 'Malformed alert.')
    if (body[1] === ALERT_CLOSE_NOTIFY) {
      if (this.state === 'connected') return this.finish()
      throw new NetError('route_unreachable', 'Peer closed the connection during the TLS handshake.')
    }
    const error = new NetError(
      body[1] === ALERT_BAD_CERTIFICATE || body[1] === 46 || body[1] === 116 ? 'peer_key_mismatch' : 'route_unreachable',
      `TLS alert ${body[1]} from peer.`,
    )
    this.state = 'closed'
    this.terminate(error)
  }

  // ---------------------------------------------------------------- handshake

  private handshakeBytes(bytes: Uint8Array): void {
    if (!bytes.length) throw new TlsFailure(ALERT_UNEXPECTED_MESSAGE, 'Empty handshake record.')
    this.handshakeBuffer = this.handshakeBuffer.length ? concat(this.handshakeBuffer, bytes) : bytes.slice()
    while (this.handshakeBuffer.length >= 4) {
      const length = (this.handshakeBuffer[1] << 16) | (this.handshakeBuffer[2] << 8) | this.handshakeBuffer[3]
      if (length > MAX_HANDSHAKE_MESSAGE) throw new TlsFailure(ALERT_DECODE_ERROR, 'Handshake message too large.')
      if (this.handshakeBuffer.length < 4 + length) break
      const message = this.handshakeBuffer.subarray(0, 4 + length)
      this.handshakeBuffer = this.handshakeBuffer.subarray(4 + length)
      const keysChange = this.handshake(message[0], message, message.subarray(4))
      // A key change must align with a record boundary (RFC 8446 §5.1).
      if (keysChange && this.handshakeBuffer.length)
        throw new TlsFailure(ALERT_UNEXPECTED_MESSAGE, 'Handshake data spans a key change.')
    }
  }

  /** Returns true when the read keys changed. */
  private handshake(type: number, message: Uint8Array, body: Uint8Array): boolean {
    switch (this.state) {
      case 'server-hello':
        if (type !== HS_SERVER_HELLO) break
        this.serverHello(body)
        this.transcript.add(message)
        this.startHandshakeKeys()
        return true
      case 'encrypted-extensions':
        if (type !== HS_ENCRYPTED_EXTENSIONS) break
        this.encryptedExtensions(body)
        this.transcript.add(message)
        this.state = 'certificate'
        return false
      case 'certificate':
        if (type === HS_CERTIFICATE_REQUEST && !this.certificateRequestContext) {
          this.certificateRequest(body)
          this.transcript.add(message)
          return false
        }
        if (type !== HS_CERTIFICATE) break
        this.certificate(body)
        this.transcript.add(message)
        this.state = 'certificate-verify'
        return false
      case 'certificate-verify':
        if (type !== HS_CERTIFICATE_VERIFY) break
        this.certificateVerify(body)
        this.transcript.add(message)
        this.state = 'finished'
        return false
      case 'finished':
        if (type !== HS_FINISHED) break
        this.serverFinished(body, message)
        return true
      case 'connected':
        if (type === HS_NEW_SESSION_TICKET) return false
        if (type === HS_KEY_UPDATE) {
          this.keyUpdate(body)
          return true
        }
        break
    }
    throw new TlsFailure(ALERT_UNEXPECTED_MESSAGE, `Unexpected handshake message ${type} in state ${this.state}.`)
  }

  private clientHello(): Uint8Array {
    const ext = (type: number, data: Uint8Array) => concat(u16(type), u16(data.length), data)
    const share = x25519.getPublicKey(this.keyShare)
    const extensions = concat(
      ext(EXT_SUPPORTED_VERSIONS, concat(Uint8Array.of(2), u16(TLS13))),
      ext(EXT_SUPPORTED_GROUPS, concat(u16(2), u16(X25519))),
      ext(EXT_SIGNATURE_ALGORITHMS, concat(u16(2), u16(ECDSA_P256_SHA256))),
      ext(EXT_KEY_SHARE, concat(u16(share.length + 4), u16(X25519), u16(share.length), share)),
    )
    const body = concat(
      u16(0x0303),
      randomBytes(32),
      Uint8Array.of(this.sessionId.length),
      this.sessionId,
      u16(2),
      u16(AES_128_GCM_SHA256),
      Uint8Array.of(1, 0),
      u16(extensions.length),
      extensions,
    )
    return handshakeMessage(HS_CLIENT_HELLO, body)
  }

  private serverHello(body: Uint8Array): void {
    const reader = new Reader(body)
    if (reader.u16() !== 0x0303) throw new TlsFailure(ALERT_ILLEGAL_PARAMETER, 'Bad ServerHello version.')
    const random = reader.take(32)
    if (equalBytes(random, HRR_RANDOM))
      throw new TlsFailure(ALERT_HANDSHAKE_FAILURE, 'HelloRetryRequest is not supported.')
    if (!equalBytes(reader.vec8(), this.sessionId)) throw new TlsFailure(ALERT_ILLEGAL_PARAMETER, 'Session id mismatch.')
    if (reader.u16() !== AES_128_GCM_SHA256) throw new TlsFailure(ALERT_ILLEGAL_PARAMETER, 'Unexpected cipher suite.')
    if (reader.u8() !== 0) throw new TlsFailure(ALERT_ILLEGAL_PARAMETER, 'Unexpected compression.')
    const extensions = parseExtensions(reader.vec16())
    reader.end()
    const version = extensions.get(EXT_SUPPORTED_VERSIONS)
    if (!version || version.length !== 2 || ((version[0] << 8) | version[1]) !== TLS13)
      throw new TlsFailure(ALERT_ILLEGAL_PARAMETER, 'Server did not select TLS 1.3.')
    const keyShare = extensions.get(EXT_KEY_SHARE)
    if (!keyShare) throw new TlsFailure(ALERT_HANDSHAKE_FAILURE, 'Server sent no key share.')
    const shareReader = new Reader(keyShare)
    if (shareReader.u16() !== X25519) throw new TlsFailure(ALERT_ILLEGAL_PARAMETER, 'Unexpected key share group.')
    const serverShare = shareReader.vec16()
    shareReader.end()
    if (serverShare.length !== 32) throw new TlsFailure(ALERT_ILLEGAL_PARAMETER, 'Bad x25519 share.')
    for (const type of extensions.keys())
      if (type !== EXT_SUPPORTED_VERSIONS && type !== EXT_KEY_SHARE)
        throw new TlsFailure(ALERT_UNEXPECTED_MESSAGE, `Unexpected ServerHello extension ${type}.`)
    const shared = x25519.getSharedSecret(this.keyShare, serverShare)
    if (shared.every((byte) => byte === 0)) throw new TlsFailure(ALERT_ILLEGAL_PARAMETER, 'Low-order x25519 share.')
    this.sharedSecret = shared
  }

  private sharedSecret?: Uint8Array

  private startHandshakeKeys(): void {
    const secret = handshakeSecret(earlySecret(), this.sharedSecret!)
    this.sharedSecret = undefined
    const hash = this.transcript.hash()
    const client = deriveSecret(secret, 'c hs traffic', hash)
    const server = deriveSecret(secret, 's hs traffic', hash)
    this.handshakeSecrets = { client, server, secret }
    this.readCipher = new RecordCipher(server)
    this.state = 'encrypted-extensions'
  }

  private encryptedExtensions(body: Uint8Array): void {
    const reader = new Reader(body)
    const extensions = parseExtensions(reader.vec16())
    reader.end()
    for (const type of [EXT_KEY_SHARE, EXT_SUPPORTED_VERSIONS, EXT_SIGNATURE_ALGORITHMS])
      if (extensions.has(type)) throw new TlsFailure(ALERT_ILLEGAL_PARAMETER, 'Forbidden EncryptedExtensions entry.')
  }

  private certificateRequest(body: Uint8Array): void {
    const reader = new Reader(body)
    const context = reader.vec8()
    const extensions = parseExtensions(reader.vec16())
    reader.end()
    const algorithms = extensions.get(EXT_SIGNATURE_ALGORITHMS)
    if (!algorithms) throw new TlsFailure(ALERT_DECODE_ERROR, 'CertificateRequest without signature_algorithms.')
    const list = new Reader(algorithms).vec16()
    let supported = false
    for (let i = 0; i + 1 < list.length; i += 2) if (((list[i] << 8) | list[i + 1]) === ECDSA_P256_SHA256) supported = true
    if (!supported) throw new TlsFailure(ALERT_HANDSHAKE_FAILURE, 'Server does not accept ECDSA P-256 client certificates.')
    this.certificateRequestContext = context.slice()
  }

  private certificate(body: Uint8Array): void {
    const reader = new Reader(body)
    if (reader.vec8().length !== 0) throw new TlsFailure(ALERT_ILLEGAL_PARAMETER, 'Server certificate context must be empty.')
    const list = new Reader(reader.vec24())
    reader.end()
    if (!list.remaining) throw new TlsFailure(ALERT_BAD_CERTIFICATE, 'Server sent no certificate.', 'peer_key_mismatch')
    const leaf = list.vec24()
    list.vec16() // entry extensions
    let spki: Uint8Array
    try {
      spki = spkiFromCertificate(leaf)
    } catch {
      throw new TlsFailure(ALERT_BAD_CERTIFICATE, 'Unreadable server certificate.', 'peer_key_mismatch')
    }
    if (!equalBytes(spki, this.options.expectedServerSpki))
      throw new TlsFailure(ALERT_BAD_CERTIFICATE, 'Server key does not match the pinned transport key.', 'peer_key_mismatch')
    this.serverSpki = spki
  }

  private certificateVerify(body: Uint8Array): void {
    const reader = new Reader(body)
    const algorithm = reader.u16()
    const signature = reader.vec16()
    reader.end()
    if (algorithm !== ECDSA_P256_SHA256) throw new TlsFailure(ALERT_ILLEGAL_PARAMETER, 'Unexpected signature algorithm.')
    const content = signedContent('TLS 1.3, server CertificateVerify', this.transcript.hash())
    if (!ecdsaVerifyDer(signature, content, this.serverSpki!))
      throw new TlsFailure(ALERT_DECRYPT_ERROR, 'Server CertificateVerify failed.', 'bad_signature')
  }

  private serverFinished(body: Uint8Array, message: Uint8Array): void {
    const secrets = this.handshakeSecrets!
    const expected = finishedMac(secrets.server, this.transcript.hash())
    if (!equalBytes(body, expected)) throw new TlsFailure(ALERT_DECRYPT_ERROR, 'Server Finished failed.', 'bad_signature')
    this.transcript.add(message)

    const master = masterSecret(secrets.secret)
    const hash = this.transcript.hash()
    const clientApp = deriveSecret(master, 'c ap traffic', hash)
    const serverApp = deriveSecret(master, 's ap traffic', hash)
    this.exporterMaster = deriveSecret(master, 'exp master', hash)

    // Middlebox compatibility: a dummy change_cipher_spec before the encrypted client flight.
    this.stream.write(Uint8Array.of(CONTENT_CCS, 0x03, 0x03, 0x00, 0x01, 0x01))
    this.writeCipher = new RecordCipher(secrets.client)
    if (this.certificateRequestContext) {
      const entry = concat(u24(this.options.transport.certificate.length), this.options.transport.certificate, u16(0))
      const certificate = handshakeMessage(
        HS_CERTIFICATE,
        concat(Uint8Array.of(this.certificateRequestContext.length), this.certificateRequestContext, u24(entry.length), entry),
      )
      this.transcript.add(certificate)
      this.sendRecord(CONTENT_HANDSHAKE, certificate)
      const signature = ecdsaSignDer(
        signedContent('TLS 1.3, client CertificateVerify', this.transcript.hash()),
        this.options.transport.secretKey,
      )
      const verify = handshakeMessage(HS_CERTIFICATE_VERIFY, concat(u16(ECDSA_P256_SHA256), u16(signature.length), signature))
      this.transcript.add(verify)
      this.sendRecord(CONTENT_HANDSHAKE, verify)
    }
    const finished = handshakeMessage(HS_FINISHED, finishedMac(secrets.client, this.transcript.hash()))
    this.sendRecord(CONTENT_HANDSHAKE, finished)

    this.handshakeSecrets = undefined
    this.readCipher = new RecordCipher(serverApp)
    this.writeCipher = new RecordCipher(clientApp)
    this.state = 'connected'
    clearTimeout(this.timer)
    this.onConnected(this)
  }

  private keyUpdate(body: Uint8Array): void {
    if (body.length !== 1 || body[0] > 1) throw new TlsFailure(ALERT_DECODE_ERROR, 'Malformed KeyUpdate.')
    this.readCipher = this.readCipher!.next()
    if (body[0] === 1) {
      this.sendRecord(CONTENT_HANDSHAKE, handshakeMessage(HS_KEY_UPDATE, Uint8Array.of(0)))
      this.writeCipher = this.writeCipher!.next()
    }
  }

  // ---------------------------------------------------------------- lifecycle

  private emit(bytes: Uint8Array): void {
    if (this.handlers) this.handlers.data(bytes)
    else this.pending.push(bytes)
  }

  private fail(error: Error): void {
    if (this.state === 'closed') return
    if (!(error instanceof NetError) && !(error instanceof TlsFailure))
      error = new TlsFailure(ALERT_DECODE_ERROR, `Malformed TLS message: ${error.message}`)
    if (error instanceof TlsFailure) {
      try {
        this.sendRecord(CONTENT_ALERT, Uint8Array.of(2, error.alert))
      } catch {
        // Best effort.
      }
      error = new NetError(error.code, error.message)
    }
    this.state = 'closed'
    this.terminate(error)
  }

  private finish(error?: Error): void {
    if (this.state === 'closed') return
    this.state = 'closed'
    this.terminate(error)
  }

  private terminate(error?: Error): void {
    clearTimeout(this.timer)
    const connected = this.exporterMaster !== undefined
    this.stream.close(error)
    if (!connected) {
      this.onFailed(error ?? new NetError('route_unreachable', 'TLS handshake aborted.'))
      return
    }
    if (this.closeEvent) return
    this.closeEvent = { error }
    this.handlers?.close(error)
  }
}

function handshakeMessage(type: number, body: Uint8Array): Uint8Array {
  return concat(Uint8Array.of(type), u24(body.length), body)
}

function signedContent(context: string, transcriptHash: Uint8Array): Uint8Array {
  return concat(new Uint8Array(64).fill(0x20), utf8(context), Uint8Array.of(0), transcriptHash)
}

function parseExtensions(bytes: Uint8Array): Map<number, Uint8Array> {
  const reader = new Reader(bytes)
  const extensions = new Map<number, Uint8Array>()
  while (reader.remaining) {
    const type = reader.u16()
    if (extensions.has(type)) throw new TlsFailure(ALERT_ILLEGAL_PARAMETER, 'Duplicate extension.')
    extensions.set(type, reader.vec16())
  }
  return extensions
}
