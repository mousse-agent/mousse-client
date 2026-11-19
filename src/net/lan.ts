// The phone's side of a computer's automatic LAN connections. A computer listens for its paired
// devices on an ephemeral TCP port and, every five seconds, sends each device in its roster an
// encrypted advertisement to the UDP multicast group 239.255.77.77:47777. Each advertisement holds
// only a timestamp and the port, sealed with AES-256-GCM under a key derived from the two devices'
// X25519 agreement keys and the sender's node id. The phone keeps a short-lived hint (the packet's
// source address and the port) in memory and dials it: the pinned TLS and signed session hello on
// top are what authenticate the computer, never the hint. Hints are never stored, logged or shown.
import { gcm } from '@noble/ciphers/aes.js'
import { utf8 } from './bytes'
import { hkdfSha256, x25519Shared } from './crypto'

export const LAN_GROUP = '239.255.77.77'
export const LAN_PORT = 47777
const MAGIC = utf8('MLN1')
export const LAN_PACKET_BYTES = 48
/** A hint lives as long as the computer's own (30 seconds), and clocks may differ by that much. */
export const LAN_HINT_TTL_MS = 30_000
/** Addresses kept per computer, so a VPN or virtual interface never replaces the Wi-Fi one. */
const ADDRESSES_PER_PEER = 8

/** The key `sender` seals its advertisements with, for the pair of `secret`'s two devices. */
export function lanKey(secret: Uint8Array, sender: string): Uint8Array {
  return hkdfSha256(secret, new Uint8Array(0), utf8(`mousse-lan-v1:${sender}`), 32)
}

/** The key that opens `computer`'s advertisements to this phone. */
export function lanReceiveKey(agreeSecret: Uint8Array, computerAgreeKey: Uint8Array, computer: string): Uint8Array {
  return lanKey(x25519Shared(agreeSecret, computerAgreeKey), computer)
}

/** The listening port in an advertisement sealed with `key`, or undefined for anyone else's or a stale one. */
export function openAdvertisement(packet: Uint8Array, key: Uint8Array, now: number): number | undefined {
  if (packet.length !== LAN_PACKET_BYTES || !MAGIC.every((byte, i) => packet[i] === byte)) return undefined
  let plain: Uint8Array
  try {
    plain = gcm(key, packet.subarray(4, 16), MAGIC).decrypt(packet.subarray(16))
  } catch {
    return undefined
  }
  const view = new DataView(plain.buffer, plain.byteOffset, plain.byteLength)
  const issued = view.getFloat64(0),
    port = view.getUint16(8)
  if (!Number.isFinite(issued) || Math.abs(now - issued) > LAN_HINT_TTL_MS || !port) return undefined
  return port
}

/** Seals an advertisement the way a computer does; for tests and the shared vectors. */
export function sealAdvertisement(key: Uint8Array, port: number, issued: number, nonce: Uint8Array, padding: Uint8Array): Uint8Array {
  const plain = new Uint8Array(16)
  plain.set(padding.subarray(0, 6), 10)
  const view = new DataView(plain.buffer)
  view.setFloat64(0, issued)
  view.setUint16(8, port)
  const sealed = gcm(key, nonce, MAGIC).encrypt(plain)
  const out = new Uint8Array(LAN_PACKET_BYTES)
  out.set(MAGIC, 0)
  out.set(nonce, 4)
  out.set(sealed, 16)
  return out
}

/** The source address of an advertisement may be used only when it is a unicast IPv4 literal. */
function usableSource(address: string): boolean {
  const parts = address.split('.')
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return false
  const first = Number(parts[0])
  return first !== 0 && first < 224
}

export interface LanHint {
  host: string
  port: number
}

export interface LanPeerKey {
  node: string
  receiveKey: Uint8Array
}

/**
 * Hints the phone collected from advertisements, per computer, newest first. An advertisement
 * counts only when it opens under one of the keys `peers()` returns; at most `budget` packets are
 * examined per window, which bounds the work a noisy network can cause.
 */
export class LanHints {
  private readonly hints = new Map<string, Map<string, { port: number; expires: number; seen: number }>>()
  private readonly listeners = new Set<(node: string) => void>()
  private budget = 0
  private window = 0

  constructor(
    private readonly peers: () => LanPeerKey[],
    private readonly now: () => number = Date.now,
    private readonly perWindow = 128,
  ) {}

  /** Feeds one received packet with the source address the socket reported. */
  receive(packet: Uint8Array, source: string): void {
    const now = this.now()
    if (now - this.window >= 5_000) {
      this.window = now
      this.budget = this.perWindow
    }
    if (packet.length !== LAN_PACKET_BYTES || this.budget-- <= 0 || !usableSource(source)) return
    let peers: LanPeerKey[]
    try {
      peers = this.peers()
    } catch {
      return
    }
    for (const peer of peers) {
      const port = openAdvertisement(packet, peer.receiveKey, now)
      if (port === undefined) continue
      const rows = this.hints.get(peer.node) ?? new Map()
      const prior = rows.get(source)
      if (!prior && rows.size >= ADDRESSES_PER_PEER) rows.delete(rows.keys().next().value!)
      rows.set(source, { port, expires: now + LAN_HINT_TTL_MS, seen: now })
      this.hints.set(peer.node, rows)
      if (prior?.port !== port) for (const listener of [...this.listeners]) listener(peer.node)
      return
    }
  }

  /** Where `node` was last seen listening, freshest first; empty when it has not been seen lately. */
  routes(node: string): LanHint[] {
    const now = this.now()
    const rows = this.hints.get(node)
    if (!rows) return []
    for (const [host, row] of rows) if (row.expires <= now) rows.delete(host)
    if (!rows.size) this.hints.delete(node)
    return [...rows.entries()].sort((a, b) => b[1].seen - a[1].seen).map(([host, row]) => ({ host, port: row.port }))
  }

  /** Calls `listener` when a computer is seen at a new address or port. */
  onChange(listener: (node: string) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Forgets every hint, as after leaving a network. */
  clear(): void {
    this.hints.clear()
  }
}
