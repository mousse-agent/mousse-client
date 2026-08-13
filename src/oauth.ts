import { App } from '@capacitor/app'
import { Browser } from '@capacitor/browser'
import { normalizedBaseUrl, randomUrlSafe, s256 } from './security'
import { tokens } from './storage'
import type { Connection, MousseConfiguration, OAuthMetadata, TokenSet } from './types'

const redirectUri = 'com.ryspa.mousse:/oauth/callback'
const scopes = ['mousse:read', 'mousse:chat', 'mousse:write', 'mousse:terminal', 'mousse:settings']
async function json<T>(url: string) { const res = await fetch(url, { cache: 'no-store' }); if (!res.ok) throw new Error(`Discovery failed (${res.status})`); return res.json() as Promise<T> }
export async function discover(baseUrl: string): Promise<{ oauth: OAuthMetadata; mousse: MousseConfiguration; connection: Connection }> {
  const base = normalizedBaseUrl(baseUrl)
  const [oauth, mousse] = await Promise.all([json<OAuthMetadata>(`${base}/.well-known/oauth-authorization-server`), json<MousseConfiguration>(`${base}/.well-known/mousse-configuration`)])
  if (mousse.protocol_version.split('.')[0] !== '1') throw new Error('This server does not support Mousse client protocol 1.x.')
  if (!oauth.code_challenge_methods_supported.includes('S256')) throw new Error('Server does not support required S256 PKCE.')
  return { oauth, mousse, connection: { baseUrl: base, serverName: mousse.server_name, serverVersion: mousse.server_version, apiEndpoint: mousse.api_endpoint, eventsEndpoint: mousse.events_endpoint, scopes: scopes.filter(x => oauth.scopes_supported.includes(x)) } }
}
export async function authorize(connection: Connection, oauth: OAuthMetadata): Promise<TokenSet> {
  const registration = await fetch(oauth.registration_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'Mousse Mobile', redirect_uris: [redirectUri], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }) })
  if (!registration.ok) throw new Error(`Registration failed (${registration.status})`)
  const { client_id } = await registration.json() as { client_id: string }
  const verifier = randomUrlSafe(48); const state = randomUrlSafe(32); const challenge = await s256(verifier)
  const callback = new Promise<URL>((resolve, reject) => { const timer = window.setTimeout(() => reject(new Error('Authorization timed out.')), 180_000); const listener = App.addListener('appUrlOpen', ({ url }) => { const received = new URL(url); if (received.protocol === 'com.ryspa.mousse:' && received.pathname === '/oauth/callback') { clearTimeout(timer); listener.then(l => l.remove()); resolve(received) } }) })
  const url = new URL(oauth.authorization_endpoint); Object.entries({ response_type: 'code', client_id, redirect_uri: redirectUri, scope: connection.scopes.join(' '), state, code_challenge: challenge, code_challenge_method: 'S256' }).forEach(([key, value]) => url.searchParams.set(key, value))
  await Browser.open({ url: url.toString(), presentationStyle: 'popover' })
  const received = await callback; await Browser.close()
  if (received.searchParams.get('state') !== state) throw new Error('Authorization state did not match.')
  if (received.searchParams.get('iss') !== oauth.issuer) throw new Error('Authorization issuer did not match discovery.')
  const code = received.searchParams.get('code'); if (!code) throw new Error(received.searchParams.get('error_description') ?? 'Authorization was denied.')
  const body = new URLSearchParams({ grant_type: 'authorization_code', client_id, code, redirect_uri: redirectUri, code_verifier: verifier })
  const res = await fetch(oauth.token_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body })
  if (!res.ok) throw new Error(`Token exchange failed (${res.status})`)
  const result = await res.json() as { access_token: string; refresh_token: string; expires_in: number; scope: string }
  const tokenSet: TokenSet = { ...result, expires_at: Date.now() + result.expires_in * 1000, client_id, base_url: connection.baseUrl, issuer: oauth.issuer }; await tokens.set(tokenSet); return tokenSet
}
