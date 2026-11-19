// The native side of LAN connections: raw TCP sockets and the multicast receiver the web view
// cannot open itself. Android has the MousseLan plugin; iOS and the web have none, and there the
// phone simply never finds a computer on the LAN and uses the relay as before.
import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core'
import { b64url, fromB64url } from './bytes'
import { NetError } from './errors'
import { StreamEndpoint, type ByteStream } from './stream'

interface MousseLanPlugin {
  tcpConnect(options: { host: string; port: number; timeoutMs: number }): Promise<{ id: string }>
  tcpWrite(options: { id: string; data: string }): Promise<void>
  tcpClose(options: { id: string }): Promise<void>
  discoveryStart(): Promise<void>
  discoveryStop(): Promise<void>
  addListener(event: 'tcpData', listener: (event: { id: string; data: string }) => void): Promise<PluginListenerHandle>
  addListener(event: 'tcpClosed', listener: (event: { id: string; error: boolean }) => void): Promise<PluginListenerHandle>
  addListener(event: 'lanAdvert', listener: (event: { address: string; data: string }) => void): Promise<PluginListenerHandle>
}

/** Opens a TCP connection; failures never name the address. */
export type TcpDialer = (host: string, port: number, timeoutMs: number) => Promise<ByteStream>

/** Receives the multicast advertisements of computers on the same network. */
export interface AdvertisementSource {
  /** Starts (or, after a network change, restarts) listening. */
  start(onPacket: (packet: Uint8Array, source: string) => void): Promise<void>
  stop(): Promise<void>
}

export interface NativeLan {
  dial: TcpDialer
  advertisements: AdvertisementSource
}

/** Standard base64, as the plugin passes bytes. */
function toBase64(bytes: Uint8Array): string {
  const text = b64url(bytes).replace(/-/g, '+').replace(/_/g, '/')
  return text + '='.repeat((4 - (text.length % 4)) % 4)
}

function fromBase64(text: string): Uint8Array {
  return fromB64url(text.replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_'))
}

let cached: NativeLan | null | undefined

/** The device's LAN sockets, or undefined where the app has no native plugin for them. */
export function nativeLan(): NativeLan | undefined {
  if (cached !== undefined) return cached ?? undefined
  if (!Capacitor.isNativePlatform() || !Capacitor.isPluginAvailable('MousseLan')) {
    cached = null
    return undefined
  }
  const plugin = registerPlugin<MousseLanPlugin>('MousseLan')
  const sockets = new Map<string, StreamEndpoint>()
  // Events can arrive before tcpConnect resolves on the JS side; they wait here until then.
  const early = new Map<string, Array<{ data?: Uint8Array; closed?: boolean }>>()
  void plugin.addListener('tcpData', ({ id, data }) => {
    const bytes = fromBase64(data)
    const socket = sockets.get(id)
    if (socket) socket.deliver(bytes)
    else early.set(id, [...(early.get(id) ?? []), { data: bytes }])
  })
  void plugin.addListener('tcpClosed', ({ id, error }) => {
    const socket = sockets.get(id)
    sockets.delete(id)
    if (socket) socket.end(error ? new NetError('route_unreachable', 'The connection to the computer dropped.') : undefined)
    else early.set(id, [...(early.get(id) ?? []), { closed: true }])
  })
  let advertListener: Promise<PluginListenerHandle> | undefined
  let onPacket: ((packet: Uint8Array, source: string) => void) | undefined
  cached = {
    dial: async (host, port, timeoutMs) => {
      let id: string
      try {
        ;({ id } = await plugin.tcpConnect({ host, port, timeoutMs }))
      } catch (cause) {
        throw new NetError('route_unreachable', 'The computer could not be reached on this network.', { cause })
      }
      const socket = new StreamEndpoint(
        (bytes) => {
          void plugin.tcpWrite({ id, data: toBase64(bytes) }).catch(() => undefined)
        },
        () => {
          sockets.delete(id)
          void plugin.tcpClose({ id }).catch(() => undefined)
        },
      )
      sockets.set(id, socket)
      for (const event of early.get(id) ?? []) {
        if (event.data) socket.deliver(event.data)
        if (event.closed) {
          sockets.delete(id)
          socket.end()
        }
      }
      early.delete(id)
      return socket
    },
    advertisements: {
      start: async (listener) => {
        onPacket = listener
        advertListener ??= plugin.addListener('lanAdvert', ({ address, data }) => {
          try {
            onPacket?.(fromBase64(data), address)
          } catch {
            // A malformed event is dropped.
          }
        })
        await advertListener
        await plugin.discoveryStart()
      },
      stop: async () => {
        onPacket = undefined
        await plugin.discoveryStop()
      },
    },
  }
  return cached
}
