// Dial side of the WebRTC direct path to a computer. The offer and answer travel as one RPC inside
// the session the phone already has (on the Mousse ID relay), so each side's DTLS fingerprint is
// authenticated by the pinned inner TLS. One ordered, reliable DataChannel then carries the same
// inner TLS byte stream as a relay circuit. ICE, DTLS and SCTP only carry bytes; the pinned TLS and
// the session handshake on top are the security, exactly as on the relay.
//
// Nothing here logs, and no error carries a WebRTC cause: SDP, candidates and addresses never
// reach `lastError`, the UI or a log line.
import { NetError } from './errors'
import { StreamEndpoint, type ByteStream } from './stream'

/** The computer's RPC that answers a WebRTC offer. */
export const WEBRTC_OFFER_METHOD = 'net.direct.webrtc.offer'
export const WEBRTC_VERSION = 1
/** The one DataChannel a direct path uses. */
export const WEBRTC_CHANNEL_LABEL = 'mousse-net/1'
/** Non-trickle: the offer goes out with whatever candidates were gathered by then. */
export const GATHER_TIMEOUT_MS = 1_500
/** Writes go out in DataChannel messages of at most this size. */
export const CHUNK_MAX_BYTES = 64 * 1024
/** A path that queues more than this has stalled; it closes with an error instead of growing. */
export const BUFFERED_MAX_BYTES = 8 * 1024 * 1024
const SDP_MAX_BYTES = 16 * 1024
const STUN_MAX_SERVERS = 4
const STUN_URL_MAX = 256
const OFFER_DEADLINE_MS = 6_000

/** A direct path the computer supports. WebRTC is the only kind. */
export interface DirectEndpoint {
  kind: 'webrtc'
}

/**
 * The computer's answer to `net.direct.endpoints`. A computer that supports the WebRTC path
 * reports `webrtc: { v: 1 }`; an older one omits it, and the phone then never tries.
 */
export function parseDirectEndpoints(value: unknown): DirectEndpoint[] {
  if (typeof value !== 'object' || value === null) return []
  const webrtc = (value as Record<string, unknown>).webrtc
  if (typeof webrtc !== 'object' || webrtc === null || (webrtc as Record<string, unknown>).v !== WEBRTC_VERSION) return []
  return [{ kind: 'webrtc' }]
}

/** STUN servers from the Mousse ID configuration; anything else (TURN, junk) is dropped. */
export function stunServers(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((url): url is string => typeof url === 'string' && url.length <= STUN_URL_MAX && /^stuns?:[^\s?#/]+$/i.test(url))
    .slice(0, STUN_MAX_SERVERS)
}

// The subset of the browser WebRTC API the opener uses; tests and the node interop polyfill inject their own.
export interface DataChannelLike {
  binaryType: string
  readonly readyState: string
  readonly bufferedAmount: number
  send(data: ArrayBufferView): void
  close(): void
  onopen: ((event: unknown) => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onerror: ((event: unknown) => void) | null
  onclose: ((event: unknown) => void) | null
}

export interface PeerConnectionLike {
  readonly connectionState: string
  readonly iceGatheringState: string
  readonly localDescription: { type: string; sdp: string } | null
  createDataChannel(label: string, options: { ordered: boolean }): DataChannelLike
  createOffer(): Promise<{ type: string; sdp?: string }>
  setLocalDescription(description: { type: string; sdp?: string }): Promise<void>
  setRemoteDescription(description: { type: 'answer'; sdp: string }): Promise<void>
  close(): void
  onicecandidate: ((event: { candidate: unknown }) => void) | null
  onicegatheringstatechange: ((event: unknown) => void) | null
  onconnectionstatechange: ((event: unknown) => void) | null
}

export interface PeerConnectionConfig {
  iceServers: Array<{ urls: string[] }>
  bundlePolicy: 'max-bundle'
  iceCandidatePoolSize: 0
}

export type PeerConnectionFactory = (config: PeerConnectionConfig) => PeerConnectionLike

/** The webview's RTCPeerConnection, when it has one. */
export function browserPeerConnectionFactory(): PeerConnectionFactory | undefined {
  if (typeof RTCPeerConnection === 'undefined') return undefined
  return (config) => new RTCPeerConnection(config) as unknown as PeerConnectionLike
}

export interface WebRtcDialOptions {
  /** STUN URLs from Mousse ID; empty means host candidates only (same network, Tailscale, IPv6). */
  stun: string[]
  /** Sends the offer RPC over the current session and resolves with its result. */
  rpc(method: string, params: unknown, options: { deadlineMs: number; signal?: AbortSignal }): Promise<unknown>
  /** Called when ICE reports `disconnected`, which is often transient; the caller checks the path. */
  onDisconnected?: () => void
  peerConnectionFactory?: PeerConnectionFactory
  signal?: AbortSignal
  gatherTimeoutMs?: number
}

const lost = (message: string) => new NetError('route_unreachable', message)

/**
 * Creates the peer connection, gathers, sends the offer over the current session, applies the
 * answer and resolves with the DataChannel's byte stream once it is open.
 */
export function dialWebRtc(options: WebRtcDialOptions): Promise<ByteStream> {
  if (options.signal?.aborted) return Promise.reject(new NetError('cancelled'))
  const factory = options.peerConnectionFactory ?? browserPeerConnectionFactory()
  if (!factory) return Promise.reject(new NetError('unavailable', 'This device has no WebRTC.'))
  return new Promise<ByteStream>((resolve, reject) => {
    let state: 'opening' | 'open' | 'failed' = 'opening'
    let stream: StreamEndpoint | undefined
    let pc: PeerConnectionLike
    let channel: DataChannelLike
    const rpcAbort = new AbortController()
    try {
      pc = factory({
        iceServers: options.stun.length ? [{ urls: [...options.stun] }] : [],
        bundlePolicy: 'max-bundle',
        iceCandidatePoolSize: 0,
      })
      channel = pc.createDataChannel(WEBRTC_CHANNEL_LABEL, { ordered: true })
      channel.binaryType = 'arraybuffer'
    } catch {
      reject(new NetError('unavailable', 'Could not start the direct connection.'))
      return
    }
    const abort = () => fail(new NetError('cancelled'))
    options.signal?.addEventListener('abort', abort, { once: true })
    const teardown = () => {
      options.signal?.removeEventListener('abort', abort)
      rpcAbort.abort()
      for (const close of [() => channel.close(), () => pc.close()])
        try {
          close()
        } catch {
          // already closed
        }
    }
    const fail = (error: NetError) => {
      if (state === 'failed') return
      const wasOpen = state === 'open'
      state = 'failed'
      teardown()
      if (wasOpen) stream?.end(error)
      else reject(error)
    }
    const send = (bytes: Uint8Array) => {
      if (state !== 'open' || channel.readyState !== 'open') return fail(lost('The direct connection closed.'))
      for (let offset = 0; offset < bytes.length; offset += CHUNK_MAX_BYTES) {
        const chunk = bytes.subarray(offset, offset + CHUNK_MAX_BYTES)
        // libwebrtc queues without limit; a path that stops draining is closed, never left to grow or drop.
        if (channel.bufferedAmount + chunk.length > BUFFERED_MAX_BYTES) return fail(lost('The direct connection stopped draining.'))
        try {
          channel.send(chunk)
        } catch {
          return fail(lost('The direct connection failed.'))
        }
      }
    }
    channel.onopen = () => {
      if (state !== 'opening') return
      state = 'open'
      options.signal?.removeEventListener('abort', abort)
      stream = new StreamEndpoint(send, () => {
        if (state === 'failed') return
        state = 'failed'
        teardown()
      })
      resolve(stream)
    }
    channel.onmessage = (event) => {
      if (state !== 'open') return
      const bytes = binary(event.data)
      if (!bytes) return fail(new NetError('bad_request', 'Unexpected message on a direct connection.'))
      if (bytes.length > CHUNK_MAX_BYTES) return fail(new NetError('too_large', 'Direct message exceeds 64 KiB.'))
      stream!.deliver(bytes)
    }
    channel.onerror = () => fail(lost('The direct connection failed.'))
    channel.onclose = () => fail(lost('The direct connection closed.'))
    pc.onconnectionstatechange = () => {
      const now = pc.connectionState
      if (now === 'failed' || now === 'closed') fail(lost('The direct connection was lost.'))
      else if (now === 'disconnected' && state === 'open') options.onDisconnected?.()
    }
    void (async () => {
      try {
        const offer = await pc.createOffer()
        await pc.setLocalDescription(offer)
        await gathered(pc, options.gatherTimeoutMs ?? GATHER_TIMEOUT_MS)
        if (state !== 'opening') return
        const sdp = pc.localDescription?.sdp
        if (!sdp || sdp.length > SDP_MAX_BYTES) return fail(new NetError('unavailable', 'Could not prepare the direct connection.'))
        const result = await options.rpc(WEBRTC_OFFER_METHOD, { sdp, v: WEBRTC_VERSION }, { deadlineMs: OFFER_DEADLINE_MS, signal: rpcAbort.signal })
        if (state !== 'opening') return
        const answer = (result as { sdp?: unknown } | null)?.sdp
        if (typeof answer !== 'string' || !answer.startsWith('v=0') || answer.length > SDP_MAX_BYTES)
          return fail(new NetError('bad_request', 'The computer sent an invalid direct answer.'))
        await pc.setRemoteDescription({ type: 'answer', sdp: answer })
      } catch (error) {
        // The computer's refusal keeps its code; WebRTC's own errors may quote SDP and are replaced.
        if (error instanceof NetError) fail(new NetError(error.code, error.code === 'cancelled' ? 'cancelled' : 'The computer did not open a direct connection.'))
        else fail(new NetError('unavailable', 'Could not set up the direct connection.'))
      }
    })()
  })
}

/** The bytes of a binary DataChannel message; undefined for text. Works across realms (polyfills). */
function binary(data: unknown): Uint8Array | undefined {
  if (data instanceof ArrayBuffer || Object.prototype.toString.call(data) === '[object ArrayBuffer]') return new Uint8Array(data as ArrayBuffer)
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice()
  return undefined
}

/** Resolves when ICE gathering completes or after `timeoutMs`, whichever is first. */
function gathered(pc: PeerConnectionLike, timeoutMs: number): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve()
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer)
      pc.onicecandidate = null
      pc.onicegatheringstatechange = null
      resolve()
    }
    const timer = setTimeout(done, timeoutMs)
    pc.onicecandidate = (event) => {
      if (!event.candidate) done()
    }
    pc.onicegatheringstatechange = () => {
      if (pc.iceGatheringState === 'complete') done()
    }
  })
}
