// A minimal WebSocket client (RFC 6455) over any byte stream, for the computer's LAN listener. The
// web view's own WebSocket cannot reach it: a plain ws:// address from the app's https origin is
// mixed content. This one runs over a native TCP socket instead. The bytes it carries are the
// inner TLS stream; the pinned TLS on top of it is the only authentication.
import { sha1 } from '@noble/hashes/legacy.js'
import { b64url, concat, fromUtf8, randomBytes, utf8 } from './bytes'
import { NetError } from './errors'
import { StreamEndpoint, type ByteStream } from './stream'

/** The path the computer's direct and LAN listeners upgrade; every other path is refused. */
export const MOUSSE_NET_PATH = '/mousse-net'
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
/** The computer accepts frames of at most 64 KiB; larger writes are split. */
export const WS_FRAME_MAX_BYTES = 64 * 1024
/** The response head the client reads before giving up. */
const HEAD_MAX_BYTES = 8 * 1024
/** The largest frame the client accepts from the computer. */
const INBOUND_FRAME_MAX_BYTES = 1024 * 1024
const HANDSHAKE_TIMEOUT_MS = 5_000

function base64(bytes: Uint8Array): string {
  const text = b64url(bytes).replace(/-/g, '+').replace(/_/g, '/')
  return text + '='.repeat((4 - (text.length % 4)) % 4)
}

function frame(opcode: number, payload: Uint8Array): Uint8Array {
  const length = payload.length
  const header = length < 126 ? [0x80 | opcode, 0x80 | length] : length < 65536 ? [0x80 | opcode, 0x80 | 126, length >> 8, length & 0xff] : undefined
  if (!header) throw new NetError('too_large')
  const mask = randomBytes(4)
  const masked = new Uint8Array(length)
  for (let i = 0; i < length; i++) masked[i] = payload[i] ^ mask[i & 3]
  return concat(Uint8Array.from(header), mask, masked)
}

/**
 * Upgrades `socket` (a TCP connection to `host:port`) to a WebSocket on the computer's Net path and
 * resolves with a byte stream of the binary messages. Failures never name the address.
 */
export function openWebSocket(socket: ByteStream, host: string, port: number, timeoutMs = HANDSHAKE_TIMEOUT_MS): Promise<ByteStream> {
  return new Promise((resolve, reject) => {
    const key = base64(randomBytes(16))
    const expected = base64(sha1(utf8(key + GUID)))
    let head: Uint8Array = new Uint8Array(0)
    let buffer: Uint8Array = new Uint8Array(0)
    let upgraded: StreamEndpoint | undefined
    let fragments: Uint8Array[] = []
    let fragmentBytes = 0
    let settled = false
    const fail = (error: Error) => {
      clearTimeout(timer)
      if (!settled) {
        settled = true
        reject(error)
      }
      upgraded?.end(error)
      socket.close(error)
    }
    const timer = setTimeout(() => fail(new NetError('deadline_exceeded', 'The computer did not answer in time.')), timeoutMs)
    const parseFrames = () => {
      for (;;) {
        if (buffer.length < 2) return
        const first = buffer[0],
          second = buffer[1]
        if (second & 0x80 || first & 0x70) return fail(new NetError('bad_request', 'The computer sent an invalid frame.'))
        let length = second & 0x7f
        let offset = 2
        if (length === 126) {
          if (buffer.length < 4) return
          length = (buffer[2] << 8) | buffer[3]
          offset = 4
        } else if (length === 127) {
          if (buffer.length < 10) return
          if (buffer[2] | buffer[3] | buffer[4] | buffer[5]) return fail(new NetError('too_large'))
          length = ((buffer[6] << 24) >>> 0) + (buffer[7] << 16) + (buffer[8] << 8) + buffer[9]
          offset = 10
        }
        if (length > INBOUND_FRAME_MAX_BYTES) return fail(new NetError('too_large'))
        if (buffer.length < offset + length) return
        const payload = buffer.slice(offset, offset + length)
        buffer = buffer.slice(offset + length)
        const opcode = first & 0x0f,
          fin = (first & 0x80) !== 0
        if (opcode === 0x8) {
          clearTimeout(timer)
          upgraded?.end(new NetError('route_unreachable', 'The computer closed the connection.'))
          socket.close()
          return
        }
        if (opcode === 0x9) {
          if (!socket.closed) socket.write(frame(0xa, payload))
          continue
        }
        if (opcode === 0xa) continue
        if (opcode === 0x1 || (opcode !== 0x2 && opcode !== 0x0)) return fail(new NetError('bad_request', 'The computer sent an invalid frame.'))
        fragments.push(payload)
        fragmentBytes += payload.length
        if (fragmentBytes > INBOUND_FRAME_MAX_BYTES) return fail(new NetError('too_large'))
        if (!fin) continue
        const message = fragments.length === 1 ? fragments[0] : concat(...fragments)
        fragments = []
        fragmentBytes = 0
        if (message.length) upgraded?.deliver(message)
      }
    }
    socket.listen({
      data: (bytes) => {
        if (upgraded) {
          buffer = buffer.length ? concat(buffer, bytes) : bytes
          return parseFrames()
        }
        head = concat(head, bytes)
        const end = indexOfHeadEnd(head)
        if (end < 0) {
          if (head.length > HEAD_MAX_BYTES) fail(new NetError('bad_request', 'The computer sent an invalid answer.'))
          return
        }
        const lines = fromUtf8(head.slice(0, end)).split('\r\n')
        const headers = new Map<string, string>()
        for (const line of lines.slice(1)) {
          const colon = line.indexOf(':')
          if (colon > 0) headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim())
        }
        if (
          !/^HTTP\/1\.1 101 /.test(lines[0] + ' ') ||
          headers.get('upgrade')?.toLowerCase() !== 'websocket' ||
          !headers.get('connection')?.toLowerCase().split(/\s*,\s*/).includes('upgrade') ||
          headers.get('sec-websocket-accept') !== expected
        )
          return fail(new NetError('route_unreachable', 'The computer refused the connection.'))
        clearTimeout(timer)
        settled = true
        upgraded = new StreamEndpoint(
          (bytes) => {
            for (let offset = 0; offset < bytes.length; offset += WS_FRAME_MAX_BYTES)
              socket.write(frame(0x2, bytes.subarray(offset, offset + WS_FRAME_MAX_BYTES)))
          },
          () => {
            try {
              if (!socket.closed) socket.write(frame(0x8, new Uint8Array([0x03, 0xe8])))
            } catch {
              // Already gone.
            }
            socket.close()
          },
        )
        resolve(upgraded)
        buffer = head.slice(end + 4)
        head = new Uint8Array(0)
        parseFrames()
      },
      close: (error) => {
        const reason = new NetError('route_unreachable', 'The computer closed the connection.', error ? { cause: error } : undefined)
        if (!settled) fail(reason)
        else upgraded?.end(error ? reason : undefined)
      },
    })
    try {
      socket.write(
        utf8(
          `GET ${MOUSSE_NET_PATH} HTTP/1.1\r\nHost: ${host}:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
            `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
        ),
      )
    } catch (error) {
      fail(new NetError('route_unreachable', 'The computer could not be reached.', { cause: error }))
    }
  })
}

function indexOfHeadEnd(bytes: Uint8Array): number {
  for (let i = 0; i + 3 < bytes.length; i++) if (bytes[i] === 13 && bytes[i + 1] === 10 && bytes[i + 2] === 13 && bytes[i + 3] === 10) return i
  return -1
}
