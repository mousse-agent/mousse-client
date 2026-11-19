// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { LanConnector } from '../../src/connection/lan'
import { NetError } from '../../src/net/errors'
import type { NativeLan } from '../../src/net/nativeLan'
import type { SecureChannel } from '../../src/net/tls13/client'

const native: NativeLan = {
  dial: async () => {
    throw new Error('The test opens channels itself.')
  },
  advertisements: { start: async () => undefined, stop: async () => undefined },
}

describe('LAN connector', () => {
  it('dials at most three IPv4 addresses at once, keeps the first channel and closes a later one', async () => {
    const dialed: string[] = []
    const closed: string[] = []
    const pending = new Map<string, (channel: SecureChannel) => void>()
    const connector = new LanConnector({
      native,
      lifecycle: { onPause() {}, onResume() {} },
      openChannel: ({ host }) => {
        dialed.push(host)
        if (host === '192.168.1.3') return Promise.reject(new NetError('peer_key_mismatch', 'another device'))
        return new Promise((resolve) => pending.set(host, resolve))
      },
    })
    const wrong: string[] = []
    const channel = (host: string) => ({ close: () => closed.push(host) }) as unknown as SecureChannel
    const opening = connector.open('nod_c', {} as never, new Uint8Array(32), {
      remembered: [
        { host: '[fd12::1]', port: 1 },
        { host: '192.168.1.1', port: 1 },
        { host: '192.168.1.2', port: 1 },
        { host: '192.168.1.3', port: 1 },
        { host: '192.168.1.4', port: 1 },
      ],
      wrongKey: (hint) => wrong.push(hint.host),
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(dialed).toEqual(['192.168.1.1', '192.168.1.2', '192.168.1.3'])
    expect(wrong).toEqual(['192.168.1.3'])
    // The first channel is used without waiting for the other attempts.
    pending.get('192.168.1.2')!(channel('192.168.1.2'))
    const won = await opening
    pending.get('192.168.1.1')!(channel('192.168.1.1'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(closed).toEqual(['192.168.1.1'])
    won!.close()
    expect(closed).toEqual(['192.168.1.1', '192.168.1.2'])
  })

  it('opens nothing when no address answers', async () => {
    const connector = new LanConnector({
      native,
      lifecycle: { onPause() {}, onResume() {} },
      openChannel: () => Promise.reject(new NetError('route_unreachable')),
    })
    expect(await connector.open('nod_c', {} as never, new Uint8Array(32), { remembered: [{ host: '192.168.1.1', port: 1 }] })).toBeUndefined()
    expect(await connector.open('nod_c', {} as never, new Uint8Array(32))).toBeUndefined()
  })
})
