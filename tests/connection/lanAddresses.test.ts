// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { LAN_ADDRESSES_TTL_MS, LanAddresses } from '../../src/connection/lanAddresses'
import { MemoryKeyStorage } from '../../src/net/keys'

const A = { host: '192.168.1.30', port: 41000 }
const B = { host: '10.0.0.5', port: 41000 }

describe('remembered LAN addresses', () => {
  it('keeps what a computer reported under its transport key, across app starts, and replaces it with the next report', async () => {
    const storage = new MemoryKeyStorage()
    let now = 1_000
    const book = new LanAddresses(storage, () => now)
    expect(await book.learn('nod_c', 'key1', [A, B])).toBe(true)
    // The same list again is nothing new to try.
    expect(await book.learn('nod_c', 'key1', [B, A])).toBe(false)
    const restarted = new LanAddresses(storage, () => now)
    expect(await restarted.read('nod_c', 'key1')).toEqual([B, A])
    // A computer with another transport key (added again) gets none of the old ones.
    expect(await restarted.read('nod_c', 'key2')).toEqual([])
    expect(await restarted.learn('nod_c', 'key1', [A])).toBe(false)
    expect(await restarted.read('nod_c', 'key1')).toEqual([A])
    now += 5
    expect(await restarted.learn('nod_c', 'key1', [])).toBe(false)
    expect(await restarted.read('nod_c', 'key1')).toEqual([])
  })

  it('forgets addresses after 30 days without a report', async () => {
    let now = 1_000
    const book = new LanAddresses(new MemoryKeyStorage(), () => now)
    await book.learn('nod_c', 'key1', [A])
    now += LAN_ADDRESSES_TTL_MS
    expect(await book.read('nod_c', 'key1')).toEqual([A])
    now += 1
    expect(await book.read('nod_c', 'key1')).toEqual([])
  })

  it('drops one address where another key answered, only under the same transport key', async () => {
    const book = new LanAddresses(new MemoryKeyStorage())
    await book.learn('nod_c', 'key1', [A, B])
    expect(await book.drop('nod_c', 'key2', A)).toBe(false)
    expect(await book.drop('nod_c', 'key1', A)).toBe(true)
    expect(await book.read('nod_c', 'key1')).toEqual([B])
  })

  it('reads damaged storage as nothing remembered', async () => {
    const storage = new MemoryKeyStorage()
    await storage.setItem('net.lanAddresses', '{"nod_c":{"transport":"key1","savedAt":1,"addresses":[{"host":5,"port":1}]}}')
    expect(await new LanAddresses(storage, () => 2).read('nod_c', 'key1')).toEqual([])
    await storage.setItem('net.lanAddresses', 'not json')
    expect(await new LanAddresses(storage, () => 2).read('nod_c', 'key1')).toEqual([])
  })
})
