import { describe, expect, it } from 'vitest'
import { normalizedBaseUrl, s256 } from '../src/security'

describe('connection security', () => {
  it('only permits HTTP for loopback hosts', () => {
    expect(normalizedBaseUrl('http://127.0.0.1:28478/')).toBe('http://127.0.0.1:28478')
    expect(normalizedBaseUrl('https://mousse.example.test:28478')).toBe('https://mousse.example.test:28478')
    expect(() => normalizedBaseUrl('http://mousse.example.test')).toThrow('HTTPS')
    expect(() => normalizedBaseUrl('https://mousse.example.test/path')).toThrow('base URL')
  })
  it('generates RFC 7636 S256 base64url challenges', async () => {
    expect(await s256('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
  })
})
