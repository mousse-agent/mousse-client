// Dial side of the hosted Mousse ID relay (`/v1/net/relay`, wrapper v1). The socket authenticates with an
// Ed25519 proof over the server's challenge, waits to be paired with the target node, then carries
// the inner TLS byte stream in binary frames of at most 64 KiB.
import { b64url, fromB64url, utf8 } from './bytes'
import { canonicalJson, isId } from './canonical'
import { sha256, signBytes } from './crypto'
import { NetError } from './errors'
import { StreamEndpoint, type ByteStream } from './stream'

export const HOSTED_RELAY_PATH = '/v1/net/relay'
export const RELAY_AUTH_DOMAIN = 'mousse-plus/net-relay-auth/v1'
const AUTH_MAX_BYTES = 16 * 1024
const FRAME_MAX_BYTES = 64 * 1024
const READY_TIMEOUT_MS = 5_000
const PAIR_TIMEOUT_MS = 10_000

/** The subset of the browser WebSocket the relay needs; tests inject a fake. */
export interface RelaySocket {
  binaryType: string
  readonly readyState: number
  send(data: string | ArrayBufferLike | ArrayBufferView): void
  close(code?: number, reason?: string): void
  onopen: ((event: unknown) => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onerror: ((event: unknown) => void) | null
  onclose: ((event: unknown) => void) | null
}
export type RelaySocketFactory = (url: string) => RelaySocket

export const browserSocketFactory: RelaySocketFactory = (url) => new WebSocket(url) as unknown as RelaySocket

export interface RelayIdentity {
  node: string
  /** Raw Ed25519 public key, base64url. */
  signKey: string
  signSecret: Uint8Array
}

export interface RelayDialOptions {
  /** A `plus-relay` route address: `<audience>?node=<target>`. */
  route: string
  identity: RelayIdentity
  /** The phone's Mousse ID registration, or the enrollment rendezvous marker. */
  registration: { registrationId: string; generation: number }
  /** Enrollment only: the invite's rendezvous ticket. */
  ticket?: string
  socketFactory?: RelaySocketFactory
  signal?: AbortSignal
  readyTimeoutMs?: number
  pairTimeoutMs?: number
}

/** Canonical audience: origin + exact relay path, wss (ws only on loopback), nothing else. */
export function canonicalAudience(address: string): string {
  let url: URL
  try {
    url = new URL(address)
  } catch {
    throw new NetError('bad_request', 'Invalid relay address.')
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== HOSTED_RELAY_PATH ||
    !['wss:', 'ws:'].includes(url.protocol) ||
    (url.protocol === 'ws:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
  )
    throw new NetError('bad_request', 'Invalid relay address.')
  return `${url.origin}${HOSTED_RELAY_PATH}`
}

/** Splits a signed route address into the socket audience and target node. */
export function parseRelayRoute(address: string): { audience: string; target: string } {
  let url: URL
  try {
    url = new URL(address)
  } catch {
    throw new NetError('bad_request', 'Invalid relay route.')
  }
  const target = url.searchParams.get('node')
  if (!isId('node', target) || [...url.searchParams.keys()].some((key) => key !== 'node') || url.searchParams.getAll('node').length !== 1)
    throw new NetError('bad_request', 'Invalid relay route.')
  url.search = ''
  return { audience: canonicalAudience(url.toString()), target }
}

/** Registration marker the relay accepts for a prepared node redeeming a rendezvous ticket. */
export function rendezvousRegistration(ticket: string): { registrationId: string; generation: number } {
  return { registrationId: `rendezvous_${b64url(sha256(fromB64url(ticket, 32)))}`, generation: 1 }
}

const RELAY_CODES = new Set([
  'bad_request',
  'forbidden',
  'not_enrolled',
  'revoked',
  'rate_limited',
  'quota_exceeded',
  'route_unreachable',
  'peer_offline',
  'deadline_exceeded',
  'too_large',
  'cancelled',
  'internal',
])

function keysAre(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).sort().join(',') === [...keys].sort().join(',')
}

/** Opens the relay socket and resolves with the paired byte stream. */
export function dialRelay(options: RelayDialOptions): Promise<ByteStream> {
  const { audience, target } = parseRelayRoute(options.route)
  const factory = options.socketFactory ?? browserSocketFactory
  if (options.signal?.aborted) return Promise.reject(new NetError('cancelled'))
  return new Promise<ByteStream>((resolve, reject) => {
    let state: 'challenge' | 'auth' | 'ready' | 'paired' | 'failed' = 'challenge'
    let stream: StreamEndpoint | undefined
    const socket = factory(audience)
    socket.binaryType = 'arraybuffer'
    let timer = setTimeout(() => fail(new NetError('deadline_exceeded', 'Relay did not admit the connection.')), options.readyTimeoutMs ?? READY_TIMEOUT_MS)
    const abort = () => fail(new NetError('cancelled'))
    options.signal?.addEventListener('abort', abort, { once: true })
    const cleanup = () => {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', abort)
    }
    const fail = (error: Error) => {
      if (state === 'failed') return
      const wasPaired = state === 'paired'
      state = 'failed'
      cleanup()
      try {
        socket.close()
      } catch {
        // already closed
      }
      if (wasPaired) stream?.end(error)
      else reject(error)
    }
    socket.onmessage = (event) => {
      try {
        const data = event.data
        if (state === 'paired') {
          if (typeof data === 'string') throw new NetError('bad_request', 'Text frame inside a relay circuit.')
          const bytes = new Uint8Array(data as ArrayBuffer)
          if (bytes.length > FRAME_MAX_BYTES) throw new NetError('too_large', 'Relay frame exceeds 64 KiB.')
          stream!.deliver(bytes)
          return
        }
        if (typeof data !== 'string') throw new NetError('bad_request', 'Binary frame before pairing.')
        if (utf8(data).length > AUTH_MAX_BYTES) throw new NetError('too_large', 'Relay message too large.')
        const value = JSON.parse(data) as Record<string, unknown>
        if (!value || typeof value !== 'object' || Array.isArray(value) || value.v !== 1)
          throw new NetError('bad_request', 'Invalid relay message.')
        if (value.t === 'error') {
          const code = keysAre(value, ['t', 'v', 'code']) && RELAY_CODES.has(String(value.code)) ? String(value.code) : 'route_unreachable'
          throw new NetError(code, `Relay refused the connection (${code}).`)
        }
        if (value.t === 'challenge' && state === 'challenge') {
          if (!keysAre(value, ['t', 'v', 'audience', 'nonce']) || value.audience !== audience)
            throw new NetError('forbidden', 'Relay challenge names another service.')
          fromB64url(String(value.nonce), 32)
          const claims = {
            t: 'auth',
            v: 1,
            audience,
            nonce: value.nonce as string,
            node: options.identity.node,
            signKey: options.identity.signKey,
            role: 'dial',
            target,
            registrationId: options.registration.registrationId,
            generation: options.registration.generation,
            ...(options.ticket ? { rendezvous: { ticket: options.ticket } } : {}),
          }
          const sig = signBytes(canonicalJson({ domain: RELAY_AUTH_DOMAIN, ...claims }), options.identity.signSecret)
          const encoded = JSON.stringify({ ...claims, sig: b64url(sig) })
          if (utf8(encoded).length > AUTH_MAX_BYTES) throw new NetError('too_large', 'Relay auth too large.')
          state = 'auth'
          socket.send(encoded)
          return
        }
        if (value.t === 'ready' && state === 'auth' && keysAre(value, ['t', 'v'])) {
          state = 'ready'
          clearTimeout(timer)
          timer = setTimeout(() => fail(new NetError('peer_offline', 'The computer did not answer through the relay.')), options.pairTimeoutMs ?? PAIR_TIMEOUT_MS)
          return
        }
        if (
          value.t === 'paired' &&
          state === 'ready' &&
          keysAre(value, ['t', 'v', 'peer', 'circuitId']) &&
          value.peer === target &&
          typeof value.circuitId === 'string' &&
          value.circuitId.length <= 128
        ) {
          state = 'paired'
          cleanup()
          stream = new StreamEndpoint(
            (bytes) => {
              for (let offset = 0; offset < bytes.length; offset += FRAME_MAX_BYTES)
                socket.send(bytes.slice(offset, offset + FRAME_MAX_BYTES))
            },
            () => {
              state = 'failed'
              try {
                socket.close()
              } catch {
                // already closed
              }
            },
          )
          resolve(stream)
          return
        }
        throw new NetError('bad_request', 'Unexpected relay message.')
      } catch (error) {
        fail(error instanceof NetError ? error : new NetError('bad_request', 'Invalid relay message.', { cause: error }))
      }
    }
    socket.onerror = () => fail(new NetError('route_unreachable', 'Relay connection failed.'))
    socket.onclose = (event) => {
      if (state === 'paired') {
        state = 'failed'
        const code = (event as { code?: unknown } | null)?.code
        stream!.end(new NetError('route_unreachable', `The relay closed the connection${typeof code === 'number' ? ` (code ${code})` : ''}.`))
      } else fail(new NetError('route_unreachable', 'Relay closed the connection.'))
    }
  })
}
