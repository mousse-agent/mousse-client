// @vitest-environment node
import { createCipheriv, hkdfSync, randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { generateAgreementKey, x25519Shared } from '../../src/net/crypto'
import { LanHints, lanReceiveKey, openAdvertisement, parseLanEndpoints } from '../../src/net/lan'

/** An advertisement sealed exactly as the desktop's `LanDiscovery.announce` seals it, with Node's crypto. */
function desktopAdvertisement(secret: Uint8Array, sender: string, port: number, issued: number): Uint8Array {
  const key = Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), `mousse-lan-v1:${sender}`, 32))
  const nonce = randomBytes(12)
  const plain = randomBytes(16)
  plain.writeDoubleBE(issued, 0)
  plain.writeUInt16BE(port, 8)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(Buffer.from('MLN1'))
  const sealed = Buffer.concat([cipher.update(plain), cipher.final()])
  return new Uint8Array(Buffer.concat([Buffer.from('MLN1'), nonce, sealed, cipher.getAuthTag()]))
}

describe('LAN advertisements', () => {
  const phone = generateAgreementKey()
  const computer = generateAgreementKey()
  const shared = x25519Shared(computer.secretKey, phone.publicKey)
  const key = lanReceiveKey(phone.secretKey, computer.publicKey, 'nod_computer')
  const now = 1_800_000_000_000

  it.each([
    ['opens a current advertisement from the computer', desktopAdvertisement(shared, 'nod_computer', 40123, now - 1_000), 40123],
    ['refuses one older than the hint lifetime', desktopAdvertisement(shared, 'nod_computer', 40123, now - 31_000), undefined],
    ['refuses one from the future beyond the clock allowance', desktopAdvertisement(shared, 'nod_computer', 40123, now + 31_000), undefined],
    ['refuses one keyed for another sender', desktopAdvertisement(shared, 'nod_other', 40123, now), undefined],
    ['refuses one with the tag changed', (() => { const p = desktopAdvertisement(shared, 'nod_computer', 40123, now); p[47] ^= 1; return p })(), undefined],
    ['refuses one of another length', desktopAdvertisement(shared, 'nod_computer', 40123, now).slice(0, 47), undefined],
  ])('%s', (_name, packet, port) => {
    expect(openAdvertisement(packet, key, now)).toBe(port)
  })

  it('keeps hints per source address, drops unusable sources and bounds the packets it examines', () => {
    let clock = now
    const hints = new LanHints(() => [{ node: 'nod_computer', receiveKey: key }], () => clock, 3)
    hints.receive(desktopAdvertisement(shared, 'nod_computer', 40123, clock), '224.0.0.1')
    hints.receive(desktopAdvertisement(shared, 'nod_computer', 40123, clock), 'not-an-address')
    expect(hints.routes('nod_computer')).toEqual([])
    hints.receive(desktopAdvertisement(shared, 'nod_computer', 40123, clock), '192.168.1.20')
    expect(hints.routes('nod_computer')).toEqual([{ host: '192.168.1.20', port: 40123 }])
    // The budget of three packets per window is spent: a restart's new port waits for the next window.
    hints.receive(desktopAdvertisement(shared, 'nod_computer', 40999, clock), '192.168.1.20')
    expect(hints.routes('nod_computer')).toEqual([{ host: '192.168.1.20', port: 40123 }])
    clock += 5_000
    hints.receive(desktopAdvertisement(shared, 'nod_computer', 40999, clock), '192.168.1.20')
    expect(hints.routes('nod_computer')).toEqual([{ host: '192.168.1.20', port: 40999 }])
    clock += 30_001
    expect(hints.routes('nod_computer')).toEqual([])
  })
})

describe('LAN addresses in the endpoints answer', () => {
  it('keeps only ws:// addresses on the Net path with a private IPv4 or unique local IPv6 literal and a port', () => {
    const addresses = [
      'ws://192.168.1.20:41234/mousse-net',
      'ws://10.0.0.7:41234/mousse-net',
      'ws://172.16.4.2:41234/mousse-net',
      'ws://[fd12:3456::1]:41234/mousse-net',
      'ws://192.168.1.20:41234/mousse-net',
      'wss://192.168.1.21:41234/mousse-net',
      'ws://192.168.1.22:41234/other',
      'ws://192.168.1.23:41234/mousse-net?x=1',
      'ws://user@192.168.1.24:41234/mousse-net',
      'ws://192.168.1.25/mousse-net',
      'ws://8.8.8.8:41234/mousse-net',
      'ws://172.32.0.1:41234/mousse-net',
      'ws://100.64.0.1:41234/mousse-net',
      'ws://127.0.0.1:41234/mousse-net',
      'ws://169.254.1.1:41234/mousse-net',
      'ws://[fe80::1]:41234/mousse-net',
      'ws://[2001:db8::1]:41234/mousse-net',
      'ws://[fd7a:115c:a1e0::1]:41234/mousse-net',
      'ws://3232235777:41234/mousse-net',
      'ws://computer.local:41234/mousse-net',
      42,
    ]
    expect(parseLanEndpoints({ endpoints: [], lan: { v: 1, addresses } })).toEqual([
      { host: '192.168.1.20', port: 41234 },
      { host: '10.0.0.7', port: 41234 },
      { host: '172.16.4.2', port: 41234 },
      { host: '[fd12:3456::1]', port: 41234 },
    ])
  })

  it('reads at most eight entries', () => {
    const addresses = Array.from({ length: 12 }, (_, i) => `ws://192.168.1.${i + 1}:41234/mousse-net`)
    expect(parseLanEndpoints({ lan: { v: 1, addresses } })).toHaveLength(8)
  })

  it('tells no news (an older computer, another version) from an empty list', () => {
    expect(parseLanEndpoints({ endpoints: [], webrtc: { v: 1 } })).toBeUndefined()
    expect(parseLanEndpoints({ lan: { v: 2, addresses: ['ws://192.168.1.20:41234/mousse-net'] } })).toBeUndefined()
    expect(parseLanEndpoints({ lan: { v: 1 } })).toBeUndefined()
    expect(parseLanEndpoints(null)).toBeUndefined()
    expect(parseLanEndpoints({ lan: { v: 1, addresses: [] } })).toEqual([])
  })
})
