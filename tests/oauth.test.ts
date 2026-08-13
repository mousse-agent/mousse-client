import { afterEach, describe, expect, it, vi } from 'vitest'
import { discover } from '../src/oauth'

const base = 'https://mousse.example.test'
const oauth = (overrides: Record<string, unknown> = {}) => ({
  issuer: base,
  authorization_endpoint: `${base}/oauth/authorize`,
  token_endpoint: `${base}/oauth/token`,
  registration_endpoint: `${base}/oauth/register`,
  code_challenge_methods_supported: ['S256'],
  scopes_supported: ['mousse:read', 'mousse:chat', 'mousse:write', 'mousse:terminal', 'mousse:settings', 'mousse:admin'],
  ...overrides
})
const mousse = (overrides: Record<string, unknown> = {}) => ({ protocol_version: '1.0', server_name: 'Mousse', server_version: 'test', api_endpoint: `${base}/v1/rpc`, events_endpoint: `${base}/v1/events`, max_request_bytes: 1, event_retention: 1, ...overrides })

describe('OAuth discovery', () => {
  afterEach(() => vi.unstubAllGlobals())
  it('rejects API metadata that changes the trusted discovery origin', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve(new Response(JSON.stringify(url.includes('oauth-authorization-server') ? oauth() : mousse({ events_endpoint: 'https://attacker.example.test/v1/events' }))))) )
    await expect(discover(base)).rejects.toThrow('Events endpoint must use the discovered server origin')
  })
  it('rejects a server that omits a visible client capability scope', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve(new Response(JSON.stringify(url.includes('oauth-authorization-server') ? oauth({ scopes_supported: ['mousse:read'] }) : mousse())))) )
    await expect(discover(base)).rejects.toThrow('required client scopes')
  })
})
