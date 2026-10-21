// Dial side of a computer's phone listener: a plain binary WebSocket on the computer's private
// address that carries the same inner TLS byte stream as a relay circuit. The WebSocket itself is
// unauthenticated and unencrypted; the pinned inner TLS and the session handshake are the security.
import { NetError } from './errors'
import { browserSocketFactory, type RelaySocketFactory } from './relay'
import { StreamEndpoint, type ByteStream } from './stream'

export const DIRECT_PATH = '/mousse-net'
const FRAME_MAX_BYTES = 64 * 1024
const OPEN_TIMEOUT_MS = 3_000

export type DirectKind = 'lan' | 'tailscale'
export interface DirectEndpoint {
  url: string
  kind: DirectKind
}

function ipv4Kind(host: string): DirectKind | undefined {
  const parts = host.split('.')
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return undefined
  const [a, b] = parts.map(Number)
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return 'lan'
  if (a === 100 && b >= 64 && b <= 127) return 'tailscale'
  return undefined
}

function ipv6Kind(host: string): DirectKind | undefined {
  if (!/^\[[0-9a-f:]+\]$/i.test(host)) return undefined
  const address = host.slice(1, -1).toLowerCase()
  if (address.startsWith('fd7a:115c:a1e0:')) return 'tailscale'
  if (/^f[cd][0-9a-f]{2}:/.test(address)) return 'lan'
  return undefined
}

/**
 * The endpoint when it is a computer's phone listener on a private LAN or Tailscale address, as
 * the computer reports it; undefined otherwise. Public addresses and host names are never dialed.
 */
export function parseDirectEndpoint(value: unknown): DirectEndpoint | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const { url: text, kind } = value as Record<string, unknown>
  if (typeof text !== 'string' || text.length > 128 || (kind !== 'lan' && kind !== 'tailscale')) return undefined
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return undefined
  }
  if (url.protocol !== 'ws:' || url.username || url.password || url.search || url.hash || url.pathname !== DIRECT_PATH || !url.port)
    return undefined
  const found = ipv4Kind(url.hostname) ?? ipv6Kind(url.hostname)
  return found ? { url: url.toString(), kind } : undefined
}

/** The computer's answer to `net.direct.endpoints`: valid endpoints, LAN first. */
export function parseDirectEndpoints(value: unknown): DirectEndpoint[] {
  const rows = typeof value === 'object' && value !== null ? (value as Record<string, unknown>).endpoints : undefined
  if (!Array.isArray(rows)) return []
  const endpoints = rows.slice(0, 16).map(parseDirectEndpoint).filter((row): row is DirectEndpoint => !!row)
  return endpoints.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'lan' ? -1 : 1))
}

export interface DirectDialOptions {
  url: string
  socketFactory?: RelaySocketFactory
  signal?: AbortSignal
  timeoutMs?: number
}

/** Opens the WebSocket and resolves with its byte stream once it is open. */
export function dialDirect(options: DirectDialOptions): Promise<ByteStream> {
  const endpoint = parseDirectEndpoint({ url: options.url, kind: 'lan' }) ?? parseDirectEndpoint({ url: options.url, kind: 'tailscale' })
  if (!endpoint) return Promise.reject(new NetError('bad_request', 'Invalid direct address.'))
  if (options.signal?.aborted) return Promise.reject(new NetError('cancelled'))
  const factory = options.socketFactory ?? browserSocketFactory
  return new Promise<ByteStream>((resolve, reject) => {
    let state: 'opening' | 'open' | 'failed' = 'opening'
    let stream: StreamEndpoint | undefined
    let socket: ReturnType<RelaySocketFactory>
    try {
      socket = factory(endpoint.url)
    } catch {
      reject(new NetError('route_unreachable', 'Could not open the direct connection.'))
      return
    }
    socket.binaryType = 'arraybuffer'
    const timer = setTimeout(() => fail(new NetError('deadline_exceeded', 'The computer did not answer directly.')), options.timeoutMs ?? OPEN_TIMEOUT_MS)
    const abort = () => fail(new NetError('cancelled'))
    options.signal?.addEventListener('abort', abort, { once: true })
    const cleanup = () => {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', abort)
    }
    const fail = (error: Error) => {
      if (state === 'failed') return
      const wasOpen = state === 'open'
      state = 'failed'
      cleanup()
      try {
        socket.close()
      } catch {
        // already closed
      }
      if (wasOpen) stream?.end(error)
      else reject(error)
    }
    socket.onopen = () => {
      if (state !== 'opening') return
      state = 'open'
      cleanup()
      stream = new StreamEndpoint(
        (bytes) => {
          for (let offset = 0; offset < bytes.length; offset += FRAME_MAX_BYTES) socket.send(bytes.slice(offset, offset + FRAME_MAX_BYTES))
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
    }
    socket.onmessage = (event) => {
      if (state !== 'open') return
      const data = event.data
      if (typeof data === 'string') return fail(new NetError('bad_request', 'Text frame on a direct connection.'))
      const bytes = new Uint8Array(data as ArrayBuffer)
      if (bytes.length > FRAME_MAX_BYTES) return fail(new NetError('too_large', 'Direct frame exceeds 64 KiB.'))
      stream!.deliver(bytes)
    }
    socket.onerror = () => fail(new NetError('route_unreachable', 'The direct connection failed.'))
    socket.onclose = () => fail(new NetError('route_unreachable', 'The direct connection closed.'))
  })
}
