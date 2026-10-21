// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { dialDirect, parseDirectEndpoint, parseDirectEndpoints } from '../../src/net/direct'
import type { RelaySocket } from '../../src/net/relay'

class FakeSocket implements RelaySocket {
  binaryType = 'blob'
  readyState = 0
  sent: Uint8Array[] = []
  closed = false
  onopen: ((event: unknown) => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  onclose: ((event: unknown) => void) | null = null
  constructor(readonly url: string) {}
  send(data: string | ArrayBufferLike | ArrayBufferView): void {
    this.sent.push(new Uint8Array(data as Uint8Array))
  }
  close(): void {
    this.closed = true
  }
}

describe('direct endpoints', () => {
  it('accepts only phone listeners on private LAN and Tailscale addresses', () => {
    expect(parseDirectEndpoint({ url: 'ws://192.168.1.5:41234/mousse-net', kind: 'lan' })).toEqual({ url: 'ws://192.168.1.5:41234/mousse-net', kind: 'lan' })
    expect(parseDirectEndpoint({ url: 'ws://[fd12:3456::5]:41234/mousse-net', kind: 'lan' })).toMatchObject({ kind: 'lan' })
    expect(parseDirectEndpoint({ url: 'ws://100.101.1.2:41234/mousse-net', kind: 'tailscale' })).toMatchObject({ kind: 'tailscale' })
    for (const url of [
      'ws://8.8.8.8:41234/mousse-net',
      'ws://studio.local:41234/mousse-net',
      'wss://192.168.1.5:41234/mousse-net',
      'ws://192.168.1.5/mousse-net',
      'ws://192.168.1.5:41234/other',
      'ws://192.168.1.5:41234/mousse-net?x=1',
      'ws://user@192.168.1.5:41234/mousse-net',
      'ws://[2401:4900::5]:41234/mousse-net',
      'ws://127.0.0.1:41234/mousse-net',
    ])
      expect(parseDirectEndpoint({ url, kind: 'lan' }), url).toBeUndefined()
    expect(parseDirectEndpoint({ url: 'ws://192.168.1.5:41234/mousse-net', kind: 'public' })).toBeUndefined()
    expect(parseDirectEndpoints({ endpoints: [{ url: 'ws://100.101.1.2:1/mousse-net', kind: 'tailscale' }, { url: 'ws://10.0.0.2:1/mousse-net', kind: 'lan' }, 'junk'] })).toEqual([
      { url: 'ws://10.0.0.2:1/mousse-net', kind: 'lan' },
      { url: 'ws://100.101.1.2:1/mousse-net', kind: 'tailscale' },
    ])
    expect(parseDirectEndpoints(null)).toEqual([])
  })
})

describe('direct dial', () => {
  it('carries binary frames of at most 64 KiB both ways', async () => {
    let socket!: FakeSocket
    const dialing = dialDirect({ url: 'ws://192.168.1.5:41234/mousse-net', socketFactory: (url) => (socket = new FakeSocket(url)) })
    expect(socket.url).toBe('ws://192.168.1.5:41234/mousse-net')
    expect(socket.binaryType).toBe('arraybuffer')
    socket.onopen!({})
    const stream = await dialing
    const received: number[] = []
    stream.listen({ data: (bytes) => received.push(bytes.length), close: () => undefined })
    stream.write(new Uint8Array(100 * 1024))
    expect(socket.sent.map((frame) => frame.length)).toEqual([64 * 1024, 36 * 1024])
    socket.onmessage!({ data: new Uint8Array(10).buffer })
    expect(received).toEqual([10])
  })

  it('fails on a text frame, on close and when the computer does not answer in time', async () => {
    let socket!: FakeSocket
    const dialing = dialDirect({ url: 'ws://10.0.0.2:41234/mousse-net', socketFactory: (url) => (socket = new FakeSocket(url)) })
    socket.onopen!({})
    const stream = await dialing
    let closedWith: Error | undefined
    stream.listen({ data: () => undefined, close: (error) => (closedWith = error) })
    socket.onmessage!({ data: 'hello' })
    expect(closedWith).toMatchObject({ code: 'bad_request' })
    expect(socket.closed).toBe(true)

    await expect(dialDirect({ url: 'ws://10.0.0.2:41234/mousse-net', socketFactory: (url) => new FakeSocket(url), timeoutMs: 10 })).rejects.toMatchObject({
      code: 'deadline_exceeded',
    })
    const refused = dialDirect({ url: 'ws://10.0.0.2:41234/mousse-net', socketFactory: (url) => (socket = new FakeSocket(url)) })
    socket.onclose!({})
    await expect(refused).rejects.toMatchObject({ code: 'route_unreachable' })
    const controller = new AbortController()
    const aborted = dialDirect({ url: 'ws://10.0.0.2:41234/mousse-net', socketFactory: (url) => (socket = new FakeSocket(url)), signal: controller.signal })
    controller.abort()
    await expect(aborted).rejects.toMatchObject({ code: 'cancelled' })
    await expect(dialDirect({ url: 'ws://8.8.8.8:41234/mousse-net' })).rejects.toMatchObject({ code: 'bad_request' })
  })
})
