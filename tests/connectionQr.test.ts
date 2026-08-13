import { describe, expect, it } from 'vitest'
import { parseConnectionQrPayload } from '../src/connectionQr'

describe('Mousse connection QR', () => {
  it('accepts a versioned configuration-only HTTPS payload', () => {
    expect(parseConnectionQrPayload('mousse://connect?v=1&base=https%3A%2F%2Fmousse.example.test%3A28478')).toBe('https://mousse.example.test:28478')
  })

  it.each([
    'https://mousse.example.test',
    'mousse://connect?v=2&base=https%3A%2F%2Fmousse.example.test',
    'mousse://connect?v=1&base=http%3A%2F%2F192.168.1.10%3A28478',
    'mousse://connect?v=1&base=https%3A%2F%2Fmousse.example.test&token=secret'
  ])('rejects untrusted payload %s', (payload) => {
    expect(() => parseConnectionQrPayload(payload)).toThrow()
  })
})
